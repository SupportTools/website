---
title: "Go Scheduler Internals: Work Stealing, M:N Threading, and GOMAXPROCS"
date: 2029-07-24T00:00:00-05:00
draft: false
tags: ["Go", "Scheduler", "Goroutines", "Concurrency", "Performance", "GOMAXPROCS", "Work Stealing"]
categories: ["Go", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Go scheduler internals covering the G/M/P model, work stealing algorithm, preemption points, GOMAXPROCS tuning, goroutine parking and unparking, and scheduler tracing for production optimization."
more_link: "yes"
url: "/go-scheduler-internals-work-stealing-threading/"
---

Go's runtime scheduler is one of the most sophisticated aspects of the language runtime. It implements M:N threading — multiplexing many goroutines onto a smaller number of OS threads — with a work-stealing algorithm that keeps all available CPUs busy without requiring explicit thread management by the programmer. Understanding the scheduler's internals is essential for diagnosing goroutine starvation, eliminating scheduling latency, and correctly tuning `GOMAXPROCS` in containerized environments.

<!--more-->

# Go Scheduler Internals: Work Stealing, M:N Threading, and GOMAXPROCS

## Section 1: The G/M/P Model

The Go scheduler's three fundamental entities are:

**G (Goroutine)**: a lightweight execution context with its own stack (starting at 2KB, growing as needed). A G encapsulates a function call and its stack state. There can be millions of Gs concurrently.

**M (Machine / OS Thread)**: an OS thread managed by the Go runtime. M's execute the Go runtime itself and run G's. The number of M's can exceed GOMAXPROCS if G's are blocked on syscalls.

**P (Processor)**: a logical CPU context. P's hold run queues of runnable G's and act as a resource permit — an M can only run Go code if it holds a P. The number of P's is controlled by GOMAXPROCS.

```
┌──────────────────────────────────────────────────────────────┐
│                     Go Scheduler                              │
│                                                              │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ← P's (GOMAXPROCS)│
│  │  P0  │  │  P1  │  │  P2  │  │  P3  │                     │
│  │ runq │  │ runq │  │ runq │  │ runq │  ← local run queues  │
│  └──┬───┘  └──┬───┘  └──┬───┘  └──┬───┘                    │
│     │M0       │M1       │M2       │M3   ← OS threads (M's)   │
│     │G executing         │                                   │
│                                                              │
│  ┌─────────────────────────────────┐                        │
│  │     Global Run Queue            │  ← overflow from P runqs│
│  │  G, G, G, G, G, G...            │                        │
│  └─────────────────────────────────┘                        │
│                                                              │
│  ┌─────────────────────────────────┐                        │
│  │     P-less M's (in syscall)     │  ← M's blocked on I/O  │
│  │  M4(syscall), M5(syscall)...    │                        │
│  └─────────────────────────────────┘                        │
└──────────────────────────────────────────────────────────────┘
```

### Key Invariants

- Each P can hold up to 256 G's in its local run queue
- Each M executing Go code holds exactly one P
- When a G blocks on a syscall, its M releases the P so another M can run Go code
- When a G blocks on a channel/mutex/wait, it parks and yields the M to another G

## Section 2: Work Stealing Algorithm

The work-stealing algorithm prevents CPU idle time when some P's have a full run queue while others are empty.

### Stealing Steps (in order of priority)

```
When P has no work to do:

1. Check local run queue — empty
2. Check global run queue — take up to globalQ.size/numP + 1 goroutines
3. Poll network (netpoll) — check for ready network I/O goroutines
4. Steal from another P's local run queue — take half of their goroutines
5. Check global run queue again
6. Park the M (surrender P, wait for work)
```

### Source-Level Illustration

```go
// Conceptual representation of the work-stealing findrunnable function
// Actual implementation: src/runtime/proc.go:findrunnable()

func findrunnable() (*g, bool) {
    // Fast path: check local run queue
    if gp := runqget(thisp); gp != nil {
        return gp, false
    }

    // Check global run queue (periodically, to prevent starvation)
    if sched.gcwaiting.Load() != 0 || pp.schedtick%61 == 0 {
        if gp := globrunqget(pp, 1); gp != nil {
            return gp, false
        }
    }

    // Poll network for ready goroutines
    if netpollinited() && netpollWaiters.Load() > 0 {
        if list, delta := netpoll(0); !list.empty() {
            gp := list.pop()
            injectglist(&list)
            casgstatus(gp, _Gwaiting, _Grunnable)
            return gp, false
        }
    }

    // Work stealing — scan other P's
    procs := uint32(gomaxprocs)
    if sched.npidle.Load() == int32(procs-1) {
        // All other P's are idle — nothing to steal
        goto stop
    }

    for i := 0; i < 4; i++ {
        // Randomize starting point to reduce contention
        for enum := stealOrder.start(uint32(fastrand())); !enum.done(); enum.next() {
            p2 := allp[enum.position()]
            if pp == p2 { continue }

            // Steal half of p2's run queue
            if gp := runqsteal(pp, p2, i == 3); gp != nil {
                return gp, false
            }
        }
    }

stop:
    // Release P and park M
    pidleput(pp, now)
    return nil, false
}
```

### Observing Work Stealing

```go
// steal_demo.go
// Demonstrates work stealing with unbalanced goroutine distribution
package main

import (
	"fmt"
	"runtime"
	"runtime/trace"
	"os"
	"time"
)

func cpuBound(n int) int {
	result := 0
	for i := 0; i < n; i++ {
		result += i
	}
	return result
}

func main() {
	// Create trace file to observe scheduling
	f, _ := os.Create("scheduler.trace")
	defer f.Close()
	trace.Start(f)
	defer trace.Stop()

	runtime.GOMAXPROCS(4)

	// Create many goroutines all on one goroutine initially
	// Work stealing will redistribute them
	results := make(chan int, 1000)

	// Intentional: all goroutines created in one P's context
	for i := 0; i < 1000; i++ {
		go func(n int) {
			results <- cpuBound(n * 1000)
		}(i)
	}

	// Collect results
	for i := 0; i < 1000; i++ {
		<-results
	}

	fmt.Println("Done")
}
```

```bash
# Run and analyze the trace
go run steal_demo.go
go tool trace scheduler.trace

# In the trace viewer, look for:
# - Goroutine distribution across P's (should balance after stealing)
# - "goroutine unblocked" events showing goroutines moving between P's
# - Any P's showing long idle periods (would indicate work stealing gap)
```

## Section 3: Goroutine States

```
Goroutine State Machine:

  _Gidle        → just allocated, not yet used
      ↓
  _Gdead        → goroutine is dead (can be reused)

  _Grunnable    → ready to run, in run queue
      ↓ scheduled
  _Grunning     → currently executing on an M
      ↓ various events
  ├─→ _Grunnable    (preempted, back to run queue)
  ├─→ _Gsyscall     (entered a syscall)
  ├─→ _Gwaiting     (blocked: channel, mutex, sleep, select, etc.)
  └─→ _Gdead        (goroutine finished)

  _Gsyscall     → in a syscall (M can release P to another)
      ↓ syscall returns
  _Grunnable

  _Gwaiting     → parked waiting for event
      ↓ unparked (e.g., channel send unblocks receiver)
  _Grunnable
```

```go
// goroutine_states.go — illustrating state transitions
package main

import (
	"runtime"
	"sync"
	"time"
)

func main() {
	var wg sync.WaitGroup
	mu := sync.Mutex{}

	// Goroutine that transitions: Grunnable → Grunning → Gwaiting (mutex) → Grunnable → Grunning
	for i := 0; i < runtime.GOMAXPROCS(0) * 4; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()

			// Grunning: CPU work
			_ = fib(20)

			// Gwaiting: waiting on mutex
			mu.Lock()
			time.Sleep(1 * time.Millisecond)
			mu.Unlock()

			// Gwaiting: channel send (if receiver not ready)
			ch := make(chan int)
			go func() { ch <- 42 }()
			<-ch
		}(i)
	}

	wg.Wait()
}

func fib(n int) int {
	if n <= 1 { return n }
	return fib(n-1) + fib(n-2)
}
```

## Section 4: Preemption Points

Go 1.14+ introduced asynchronous preemption via signals (SIGURG on Linux), allowing goroutines to be preempted at any point. Before Go 1.14, preemption only occurred at function call boundaries.

### Cooperative Preemption Points

```go
// Go inserts preemption checks at function calls and certain loops
// These are cooperative — the goroutine yields voluntarily

func preemptionPoints() {
	// 1. Any function call — runtime checks preempt flag
	fmt.Println("function call")

	// 2. Memory allocation (runtime.newobject, runtime.makeslice)
	s := make([]byte, 1024)
	_ = s

	// 3. Stack growth (when goroutine stack needs to grow)

	// 4. Explicit yield
	runtime.Gosched()

	// 5. Channel operations (goroutine may park and yield M)
	ch := make(chan int, 1)
	ch <- 1
	<-ch
}

// Anti-pattern: tight loop with no preemption opportunities (pre-Go 1.14 issue)
// In Go 1.14+, SIGURG asynchronously preempts these
func noPreemptionBefore114(n int) int {
	sum := 0
	for i := 0; i < n; i++ {
		sum += i  // No function call, no channel, pure computation
		// Go 1.13-: goroutine cannot be preempted here
		// Go 1.14+: SIGURG can preempt at any safe point
	}
	return sum
}
```

### Observing Preemption

```bash
# GOTRACEBACK shows goroutine stacks including preemption state
GOTRACEBACK=all go run main.go 2>&1 | head -100

# Schedule trace shows preemption events
GODEBUG=schedtrace=1000 go run main.go 2>&1 | grep -E "gomaxprocs|runqueue|steal"
# Output: SCHED 1000ms: gomaxprocs=4 idleprocs=2 threads=8 spinningthreads=1
#         runqueue=0 [0 0 1 0] steal=24 syscalls=3

# Fields:
# gomaxprocs=4        — number of P's
# idleprocs=2         — P's with no work
# threads=8           — OS threads created
# spinningthreads=1   — M's spinning looking for work
# runqueue=0          — global run queue length
# [0 0 1 0]           — per-P run queue lengths
# steal=24            — total goroutines stolen since start
```

## Section 5: Syscall Handling

When a goroutine enters a syscall, its M cannot run other goroutines. The scheduler handles this by detaching the P:

```
Goroutine enters syscall:
  1. G transitions to _Gsyscall state
  2. M releases P (P becomes available for another M)
  3. M enters kernel with G
  4. Another M (or newly created M) picks up the released P
  5. When syscall returns:
     a. If original P is still available: M reclaims it
     b. If P was taken: M looks for another idle P
     c. If no P available: G parks, M returns to pool
```

```go
// syscall_demo.go — demonstrating syscall P release
package main

import (
	"fmt"
	"net"
	"runtime"
	"sync"
	"time"
)

func main() {
	runtime.GOMAXPROCS(2)  // Only 2 P's

	var wg sync.WaitGroup

	// Create more goroutines than P's — they'll share M's
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()

			// This goroutine will block on network I/O (syscall)
			// When blocked, its M releases the P, allowing another goroutine to run
			conn, err := net.DialTimeout("tcp", "127.0.0.1:12345", 10*time.Millisecond)
			if err != nil {
				return // Expected: nothing listening
			}
			conn.Close()
		}(i)
	}

	// These goroutines can run even though 100 goroutines are in syscall
	// because the P's are released during the syscall
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			time.Sleep(50 * time.Millisecond)
			fmt.Println("compute goroutine ran despite syscall goroutines")
		}()
	}

	wg.Wait()
}
```

### Monitoring Thread Creation

```bash
# Monitor goroutine and thread count
GODEBUG=schedtrace=1000,scheddetail=1 go run main.go 2>&1 | \
    grep -E "threads|goroutine" | head -20

# In production, use runtime metrics
go tool pprof http://localhost:6060/debug/pprof/goroutine
go tool pprof http://localhost:6060/debug/pprof/threadcreate
```

## Section 6: Goroutine Parking and Unparking

When a goroutine cannot proceed (waiting for a channel, mutex, timer), it parks itself and yields the M to the scheduler.

```go
// channel_parking.go — illustrating park/unpark mechanics
package main

import (
	"fmt"
	"runtime"
	"sync/atomic"
	"time"
)

// Low-level channel mechanics (conceptual):
//
// ch <- v  (send on full/unbuffered channel):
//   1. G creates a "sudog" (goroutine waiting struct) with value v
//   2. Appends sudog to ch.sendq
//   3. Calls gopark() — G transitions to _Gwaiting, M picks up next runnable G
//
// <-ch  (receive on empty channel):
//   1. If sender is waiting in sendq: directly transfer value, unpark sender
//   2. Otherwise: create sudog, append to ch.recvq, call gopark()
//
// When value becomes available:
//   1. Runtime calls goready(g) on parked G
//   2. G transitions back to _Grunnable, added to run queue
//   3. G will be scheduled on the next available P

func demonstrateParkUnpark() {
	ch := make(chan int)
	started := int32(0)

	receiver := make(chan struct{})

	// Receiver parks immediately (channel empty)
	go func() {
		atomic.StoreInt32(&started, 1)
		close(receiver)
		v := <-ch  // Parks here
		fmt.Printf("received: %d\n", v)
	}()

	<-receiver
	for atomic.LoadInt32(&started) == 0 {
		runtime.Gosched()
	}

	// Small delay to ensure receiver is parked
	time.Sleep(1 * time.Millisecond)

	// This unparks the receiver
	ch <- 42  // Finds receiver in ch.recvq, directly delivers value
}

// Inefficient pattern: goroutine spinning instead of parking
func spinningAntiPattern(done <-chan struct{}) {
	for {
		select {
		case <-done:
			return
		default:
			// BAD: busy-spins, consumes CPU, prevents work stealing
			// Use case <-done only (no default) to park goroutine
		}
	}
}

// Correct pattern: park the goroutine
func parkingPattern(done <-chan struct{}) {
	<-done  // Goroutine parks; M is released for other work
}
```

## Section 7: GOMAXPROCS Tuning

`GOMAXPROCS` controls the number of P's (logical processors) in the scheduler. Setting it incorrectly is a common source of both under-utilization and excess context switching.

### Default Behavior

```go
// Go's default: GOMAXPROCS = runtime.NumCPU()
// This is optimal for CPU-bound workloads

// Check current setting
fmt.Println("GOMAXPROCS:", runtime.GOMAXPROCS(0))
fmt.Println("NumCPU:", runtime.NumCPU())
```

### Container CPU Quota Problem

The most common GOMAXPROCS misconfiguration occurs in Kubernetes pods with CPU limits:

```yaml
# Pod with CPU limits
containers:
- name: app
  resources:
    requests:
      cpu: "1"
    limits:
      cpu: "2"       # 2 CPU cores worth of CFS quota
```

```go
// Without automaxprocs: Go sees the HOST CPU count, not the container quota
// A host with 64 cores will set GOMAXPROCS=64
// But the container only gets 2 CPU cores of quota
// Result: 64 P's competing for 2 CPUs — massive context switching overhead

// Symptom: high %sys CPU, many context switches
// Fix: use uber-go/automaxprocs

import _ "go.uber.org/automaxprocs"
// automaxprocs sets GOMAXPROCS based on CFS quota: ceil(quota/period)
// For 2 CPU quota: GOMAXPROCS = 2
```

```bash
# Without automaxprocs on 64-core host, 2-CPU-limit container:
# GOMAXPROCS = 64, but effective CPUs = 2
# Each scheduling period: up to 64 runnable goroutines competing for 2 CPU slots
# Context switches per second can be 10-100x higher than necessary

# Verify automaxprocs is working
kubectl exec -it <pod> -- env | grep GOMAXPROCS
# Should see: GOMAXPROCS=2 (matching the CPU limit)

# Or check at runtime
kubectl exec -it <pod> -- /bin/sh -c 'cat /proc/$(pgrep app)/status | grep Threads'
```

### When to Override GOMAXPROCS

```go
package main

import (
	"runtime"
	"os"
	"strconv"
)

func setGOMAXPROCS() {
	// 1. CPU-bound workload: use default (NumCPU or automaxprocs)
	// runtime.GOMAXPROCS(runtime.NumCPU())

	// 2. I/O-bound workload with many goroutines:
	// Fewer P's reduce scheduling overhead when most goroutines are parked
	// runtime.GOMAXPROCS(4)  // Even on 64-core host

	// 3. Latency-sensitive, single-request-at-a-time:
	// runtime.GOMAXPROCS(1)  // Eliminates all lock contention in scheduler

	// 4. From environment variable (for Kubernetes tuning)
	if v := os.Getenv("GOMAXPROCS"); v != "" {
		n, err := strconv.Atoi(v)
		if err == nil && n > 0 {
			runtime.GOMAXPROCS(n)
		}
	}
}

// Benchmark different GOMAXPROCS values
func benchmarkGOMAXPROCS() {
	for _, n := range []int{1, 2, 4, 8, 16, 32} {
		runtime.GOMAXPROCS(n)
		start := time.Now()
		runWorkload()
		duration := time.Since(start)
		fmt.Printf("GOMAXPROCS=%d: %v\n", n, duration)
	}
}
```

## Section 8: Scheduler Tracing

```go
// pprof_demo.go — expose pprof endpoints for scheduler analysis
package main

import (
	"net/http"
	_ "net/http/pprof"
	"log"
)

func main() {
	// Start pprof server
	go func() {
		log.Println(http.ListenAndServe(":6060", nil))
	}()

	// Application work...
	runApplication()
}
```

```bash
# Real-time goroutine trace
go tool pprof http://localhost:6060/debug/pprof/goroutine
# In pprof shell:
# (pprof) top20
# (pprof) list main.myFunction
# (pprof) web  # generates SVG

# Execution trace (most detailed)
curl http://localhost:6060/debug/pprof/trace?seconds=5 > trace.out
go tool trace trace.out
# Trace UI shows:
# - Goroutine scheduling events
# - P utilization over time
# - GC pauses
# - Syscall durations

# Mutex contention profile
go tool pprof http://localhost:6060/debug/pprof/mutex
# Requires: runtime.SetMutexProfileFraction(1) in your code

# Block profile (goroutines blocked on channels, mutexes)
go tool pprof http://localhost:6060/debug/pprof/block
# Requires: runtime.SetBlockProfileRate(1) in your code
```

### GODEBUG Scheduler Tracing

```bash
# schedtrace=N: print scheduling info every N milliseconds
GODEBUG=schedtrace=1000 ./myapp 2>&1 | head -20
# SCHED 0ms: gomaxprocs=8 idleprocs=7 threads=4 spinningthreads=0
#            needspinning=0 idlethreads=1 runqueue=0 [0 0 0 0 0 0 0 0]
#
# SCHED 1001ms: gomaxprocs=8 idleprocs=4 threads=9 spinningthreads=2
#              runqueue=4 [2 0 1 0 3 0 2 0] steal=8 syscalls=12

# Interpret:
# idleprocs=4    — 4 P's have no goroutines (waste if CPU-bound)
# runqueue=4     — 4 goroutines in global queue (local queues are full)
# steal=8        — 8 steal operations since start
# syscalls=12    — 12 goroutines currently in syscall

# scheddetail=1: verbose per-goroutine info (very noisy)
GODEBUG=schedtrace=5000,scheddetail=1 ./myapp 2>&1 | grep "goroutine" | head -50
```

## Section 9: Common Scheduler Problems

### Goroutine Leak

```go
// goroutine_leak_detector.go
package main

import (
	"fmt"
	"runtime"
	"time"
)

// Anti-pattern: goroutine that never terminates
func leakyServer(requests <-chan string) {
	go func() {
		for req := range requests {
			// If requests channel is never closed, goroutine leaks
			fmt.Println("handling:", req)
		}
	}()
}

// Detection: monitor goroutine count
func monitorGoroutines() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	prev := runtime.NumGoroutine()
	for range ticker.C {
		current := runtime.NumGoroutine()
		if current > prev+100 {
			fmt.Printf("WARN: goroutine count increased from %d to %d\n", prev, current)
		}
		prev = current
	}
}

// Fix: always pass a context for cancellation
func correctServer(ctx context.Context, requests <-chan string) {
	go func() {
		for {
			select {
			case req, ok := <-requests:
				if !ok { return }
				fmt.Println("handling:", req)
			case <-ctx.Done():
				return
			}
		}
	}()
}
```

### Scheduler Starvation

```go
// starvation_demo.go
// Demonstrating goroutine starvation and prevention

package main

import (
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
)

// Anti-pattern: goroutine that holds CPU without yielding
func greedy() {
	for {
		// Tight loop — never yields to scheduler
		// Can starve other goroutines (though asynchronous preemption helps in Go 1.14+)
		_ = runtime.NumGoroutine()
	}
}

// Fix: yield periodically for very long-running computations
func cooperative(n int) int {
	result := 0
	for i := 0; i < n; i++ {
		result += i
		if i%10000 == 0 {
			runtime.Gosched()  // Explicit yield point
		}
	}
	return result
}

// Mutex starvation: high-contention mutex causes some goroutines to wait forever
func demonstrateMutexStarvation() {
	var mu sync.Mutex
	var count int64

	// Many goroutines all trying to increment
	for i := 0; i < 100; i++ {
		go func() {
			for {
				mu.Lock()
				atomic.AddInt64(&count, 1)
				mu.Unlock()
			}
		}()
	}

	// Some goroutines will be starved — use sync.Mutex with fairness
	// Go's sync.Mutex is starvation-free since Go 1.9
	// After 1ms of starvation, mutex enters "starvation mode"
	// and direct-queues the next waiter instead of allowing new arrivals
}
```

### Goroutine Pool Pattern

```go
// pool.go — worker pool for controlling goroutine count
package pool

import (
	"context"
	"sync"
)

// WorkerPool limits concurrent goroutines to avoid overwhelming the scheduler
type WorkerPool struct {
	workers   chan struct{}
	wg        sync.WaitGroup
}

func New(size int) *WorkerPool {
	return &WorkerPool{
		workers: make(chan struct{}, size),
	}
}

// Submit runs fn in a worker goroutine, blocking until a worker is available
func (p *WorkerPool) Submit(ctx context.Context, fn func()) error {
	select {
	case p.workers <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}

	p.wg.Add(1)
	go func() {
		defer func() {
			<-p.workers
			p.wg.Done()
		}()
		fn()
	}()
	return nil
}

// Wait blocks until all submitted work completes
func (p *WorkerPool) Wait() {
	p.wg.Wait()
}

// Usage: prevents creating thousands of goroutines for batch operations
func processItems(items []string) {
	pool := New(runtime.GOMAXPROCS(0) * 4)
	ctx := context.Background()

	for _, item := range items {
		item := item
		_ = pool.Submit(ctx, func() {
			processItem(item)
		})
	}
	pool.Wait()
}
```

## Section 10: Performance Analysis Tools

```go
// benchmark_scheduler.go
package main

import (
	"runtime"
	"sync"
	"testing"
)

// Benchmark goroutine creation overhead
func BenchmarkGoroutineCreate(b *testing.B) {
	var wg sync.WaitGroup
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		wg.Add(1)
		go func() {
			wg.Done()
		}()
	}
	wg.Wait()
}

// Benchmark channel communication latency
func BenchmarkChannelLatency(b *testing.B) {
	ch := make(chan int)
	go func() {
		for range ch {
			ch <- 1
		}
	}()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ch <- 1
		<-ch
	}
}

// Benchmark work stealing overhead
func BenchmarkWorkStealing(b *testing.B) {
	procs := runtime.GOMAXPROCS(0)
	var wg sync.WaitGroup

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		wg.Add(procs)
		for j := 0; j < procs; j++ {
			go func() {
				// Minimal work — tests scheduling overhead
				wg.Done()
			}()
		}
		wg.Wait()
	}
}

// Run: go test -bench=. -count=5 -cpu=1,2,4,8 ./...
// Compare results at different GOMAXPROCS values
```

### Scheduler Latency Analysis

```go
// sched_latency.go — measure time from goroutine creation to first execution
package main

import (
	"fmt"
	"runtime"
	"sort"
	"time"
)

func measureSchedulingLatency(n int) {
	latencies := make([]time.Duration, n)
	var wg sync.WaitGroup

	wg.Add(n)
	for i := 0; i < n; i++ {
		i := i
		created := time.Now()
		go func() {
			// First instruction after goroutine is scheduled
			latencies[i] = time.Since(created)
			wg.Done()
		}()
	}
	wg.Wait()

	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })

	fmt.Printf("Scheduling latency (GOMAXPROCS=%d, n=%d):\n", runtime.GOMAXPROCS(0), n)
	fmt.Printf("  p50:  %v\n", latencies[n/2])
	fmt.Printf("  p99:  %v\n", latencies[n*99/100])
	fmt.Printf("  p999: %v\n", latencies[n*999/1000])
	fmt.Printf("  max:  %v\n", latencies[n-1])
}

func main() {
	for _, maxprocs := range []int{1, 2, 4, 8} {
		runtime.GOMAXPROCS(maxprocs)
		measureSchedulingLatency(10000)
	}
}
```

## Section 11: Production Tuning Checklist

```
Go Scheduler Production Checklist:

GOMAXPROCS:
  [ ] Using automaxprocs in Kubernetes (go.uber.org/automaxprocs)
  [ ] Verified GOMAXPROCS matches CPU quota (not host CPU count)
  [ ] Profiled optimal GOMAXPROCS for your workload type
  [ ] Set appropriate CPU requests and limits in k8s (requests = limits for predictable GOMAXPROCS)

Goroutine Health:
  [ ] Monitor goroutine count via runtime.NumGoroutine() metric
  [ ] Alert on goroutine count growth (goroutine leak)
  [ ] All goroutines have cancellation via context
  [ ] Worker pools used for batch operations (not unbounded goroutine creation)
  [ ] pprof endpoint enabled in production with auth

Profiling:
  [ ] Execution trace captured at 5-10% load before performance problems
  [ ] CPU profile baseline established
  [ ] Block profile rate set (runtime.SetBlockProfileRate(100))
  [ ] Mutex profile rate set (runtime.SetMutexProfileFraction(100))

GODEBUG Flags for Debugging:
  [ ] schedtrace=1000 to check P utilization and work stealing
  [ ] asyncpreemptoff=1 to diagnose preemption-related issues
  [ ] efence=1 for memory safety analysis in staging

Benchmarking:
  [ ] Run with -cpu=1,2,4,8 flags to find scaling bottlenecks
  [ ] Measure goroutine creation and channel latency baselines
  [ ] Test under realistic load (not just synthetic benchmarks)
```
