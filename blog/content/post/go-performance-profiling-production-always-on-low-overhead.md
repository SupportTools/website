---
title: "Go Performance Profiling in Production: Always-On Low-Overhead Techniques"
date: 2029-08-20T00:00:00-05:00
draft: false
tags: ["Go", "Performance", "Profiling", "Pyroscope", "pprof", "Observability", "Production"]
categories: ["Go", "Performance", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to always-on production Go profiling with Pyroscope continuous profiling, pprof user-defined labels for multi-dimensional analysis, 1% sampling overhead validation, and push vs pull profiling architecture decisions."
more_link: "yes"
url: "/go-performance-profiling-production-always-on-low-overhead/"
---

Traditional profiling is performed when a performance problem is already observed, but by then the evidence is gone. Continuous profiling keeps a low-overhead profile running at all times, capturing performance data across deployments and correlating it with incidents after the fact. This guide covers production Go profiling with Pyroscope, pprof labels for multi-dimensional drill-down, overhead validation, and the architectural decision between push and pull profiling models.

<!--more-->

# Go Performance Profiling in Production: Always-On Low-Overhead Techniques

## The Case for Continuous Profiling

Traditional on-demand profiling has a fundamental limitation: it requires you to know when the problem is happening. Production performance regressions often manifest intermittently, under specific load conditions, or only after certain code paths are taken. By the time you notice and attach a profiler, the condition is gone.

Continuous profiling solves this by:
- **Temporal coverage**: profiles are captured for every minute of production operation
- **Deployment correlation**: compare profiles before and after a deployment
- **Flame graph diff**: see exactly which functions regressed
- **Percentile visibility**: p99 CPU time, not just averages

The Go runtime's built-in sampling profiler adds approximately 1-3% overhead at typical sampling rates, making it suitable for always-on production use.

## Understanding Go's pprof Profiler

### The Sampling Mechanism

Go's CPU profiler uses signals (SIGPROF on Linux, timer-based on other OS) to interrupt goroutines and sample the call stack:

```go
// The profiler is controlled via runtime/pprof
import "runtime/pprof"

// CPU profiling: captures call stacks at 100Hz by default
// 100Hz = 1 sample per 10ms = ~1% CPU overhead for sampling itself

// Memory profiling: samples allocations at 1/MemProfileRate frequency
// Default: 1 in every 512KB of allocation
runtime.MemProfileRate = 512 * 1024  // lower value = more samples
```

### What Each Profile Type Captures

```go
package main

import (
    "net/http"
    _ "net/http/pprof"  // Registers pprof HTTP handlers
    "runtime/pprof"
    "os"
)

func main() {
    // Built-in profiles:
    // /debug/pprof/         — index page
    // /debug/pprof/profile  — 30-second CPU profile
    // /debug/pprof/heap     — heap memory allocations
    // /debug/pprof/goroutine — all goroutine stacks
    // /debug/pprof/block    — goroutine blocking events
    // /debug/pprof/mutex    — mutex contention
    // /debug/pprof/allocs   — allocation profiling
    // /debug/pprof/threadcreate — OS thread creation

    // Enable block profiling (disabled by default — has overhead)
    runtime.SetBlockProfileRate(1000)  // 1/1000 blocking events

    // Enable mutex profiling (disabled by default)
    runtime.SetMutexProfileFraction(100)  // 1/100 mutex contentions

    http.ListenAndServe(":6060", nil)
}
```

## Pyroscope: Continuous Profiling Infrastructure

Pyroscope is an open-source continuous profiling platform that stores profiles over time and provides flame graph visualization.

### Pyroscope Server Deployment

```yaml
# pyroscope-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pyroscope
  namespace: observability
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
            - -config.file=/etc/pyroscope/config.yaml
          ports:
            - containerPort: 4040
              name: http
          volumeMounts:
            - name: config
              mountPath: /etc/pyroscope
            - name: data
              mountPath: /data
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 2000m
              memory: 4Gi
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
  namespace: observability
data:
  config.yaml: |
    server:
      http_listen_port: 4040

    storage:
      backend: s3
      s3:
        bucket_name: mycompany-pyroscope
        endpoint: s3.amazonaws.com
        region: us-east-1

    ingester:
      lifecycler:
        ring:
          kvstore:
            store: memberlist
          replication_factor: 1

    limits:
      max_query_range: 720h

---
apiVersion: v1
kind: Service
metadata:
  name: pyroscope
  namespace: observability
spec:
  selector:
    app: pyroscope
  ports:
    - port: 4040
      targetPort: 4040
```

## Integrating Pyroscope Push Profiling into Go Applications

### Basic Integration

```go
// pkg/profiling/profiling.go
package profiling

import (
    "context"
    "log/slog"
    "os"
    "runtime"

    "github.com/grafana/pyroscope-go"
)

type Config struct {
    ServerAddress  string
    ApplicationName string
    Environment    string
    Version        string
    SampleRate     uint32
    EnableMutex    bool
    EnableBlock    bool
}

func Start(cfg Config) (*pyroscope.Profiler, error) {
    // Configure runtime profilers if requested
    if cfg.EnableMutex {
        // 1/100 mutex events: low overhead, good signal
        runtime.SetMutexProfileFraction(100)
    }
    if cfg.EnableBlock {
        // Only sample blocking events > 1ms
        // Lower values have significant overhead
        runtime.SetBlockProfileRate(1_000_000) // 1ms in nanoseconds
    }

    // Build tags from environment
    tags := map[string]string{
        "environment": cfg.Environment,
        "version":     cfg.Version,
        "hostname":    hostname(),
    }

    profiler, err := pyroscope.Start(pyroscope.Config{
        ApplicationName: cfg.ApplicationName,
        ServerAddress:   cfg.ServerAddress,
        Tags:            tags,
        SampleRate:      cfg.SampleRate, // Hz, default 100
        ProfileTypes: []pyroscope.ProfileType{
            pyroscope.ProfileCPU,
            pyroscope.ProfileAllocObjects,
            pyroscope.ProfileAllocSpace,
            pyroscope.ProfileInuseObjects,
            pyroscope.ProfileInuseSpace,
            // Only enable these if SetMutexProfileFraction/SetBlockProfileRate are set
            // pyroscope.ProfileMutexCount,
            // pyroscope.ProfileMutexDuration,
            // pyroscope.ProfileBlockCount,
            // pyroscope.ProfileBlockDuration,
            pyroscope.ProfileGoroutines,
        },
        Logger: pyroscope.StandardLogger,
    })
    if err != nil {
        return nil, err
    }

    slog.Info("continuous profiling started",
        "server", cfg.ServerAddress,
        "app", cfg.ApplicationName,
        "sample_rate_hz", cfg.SampleRate,
    )
    return profiler, nil
}

func hostname() string {
    h, err := os.Hostname()
    if err != nil {
        return "unknown"
    }
    return h
}
```

### Application Integration

```go
// main.go
package main

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "syscall"

    "myapp/pkg/profiling"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    // Start continuous profiling
    prof, err := profiling.Start(profiling.Config{
        ServerAddress:   getEnv("PYROSCOPE_URL", "http://pyroscope.observability.svc.cluster.local:4040"),
        ApplicationName: "myapp",
        Environment:     getEnv("ENVIRONMENT", "production"),
        Version:         getEnv("APP_VERSION", "unknown"),
        SampleRate:      100,  // 100Hz = ~1% CPU overhead
        EnableMutex:     false, // Enable only if investigating mutex contention
        EnableBlock:     false, // Enable only if investigating goroutine blocking
    })
    if err != nil {
        logger.Warn("profiling startup failed — continuing without profiling",
            "error", err,
        )
        // Non-fatal: app should work without profiling
    } else {
        defer prof.Stop()
    }

    // ... rest of application startup

    ctx, cancel := signal.NotifyContext(context.Background(),
        syscall.SIGTERM, syscall.SIGINT)
    defer cancel()

    runServer(ctx)
}
```

## pprof Labels: Multi-Dimensional Profiling

pprof labels allow you to annotate code sections with key-value pairs that appear in the profile output. This enables drill-down by request type, user tier, feature flag, or any other dimension without capturing separate profiles per category.

### Adding Labels to HTTP Handlers

```go
package handlers

import (
    "context"
    "net/http"
    "runtime/pprof"
    "time"

    "github.com/grafana/pyroscope-go"
)

// LabeledHandler wraps an HTTP handler with pprof labels
func LabeledHandler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Build labels for this request
        labels := pprof.Labels(
            "http.method", r.Method,
            "http.path", sanitizePath(r.URL.Path),
            "http.handler", extractHandlerName(r),
        )

        // All CPU samples captured while executing this handler
        // will be tagged with these labels
        pprof.Do(r.Context(), labels, func(ctx context.Context) {
            // Update request context so downstream code can add more labels
            r = r.WithContext(ctx)
            next.ServeHTTP(w, r)
        })
    })
}

// LabeledHTTPClient wraps HTTP client calls with profiling labels
func doHTTPRequest(ctx context.Context, method, url string) (*http.Response, error) {
    labels := pprof.Labels(
        "http.client.method", method,
        "http.client.host", extractHost(url),
    )

    var resp *http.Response
    var err error

    pprof.Do(ctx, labels, func(ctx context.Context) {
        req, _ := http.NewRequestWithContext(ctx, method, url, nil)
        resp, err = http.DefaultClient.Do(req)
    })

    return resp, err
}

func sanitizePath(path string) string {
    // Replace dynamic segments with placeholders to avoid cardinality explosion
    // /users/12345/orders -> /users/:id/orders
    // Use a router-specific method if available (chi, gorilla, etc.)
    return path // simplified
}
```

### Labels for Database Operations

```go
package database

import (
    "context"
    "runtime/pprof"

    "database/sql"
)

type LabeledDB struct {
    db *sql.DB
}

func (l *LabeledDB) QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
    // Extract query type (SELECT, INSERT, UPDATE, DELETE)
    queryType := extractQueryType(query)

    var rows *sql.Rows
    var err error

    labels := pprof.Labels(
        "db.operation", queryType,
        "db.table", extractTable(query),
        "db.driver", "postgres",
    )

    pprof.Do(ctx, labels, func(ctx context.Context) {
        rows, err = l.db.QueryContext(ctx, query, args...)
    })

    return rows, err
}

func (l *LabeledDB) ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error) {
    queryType := extractQueryType(query)

    var result sql.Result
    var err error

    labels := pprof.Labels(
        "db.operation", queryType,
        "db.table", extractTable(query),
    )

    pprof.Do(ctx, labels, func(ctx context.Context) {
        result, err = l.db.ExecContext(ctx, query, args...)
    })

    return result, err
}

func extractQueryType(query string) string {
    if len(query) < 6 {
        return "unknown"
    }
    switch query[:6] {
    case "SELECT":
        return "select"
    case "INSERT":
        return "insert"
    case "UPDATE":
        return "update"
    case "DELETE":
        return "delete"
    default:
        return "other"
    }
}
```

### Pyroscope-Specific Labels (Span Integration)

Pyroscope extends pprof labels with its own Tag API that integrates with distributed tracing:

```go
package tracing

import (
    "context"
    "net/http"

    "github.com/grafana/pyroscope-go"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/trace"
)

// TracedHandler combines OpenTelemetry tracing with Pyroscope profiling
func TracedHandler(next http.Handler) http.Handler {
    tracer := otel.Tracer("myapp")

    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx, span := tracer.Start(r.Context(), "http.request")
        defer span.End()

        // Tag the profile with the trace ID for correlation
        traceID := span.SpanContext().TraceID().String()
        spanID := span.SpanContext().SpanID().String()

        // Pyroscope tag — appears in profile metadata
        ctx = pyroscope.TagWrapper(ctx, pyroscope.Labels(
            "trace_id", traceID,
            "span_id", spanID,
            "service", "myapp",
            "endpoint", r.URL.Path,
        ), func(c context.Context) {
            r = r.WithContext(c)
            next.ServeHTTP(w, r)
        })

        _ = ctx
    })
}
```

## Overhead Measurement and Validation

### Benchmarking Profiling Overhead

```go
// profiling_overhead_test.go
package profiling_test

import (
    "runtime"
    "runtime/pprof"
    "testing"
    "time"
    "os"
)

// BenchmarkWithoutProfiling establishes baseline
func BenchmarkWithoutProfiling(b *testing.B) {
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        doWork()
    }
}

// BenchmarkWithCPUProfiling measures CPU profiling overhead
func BenchmarkWithCPUProfiling(b *testing.B) {
    f, _ := os.CreateTemp("", "cpu-profile-*.prof")
    defer os.Remove(f.Name())
    defer f.Close()

    pprof.StartCPUProfile(f)
    defer pprof.StopCPUProfile()

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        doWork()
    }
}

// BenchmarkWithMemProfiling measures memory profiling overhead
func BenchmarkWithMemProfiling(b *testing.B) {
    // Set high sample rate for accurate measurement
    prev := runtime.MemProfileRate
    runtime.MemProfileRate = 1 // Sample every allocation — maximum overhead
    defer func() { runtime.MemProfileRate = prev }()

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        doWork()
    }
}

func doWork() {
    // Simulate application work: allocations, computation, goroutines
    data := make([]byte, 4096)
    for i := range data {
        data[i] = byte(i)
    }

    sum := 0
    for _, v := range data {
        sum += int(v)
    }
    _ = sum
}
```

```bash
# Run overhead benchmarks
go test -bench=. -benchtime=30s -benchmem ./profiling_overhead_test.go

# Expected output:
# BenchmarkWithoutProfiling-8      15000000    1952 ns/op    4096 B/op    1 allocs/op
# BenchmarkWithCPUProfiling-8      14700000    2011 ns/op    4096 B/op    1 allocs/op
# BenchmarkWithMemProfiling-8       8000000    3724 ns/op    4096 B/op    1 allocs/op

# CPU profiling at 100Hz: ~3% overhead
# Memory profiling at default rate: ~1% overhead
# Memory profiling at rate=1: ~90% overhead (never use in production)
```

### Production Overhead Monitoring

```go
package monitoring

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
        Buckets: prometheus.ExponentialBuckets(0.0001, 2, 15),
    })

    goroutineCount = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_goroutines",
        Help: "Current number of goroutines",
    })

    heapInUse = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_heap_inuse_bytes",
        Help: "Heap in use bytes",
    })
)

func StartRuntimeMetrics() {
    go func() {
        ticker := time.NewTicker(15 * time.Second)
        defer ticker.Stop()

        var lastGC uint32
        var stats runtime.MemStats

        for range ticker.C {
            runtime.ReadMemStats(&stats)

            goroutineCount.Set(float64(runtime.NumGoroutine()))
            heapInUse.Set(float64(stats.HeapInuse))

            // Report GC pauses since last check
            if stats.NumGC > lastGC {
                for i := lastGC; i < stats.NumGC && i < uint32(len(stats.PauseNs)); i++ {
                    idx := i % uint32(len(stats.PauseNs))
                    pauseDuration := time.Duration(stats.PauseNs[idx])
                    gcPauseHistogram.Observe(pauseDuration.Seconds())
                }
                lastGC = stats.NumGC
            }
        }
    }()
}
```

## Pull Profiling: The pprof HTTP Endpoint Approach

Pull profiling lets external tools scrape profiles on demand. Pyroscope supports this in addition to push mode.

### Exposing pprof Endpoints Securely

```go
// pkg/debugserver/server.go
package debugserver

import (
    "context"
    "net/http"
    _ "net/http/pprof"  // Side-effect: registers /debug/pprof/* handlers
    "time"
    "log/slog"
)

type Server struct {
    addr   string
    logger *slog.Logger
}

func New(addr string, logger *slog.Logger) *Server {
    return &Server{addr: addr, logger: logger}
}

func (s *Server) Start(ctx context.Context) error {
    mux := http.NewServeMux()

    // Only expose debug endpoints on a separate, non-public port
    // This port should NOT be exposed via Kubernetes Service to external traffic
    mux.HandleFunc("/debug/pprof/", http.DefaultServeMux.ServeHTTP)

    // Health and readiness
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    srv := &http.Server{
        Addr:         s.addr,
        Handler:      mux,
        ReadTimeout:  60 * time.Second,  // CPU profiles take 30s
        WriteTimeout: 65 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    go func() {
        <-ctx.Done()
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        srv.Shutdown(shutdownCtx)
    }()

    s.logger.Info("debug server starting", "addr", s.addr)
    return srv.ListenAndServe()
}
```

### Pyroscope Pull Mode Configuration

```yaml
# pyroscope-scrape-config.yaml — configure Pyroscope to pull from Go apps
# This goes in the Pyroscope server config

scrape_configs:
  - job_name: 'go-services'
    scrape_interval: 15s
    static_configs:
      - targets:
          - 'myapp-service.production.svc.cluster.local:6060'
    profiling_config:
      pprof_config:
        memory:
          enabled: true
          path: /debug/pprof/heap
          delta: false
        block:
          enabled: false
        mutex:
          enabled: false
        cpu:
          enabled: true
          path: /debug/pprof/profile
          delta: true
          seconds: 14  # Profile duration per scrape
        goroutine:
          enabled: true
          path: /debug/pprof/goroutine
          delta: false
        process_cpu:
          enabled: true
```

## Push vs Pull: When to Use Each

### Push Profiling (Pyroscope Agent in App)

**Pros:**
- Works behind NAT/firewalls
- No service discovery needed
- Profiling data sent even when app is under load (pull can timeout)
- Easier in serverless/batch job contexts

**Cons:**
- Adds dependency to every application binary
- Requires Pyroscope server URL in app config
- Agent bugs can affect application

**Use when:** Applications in private networks, batch jobs, Kubernetes pods without stable DNS names

### Pull Profiling (Pyroscope Scrapes pprof Endpoints)

**Pros:**
- No Pyroscope dependency in app code
- Applications only need the standard `net/http/pprof` import
- Pull model is consistent with Prometheus pattern
- Easier to manage sampling rate from the scraper side

**Cons:**
- Requires stable DNS/service discovery
- High-load situations may cause profile collection timeouts
- Requires network access from Pyroscope to every app instance

**Use when:** Apps already expose pprof endpoints, Kubernetes-native environments with Prometheus-style service discovery

### Hybrid Approach (Recommended)

```go
// Support both push and pull in the same binary
func main() {
    // Always expose pprof HTTP endpoint (pull profiling)
    go debugserver.New(":6060", logger).Start(ctx)

    // Push profiling: only enabled when PYROSCOPE_URL is set
    if pyroscopeURL := os.Getenv("PYROSCOPE_URL"); pyroscopeURL != "" {
        _, err := pyroscope.Start(pyroscope.Config{
            ApplicationName: "myapp",
            ServerAddress:   pyroscopeURL,
            // ... rest of config
        })
        if err != nil {
            logger.Warn("push profiling disabled", "error", err)
        }
    }

    // ... rest of app
}
```

## Analyzing Profiles: Common Patterns

### Identifying CPU Regressions

```bash
# Capture two profiles: before and after a deployment
go tool pprof -http=:8081 https://myapp:6060/debug/pprof/profile?seconds=30

# Or use the Pyroscope diff UI:
# Compare time range before deployment vs after deployment
# The flame graph diff shows +/- CPU time for each function

# CLI comparison
go tool pprof -diff_base=profile_before.prof profile_after.prof

# Focus on the top functions
(pprof) top20
# Look for functions that increased significantly
```

### Heap Allocation Analysis

```bash
# Capture heap profile
curl -o heap.prof https://myapp:6060/debug/pprof/heap

# Interactive analysis
go tool pprof heap.prof

# Show allocation sites
(pprof) top --cum  # Cumulative allocations in call tree
(pprof) list myapp.HotFunction  # Annotated source with allocation counts

# For allocation profiling (where objects are allocated)
# use allocs profile instead of heap
curl -o allocs.prof "https://myapp:6060/debug/pprof/allocs"
go tool pprof allocs.prof
(pprof) web  # Opens flame graph in browser
```

### Goroutine Leak Detection

```bash
# Capture goroutine profile at two points in time
curl -o goroutines_t1.txt "https://myapp:6060/debug/pprof/goroutine?debug=1"
sleep 60
curl -o goroutines_t2.txt "https://myapp:6060/debug/pprof/goroutine?debug=1"

# Compare goroutine counts
grep "^goroutine" goroutines_t1.txt | wc -l
grep "^goroutine" goroutines_t2.txt | wc -l

# If count is growing, look for the top goroutine states
grep -A 3 "goroutine [0-9]" goroutines_t2.txt | sort | uniq -c | sort -rn | head -20
```

## Summary

Continuous profiling in Go production environments requires careful attention to:

1. **Sampling rate**: 100Hz (the default) adds ~1-3% CPU overhead and is suitable for most production services
2. **Memory profiling rate**: Leave at default (512KB). Setting to 1 is for debugging only
3. **Block/mutex profiling**: Disable unless actively investigating — they add significant overhead
4. **pprof labels**: Use to slice profiles by request type, user tier, or feature — eliminates the need for separate profiles per cohort
5. **Push vs pull**: Use push for batch jobs and NAT-restricted environments; pull for Kubernetes services following the Prometheus pattern
6. **Security**: Never expose the pprof debug port publicly — bind to loopback or use a separate internal port

The Pyroscope platform unifies these profiles over time, enabling post-hoc analysis of performance events that occurred days or weeks ago — turning profiling from a reactive debugging tool into a proactive observability signal.
