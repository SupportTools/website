---
title: "Go Garbage Collector Internals: Tri-Color Mark-Sweep and GC Tuning"
date: 2029-07-27T00:00:00-05:00
draft: false
tags: ["Go", "Garbage Collection", "GC Tuning", "Performance", "Memory Management", "GOGC", "GOMEMLIMIT"]
categories: ["Go", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Go garbage collector internals covering the tri-color mark-sweep algorithm, write barriers, GC assist, GOGC and GOMEMLIMIT tuning, GC trace output interpretation, and allocation profiling for production optimization."
more_link: "yes"
url: "/go-garbage-collector-internals-tri-color-mark-sweep-guide/"
---

Go's garbage collector is one of the most consequential components of the runtime for latency-sensitive production services. While Go's GC has evolved dramatically — from fully stop-the-world in Go 1.0 to a concurrent, low-latency collector in modern versions — understanding its internals allows engineers to make informed decisions about heap allocation patterns, GC tuning parameters, and the tradeoffs between throughput and pause times. This guide covers the tri-color mark-sweep algorithm in depth, explains write barriers and GC assist, and provides a systematic approach to tuning `GOGC`, `GOMEMLIMIT`, and allocation behavior for production workloads.

<!--more-->

# Go Garbage Collector Internals: Tri-Color Mark-Sweep and GC Tuning

## Section 1: GC Algorithm Overview

Go uses a non-generational, non-compacting, concurrent, tri-color mark-sweep GC. Let us unpack each attribute:

- **Non-generational**: Unlike Java's GC, Go does not have young/old generations. All live objects are traced in each GC cycle.
- **Non-compacting**: Objects are not moved after allocation. This avoids the complexity of updating all pointers but means heap can fragment over time (mitigated by the size-classed allocator).
- **Concurrent**: Most of the GC work runs concurrently with the application (mutator goroutines). Stop-the-world (STW) pauses are minimized to two short phases.
- **Tri-color mark-sweep**: The algorithm uses three sets of objects: white (unmarked), gray (discovered but children not yet traced), and black (fully traced).

### GC Phases

```
GC Cycle Timeline:

1. Mark Setup (STW ~50-500µs):
   - Stop all goroutines briefly
   - Enable write barriers
   - Scan goroutine stacks
   - Resume goroutines

2. Concurrent Mark (concurrent with mutator):
   - Mark roots (globals, stack vars)
   - Trace object graph: gray → black
   - GC assist: goroutines help mark proportionally to allocation rate
   - Write barriers track mutations during marking

3. Mark Termination (STW ~50-500µs):
   - Stop all goroutines briefly
   - Flush remaining write barrier buffers
   - Final marking pass
   - Disable write barriers
   - Resume goroutines

4. Concurrent Sweep (concurrent with mutator):
   - Return unmarked (white) objects to memory pools
   - Happens lazily as allocations are requested
```

## Section 2: Tri-Color Algorithm

```
Invariant:
- No black object may contain a pointer to a white object
- (if it did, the white object might be incorrectly freed)

Initially:
- All objects are WHITE (unmarked)
- All root objects (globals, stack vars) are added to GRAY set

Mark loop:
  While gray set is not empty:
    1. Take object O from gray set
    2. For each pointer P in O:
       a. If P points to a white object W:
          - Mark W as GRAY (add to gray set)
    3. Mark O as BLACK (fully scanned)

When gray set is empty:
- All reachable objects are BLACK
- All unreachable objects remain WHITE
- Sweep phase frees WHITE objects

Illustration:

  Initial state:
  Root → [White A] → [White B] → [White D]
          ↓
         [White C]

  After marking A:
  Root → [Black A] → [Gray B]  → [White D]
          ↓
         [Gray C]

  After marking B and C:
  Root → [Black A] → [Black B] → [Gray D]
          ↓
         [Black C]

  After marking D:
  Root → [Black A] → [Black B] → [Black D]
          ↓
         [Black C]

  If X is unreachable:
  [White X]  ← freed by sweep
```

## Section 3: Write Barriers

The tri-color invariant is maintained concurrently by the **write barrier**: a small piece of code injected by the compiler before every pointer write operation. Without write barriers, a mutation during concurrent marking could:
1. Create a new pointer from a black object to a white object (the GC might miss it)
2. Delete the only gray path to a white object (making it look unreachable when it isn't)

### Hybrid Write Barrier (Go 1.14+)

```go
// The write barrier is injected at compile time for pointer writes.
// Conceptually, for every:
//   *slot = ptr
// The compiler generates:
//   writeBarrier(*slot, ptr)
//   *slot = ptr

// The hybrid write barrier (Dijkstra + Yuasa combined):
func writeBarrier(slot **T, newVal *T) {
    if gcEnabled {
        shade(*slot)    // Shade the OLD value (Yuasa barrier)
        shade(newVal)   // Shade the NEW value (Dijkstra barrier)
    }
}

// shade: if object is white, make it gray (add to mark worklist)
func shade(ptr *T) {
    if ptr != nil && isWhite(ptr) {
        markGray(ptr)
    }
}
```

### Write Barrier Impact on Performance

Write barriers add overhead to every pointer write. This is measurable:

```go
// Benchmark: pointer-heavy vs value-heavy data structures
package main

import (
	"testing"
	"math/rand"
)

// Pointer-heavy: linked list (every Next is a pointer write)
type Node struct {
	Value int
	Next  *Node
}

// Value-heavy: slice of values (no pointer writes for int elements)
type ValueSlice []int

func BenchmarkLinkedListInsert(b *testing.B) {
	var head *Node
	for i := 0; i < b.N; i++ {
		// Each assignment to Next triggers write barrier
		node := &Node{Value: i, Next: head}
		head = node  // Write barrier: head is a pointer
	}
	_ = head
}

func BenchmarkSliceAppend(b *testing.B) {
	var s []int
	for i := 0; i < b.N; i++ {
		// No write barrier for int values
		s = append(s, i)
	}
	_ = s
}

// Run: go test -bench=. -gcflags="-d writebarrier=1" to see barrier injections
// Run: go test -bench=. -benchmem to see allocation rates
```

### Disabling Write Barrier (for benchmarking only)

```bash
# Disable the write barrier to measure its overhead (UNSAFE — for benchmarking only)
go test -bench=. -gcflags="-d gccheckmark=1"

# See write barrier injection points in assembly
go tool objdump -s "BenchmarkLinkedListInsert" ./bench.test | grep -E "CALL|writeBarrier"
```

## Section 4: GC Assist

When goroutines allocate memory faster than the background GC can mark, the runtime uses **GC assist**: the allocating goroutine is forced to do marking work proportional to the amount it allocated. This prevents the heap from growing unboundedly during a GC cycle.

```go
// Conceptual GC assist flow
// (actual implementation in runtime/malloc.go)

func mallocgc(size uintptr) unsafe.Pointer {
    // 1. Calculate debt: how much marking work this goroutine owes
    // debt = alloc_credit - size

    // 2. If in debt, do marking work to repay
    if gcAssistBytes < 0 {
        gcAssist()  // Marks objects until debt is repaid
    }

    // 3. Perform actual allocation
    return allocateMemory(size)
}
```

### Observing GC Assist

```bash
# GODEBUG=gccheckmark enables checking for GC errors (slow)
GODEBUG=gccheckmark=1 ./myapp

# GODEBUG=gcpacertrace shows GC pacing information
GODEBUG=gcpacertrace=1 ./myapp 2>&1 | head -20
# pacer: assist ratio=0.53/0.55 (scan 4 MB in 8 MB)
# pacer: goroutine 12 assisted: 0 B/cycle → 1024 B/cycle

# Check if GC assist is a bottleneck
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30
# In pprof:
# (pprof) top
# Look for: runtime.gcAssistAlloc, runtime.gcDrainN in top allocators
```

## Section 5: GOGC Tuning

`GOGC` controls the GC target heap size as a percentage of the live heap. The default is 100 (GC when heap doubles).

### How GOGC Works

```
GOGC = 100 (default):
  - After GC, live heap = L
  - Next GC triggered when heap reaches: L + L * (GOGC/100) = 2L
  - Example: live heap = 100 MB → next GC at 200 MB

GOGC = 200:
  - Next GC at 300 MB (3x live heap)
  - Fewer GC cycles, higher peak memory, more throughput
  - Good for: batch jobs, throughput-sensitive tasks

GOGC = 50:
  - Next GC at 150 MB (1.5x live heap)
  - More GC cycles, lower peak memory, more latency spikes
  - Good for: memory-constrained environments

GOGC = off:
  - GC disabled (use GOMEMLIMIT instead)
  - Combined with GOMEMLIMIT: GC runs only when memory limit approached
```

```go
// Setting GOGC programmatically
import "runtime/debug"

func optimizeGC() {
	// For throughput-heavy batch processor:
	debug.SetGCPercent(300)  // Equivalent to GOGC=300

	// After batch processing completes, force GC and reset
	runtime.GC()
	debug.SetGCPercent(100)  // Restore default

	// Disable GC entirely (must handle memory limit separately)
	debug.SetGCPercent(-1)  // Equivalent to GOGC=off
}
```

### GOGC Impact on Latency

```go
// gcpause_benchmark.go — measure GC pause times with different GOGC values
package main

import (
	"fmt"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"time"
)

func allocateAndRetain(mb int) [][]byte {
	// Allocate mb MB of data (retained in heap)
	const chunkSize = 1024 * 1024
	chunks := make([][]byte, mb)
	for i := range chunks {
		chunks[i] = make([]byte, chunkSize)
		// Fill to prevent optimization
		for j := range chunks[i] {
			chunks[i][j] = byte(i + j)
		}
	}
	return chunks
}

func measureGCPauses(gogc int, retainedMB int) {
	debug.SetGCPercent(gogc)

	// Retain some baseline heap
	retained := allocateAndRetain(retainedMB)
	_ = retained

	// Collect pause stats
	var stats debug.GCStats
	debug.ReadGCStats(&stats)
	before := len(stats.Pause)

	// Generate allocation pressure
	for i := 0; i < 1000; i++ {
		_ = make([]byte, 1*1024*1024)  // 1 MB ephemeral allocation
		time.Sleep(time.Millisecond)
	}

	debug.ReadGCStats(&stats)
	newPauses := stats.Pause[before:]

	if len(newPauses) == 0 {
		fmt.Printf("GOGC=%d: no GC cycles\n", gogc)
		return
	}

	var total, max time.Duration
	for _, p := range newPauses {
		total += p
		if p > max { max = p }
	}
	avg := total / time.Duration(len(newPauses))

	fmt.Printf("GOGC=%d: cycles=%d avg_pause=%v max_pause=%v total_pause=%v\n",
		gogc, len(newPauses), avg, max, total)
}

func main() {
	gogcVal := 100
	if v := os.Getenv("GOGC_TEST"); v != "" {
		gogcVal, _ = strconv.Atoi(v)
	}
	measureGCPauses(gogcVal, 50)
}
```

```bash
# Run with different GOGC values
for gogc in 50 100 200 400 800; do
    GOGC_TEST=$gogc go run gcpause_benchmark.go
done

# Typical output:
# GOGC=50:  cycles=42 avg_pause=180µs max_pause=2.1ms total_pause=7.6ms
# GOGC=100: cycles=21 avg_pause=210µs max_pause=2.8ms total_pause=4.4ms
# GOGC=200: cycles=11 avg_pause=280µs max_pause=3.2ms total_pause=3.1ms
# GOGC=400: cycles=6  avg_pause=350µs max_pause=4.1ms total_pause=2.1ms
# GOGC=800: cycles=3  avg_pause=450µs max_pause=5.5ms total_pause=1.4ms
```

## Section 6: GOMEMLIMIT

Introduced in Go 1.19, `GOMEMLIMIT` sets a soft memory limit for the Go runtime. When the total memory footprint approaches this limit, the GC runs more aggressively to stay within budget.

```go
// Setting GOMEMLIMIT programmatically
import "runtime/debug"

func setMemoryLimit() {
	// Set limit to 512 MB
	debug.SetMemoryLimit(512 * 1024 * 1024)

	// Or use the environment variable:
	// GOMEMLIMIT=512MiB go run main.go
}
```

### GOGC=off + GOMEMLIMIT (The High-Performance Pattern)

```bash
# Disable GOGC and use only memory-limit-based GC triggering.
# Result: GC runs only when memory is actually needed, not on a percentage schedule.
# Best for: services with stable live heap and bursty allocation.

GOGC=off GOMEMLIMIT=1GiB ./myservice

# How it works:
# - With GOGC=off, GC does not run on the percentage trigger
# - When heap approaches GOMEMLIMIT, GC is forced to run
# - If heap fits in GOMEMLIMIT with room: very few GC cycles (high throughput)
# - If allocation rate is high: GC runs as needed to stay under limit
```

### Containerized Memory Limit Integration

```go
// cmd/server/main.go — automatically configure GOMEMLIMIT from container limits
package main

import (
	"log"
	"os"
	"runtime/debug"
)

func configureGOMemLimit() {
	// In Kubernetes, the container memory limit is in /sys/fs/cgroup/memory.limit_in_bytes
	// or /sys/fs/cgroup/memory/memory.limit_in_bytes (cgroup v1)
	// or /sys/fs/cgroup/memory.max (cgroup v2)

	cgroupV2Limit := readCgroupLimit("/sys/fs/cgroup/memory.max")
	cgroupV1Limit := readCgroupLimit("/sys/fs/cgroup/memory/memory.limit_in_bytes")

	var containerLimit int64
	switch {
	case cgroupV2Limit > 0 && cgroupV2Limit < (1<<62):
		containerLimit = cgroupV2Limit
		log.Printf("Detected cgroup v2 memory limit: %d bytes", containerLimit)
	case cgroupV1Limit > 0 && cgroupV1Limit < (1<<62):
		containerLimit = cgroupV1Limit
		log.Printf("Detected cgroup v1 memory limit: %d bytes", containerLimit)
	default:
		log.Println("No container memory limit detected")
		return
	}

	// Set GOMEMLIMIT to 90% of container limit
	// (leave 10% for non-heap: OS, goroutine stacks, cgo)
	goMemLimit := int64(float64(containerLimit) * 0.90)
	debug.SetMemoryLimit(goMemLimit)

	// With container limits set, GOGC=off gives best throughput
	// Go's runtime is smart enough to GC when approaching GOMEMLIMIT
	debug.SetGCPercent(-1)  // Disable percentage-based GC

	log.Printf("Configured: GOMEMLIMIT=%d GOGC=off", goMemLimit)
}

func readCgroupLimit(path string) int64 {
	data, err := os.ReadFile(path)
	if err != nil { return -1 }

	var limit int64
	_, err = fmt.Sscan(string(data), &limit)
	if err != nil { return -1 }
	return limit
}

func main() {
	configureGOMemLimit()
	// Start application...
}
```

## Section 7: GC Trace Output

```bash
# Enable GC trace output (GODEBUG=gctrace=1)
GODEBUG=gctrace=1 ./myapp 2>&1 | grep "^gc"

# Example output:
# gc 1 @0.104s 2%: 0.017+1.3+0.048 ms clock, 0.034+0.58/1.3/0+0.097 ms cpu, 4->4->2 MB, 5 MB goal, 0 MB stacks, 0 MB globals, 4 P

# Parse each field:
# gc 1        — GC cycle number
# @0.104s     — time since program start
# 2%          — CPU usage: GC used 2% of total CPU time since last GC
#
# Clock times (wall): 0.017+1.3+0.048 ms
#   0.017 ms  — sweep termination STW pause
#   1.3 ms    — concurrent mark phase (concurrent with mutator)
#   0.048 ms  — mark termination STW pause
#
# CPU times: 0.034+0.58/1.3/0+0.097 ms
#   0.034 ms  — sweep termination (all goroutines stopped)
#   0.58 ms   — mutator assist during mark
#   1.3 ms    — background GC workers
#   0 ms      — idle GC
#   0.097 ms  — mark termination
#
# Heap: 4->4->2 MB
#   4 MB      — heap size at GC start
#   4 MB      — heap size at mark termination
#   2 MB      — live heap after sweep (retainables)
#
# 5 MB goal   — target heap size for next GC (live * (1 + GOGC/100))
# 4 P         — number of P's (GOMAXPROCS)
```

### Parsing GC Trace Programmatically

```go
// gc_trace_parser.go — parse GODEBUG=gctrace=1 output for analysis
package main

import (
	"bufio"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

type GCEvent struct {
	Cycle           int
	TimeS           float64
	CPUPercent      float64
	STWSetupMs      float64
	ConcurrentMarkMs float64
	STWMarkTermMs   float64
	HeapBeforeMB    float64
	HeapAfterMarkMB float64
	LiveHeapMB      float64
	GoalMB          float64
}

var gcLineRegex = regexp.MustCompile(
	`gc (\d+) @([\d.]+)s (\d+)%: ([\d.]+)\+([\d.]+)\+([\d.]+) ms clock.*` +
	`([\d.]+)->([\d.]+)->([\d.]+) MB, ([\d.]+) MB goal`)

func parseGCTrace(filename string) ([]GCEvent, error) {
	f, err := os.Open(filename)
	if err != nil { return nil, err }
	defer f.Close()

	var events []GCEvent
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "gc ") { continue }

		m := gcLineRegex.FindStringSubmatch(line)
		if m == nil { continue }

		parseFloat := func(s string) float64 {
			v, _ := strconv.ParseFloat(s, 64)
			return v
		}
		parseInt := func(s string) int {
			v, _ := strconv.Atoi(s)
			return v
		}

		events = append(events, GCEvent{
			Cycle:            parseInt(m[1]),
			TimeS:            parseFloat(m[2]),
			CPUPercent:       parseFloat(m[3]),
			STWSetupMs:       parseFloat(m[4]),
			ConcurrentMarkMs: parseFloat(m[5]),
			STWMarkTermMs:    parseFloat(m[6]),
			HeapBeforeMB:     parseFloat(m[7]),
			HeapAfterMarkMB:  parseFloat(m[8]),
			LiveHeapMB:       parseFloat(m[9]),
			GoalMB:           parseFloat(m[10]),
		})
	}
	return events, scanner.Err()
}

func analyzeGCEvents(events []GCEvent) {
	if len(events) == 0 {
		fmt.Println("No GC events")
		return
	}

	var maxSTW, maxConcurrent, totalCPU float64
	for _, e := range events {
		stw := e.STWSetupMs + e.STWMarkTermMs
		if stw > maxSTW { maxSTW = stw }
		if e.ConcurrentMarkMs > maxConcurrent { maxConcurrent = e.ConcurrentMarkMs }
		totalCPU += e.CPUPercent
	}

	fmt.Printf("GC Analysis (%d cycles):\n", len(events))
	fmt.Printf("  Max STW pause:       %.3f ms\n", maxSTW)
	fmt.Printf("  Max concurrent mark: %.3f ms\n", maxConcurrent)
	fmt.Printf("  Avg GC CPU%%:         %.1f%%\n", totalCPU/float64(len(events)))
	fmt.Printf("  GC frequency:        %.1f cycles/s\n",
		float64(len(events)) / (events[len(events)-1].TimeS - events[0].TimeS))

	// Find cycles with high GC assist (allocation-heavy cycles)
	fmt.Println("\nHigh-impact cycles (STW > 1ms):")
	for _, e := range events {
		if e.STWSetupMs+e.STWMarkTermMs > 1.0 {
			fmt.Printf("  gc%-4d @%.2fs STW=%.3fms live=%.1fMB->%.1fMB\n",
				e.Cycle, e.TimeS,
				e.STWSetupMs+e.STWMarkTermMs,
				e.HeapBeforeMB, e.LiveHeapMB)
		}
	}
}
```

## Section 8: Allocation Profiling

```go
// alloc_profiling.go — identify allocation hotspots
package main

import (
	"net/http"
	_ "net/http/pprof"
	"runtime"
	"testing"
)

// Enable allocation sampling
func init() {
	// Sample every 512 KB of allocation (default is 512 KB)
	runtime.MemProfileRate = 512 * 1024
}

// Common allocation anti-patterns

// Anti-pattern 1: string concatenation in loop
func badStringConcat(n int) string {
	s := ""
	for i := 0; i < n; i++ {
		s += fmt.Sprintf("item%d,", i)  // Allocates new string each iteration
	}
	return s
}

// Fix: use strings.Builder
func goodStringConcat(n int) string {
	var b strings.Builder
	b.Grow(n * 8)  // Pre-allocate estimate
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, "item%d,", i)
	}
	return b.String()
}

// Anti-pattern 2: interface boxing of scalars
type Metric interface {
	Value() float64
}

type metricImpl struct{ v float64 }
func (m *metricImpl) Value() float64 { return m.v }

func badInterface(vals []float64) []Metric {
	metrics := make([]Metric, len(vals))
	for i, v := range vals {
		metrics[i] = &metricImpl{v: v}  // Heap allocation per element
	}
	return metrics
}

// Fix: avoid interfaces on hot paths; use concrete types
func goodConcrete(vals []float64) []metricImpl {
	metrics := make([]metricImpl, len(vals))
	for i, v := range vals {
		metrics[i] = metricImpl{v: v}  // No allocation
	}
	return metrics
}

// Anti-pattern 3: closure capturing loop variable by reference
func badClosure(fns []func()) {
	for i := 0; i < 10; i++ {
		fns = append(fns, func() {
			fmt.Println(i)  // Captures i by reference — heap escapes
		})
	}
}

// Fix: copy loop variable
func goodClosure(fns []func()) {
	for i := 0; i < 10; i++ {
		i := i  // New variable per iteration
		fns = append(fns, func() {
			fmt.Println(i)  // Captures local copy
		})
	}
}
```

### Escape Analysis

```bash
# See why variables escape to the heap
go build -gcflags="-m -m" ./... 2>&1 | grep "escapes to heap"

# Focus on a specific package
go build -gcflags="-m -m" ./cmd/server/... 2>&1 | \
    grep -v "^#" | grep -v "inlining" | \
    grep "escapes to heap" | sort | uniq -c | sort -rn | head -20

# Example output:
# 45 ./handler.go:123:18: arg escapes to heap
# 23 ./service.go:67:12: &metrics escapes to heap
# 12 ./store.go:89:15: converted to interface escapes to heap

# Reduce escape with sync.Pool for frequently allocated objects
var metricPool = sync.Pool{
    New: func() any { return &Metric{} },
}

func processRequest(data []byte) {
    m := metricPool.Get().(*Metric)
    defer metricPool.Put(m)
    // Use m...
}
```

## Section 9: Memory Profiling in Production

```go
// memory_profiling.go — capturing and analyzing heap profiles
package main

import (
	"os"
	"runtime"
	"runtime/pprof"
	"time"
)

// Capture heap profile on signal or periodically
func captureHeapProfile(path string) error {
	f, err := os.Create(path)
	if err != nil { return err }
	defer f.Close()

	// Trigger GC before profiling for cleaner live/dead distinction
	runtime.GC()
	runtime.GC()  // Two GC cycles to ensure all finalizers run

	return pprof.WriteHeapProfile(f)
}

// Periodic heap snapshot for trend analysis
func periodicHeapSnapshot(dir string, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		<-ticker.C
		path := fmt.Sprintf("%s/heap-%s.pprof",
			dir, time.Now().Format("20060102-150405"))
		if err := captureHeapProfile(path); err != nil {
			log.Printf("heap snapshot failed: %v", err)
		}
	}
}

// Detect memory leaks by comparing snapshots
func compareHeapProfiles(before, after string) {
	// go tool pprof -base=before.pprof after.pprof
	// Shows allocations in after that weren't in before
}
```

```bash
# Capture heap profile via pprof HTTP endpoint
curl http://localhost:6060/debug/pprof/heap > heap.pprof

# Analyze heap profile
go tool pprof -http=:8080 heap.pprof

# Command line analysis
go tool pprof heap.pprof
# (pprof) top20            — top 20 allocation sites by size
# (pprof) top20 -cum       — top 20 by cumulative size (including callees)
# (pprof) list myFunc      — show allocation details for myFunc
# (pprof) tree             — call tree

# Compare before and after optimization
go tool pprof -base=before.pprof -http=:8080 after.pprof

# Allocs profile: shows allocations by count (not live heap)
curl http://localhost:6060/debug/pprof/allocs > allocs.pprof
go tool pprof allocs.pprof
# (pprof) top20 -flat -nodecount=30 -inuse_objects
```

## Section 10: GC-Friendly Data Structures

```go
// gc_friendly_structures.go

// Pattern 1: Slab allocator — reduce GC pressure by pooling objects
type SlabAllocator[T any] struct {
	pool []T
	free []int
	mu   sync.Mutex
}

func (s *SlabAllocator[T]) Alloc() (int, *T) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.free) > 0 {
		idx := s.free[len(s.free)-1]
		s.free = s.free[:len(s.free)-1]
		return idx, &s.pool[idx]
	}

	idx := len(s.pool)
	s.pool = append(s.pool, *new(T))
	return idx, &s.pool[idx]
}

func (s *SlabAllocator[T]) Free(idx int) {
	s.mu.Lock()
	s.free = append(s.free, idx)
	s.mu.Unlock()
}

// Pattern 2: Arena allocator — batch allocate, batch free
// Eliminates GC scanning entirely for the arena's lifetime
type Arena struct {
	chunks [][]byte
	pos    int
	size   int
}

func NewArena(size int) *Arena {
	return &Arena{
		chunks: [][]byte{make([]byte, size)},
		size:   size,
	}
}

func (a *Arena) Alloc(size int) []byte {
	if a.pos+size > len(a.chunks[len(a.chunks)-1]) {
		// Allocate new chunk
		newSize := a.size
		if size > newSize { newSize = size }
		a.chunks = append(a.chunks, make([]byte, newSize))
		a.pos = 0
	}
	cur := a.chunks[len(a.chunks)-1]
	result := cur[a.pos : a.pos+size]
	a.pos += size
	return result
}

func (a *Arena) Reset() {
	// Reuse all chunks without GC
	for _, chunk := range a.chunks[:len(a.chunks)-1] {
		a.chunks = a.chunks[:len(a.chunks)-1]
		_ = chunk
	}
	a.pos = 0
}

// Pattern 3: Avoid pointer-heavy maps for large datasets
// map[string]*Value has O(N) GC scan time
// Use flat arrays + binary search or a hash table with value semantics

// Slow GC path: map with pointer values
type CacheSlow map[string]*CacheEntry  // GC scans all values

// Fast GC path: map with index into slice
type CacheFast struct {
	index   map[string]int
	entries []CacheEntry  // No pointers in CacheEntry → GC skips it
}

type CacheEntry struct {
	// All value types — no pointers
	Score    int64
	TTL      int64
	HitCount int32
	Flags    uint32
}
```

## Section 11: Runtime Memory Statistics

```go
// runtime_stats.go — comprehensive GC and memory statistics
package main

import (
	"fmt"
	"runtime"
	"time"
)

func printMemStats() {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	fmt.Printf("=== Memory Statistics ===\n")
	fmt.Printf("Heap:\n")
	fmt.Printf("  Alloc:        %8.1f MB (currently allocated)\n", mbytes(m.Alloc))
	fmt.Printf("  TotalAlloc:   %8.1f MB (cumulative)\n", mbytes(m.TotalAlloc))
	fmt.Printf("  Sys:          %8.1f MB (obtained from OS)\n", mbytes(m.Sys))
	fmt.Printf("  HeapAlloc:    %8.1f MB\n", mbytes(m.HeapAlloc))
	fmt.Printf("  HeapSys:      %8.1f MB\n", mbytes(m.HeapSys))
	fmt.Printf("  HeapIdle:     %8.1f MB (returned to OS)\n", mbytes(m.HeapIdle))
	fmt.Printf("  HeapInuse:    %8.1f MB\n", mbytes(m.HeapInuse))
	fmt.Printf("  HeapReleased: %8.1f MB\n", mbytes(m.HeapReleased))
	fmt.Printf("  HeapObjects:  %8d (live objects)\n", m.HeapObjects)

	fmt.Printf("\nGarbage Collection:\n")
	fmt.Printf("  NumGC:         %d\n", m.NumGC)
	fmt.Printf("  NumForcedGC:   %d\n", m.NumForcedGC)
	fmt.Printf("  GCCPUFraction: %.4f (fraction of CPU used by GC)\n", m.GCCPUFraction)
	fmt.Printf("  LastGC:        %s ago\n", time.Since(time.Unix(0, int64(m.LastGC))))

	if m.NumGC > 0 {
		avgPause := m.PauseTotalNs / uint64(m.NumGC)
		fmt.Printf("  PauseTotalNs:  %v\n", time.Duration(m.PauseTotalNs))
		fmt.Printf("  AvgPause:      %v\n", time.Duration(avgPause))
	}

	fmt.Printf("\nAllocator:\n")
	fmt.Printf("  Mallocs:   %d\n", m.Mallocs)
	fmt.Printf("  Frees:     %d\n", m.Frees)
	fmt.Printf("  Live objs: %d\n", m.Mallocs-m.Frees)
	fmt.Printf("  StackInuse: %.1f MB\n", mbytes(m.StackInuse))
	fmt.Printf("  MSpanInuse: %.1f MB\n", mbytes(m.MSpanInuse))
	fmt.Printf("  MCacheInuse: %.1f MB\n", mbytes(m.MCacheInuse))
	fmt.Printf("  BuckHashSys: %.1f MB\n", mbytes(m.BuckHashSys))
}

func mbytes(b uint64) float64 { return float64(b) / (1024 * 1024) }
```

## Section 12: Production Tuning Playbook

```
Go GC Production Tuning Playbook:

Step 1: Baseline Measurement
  - Enable gctrace=1 in staging under production-like load
  - Capture heap profile: curl http://localhost:6060/debug/pprof/heap
  - Note: GC cycle frequency, average STW pause, peak heap, GCCPUFraction

Step 2: Identify Problem Type
  - High GC frequency (>5/sec): increase GOGC or reduce allocation rate
  - High max pause (>1ms): increase GOGC to reduce concurrent work
  - GCCPUFraction > 10%: major allocation problem — find hotspot with allocs pprof
  - OOM kills: set GOMEMLIMIT, reduce GOGC, fix leaks

Step 3: Apply Tuning

  For latency-sensitive services (p99 < 1ms target):
    GOGC=off
    GOMEMLIMIT=<container_limit * 0.9>
    Result: GC runs only when memory pressure demands it

  For throughput batch processing:
    GOGC=400
    Result: 4x fewer GC cycles, higher peak memory, ~15% better throughput

  For memory-constrained containers (< 256 MB):
    GOGC=50
    GOMEMLIMIT=200MiB
    Result: GC before memory pressure; predictable memory footprint

  For high-allocation microservices:
    Use sync.Pool for hot allocations
    GOGC=off GOMEMLIMIT=<90% of limit>
    Add allocation pressure relief with runtime.GC() after request burst

Step 4: Verify
  - Redeploy with GODEBUG=gctrace=1 temporarily
  - Compare: GC frequency, max STW pause, GCCPUFraction
  - Check: p99 latency improved, no OOM events, memory footprint stable
  - Profile with heap pprof to confirm allocation improvements

Step 5: Continuous Monitoring
  - Expose runtime.MemStats via Prometheus (go_memstats_alloc_bytes etc.)
  - Alert on: GCCPUFraction > 15%, STW pause > 5ms, heap growth trend
  - Track GC overhead as a % of request latency
```

```yaml
# Prometheus recording rules for Go GC metrics
groups:
  - name: go_gc
    rules:
      - record: job:go_gc_duration_seconds:p99
        expr: histogram_quantile(0.99, sum(rate(go_gc_duration_seconds_bucket[5m])) by (job, le))

      - alert: GoHighGCPause
        expr: histogram_quantile(0.99, sum(rate(go_gc_duration_seconds_bucket[5m])) by (job, le)) > 0.005
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High GC pause in {{ $labels.job }}: p99={{ $value | humanizeDuration }}"

      - alert: GoGCOverhead
        expr: rate(go_gc_duration_seconds_sum[5m]) / rate(go_gc_duration_seconds_count[5m]) * 100 > 15
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "GC overhead {{ $value | humanize }}% in {{ $labels.job }}"

      - alert: GoHeapGrowth
        expr: |
          (go_memstats_heap_inuse_bytes - go_memstats_heap_inuse_bytes offset 30m)
          / go_memstats_heap_inuse_bytes offset 30m > 0.5
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Heap grew 50%+ in last 30m in {{ $labels.job }} — possible leak"
```
