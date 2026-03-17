---
title: "Go Coroutines vs Goroutines: Cooperative vs Preemptive Scheduling"
date: 2029-09-07T00:00:00-05:00
draft: false
tags: ["Go", "Goroutines", "Concurrency", "Scheduler", "Runtime", "Performance"]
categories: ["Go", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "An in-depth examination of Go goroutine scheduling mechanics, the history of goroutine preemption from cooperative to asynchronous preemption in Go 1.14, goroutine size comparison with OS threads and green threads, and scheduling fairness analysis."
more_link: "yes"
url: "/go-coroutines-vs-goroutines-scheduling/"
---

Goroutines are often called "lightweight threads" or "green threads," but neither label captures their full behavior. Goroutines are closer to cooperatively scheduled coroutines from the early days of the Go runtime, but since Go 1.14 they have asynchronous preemption. This post traces the evolution of goroutine scheduling from purely cooperative to the current preemptive model, explains why the distinction matters for production systems, and compares goroutines against coroutines and OS threads across multiple dimensions.

<!--more-->

# Go Coroutines vs Goroutines: Cooperative vs Preemptive Scheduling

## Coroutines: The Conceptual Foundation

A coroutine is a function that can suspend its execution and yield control to another coroutine, later resuming from exactly where it left off. The critical property is that suspension is *explicit and cooperative* — the coroutine decides when to yield.

Python's generators and async/await, Lua's coroutines, and C++ coroutines (C++20) all implement this model. The coroutine scheduler has no authority to interrupt a running coroutine; it can only run the next coroutine when the current one yields.

```python
# Python coroutine: cooperative scheduling
async def fetch_data(url):
    # Explicit yield point - control returns to event loop
    response = await http_client.get(url)
    return response

# If fetch_data had a CPU-bound loop with no awaits,
# no other coroutine could run until it returned
async def bad_coroutine():
    result = 0
    for i in range(10_000_000):  # Blocks the event loop entirely
        result += i
    return result
```

This cooperative nature is both the strength and weakness of coroutine-based concurrency. The programmer controls scheduling points, so there are no race conditions from preemption within a coroutine. But a misbehaving coroutine can starve all others.

## Early Go: Cooperative Goroutines

Go goroutines were initially cooperative in a similar sense. The scheduler only took control at specific "schedule points":

- Function calls (the scheduler could preempt at function entry)
- Channel operations
- System calls
- `runtime.Gosched()` explicit yield
- Blocking operations (network I/O, sync primitives)

The Go scheduler inserts preemption checks at function prologues. When the goroutine stack needs to grow, the prologue code runs and the scheduler can intervene. This is the goroutine's stack growth mechanism doubling as a scheduling mechanism.

```go
package main

import (
    "fmt"
    "runtime"
    "time"
)

// Before Go 1.14: this goroutine could NOT be preempted
// It runs in a tight loop with no function calls except the inner arithmetic
func cpuBound() {
    sum := 0
    for i := 0; i < 1_000_000_000; i++ {
        sum += i
    }
    fmt.Println("done:", sum)
}

func main() {
    runtime.GOMAXPROCS(1)  // Single OS thread to demonstrate

    go cpuBound()

    // On Go versions before 1.14, this Sleep might not return promptly
    // because cpuBound holds the OS thread
    time.Sleep(100 * time.Millisecond)
    fmt.Println("main continues")
}
```

On Go 1.13 with `GOMAXPROCS=1`, `cpuBound()` could monopolize the OS thread for the entire billion-iteration loop before the scheduler could run `main`'s goroutine. The `time.Sleep` would effectively not sleep until `cpuBound` yielded.

## Go 1.14: Asynchronous Preemption

Go 1.14 introduced signal-based asynchronous preemption. The runtime now sends `SIGURG` signals to OS threads at regular intervals (approximately 10ms). When the signal handler fires, it checks if the current goroutine is preemptible and if so, suspends it.

The implementation is elegant but complex:

1. The runtime's `sysmon` goroutine runs on its own OS thread and monitors all goroutines
2. When `sysmon` detects a goroutine has been running for more than 10ms, it sends `SIGURG` to the goroutine's thread
3. The signal handler inspects the goroutine's current state
4. If the goroutine is in a safe state (not executing a `go:nosplit` function, not modifying stack metadata), the signal handler injects a call to `runtime.asyncPreempt`
5. `asyncPreempt` saves the goroutine state and returns control to the scheduler

```
SIGURG signal arrives
    |
    v
Signal handler runs (in OS thread's signal context)
    |
    v
Is the goroutine in a safe preemption state?
    |
    +-- No: set preemption flag, return
    |
    +-- Yes: inject asyncPreempt call, return
                |
                v
        asyncPreempt runs in goroutine context
                |
                v
        Save all registers to goroutine stack
                |
                v
        Call mcall(preemptPark) to yield
                |
                v
        Scheduler picks next runnable goroutine
```

### Verifying Preemption Works

```go
package main

import (
    "fmt"
    "runtime"
    "sync/atomic"
    "time"
)

func main() {
    runtime.GOMAXPROCS(1)  // Force single-thread to make preemption visible

    var counter int64

    // CPU-bound goroutine with no explicit yield points
    go func() {
        for {
            atomic.AddInt64(&counter, 1)
        }
    }()

    // On Go 1.14+, this loop runs even with GOMAXPROCS=1 because
    // the CPU-bound goroutine gets preempted
    for i := 0; i < 5; i++ {
        time.Sleep(100 * time.Millisecond)
        fmt.Printf("counter at %dms: %d\n", (i+1)*100, atomic.LoadInt64(&counter))
    }
}

// Output on Go 1.14+ (approximate):
// counter at 100ms: 89234123
// counter at 200ms: 178456231
// counter at 300ms: 267234123
// counter at 400ms: 356789012
// counter at 500ms: 445123456
//
// On Go 1.13 with GOMAXPROCS=1, the main goroutine might never print
// because cpuBound holds the thread indefinitely
```

## Goroutine Stack Size and Memory Model

One of the most significant differences between goroutines and OS threads is memory footprint.

### OS Thread Stack

An OS thread's stack is allocated at thread creation by the kernel. Default sizes vary by OS:

```
Linux:   8 MB default (ulimit -s)
macOS:   8 MB default
Windows: 1 MB default
```

This is committed virtual memory that cannot be reclaimed while the thread is alive. Creating 10,000 OS threads would require 80 GB of virtual address space on Linux.

### Goroutine Stack: Starting Small, Growing as Needed

Goroutines start with a 2KB (2048 byte) stack in Go 1.4+. Earlier versions used 8KB. The stack grows dynamically via the "stack copying" mechanism:

```
Initial goroutine stack: 2 KB
First growth:            4 KB
Second growth:           8 KB
...
Maximum (default):       1 GB (configurable via GOTRACEBACK)
```

The stack growth trigger is in every function prologue:

```asm
; Generated x86-64 function prologue
MOVQ  (TLS), CX          ; Load G pointer (current goroutine)
CMPQ  SP, stackguard0(CX) ; Compare SP against stack guard
JBE   stackgrow           ; Jump if SP is below the guard (stack overflow)
; ... function body ...
stackgrow:
CALL  runtime.morestack_noctxt  ; Grow the stack
```

When `morestack` is called, it:
1. Allocates a new, larger stack
2. Copies all existing stack frames to the new stack
3. Updates all pointers in copied frames to point to new locations
4. Resumes execution

```go
package main

import (
    "fmt"
    "runtime"
)

// Demonstrate goroutine stack growth
func recurse(depth int) int {
    if depth == 0 {
        // Report current stack usage
        var stats runtime.MemStats
        runtime.ReadMemStats(&stats)
        return 0
    }
    // Each frame uses ~32 bytes; after enough recursion,
    // the 2KB initial stack will grow
    buf := [32]byte{}
    _ = buf
    return recurse(depth-1) + 1
}

func goroutineStackDemo() {
    // Get goroutine stack info
    buf := make([]byte, 64*1024)
    n := runtime.Stack(buf, false)
    fmt.Printf("Stack trace size: %d bytes\n", n)
}

func main() {
    // Spawn 100,000 goroutines - feasible because each starts at 2KB
    const numGoroutines = 100_000
    done := make(chan struct{}, numGoroutines)

    var memBefore runtime.MemStats
    runtime.ReadMemStats(&memBefore)

    for i := 0; i < numGoroutines; i++ {
        go func() {
            // Simulate some work
            sum := 0
            for j := 0; j < 1000; j++ {
                sum += j
            }
            done <- struct{}{}
        }()
    }

    for i := 0; i < numGoroutines; i++ {
        <-done
    }

    var memAfter runtime.MemStats
    runtime.ReadMemStats(&memAfter)

    heapGrowth := memAfter.HeapInuse - memBefore.HeapInuse
    fmt.Printf("Heap growth for %d goroutines: %d MB\n",
        numGoroutines, heapGrowth/1024/1024)
    // Typically: ~200-400 MB for 100,000 goroutines
    // vs 800,000 MB for 100,000 OS threads at 8MB each
}
```

### Goroutine vs Thread vs Green Thread Comparison

| Property | OS Thread | Green Thread | Goroutine |
|---|---|---|---|
| Stack size | 1-8 MB (fixed) | Varies (fixed or grown) | 2 KB (grows dynamically) |
| Scheduling | Kernel (preemptive) | Runtime (cooperative) | Runtime (async preemptive) |
| Context switch cost | ~2-10 μs | ~100-500 ns | ~100-300 ns |
| M:N mapping | 1:1 | M:N | M:N |
| Preemption | Yes (kernel signals) | No (cooperative only) | Yes (SIGURG, Go 1.14+) |
| Blocking syscall | Parks thread | May block all green threads | Uses separate OS thread |
| Max practical count | ~10,000 | ~100,000+ | ~1,000,000+ |

## The M:N Scheduler Architecture

Go's scheduler maps M goroutines onto N OS threads (where N typically equals `GOMAXPROCS`). The scheduler has three primary structures:

```
G: Goroutine - represents a function and its stack
M: Machine - OS thread
P: Processor - scheduling context, holds a run queue

Each P has:
  - Local run queue (up to 256 goroutines)
  - Pointer to current M (OS thread)
  - Pointer to current G (running goroutine)

Global run queue: overflow when local queues are full
```

### Work Stealing

When a P's local run queue is empty, it steals goroutines from other Ps:

```
P0 local queue: [G1, G2, G3, G4, G5, G6, G7, G8]
P1 local queue: []  <- empty

P1 steals: takes half of P0's queue
P0 local queue: [G1, G2, G3, G4]
P1 local queue: [G5, G6, G7, G8]
```

Work stealing prevents idle Ps from waiting when goroutines are available elsewhere. The stealing algorithm is in `runtime/proc.go:runqsteal`.

### Observing Scheduler Behavior

```bash
# GODEBUG=schedtrace shows scheduler state at intervals
GODEBUG=schedtrace=1000 go run myapp.go

# Output format:
# SCHED 1000ms: gomaxprocs=8 idleprocs=6 threads=10 spinningthreads=0 \
#               needspinning=0 idlethreads=3 runqueue=0 [0 0 0 0 0 0 0 0]
#   gomaxprocs: number of Ps
#   idleprocs: Ps with no work
#   threads: total OS threads
#   runqueue: global run queue length
#   [0 0 ...]: local run queue length per P

# scheddetail adds per-goroutine information
GODEBUG=schedtrace=1000,scheddetail=1 go run myapp.go
```

## Scheduling Fairness

Goroutine scheduling fairness means that no goroutine should be permanently starved. The Go scheduler implements several mechanisms for fairness.

### Local Queue Fairness

When a new goroutine is created with `go`, it enters the current P's local run queue. The scheduler alternates between the local queue and the global queue to prevent local-queue-only starvation:

```go
// Simplified scheduler logic (from runtime/proc.go)
func schedule() {
    // Every 61st schedule, check global queue first
    // This prevents global queue starvation
    if gp == nil && pp.schedtick%61 == 0 {
        gp = globrunqget(pp, 1)
    }

    // Otherwise, prefer local queue
    if gp == nil {
        gp, inheritTime, tryWakeP = findRunnable()
    }

    execute(gp, inheritTime)
}
```

The `schedtick%61` check ensures global queue goroutines get CPU time even when local queues are full.

### Goroutine Fairness in Channels

Channel operations are fair: goroutines waiting on a channel are served in FIFO order. A goroutine that has been waiting longest is woken first when data becomes available.

```go
package main

import (
    "fmt"
    "sync"
    "time"
)

func fairnessDemo() {
    ch := make(chan int, 1)
    var wg sync.WaitGroup

    // Start 5 goroutines waiting on the same channel
    for i := 0; i < 5; i++ {
        wg.Add(1)
        id := i
        time.Sleep(time.Millisecond) // Stagger to ensure ordering
        go func() {
            defer wg.Done()
            val := <-ch
            fmt.Printf("Goroutine %d received %d\n", id, val)
        }()
    }

    // Send 5 values - goroutines should receive in order they started waiting
    time.Sleep(100 * time.Millisecond) // Ensure all goroutines are waiting
    for i := 0; i < 5; i++ {
        ch <- i
    }

    wg.Wait()
}
```

### Timer Fairness

Timers in Go are implemented as a min-heap per P. Timer goroutines are woken at the correct time, but the exact scheduling still depends on whether there's an available P. Under extreme load, timers may fire slightly late.

```go
package main

import (
    "fmt"
    "time"
)

// Measure timer accuracy under load
func timerAccuracy() {
    const numTimers = 1000
    const targetDelay = 10 * time.Millisecond

    results := make([]time.Duration, numTimers)
    done := make(chan struct{}, numTimers)

    for i := 0; i < numTimers; i++ {
        idx := i
        start := time.Now()
        time.AfterFunc(targetDelay, func() {
            actual := time.Since(start)
            results[idx] = actual - targetDelay // Measure jitter
            done <- struct{}{}
        })
    }

    for i := 0; i < numTimers; i++ {
        <-done
    }

    var totalJitter time.Duration
    var maxJitter time.Duration
    for _, j := range results {
        if j < 0 {
            j = -j
        }
        totalJitter += j
        if j > maxJitter {
            maxJitter = j
        }
    }

    fmt.Printf("Average timer jitter: %v\n", totalJitter/numTimers)
    fmt.Printf("Max timer jitter: %v\n", maxJitter)
}
```

## go:nosplit and Preemption-Safe Code

The `//go:nosplit` pragma marks functions that cannot grow the stack and therefore cannot be preempted at their function entry:

```go
//go:nosplit
func atomicAdd(p *int64, delta int64) int64 {
    // This function runs without stack growth checks
    // The scheduler cannot preempt here
    return *p + delta
}
```

`go:nosplit` functions must be short and cannot call other functions (that themselves are not `go:nosplit`). The linker verifies that the combined stack depth of a `go:nosplit` call chain stays within a safe limit (128 bytes for goroutines, 800 bytes for the signal handler stack).

Asynchronous preemption via SIGURG also checks for `go:nosplit` — these functions are always skipped for preemption.

## Context Switch Cost Analysis

Measuring goroutine context switch overhead:

```go
package main

import (
    "fmt"
    "runtime"
    "sync"
    "time"
)

// BenchmarkContextSwitch measures goroutine context switch cost
// by ping-ponging between two goroutines
func benchmarkContextSwitch() time.Duration {
    runtime.GOMAXPROCS(1) // Force single thread for clean measurement

    const iterations = 1_000_000
    ch1 := make(chan struct{})
    ch2 := make(chan struct{})

    var wg sync.WaitGroup
    wg.Add(2)

    go func() {
        defer wg.Done()
        for i := 0; i < iterations; i++ {
            ch1 <- struct{}{}
            <-ch2
        }
    }()

    go func() {
        defer wg.Done()
        for i := 0; i < iterations; i++ {
            <-ch1
            ch2 <- struct{}{}
        }
    }()

    start := time.Now()
    // Start the chain
    ch1 <- struct{}{}
    wg.Wait()
    elapsed := time.Since(start)

    // Each iteration involves 2 context switches
    switchCost := elapsed / time.Duration(iterations*2)
    return switchCost
}

func main() {
    cost := benchmarkContextSwitch()
    fmt.Printf("Goroutine context switch: ~%v\n", cost)
    // Typical output: ~150-300 ns per context switch
    // OS thread context switch: ~2000-10000 ns
}
```

## Practical Implications for Production Code

### When Cooperative Yield Is Needed

Even with preemptive scheduling, some scenarios benefit from explicit yields:

```go
package main

import (
    "runtime"
)

// ProcessLargeBatch processes items but yields periodically to prevent
// scheduler starvation of other goroutines (latency-sensitive paths)
func ProcessLargeBatch(items []Item) {
    for i, item := range items {
        process(item)

        // Yield every 1000 items to allow other goroutines to run
        // This reduces latency variance for other concurrent operations
        if i%1000 == 0 {
            runtime.Gosched()
        }
    }
}

type Item struct{ data [64]byte }

func process(item Item) {
    // Simulate CPU work
    _ = item
}
```

### goroutine Leak Detection

Goroutines that are stuck waiting on channels or blocked syscalls contribute to goroutine leaks. The scheduler cannot preempt them because they're not using CPU — they're legitimately blocked.

```go
package main

import (
    "context"
    "fmt"
    "runtime"
    "time"
)

// LeakDetector periodically reports goroutine count
type LeakDetector struct {
    baseline int
    ticker   *time.Ticker
}

func NewLeakDetector(interval time.Duration) *LeakDetector {
    d := &LeakDetector{
        baseline: runtime.NumGoroutine(),
        ticker:   time.NewTicker(interval),
    }
    go d.monitor()
    return d
}

func (d *LeakDetector) monitor() {
    for range d.ticker.C {
        current := runtime.NumGoroutine()
        delta := current - d.baseline
        if delta > 100 {
            fmt.Printf("WARNING: Goroutine count grew by %d (baseline: %d, current: %d)\n",
                delta, d.baseline, current)
            // Print stack traces of all goroutines
            buf := make([]byte, 1024*1024)
            n := runtime.Stack(buf, true)
            fmt.Printf("Stack traces:\n%s\n", buf[:n])
        }
    }
}

// Properly context-aware goroutine avoids leaks
func startWorker(ctx context.Context, input <-chan string) {
    go func() {
        for {
            select {
            case msg, ok := <-input:
                if !ok {
                    return
                }
                _ = msg
            case <-ctx.Done():
                // Context canceled, goroutine exits
                return
            }
        }
    }()
}
```

## Summary

The journey from cooperative goroutines to asynchronous preemption reflects Go's maturation as a production language. Key points:

- Goroutines are not coroutines: since Go 1.14, they are asynchronously preemptible via SIGURG
- Goroutines are not OS threads: they start at 2 KB and scale to millions per process
- Goroutines are not green threads: the M:N scheduler maps them across multiple OS threads with work stealing
- The Go scheduler's 10ms preemption window prevents CPU-bound goroutines from starving I/O-bound ones
- `go:nosplit` functions opt out of preemption for small, critical sections
- Channel operations are FIFO-fair; timer fairness depends on P availability
- Context switches cost ~150-300 ns, roughly 10x cheaper than OS thread switches
- Goroutine leaks come from blocked goroutines, not CPU-bound ones — the scheduler cannot reclaim blocked goroutines
