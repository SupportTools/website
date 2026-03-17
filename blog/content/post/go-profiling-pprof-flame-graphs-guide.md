---
title: "Go Profiling Deep Dive: pprof HTTP Endpoints, Flame Graphs, Allocation Profiles, and Mutex Contention"
date: 2028-07-28T00:00:00-05:00
draft: false
tags: ["Go", "Profiling", "pprof", "Performance", "Flame Graphs", "Optimization"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to Go performance profiling using pprof: CPU profiles, memory allocation analysis, goroutine traces, mutex contention identification, and interpreting flame graphs to find and fix real bottlenecks."
more_link: "yes"
url: "/go-profiling-pprof-flame-graphs-guide/"
---

Performance problems in Go services are often invisible until they cause production incidents. A service that handles 10,000 requests per second in testing may crawl at 1,000 RPS under real traffic because of an unexpected allocation hotspot, a contended mutex, or a goroutine leak that only manifests at scale. Go's built-in profiling tools — pprof, runtime/trace, and the execution tracer — are the most powerful diagnostic tools available, but few engineers know how to use them beyond the basics.

This guide covers the full profiling workflow: exposing pprof endpoints, capturing CPU and memory profiles, analyzing allocation patterns, identifying mutex contention and goroutine leaks, generating flame graphs, and translating profile data into concrete code changes.

<!--more-->

# Go Profiling Deep Dive: From pprof to Production Optimization

## The Go Profiling Toolkit

Go ships with several profiling subsystems:

- **CPU profiler**: Samples the call stack at 100Hz (configurable) to find where CPU time is spent
- **Memory profiler**: Samples heap allocations to find allocation hotspots
- **Goroutine profiler**: Shows all live goroutines and their stack traces
- **Mutex profiler**: Tracks time spent waiting on mutexes
- **Block profiler**: Tracks time spent blocked on synchronization primitives
- **Execution tracer**: Records a detailed timeline of all runtime events

## Section 1: Exposing pprof Endpoints

### HTTP Server Integration

The simplest way to expose pprof is to import the `net/http/pprof` package, which automatically registers handlers on `DefaultServeMux`:

```go
// Simplest approach — register on DefaultServeMux.
import _ "net/http/pprof"

// This registers endpoints at /debug/pprof/ on the default mux.
```

However, in production you typically want to expose pprof on a separate port (not the public-facing port) and require authentication:

```go
// cmd/server/main.go
package main

import (
	"net/http"
	"net/http/pprof"
	"os"
	"time"
)

// registerPProfHandlers registers pprof handlers on the given mux.
// Returns a server that MUST be started in a goroutine.
func newPProfServer(addr string) *http.Server {
	mux := http.NewServeMux()

	// Register pprof handlers manually (avoids polluting DefaultServeMux).
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)

	// Require a shared secret to access pprof endpoints.
	handler := requireSecret(mux, os.Getenv("PPROF_SECRET"))

	return &http.Server{
		Addr:         addr,
		Handler:      handler,
		ReadTimeout:  65 * time.Second, // Longer than max profile duration.
		WriteTimeout: 65 * time.Second,
	}
}

// requireSecret wraps a handler with basic secret validation.
func requireSecret(next http.Handler, secret string) http.Handler {
	if secret == "" {
		return next // No protection in dev.
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Pprof-Secret") != secret {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	// Start pprof server on a private port.
	pprofServer := newPProfServer(":6060")
	go func() {
		if err := pprofServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			panic(err)
		}
	}()

	// Main application server...
	http.ListenAndServe(":8080", nil)
}
```

### Enabling Mutex and Block Profiling

The mutex and block profilers are disabled by default because they have a measurable overhead. Enable them in the application's startup code or via an HTTP endpoint:

```go
import "runtime"

func init() {
	// Report 100% of mutex contention events.
	runtime.SetMutexProfileFraction(1)

	// Report 100% of blocking events.
	runtime.SetBlockProfileRate(1)
}

// In production, you may want to enable these only temporarily.
// Provide an HTTP endpoint to toggle them:
func (s *Server) HandleMutexProfile(w http.ResponseWriter, r *http.Request) {
	rate, _ := strconv.Atoi(r.URL.Query().Get("rate"))
	old := runtime.SetMutexProfileFraction(rate)
	fmt.Fprintf(w, "mutex profile rate changed from %d to %d\n", old, rate)
}
```

## Section 2: Capturing Profiles

### CPU Profile

```bash
# Capture a 30-second CPU profile.
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# Save to file for later analysis.
curl -s "http://localhost:6060/debug/pprof/profile?seconds=30" \
  > cpu.prof

# Analyze the saved profile.
go tool pprof cpu.prof
```

### Memory Profile

```bash
# Capture a heap profile.
curl -s "http://localhost:6060/debug/pprof/heap" > heap.prof

# Capture an allocation profile (cumulative, not just live objects).
curl -s "http://localhost:6060/debug/pprof/allocs" > allocs.prof

# Compare two heap profiles to find memory growth.
go tool pprof -diff_base heap_before.prof heap_after.prof
```

### Goroutine Profile

```bash
# Capture goroutine stack traces.
curl -s "http://localhost:6060/debug/pprof/goroutine" > goroutine.prof

# View with stack trace debug level (shows all goroutines).
curl -s "http://localhost:6060/debug/pprof/goroutine?debug=2" | head -200
```

### Execution Trace

```bash
# Capture a 5-second execution trace.
curl -s "http://localhost:6060/debug/pprof/trace?seconds=5" > trace.out

# Analyze in the browser.
go tool trace trace.out
```

## Section 3: CPU Profile Analysis

### Interactive pprof Session

```bash
go tool pprof cpu.prof
```

Key pprof commands:

```
(pprof) top10
# Shows the 10 functions with the most CPU time.
# "flat" is time spent directly in the function.
# "cum" is time spent in the function and all its callees.

Showing nodes accounting for 4.52s, 67.26% of 6.72s total
      flat  flat%   sum%        cum   cum%
     1.45s 21.58% 21.58%      2.12s 31.55%  encoding/json.(*encodeState).marshal
     0.85s 12.65% 34.23%      1.20s 17.86%  runtime.mallocgc
     0.45s 6.70% 40.92%      0.45s  6.70%  runtime.memclrNoHeapPointers
     0.38s 5.65% 46.58%      0.55s  8.19%  encoding/json.marshallerEncoder

(pprof) list encoding/json.marshallerEncoder
# Shows annotated source code for the function.

(pprof) web
# Opens an interactive call graph in the browser.
# Requires graphviz: apt-get install graphviz

(pprof) weblist encoding/json.marshal
# Opens the source with profile annotations in the browser.

(pprof) tree
# Shows the full call tree.

(pprof) focus=encoding/json
# Filter to only show nodes related to encoding/json.

(pprof) ignore=runtime
# Exclude runtime functions from the display.
```

## Section 4: Flame Graphs

Flame graphs are the most effective visualization for CPU profiles. The width of each bar represents the proportion of total time spent in that function (and its callees). The depth represents the call stack.

### Generating Flame Graphs with pprof

```bash
# The -http flag opens pprof's built-in web UI including flame graphs.
go tool pprof -http=:8090 cpu.prof

# Navigate to /ui/flamegraph in the browser.
# http://localhost:8090/ui/flamegraph
```

### Generating with go-torch (for Older Workflows)

```bash
# Install go-torch.
go install github.com/uber/go-torch@latest

# Generate a flame graph from a running server.
go-torch -u http://localhost:6060 -t 30 -f cpu-flamegraph.svg

# Open the SVG in a browser.
open cpu-flamegraph.svg
```

### Reading a Flame Graph

When analyzing a flame graph:

1. **Wide boxes at the top** indicate functions that consume significant CPU directly
2. **Wide boxes in the middle of a tall stack** indicate that many code paths pass through this function
3. **Plateaus** (flat tops with a single wide box above) indicate leaf functions where CPU time is actually consumed
4. **Look for unexpected patterns**: JSON marshaling in a hot path, fmt.Sprintf in a tight loop, or reflect calls where none are expected

### Differential Flame Graphs

Differential flame graphs compare two profiles and show where performance changed:

```bash
# Capture a baseline profile.
curl -s "http://localhost:6060/debug/pprof/profile?seconds=30" > base.prof

# Make a code change and deploy, then capture another profile.
curl -s "http://localhost:6060/debug/pprof/profile?seconds=30" > after.prof

# Generate a differential profile.
go tool pprof -diff_base base.prof after.prof
# Functions shown in red have increased CPU usage.
# Functions shown in green have decreased CPU usage.
```

## Section 5: Memory Allocation Analysis

Memory pressure is one of the most common causes of latency spikes in Go services. The GC pauses, combined with constant allocation pressure, can cause P99 latency to spike even when average latency looks fine.

### Heap vs Allocation Profile

- `heap` profile: Shows currently live objects (what is holding memory right now)
- `allocs` profile: Shows cumulative allocations since the process started (where allocations happen)

```bash
# Analyze allocation hotspots.
go tool pprof -alloc_objects allocs.prof

(pprof) top10
# Shows functions allocating the most objects.

(pprof) top10 -cum
# Shows functions responsible for the most cumulative allocations.

# Focus on allocation space rather than count.
go tool pprof -alloc_space allocs.prof
(pprof) top10
# Shows functions allocating the most bytes.
```

### Finding Escape Analysis Issues

When a variable "escapes" to the heap, it increases GC pressure. Go's compiler can explain why variables escape:

```bash
# Show compiler escape analysis decisions.
go build -gcflags='-m=2' ./... 2>&1 | grep -E "escapes|does not escape"

# Example output:
# ./handler.go:45:12: &RequestLog{...} escapes to heap
# ./parser.go:88:20: arg escapes to heap
# ./cache.go:112:9: moved to heap: entry
```

### Profiling a Memory-Intensive Function

```go
// Example: before optimization — allocates a new slice on every call.
func processEvents(events []Event) []string {
	result := make([]string, 0, len(events)) // allocation
	for _, e := range events {
		result = append(result, fmt.Sprintf("%s:%d", e.Type, e.ID)) // allocations
	}
	return result
}

// After optimization — reuses a buffer, avoids fmt.Sprintf allocation.
var processBuf strings.Builder

func processEventsOptimized(events []Event, out []string) []string {
	if out == nil {
		out = make([]string, 0, len(events))
	} else {
		out = out[:0] // Reuse the existing backing array.
	}
	for _, e := range events {
		processBuf.Reset()
		processBuf.WriteString(e.Type)
		processBuf.WriteByte(':')
		processBuf.WriteString(strconv.FormatInt(int64(e.ID), 10))
		out = append(out, processBuf.String())
	}
	return out
}
```

### Benchmarking Allocations

```go
// Always benchmark with -benchmem to see allocation counts.
func BenchmarkProcessEvents(b *testing.B) {
	events := generateTestEvents(1000)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		processEvents(events)
	}
}

func BenchmarkProcessEventsOptimized(b *testing.B) {
	events := generateTestEvents(1000)
	out := make([]string, 0, len(events))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		out = processEventsOptimized(events, out)
	}
}
```

```bash
go test -bench=BenchmarkProcess -benchmem -count=5 ./...

# Expected output:
# BenchmarkProcessEvents-8          100000    12543 ns/op    8192 B/op    1001 allocs/op
# BenchmarkProcessEventsOptimized-8 500000     2841 ns/op     512 B/op       2 allocs/op
```

## Section 6: Mutex Contention Analysis

Mutex contention is a common source of latency in high-concurrency services. The mutex profiler shows where goroutines are waiting for locks.

```bash
# Capture a mutex profile.
curl -s "http://localhost:6060/debug/pprof/mutex" > mutex.prof

go tool pprof mutex.prof
(pprof) top10
# Shows the mutexes with the most contention.
# "flat" = time held, "cum" = time waiting for the mutex.
```

### Finding and Fixing Mutex Contention

```go
// Problem: single global mutex protecting a map.
type Cache struct {
	mu    sync.Mutex
	items map[string][]byte
}

func (c *Cache) Get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.items[key]
	return v, ok
}

func (c *Cache) Set(key string, value []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items[key] = value
}

// Fix 1: Use sync.RWMutex for read-heavy workloads.
type CacheRW struct {
	mu    sync.RWMutex
	items map[string][]byte
}

func (c *CacheRW) Get(key string) ([]byte, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	v, ok := c.items[key]
	return v, ok
}

// Fix 2: Shard the cache to reduce contention.
const numShards = 256

type ShardedCache struct {
	shards [numShards]struct {
		mu    sync.RWMutex
		items map[string][]byte
	}
}

func (c *ShardedCache) shard(key string) int {
	h := fnv.New32a()
	h.Write([]byte(key))
	return int(h.Sum32()) % numShards
}

func (c *ShardedCache) Get(key string) ([]byte, bool) {
	s := c.shard(key)
	c.shards[s].mu.RLock()
	defer c.shards[s].mu.RUnlock()
	v, ok := c.shards[s].items[key]
	return v, ok
}

// Fix 3: Use sync.Map for concurrent-safe access (good for mostly-stable maps).
type SyncCache struct {
	items sync.Map
}

func (c *SyncCache) Get(key string) ([]byte, bool) {
	v, ok := c.items.Load(key)
	if !ok {
		return nil, false
	}
	return v.([]byte), true
}
```

## Section 7: Goroutine Leak Detection

Goroutine leaks are a silent killer in long-running services. A leaked goroutine holds memory and potentially other resources until the process restarts.

```bash
# Check current goroutine count.
curl -s "http://localhost:6060/debug/pprof/goroutine?debug=1" | head -5

# Over time, if this count grows monotonically, you have a leak.
# Sample it periodically with:
while true; do
  count=$(curl -s "http://localhost:6060/debug/pprof/goroutine?debug=1" | head -1 | grep -oE '[0-9]+')
  echo "$(date): goroutines=$count"
  sleep 60
done
```

### Common Goroutine Leak Patterns

```go
// Pattern 1: Unbuffered channel send with no receiver.
// BAD: If the receiver returns early, the sender leaks.
func sendResult(results chan<- Result) {
	go func() {
		result := doExpensiveWork()
		results <- result  // LEAK if the reader has gone away
	}()
}

// FIX: Use context cancellation or a buffered channel.
func sendResultFixed(ctx context.Context, results chan<- Result) {
	go func() {
		result := doExpensiveWork()
		select {
		case results <- result:
		case <-ctx.Done():
			// Caller is gone; exit cleanly.
		}
	}()
}

// Pattern 2: Goroutines waiting on a timer that never fires.
// BAD:
func waitForThing() {
	go func() {
		timer := time.NewTimer(24 * time.Hour)
		select {
		case <-timer.C:
			doThing()
		}
		// LEAK if doThing() takes forever or if no one cancels this.
	}()
}

// FIX: Always pass a context.
func waitForThingFixed(ctx context.Context) {
	go func() {
		timer := time.NewTimer(24 * time.Hour)
		defer timer.Stop()
		select {
		case <-timer.C:
			doThing()
		case <-ctx.Done():
			return
		}
	}()
}
```

### Using goleak for Test-Time Leak Detection

```go
// Add to your test file.
import "go.uber.org/goleak"

func TestMain(m *testing.M) {
	goleak.VerifyTestMain(m)
}

// Or check individual tests.
func TestMyHandler(t *testing.T) {
	defer goleak.VerifyNone(t)

	// Run the test...
}
```

## Section 8: Continuous Profiling in Production

On-demand profiling is useful for investigating known problems, but continuous profiling catches problems before they become visible:

```go
// pkg/profiling/continuous.go
package profiling

import (
	"context"
	"os"
	"runtime/pprof"
	"time"
)

// ContinuousProfiler captures profiles at regular intervals and
// saves them with timestamps for later analysis.
type ContinuousProfiler struct {
	dir      string
	interval time.Duration
	duration time.Duration
}

func NewContinuousProfiler(dir string, interval, duration time.Duration) *ContinuousProfiler {
	return &ContinuousProfiler{
		dir:      dir,
		interval: interval,
		duration: duration,
	}
}

func (cp *ContinuousProfiler) Run(ctx context.Context) {
	ticker := time.NewTicker(cp.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case t := <-ticker.C:
			go cp.captureProfile(t)
		}
	}
}

func (cp *ContinuousProfiler) captureProfile(t time.Time) {
	// Capture heap profile.
	heapFile := filepath.Join(cp.dir,
		fmt.Sprintf("heap-%s.prof", t.Format("20060102-150405")))
	f, err := os.Create(heapFile)
	if err == nil {
		_ = pprof.WriteHeapProfile(f)
		f.Close()
	}

	// Delete profiles older than 24 hours to prevent disk fill.
	cp.cleanOldProfiles()
}

func (cp *ContinuousProfiler) cleanOldProfiles() {
	entries, err := os.ReadDir(cp.dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-24 * time.Hour)
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(cp.dir, e.Name()))
		}
	}
}
```

### Using Pyroscope for Continuous Profiling

```go
// Integrate Pyroscope for always-on profiling with a web UI.
import "github.com/grafana/pyroscope-go"

func initPyroscope() {
	_, err := pyroscope.Start(pyroscope.Config{
		ApplicationName: "my-service",
		ServerAddress:   "http://pyroscope:4040",
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
	})
	if err != nil {
		log.Printf("pyroscope init: %v", err)
	}
}
```

## Section 9: The Execution Tracer

The execution tracer provides microsecond-level visibility into goroutine scheduling, GC events, and system calls. It is essential for diagnosing latency spikes that don't show up in CPU profiles.

```bash
# Capture a 3-second trace.
curl -s "http://localhost:6060/debug/pprof/trace?seconds=3" > trace.out

# Analyze in the browser.
go tool trace trace.out
```

Key views in the trace tool:

- **Goroutines**: Shows the state of every goroutine over time (running, waiting, blocked, sleeping)
- **Heap**: Shows GC events and heap growth
- **Threads**: Shows OS thread activity
- **Syscalls**: Shows system call durations

### Reading a Trace for GC Issues

When GC is causing latency, the trace will show:
1. A `GC` event in the heap view
2. During the GC event, all goroutines transition to `waiting` briefly (STW — stop-the-world)
3. After the GC, goroutines resume but may be slower due to write barriers

To reduce GC pressure:
- Reduce allocation rate (use object pools, reuse slices)
- Increase `GOGC` (default 100 — triggers GC when heap doubles; increase to 200-400 for batch workloads)
- Use `GOMEMLIMIT` to set an absolute memory limit and prevent out-of-memory kills

```bash
# Set GC target: trigger GC when heap grows by 200% (instead of 100%).
export GOGC=200

# Set a memory limit (Go 1.19+).
export GOMEMLIMIT=4GiB
```

## Section 10: Profiling Checklist

**Before Profiling**
- Reproduce the issue under realistic load (not just a single request)
- Enable mutex and block profiling before capturing profiles (they default to off)
- Capture profiles from production or a load-tested staging environment

**CPU Profiling**
- Run for at least 30 seconds to get a representative sample
- Look for unexpected function calls in hot paths (JSON marshal, fmt.Sprintf, reflect)
- Check cumulative percentages to find the functions responsible for the most total time

**Memory Profiling**
- Use `allocs` (not `heap`) to find allocation hotspots
- Check for allocations in hot loops (any allocation in a loop called millions of times/second is significant)
- Run with `-gcflags=-m` to understand which variables escape to the heap

**Goroutine Analysis**
- If goroutine count grows over time, you have a leak
- Look for goroutines blocked in `select` with no `ctx.Done()` case
- Use goleak in tests to catch leaks before they reach production

**Mutex Profiling**
- Enable with `runtime.SetMutexProfileFraction(1)` before capturing
- Look for mutexes protecting shared maps under high read concurrency
- Consider sync.RWMutex, sharding, or sync.Map as alternatives

## Conclusion

Go's profiling tools give you unprecedented visibility into your running service. The key is developing the habit of capturing and analyzing profiles before a performance problem becomes critical. CPU profiles reveal hot code paths. Memory profiles reveal allocation patterns and GC pressure. Mutex profiles reveal contention that prevents horizontal scaling. Goroutine profiles reveal leaks that cause gradual memory growth.

The flame graph is the universal language for communicating performance findings: wide bars in unexpected places drive optimization decisions better than any other representation. Combined with continuous profiling via Pyroscope or a similar system, these tools transform performance engineering from reactive firefighting into systematic, data-driven improvement.
