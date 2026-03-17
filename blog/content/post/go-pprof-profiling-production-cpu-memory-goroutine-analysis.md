---
title: "Go pprof Profiling in Production: CPU, Memory, and Goroutine Analysis"
date: 2030-05-15T00:00:00-05:00
draft: false
tags: ["Go", "pprof", "Performance", "Profiling", "Pyroscope", "Memory Leaks", "Flame Graphs"]
categories:
- Go
- Performance
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to using pprof for profiling Go applications in production: continuous profiling, flame graphs, memory leak detection, goroutine analysis, and integration with Pyroscope."
more_link: "yes"
url: "/go-pprof-profiling-production-cpu-memory-goroutine-analysis/"
---

Production Go services frequently exhibit performance characteristics that are impossible to reproduce in development environments. Real traffic patterns, concurrent workloads, and long-running memory allocation behaviors only manifest under genuine load. Integrating pprof-based profiling directly into production binaries—and connecting those profiles to continuous profiling infrastructure—transforms performance analysis from an occasional fire-fighting exercise into a continuous engineering discipline.

<!--more-->

## The pprof Ecosystem

Go ships with two profiling packages: `runtime/pprof` for programmatic profile capture and `net/http/pprof` for HTTP-based endpoint exposure. Both produce profiles in the pprof protobuf format, which tools including `go tool pprof`, Speedscope, Grafana, and Pyroscope consume.

Profile types available in Go:

| Profile | Description |
|---------|-------------|
| `cpu` | Sampled CPU usage across goroutines (default 100 Hz) |
| `heap` | Allocation statistics for live and all-time objects |
| `goroutine` | Stack traces for all current goroutines |
| `threadcreate` | Stack traces leading to OS thread creation |
| `block` | Goroutine blocking events (mutex waits, channel operations) |
| `mutex` | Contended mutex hold times |
| `allocs` | Cumulative allocation profile (includes freed objects) |

## Enabling pprof Endpoints Safely

### Isolated Metrics Server Pattern

Never expose pprof endpoints on the public-facing HTTP port. Use a dedicated internal port protected by network policy.

```go
// internal/debug/server.go
package debug

import (
	"context"
	"fmt"
	"net/http"
	_ "net/http/pprof" // registers /debug/pprof handlers on DefaultServeMux
	"time"

	"go.uber.org/zap"
)

// Server exposes pprof endpoints on an internal-only port.
type Server struct {
	logger     *zap.Logger
	httpServer *http.Server
}

// NewServer creates a debug server bound to addr (e.g., "127.0.0.1:6060").
func NewServer(addr string, logger *zap.Logger) *Server {
	mux := http.NewServeMux()

	// Register pprof handlers explicitly rather than relying on DefaultServeMux
	// to avoid side effects if DefaultServeMux is used elsewhere.
	mux.HandleFunc("/debug/pprof/", http.DefaultServeMux.ServeHTTP)

	return &Server{
		logger: logger,
		httpServer: &http.Server{
			Addr:              addr,
			Handler:           mux,
			ReadTimeout:       30 * time.Second,
			WriteTimeout:      120 * time.Second, // CPU profiles can take up to 30s
			ReadHeaderTimeout: 5 * time.Second,
		},
	}
}

// Start begins serving debug endpoints.
func (s *Server) Start() error {
	s.logger.Info("starting debug server", zap.String("addr", s.httpServer.Addr))
	if err := s.httpServer.ListenAndServe(); err != http.ErrServerClosed {
		return fmt.Errorf("debug server: %w", err)
	}
	return nil
}

// Shutdown gracefully stops the debug server.
func (s *Server) Shutdown(ctx context.Context) error {
	return s.httpServer.Shutdown(ctx)
}
```

```go
// cmd/api-server/main.go
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"go.uber.org/zap"

	"github.com/example/api-server/internal/debug"
	"github.com/example/api-server/internal/server"
)

func main() {
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	debugServer := debug.NewServer("127.0.0.1:6060", logger)
	go func() {
		if err := debugServer.Start(); err != nil {
			logger.Error("debug server failed", zap.Error(err))
		}
	}()

	appServer := server.New(logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := appServer.Run(ctx); err != nil {
		logger.Fatal("server failed", zap.Error(err))
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = debugServer.Shutdown(shutdownCtx)
}
```

### Network Policy for Debug Port Isolation

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-debug-from-monitoring
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api-server
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
        - podSelector:
            matchLabels:
              app: pyroscope
      ports:
        - protocol: TCP
          port: 6060
```

## CPU Profiling

### Capturing CPU Profiles

```bash
# Capture a 30-second CPU profile
kubectl exec -n production pod/api-server-6b8d94f5c-xk7p2 -- \
  curl -s http://127.0.0.1:6060/debug/pprof/profile?seconds=30 \
  -o /tmp/cpu.prof

# Copy the profile locally
kubectl cp production/api-server-6b8d94f5c-xk7p2:/tmp/cpu.prof /tmp/cpu.prof

# Open interactive analysis
go tool pprof /tmp/cpu.prof
```

### pprof Interactive Commands

```
(pprof) top15
Showing nodes accounting for 42.31s, 89.42% of 47.32s total
      flat  flat%   sum%        cum   cum%
    15.23s 32.18% 32.18%     15.23s 32.18%  runtime.mallocgc
     8.44s 17.84% 50.02%      8.44s 17.84%  syscall.syscall
     4.12s  8.71% 58.73%      4.12s  8.71%  runtime.gcBgMarkWorker
     3.88s  8.20% 66.93%     21.50s 45.44%  encoding/json.Marshal
     2.91s  6.15% 73.08%      2.91s  6.15%  compress/gzip.(*compressor).deflate

# Show allocation-heavy call trees
(pprof) top -cum 15

# Focus on a specific function
(pprof) list encoding/json.Marshal

# Generate an SVG flame graph
(pprof) web

# Generate a directed graph of top consumers
(pprof) png > /tmp/cpu-graph.png
```

### Generating Flame Graphs

```bash
# Generate an interactive flame graph SVG
go tool pprof -http=:8080 /tmp/cpu.prof

# Use the Flame Graph view at http://localhost:8080/ui/flamegraph

# Alternatively generate a static flame graph with flamegraph.pl
go tool pprof -raw /tmp/cpu.prof \
  | ~/FlameGraph/stackcollapse-go.pl \
  | ~/FlameGraph/flamegraph.pl \
  > /tmp/cpu-flame.svg
```

### Identifying Hot Paths Programmatically

```go
// tools/profile-analyzer/main.go
package main

import (
	"fmt"
	"log"
	"os"
	"sort"

	"github.com/google/pprof/profile"
)

func main() {
	f, err := os.Open(os.Args[1])
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()

	p, err := profile.Parse(f)
	if err != nil {
		log.Fatal(err)
	}

	// Aggregate flat CPU time by function.
	flat := make(map[string]int64)
	for _, sample := range p.Sample {
		if len(sample.Location) == 0 {
			continue
		}
		topFrame := sample.Location[0]
		for _, line := range topFrame.Line {
			name := line.Function.Name
			flat[name] += sample.Value[0]
		}
	}

	type entry struct {
		name  string
		value int64
	}
	entries := make([]entry, 0, len(flat))
	for k, v := range flat {
		entries = append(entries, entry{k, v})
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].value > entries[j].value
	})

	total := p.DurationNanos
	fmt.Printf("%-60s %10s %8s\n", "Function", "Samples(ns)", "Percent")
	for _, e := range entries[:min(20, len(entries))] {
		pct := float64(e.value) / float64(total) * 100
		fmt.Printf("%-60s %10d %7.2f%%\n", e.name, e.value, pct)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
```

## Memory Profiling and Leak Detection

### Heap Profile Analysis

```bash
# Capture current heap allocations
kubectl exec -n production pod/api-server-6b8d94f5c-xk7p2 -- \
  curl -s http://127.0.0.1:6060/debug/pprof/heap \
  -o /tmp/heap.prof

go tool pprof /tmp/heap.prof
```

```
(pprof) top15 -inuse_space
Showing nodes accounting for 1.24GB, 91.23% of 1.36GB total
      flat  flat%   sum%        cum   cum%
  512.00MB 37.65% 37.65%   512.00MB 37.65%  bytes.makeSlice
  256.00MB 18.82% 56.47%   768.00MB 56.47%  net/http.(*response).ReadFrom
  128.00MB  9.41% 65.88%   128.00MB  9.41%  encoding/json.(*encodeState).marshal

# Compare two heap profiles to find growth
go tool pprof -base /tmp/heap-before.prof /tmp/heap-after.prof
```

### Detecting Memory Leaks with Consecutive Snapshots

```go
// tools/memleak/main.go
package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/google/pprof/profile"
)

// SnapshotHeap fetches a heap profile from a running service.
func SnapshotHeap(addr string) (*profile.Profile, error) {
	resp, err := http.Get(fmt.Sprintf("http://%s/debug/pprof/heap", addr))
	if err != nil {
		return nil, fmt.Errorf("fetching heap profile: %w", err)
	}
	defer resp.Body.Close()

	return profile.Parse(resp.Body)
}

// CompareAllocations returns functions whose inuse_space grew between snapshots.
func CompareAllocations(before, after *profile.Profile) map[string]int64 {
	flatBefore := flatInuseSpace(before)
	flatAfter := flatInuseSpace(after)

	growth := make(map[string]int64)
	for fn, afterBytes := range flatAfter {
		beforeBytes := flatBefore[fn]
		if delta := afterBytes - beforeBytes; delta > 0 {
			growth[fn] = delta
		}
	}
	return growth
}

func flatInuseSpace(p *profile.Profile) map[string]int64 {
	result := make(map[string]int64)
	inuseSpaceIdx := -1
	for i, st := range p.SampleType {
		if st.Type == "inuse_space" {
			inuseSpaceIdx = i
			break
		}
	}
	if inuseSpaceIdx < 0 {
		return result
	}
	for _, sample := range p.Sample {
		if len(sample.Location) == 0 {
			continue
		}
		for _, line := range sample.Location[0].Line {
			result[line.Function.Name] += sample.Value[inuseSpaceIdx]
		}
	}
	return result
}

func main() {
	addr := os.Args[1] // e.g., "127.0.0.1:6060"

	fmt.Println("Taking baseline snapshot...")
	before, err := SnapshotHeap(addr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Waiting 60 seconds for workload to generate allocations...")
	time.Sleep(60 * time.Second)

	fmt.Println("Taking comparison snapshot...")
	after, err := SnapshotHeap(addr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	growth := CompareAllocations(before, after)
	fmt.Printf("\nTop allocation growth (inuse_space):\n")
	for fn, bytes := range growth {
		if bytes > 1<<20 { // only report > 1 MiB growth
			fmt.Printf("  %-70s %8.2f MiB\n", fn, float64(bytes)/(1<<20))
		}
	}
}
```

### Common Memory Leak Patterns

```go
// Example: goroutine leak via channel that is never closed
func leakyHandler(w http.ResponseWriter, r *http.Request) {
	results := make(chan Result) // LEAK: no one closes this channel

	go func() {
		results <- processRequest(r) // goroutine blocks forever if no receiver
	}()

	// If the request is cancelled, this select may return early via ctx.Done(),
	// leaving the goroutine above blocked on the channel send indefinitely.
	select {
	case result := <-results:
		json.NewEncoder(w).Encode(result)
	case <-r.Context().Done():
		http.Error(w, "cancelled", http.StatusRequestTimeout)
	}
}

// Fixed version: use a buffered channel so the goroutine never blocks
func fixedHandler(w http.ResponseWriter, r *http.Request) {
	results := make(chan Result, 1) // buffered: goroutine can always send

	go func() {
		results <- processRequest(r)
	}()

	select {
	case result := <-results:
		json.NewEncoder(w).Encode(result)
	case <-r.Context().Done():
		http.Error(w, "cancelled", http.StatusRequestTimeout)
	}
}
```

```go
// Example: cache that grows without eviction
type InMemoryCache struct {
	mu    sync.RWMutex
	items map[string]CacheItem // LEAK: items are added but never removed
}

// Fixed version: use an LRU cache with a capacity bound
import lru "github.com/hashicorp/golang-lru/v2"

type BoundedCache struct {
	cache *lru.Cache[string, CacheItem]
}

func NewBoundedCache(maxSize int) (*BoundedCache, error) {
	c, err := lru.New[string, CacheItem](maxSize)
	if err != nil {
		return nil, err
	}
	return &BoundedCache{cache: c}, nil
}
```

## Goroutine Profiling

### Capturing and Analyzing Goroutine Profiles

```bash
# Capture goroutine stack traces (debug=2 provides full stacks)
kubectl exec -n production pod/api-server-6b8d94f5c-xk7p2 -- \
  curl -s "http://127.0.0.1:6060/debug/pprof/goroutine?debug=2" \
  -o /tmp/goroutines.txt

# Quick count by state
grep -c "^goroutine" /tmp/goroutines.txt

# Group goroutines by their top frame
go tool pprof /tmp/goroutines.prof
(pprof) top
```

### Goroutine Leak Detector Integration

```go
// internal/testing/goroutine_leak_checker.go
package testing

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

// GoroutineSnapshot captures current goroutine count for comparison.
type GoroutineSnapshot struct {
	count int
}

// TakeSnapshot records the current number of goroutines.
func TakeSnapshot() GoroutineSnapshot {
	return GoroutineSnapshot{count: runtime.NumGoroutine()}
}

// CheckForLeaks fails the test if goroutines increased by more than tolerance.
func CheckForLeaks(t *testing.T, before GoroutineSnapshot, tolerance int) {
	t.Helper()

	// Give goroutines time to finish.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		current := runtime.NumGoroutine()
		if current <= before.count+tolerance {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}

	current := runtime.NumGoroutine()
	if current > before.count+tolerance {
		buf := make([]byte, 1<<20)
		n := runtime.Stack(buf, true)
		t.Errorf("goroutine leak: started=%d, ended=%d (tolerance=%d)\n%s",
			before.count, current, tolerance, buf[:n])
	}
}

// Usage in tests:
func TestMyHandler(t *testing.T) {
	snap := TakeSnapshot()
	defer CheckForLeaks(t, snap, 0)

	// ... run test ...
}
```

## Block and Mutex Profiling

### Enabling Block and Mutex Profiling

Block and mutex profiling are disabled by default due to their runtime overhead. Enable them only when investigating contention issues.

```go
// cmd/api-server/main.go
import "runtime"

func init() {
	// Enable block profiling: reports on goroutine blocking events.
	// Rate of 1 = report every blocking event; higher values reduce overhead.
	runtime.SetBlockProfileRate(1)

	// Enable mutex profiling: reports on mutex contention.
	// Fraction of 1 = report every mutex event.
	runtime.SetMutexProfileFraction(1)
}
```

```bash
# Capture mutex contention profile
curl -s http://127.0.0.1:6060/debug/pprof/mutex > /tmp/mutex.prof
go tool pprof /tmp/mutex.prof

(pprof) top
Showing nodes accounting for 23.89s, 94.12% of 25.38s total
     flat  flat%   sum%        cum   cum%
   18.44s 72.66% 72.66%     18.44s 72.66%  sync.(*Mutex).Unlock
    5.45s 21.47% 94.13%      5.45s 21.47%  sync.(*RWMutex).RUnlock
```

### High-Contention Mutex Pattern

```go
// BEFORE: single global lock causing contention
type MetricsRegistry struct {
	mu      sync.Mutex
	metrics map[string]*Counter
}

func (r *MetricsRegistry) Increment(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.metrics[key].value++
}

// AFTER: sharded locks to reduce contention
const numShards = 64

type ShardedRegistry struct {
	shards [numShards]struct {
		sync.Mutex
		metrics map[string]*Counter
	}
}

func (r *ShardedRegistry) Increment(key string) {
	h := fnv32(key) % numShards
	r.shards[h].Lock()
	defer r.shards[h].Unlock()
	r.shards[h].metrics[key].value++
}

func fnv32(key string) uint32 {
	h := uint32(2166136261)
	for _, b := range []byte(key) {
		h ^= uint32(b)
		h *= 16777619
	}
	return h
}
```

## Continuous Profiling with Pyroscope

Pyroscope provides always-on profiling that captures profiles at regular intervals and stores them with time-series indexing, enabling correlation with incidents and deployments.

### Pyroscope Go SDK Integration

```go
// internal/profiling/pyroscope.go
package profiling

import (
	"fmt"
	"os"

	"github.com/grafana/pyroscope-go"
)

// Config holds the Pyroscope profiler configuration.
type Config struct {
	ServerAddr  string
	AppName     string
	Environment string
	Version     string
	ProfileTypes []pyroscope.ProfileType
}

// Start initializes the Pyroscope continuous profiler.
func Start(cfg Config) (*pyroscope.Profiler, error) {
	hostname, _ := os.Hostname()

	types := cfg.ProfileTypes
	if len(types) == 0 {
		types = []pyroscope.ProfileType{
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
		}
	}

	profiler, err := pyroscope.Start(pyroscope.Config{
		ApplicationName: cfg.AppName,
		ServerAddress:   cfg.ServerAddr,
		Tags: map[string]string{
			"env":      cfg.Environment,
			"version":  cfg.Version,
			"hostname": hostname,
		},
		ProfileTypes: types,
		Logger:       pyroscope.StandardLogger,
	})
	if err != nil {
		return nil, fmt.Errorf("starting pyroscope profiler: %w", err)
	}

	return profiler, nil
}
```

```go
// cmd/api-server/main.go
import "github.com/example/api-server/internal/profiling"

func main() {
	if os.Getenv("PYROSCOPE_ENABLED") == "true" {
		profiler, err := profiling.Start(profiling.Config{
			ServerAddr:  os.Getenv("PYROSCOPE_SERVER_ADDR"),
			AppName:     "api-server",
			Environment: os.Getenv("ENVIRONMENT"),
			Version:     os.Getenv("APP_VERSION"),
		})
		if err != nil {
			logger.Warn("pyroscope profiler failed to start", zap.Error(err))
		} else {
			defer profiler.Stop()
		}
	}
	// ... rest of main
}
```

### Pyroscope Deployment on Kubernetes

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
            - -config.file=/etc/pyroscope/config.yaml
          ports:
            - containerPort: 4040
              name: http
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 2000m
              memory: 4Gi
          volumeMounts:
            - name: config
              mountPath: /etc/pyroscope
            - name: data
              mountPath: /var/lib/pyroscope
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
        dir: /var/lib/pyroscope
    limits:
      max_query_lookback: 168h  # 7 days
      ingestion_rate_mb: 100
    compactor:
      compaction_window: 1h
```

## Benchmark-Driven Profiling

### Profiling Benchmarks Directly

```go
// internal/parser/parser_test.go
package parser_test

import (
	"os"
	"testing"

	"github.com/example/api-server/internal/parser"
)

func BenchmarkParseRequest(b *testing.B) {
	input := []byte(`{"id":"req-001","method":"GET","path":"/api/v2/users","headers":{"Authorization":"Bearer token"}}`)

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		_, err := parser.ParseRequest(input)
		if err != nil {
			b.Fatal(err)
		}
	}
}

// Run with profiling:
// go test -bench=BenchmarkParseRequest -cpuprofile=cpu.prof -memprofile=mem.prof ./internal/parser/
// go tool pprof cpu.prof
```

### Continuous Benchmark Tracking

```bash
#!/bin/bash
# scripts/benchmark-profile.sh
# Run benchmarks and capture profiles for comparison against baseline.

set -euo pipefail

BENCH_NAME="${1:-BenchmarkParseRequest}"
PKG="${2:-./internal/parser/}"
OUTPUT_DIR="profiles/$(date +%Y%m%d-%H%M%S)"

mkdir -p "${OUTPUT_DIR}"

go test -bench="${BENCH_NAME}" \
  -benchmem \
  -count=5 \
  -benchtime=10s \
  -cpuprofile="${OUTPUT_DIR}/cpu.prof" \
  -memprofile="${OUTPUT_DIR}/mem.prof" \
  -blockprofile="${OUTPUT_DIR}/block.prof" \
  -mutexprofile="${OUTPUT_DIR}/mutex.prof" \
  "${PKG}" | tee "${OUTPUT_DIR}/results.txt"

echo "Profiles saved to ${OUTPUT_DIR}"
echo ""
echo "Top CPU consumers:"
go tool pprof -top "${OUTPUT_DIR}/cpu.prof" | head -20

echo ""
echo "Top memory allocators:"
go tool pprof -top -alloc_space "${OUTPUT_DIR}/mem.prof" | head -20
```

## Interpreting Profile Data

### Understanding Flat vs. Cumulative Time

- **flat**: CPU time spent directly in the function (not in callees)
- **cum**: CPU time spent in the function and all functions it calls

A function with high `cum` but low `flat` is an orchestrator calling expensive children. Optimize the children. A function with high `flat` is doing expensive work itself and is the direct optimization target.

### Memory Profile Units

```
(pprof) top -inuse_space     # live memory currently held
(pprof) top -inuse_objects   # count of live objects
(pprof) top -alloc_space     # total bytes ever allocated (includes freed)
(pprof) top -alloc_objects   # total object count ever allocated
```

High `alloc_space` relative to `inuse_space` indicates churn—objects are being allocated and freed frequently, which stresses the GC. Reducing allocation churn often produces larger performance improvements than optimizing CPU-bound code.

### GC Pressure Indicators

```bash
# Enable GC trace output
GODEBUG=gctrace=1 ./api-server 2>&1 | head -20

# Output format:
# gc 42 @18.232s 4%: 0.23+12+1.2 ms clock, 1.8+3.2/24.1/4.8+9.7 ms cpu,
#    42->45->22 MB, 45 MB goal, 0 MB stacks, 1 MB globals, 8 P
#
# Fields:
#   gc 42         - GC cycle number
#   @18.232s      - time since program start
#   4%            - percentage of time spent in GC
#   0.23+12+1.2   - wall clock stop-the-world times (ms)
#   42->45->22 MB - heap before GC -> after GC -> live objects
```

### GOGC and Memory Limits Tuning

```go
import "runtime/debug"

func init() {
	// Set GOGC to 200: GC triggers when heap is 200% of live data size.
	// Default is 100. Higher values reduce GC frequency at the cost of more memory.
	debug.SetGCPercent(200)

	// Set a hard memory limit (Go 1.19+).
	// The runtime will GC more aggressively to stay under this limit.
	debug.SetMemoryLimit(512 * 1024 * 1024) // 512 MiB
}
```

## Production Profiling Workflow

### Profiling During Incidents

```bash
#!/bin/bash
# scripts/capture-profiles.sh
# Capture a complete set of profiles from a production pod for incident analysis.

POD="${1:?usage: capture-profiles.sh <pod-name> [namespace]}"
NS="${2:-production}"
DEBUG_PORT="6060"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT_DIR="./incident-profiles/${TIMESTAMP}-${POD}"

mkdir -p "${OUTPUT_DIR}"

echo "Capturing profiles from ${NS}/${POD}..."

# Forward the debug port
kubectl port-forward -n "${NS}" "pod/${POD}" "${DEBUG_PORT}:${DEBUG_PORT}" &
PF_PID=$!
sleep 2

trap "kill ${PF_PID} 2>/dev/null" EXIT

# CPU profile (30 seconds)
echo "CPU profile (30s)..."
curl -sf "http://127.0.0.1:${DEBUG_PORT}/debug/pprof/profile?seconds=30" \
  -o "${OUTPUT_DIR}/cpu.prof"

# Heap profile
echo "Heap profile..."
curl -sf "http://127.0.0.1:${DEBUG_PORT}/debug/pprof/heap" \
  -o "${OUTPUT_DIR}/heap.prof"

# Goroutine profile
echo "Goroutine profile..."
curl -sf "http://127.0.0.1:${DEBUG_PORT}/debug/pprof/goroutine?debug=2" \
  -o "${OUTPUT_DIR}/goroutines.txt"

# Block profile
echo "Block profile..."
curl -sf "http://127.0.0.1:${DEBUG_PORT}/debug/pprof/block" \
  -o "${OUTPUT_DIR}/block.prof"

# Mutex profile
echo "Mutex profile..."
curl -sf "http://127.0.0.1:${DEBUG_PORT}/debug/pprof/mutex" \
  -o "${OUTPUT_DIR}/mutex.prof"

# Allocs profile
echo "Allocs profile..."
curl -sf "http://127.0.0.1:${DEBUG_PORT}/debug/pprof/allocs" \
  -o "${OUTPUT_DIR}/allocs.prof"

# Runtime metrics
echo "Runtime metrics..."
curl -sf "http://127.0.0.1:${DEBUG_PORT}/debug/pprof/cmdline" \
  -o "${OUTPUT_DIR}/cmdline.txt"

echo ""
echo "Profiles saved to ${OUTPUT_DIR}"
echo ""
echo "Quick analysis:"
echo "  CPU top: go tool pprof -top ${OUTPUT_DIR}/cpu.prof"
echo "  Memory:  go tool pprof -top -inuse_space ${OUTPUT_DIR}/heap.prof"
echo "  Web UI:  go tool pprof -http=:8080 ${OUTPUT_DIR}/cpu.prof"
```

### Automating Profile Regression Detection

```bash
#!/bin/bash
# CI check: compare benchmark allocations against main branch baseline.
# Fails if any benchmark shows > 10% regression in alloc_bytes/op.

go test -bench=. -benchmem -count=5 ./... \
  | tee current-bench.txt

benchstat baseline-bench.txt current-bench.txt \
  | awk '/alloc_bytes\/op/ && /\+[0-9]/ {
    if ($NF+0 > 10.0) {
      print "REGRESSION:", $0
      exit_code=1
    }
  } END { exit exit_code }'
```

Combining pprof with continuous profiling via Pyroscope provides both the deep analysis capabilities needed for incident response and the longitudinal visibility required to catch gradual performance degradation before it affects users.
