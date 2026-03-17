---
title: "Go Scheduler Internals: Work Stealing and GOMAXPROCS Tuning"
date: 2031-03-02T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Scheduler", "Performance", "Concurrency", "GOMAXPROCS", "Runtime"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into the Go scheduler's M:N threading model, work-stealing algorithm, P lifecycle, asynchronous goroutine preemption, and GOMAXPROCS tuning for CPU-bound vs I/O-bound workloads."
more_link: "yes"
url: "/go-scheduler-internals-work-stealing-gomaxprocs-tuning/"
---

The Go scheduler is a user-space M:N scheduler embedded in the runtime. It multiplexes thousands of goroutines onto a small fixed pool of OS threads, using a work-stealing algorithm to balance load across logical processors. Understanding its internals directly informs decisions about GOMAXPROCS, goroutine pool sizing, and container CPU limits. This guide dissects every layer of the scheduler from first principles.

<!--more-->

# Go Scheduler Internals: Work Stealing and GOMAXPROCS Tuning

## Section 1: The M:N Threading Model

### Three Scheduler Entities

The Go scheduler operates on three entity types:

**G (goroutine)**: A lightweight unit of execution. Each G has its own stack (starting at 2–8 KB, growing as needed), a program counter, and goroutine-local state. Goroutines are cheap to create — millions can coexist with moderate memory overhead.

**M (machine / OS thread)**: A real operating system thread. The Go runtime creates and parks M's as needed. An M must acquire a P before it can run Go code. An M without a P can still execute system calls and interact with the runtime.

**P (processor)**: A logical processor. The total count of active P's is controlled by GOMAXPROCS. Each P maintains a local run queue of goroutines waiting to execute. A P is required to run Go code — it provides the scheduling context and the memory allocator's per-P caches (mcache).

The relationship: `M runs G on P`. An M holds one P, which holds one running G plus a local queue of ready-to-run G's.

### Scheduler State Diagram

```
                          global run queue (GRQ)
                         ┌──────────────────────┐
                         │  G7 G8 G9 G10 ...    │
                         └──────────────────────┘
                                    │  steal or schedule
          ┌─────────────────────────┼──────────────────────────┐
          │                         │                          │
    ┌─────▼──────┐           ┌──────▼─────┐           ┌───────▼────┐
    │     P0     │           │     P1     │           │     P2     │
    │  LRQ: G1G2 │           │  LRQ: G4  │           │  LRQ: (empty) │
    │  running:  │           │  running: │           │  running:  │
    │     G3     │           │     G5    │           │     G6     │
    └──────┬─────┘           └──────┬────┘           └──────┬─────┘
           │                        │                        │
    ┌──────▼──────┐         ┌───────▼─────┐         ┌───────▼────┐
    │     M0      │         │      M1     │         │     M2     │
    │ (OS thread) │         │ (OS thread) │         │ (OS thread)│
    └─────────────┘         └─────────────┘         └─────────────┘
```

When P2's local run queue is empty, the scheduler steals work from other P's or the global run queue.

## Section 2: The Work-Stealing Algorithm

### Local Run Queue (LRQ)

Each P has a circular ring buffer of size 256 holding pointers to runnable goroutines. Operations on the LRQ are lock-free (except when stealing).

When a new goroutine is spawned (`go f()`):
1. If the current P's LRQ has space, the new G is placed at the tail.
2. If the LRQ is full, half of the LRQ is moved to the global run queue (GRQ), and the new G is placed in the now-half-empty LRQ.

### Stealing from Other P's

When an M's P has an empty LRQ and the GRQ is empty, the scheduler runs the work-stealing loop:

```
for stealAttempts = 0; stealAttempts < 4; stealAttempts++ {
    // Randomly pick a victim P
    victim = allP[fastrand() % nP]
    if victim.LRQ.len > 0 {
        // Steal half of victim's LRQ
        n = victim.LRQ.len / 2
        move n goroutines from victim.LRQ to our P's LRQ
        return
    }
}

// Fall back to global run queue
if GRQ.len > 0 {
    take min(GRQ.len/nP + 1, 128) goroutines from GRQ
    return
}

// Check netpoller for goroutines unblocked by I/O
if netpoll.ready() {
    return netpoll goroutines
}

// Truly idle: park the M
```

The random victim selection means stealing is O(1) on average and avoids contention hotspots.

### Source Code Reference

The core scheduling logic lives in `src/runtime/proc.go`. Key functions:

- `schedule()`: The main scheduler loop. Finds the next G to run.
- `findRunnable()`: Implements the work-stealing search.
- `runqsteal()`: Steals from a victim P's run queue.
- `runqput()`: Puts a G into the current P's run queue.
- `runqget()`: Gets a G from the current P's run queue (or steals if empty).

## Section 3: P Lifecycle and Spinning

### Spinning M's

To minimize latency when new goroutines are created, the runtime keeps some M's in a "spinning" state — they have a P but no G to run, and are actively polling for work. Spinning threads consume CPU but reduce goroutine scheduling latency to near-zero.

The invariant maintained:

```
spinning_Ms + idle_Ms >= max(P_with_work - 1, 0)
```

If there are 4 P's with work and 0 spinning M's, the runtime will wake up an idle M (or create a new one) to spin on one of the idle P's.

The number of spinning M's is capped at `GOMAXPROCS / 2`, preventing excessive CPU consumption in idle programs.

### Sysmon — The Background Monitor

`sysmon` is a special goroutine that runs without a P (in a dedicated OS thread) and performs several critical functions:

1. **Preempt long-running goroutines**: Goroutines that have run for >10ms without a scheduling point are preempted (described below).
2. **Retake P's from blocked syscalls**: If an M is stuck in a syscall and its P is idle, sysmon takes the P away and gives it to another M.
3. **Run the garbage collector** if GC is due.
4. **Poll the netpoller** to unblock goroutines waiting on I/O.

```go
// Simplified sysmon logic (from runtime/proc.go)
func sysmon() {
    for {
        usleep(10) // Sleep 10-20 microseconds, adaptive

        // Check for long-running goroutines to preempt
        retake(now)

        // Force GC if overdue
        if t := forcegchelper(); t > 0 {
            gcStart()
        }

        // Scavenge memory
        scavenge()
    }
}
```

## Section 4: Goroutine Preemption

### Cooperative Preemption (Go 1.13 and Earlier)

Prior to Go 1.14, goroutines could only be preempted at safe points: function calls, channel operations, and certain built-in operations. A goroutine running a tight CPU loop (no function calls) could hold its P indefinitely, starving other goroutines.

```go
// This would prevent preemption in Go 1.13 and earlier
func badLoop() {
    i := 0
    for {
        i++    // No function call = no preemption point
        _ = i
    }
}
```

### Asynchronous Preemption (Go 1.14+)

Go 1.14 introduced asynchronous preemption using POSIX signals. When sysmon detects a goroutine has been running for >10ms:

1. sysmon sends `SIGURG` to the OS thread running that goroutine.
2. The signal handler in the runtime captures the goroutine's current execution state (registers, PC, SP).
3. The goroutine is marked as preempted.
4. On the next instruction boundary, the goroutine's stack is unwound to the signal handler, which schedules the next goroutine.

This allows preemption of any goroutine, including tight loops:

```go
// This is now safely preemptible in Go 1.14+
func safeLoop() {
    i := 0
    for {
        i++    // Preemptible via SIGURG
        _ = i
    }
}
```

**Implications for profiling**: `pprof` uses the same SIGURG-based signal delivery mechanism for CPU profiling. This means CPU profiles can now accurately capture time spent in tight loops.

### Stack Scan Points

Even with async preemption, goroutines can only be preempted at "safe points" where the GC can scan the goroutine stack. The compiler inserts stack-scan metadata at every instruction that might hold a pointer. The runtime uses this metadata during preemption to correctly identify GC roots.

## Section 5: GOMAXPROCS Tuning

### Default Behavior

Since Go 1.5, `GOMAXPROCS` defaults to `runtime.NumCPU()`, which returns the number of logical CPUs visible to the process. In a container, this means all CPUs on the host unless CPU affinity or cgroups limits are set.

### The Container CPU Limits Problem

When running in Kubernetes with CPU limits, the container may see 40 CPUs (the host count) but only be allowed to use 2 CPU-seconds per second (a limit of `2000m`). Setting GOMAXPROCS=40 creates 40 P's, 40 spinning OS threads, and massive context-switching overhead as the kernel throttles the container.

**Incorrect behavior** (GOMAXPROCS=40 with 2 CPU limit):
```
Container CPU quota: 200ms per 100ms period (2 cores)
GOMAXPROCS: 40
OS threads created: 40+
Scheduler overhead: ~30% of CPU time switching between 40 threads
Effective compute: ~1.4 cores (of 2 allowed)
```

**Correct behavior** (GOMAXPROCS=2 with 2 CPU limit):
```
Container CPU quota: 200ms per 100ms period (2 cores)
GOMAXPROCS: 2
OS threads running: 2
Effective compute: ~1.95 cores (of 2 allowed)
```

### automaxprocs — The Standard Solution

The `go.uber.org/automaxprocs` package reads the Linux cgroup CPU quota and sets GOMAXPROCS accordingly at program startup:

```go
package main

import (
    "log"

    _ "go.uber.org/automaxprocs"
)

func main() {
    // automaxprocs reads /sys/fs/cgroup/cpu/cpu.cfs_quota_us
    // and /sys/fs/cgroup/cpu/cpu.cfs_period_us
    // then calls runtime.GOMAXPROCS(ceil(quota / period))
    log.Println("GOMAXPROCS set automatically from cgroup CPU quota")

    // rest of program
}
```

Always include `automaxprocs` as a blank import in production Go services deployed to containers.

### Manual GOMAXPROCS Tuning

For services where automaxprocs is not sufficient, understand these tuning scenarios:

**CPU-bound workload (image processing, cryptography, compression)**:

```go
import "runtime"

// Use all available CPUs
runtime.GOMAXPROCS(runtime.NumCPU())

// Or use 75% of CPUs to leave headroom for OS and other processes
runtime.GOMAXPROCS(max(1, runtime.NumCPU()*3/4))
```

**I/O-bound workload (HTTP server, database client)**:

```go
// I/O-bound workloads spend most time blocked on network/disk.
// GOMAXPROCS = NumCPU is still correct because when goroutines
// are blocked in the netpoller, they don't consume a P.
// However, consider limiting to avoid scheduler overhead.
runtime.GOMAXPROCS(runtime.NumCPU())

// If you see excessive context switching, cap at a lower value
// and rely on goroutine concurrency for I/O multiplexing
runtime.GOMAXPROCS(min(runtime.NumCPU(), 8))
```

**Mixed workload (database with background CPU tasks)**:

For a service that does both I/O multiplexing and background CPU work, the default of `NumCPU` is generally correct. Tune down only if profiling shows scheduler overhead.

### Measuring Scheduler Overhead

```go
package main

import (
    "fmt"
    "runtime"
    "time"
)

func benchmarkGOMAXPROCS(maxprocs int, work func()) time.Duration {
    old := runtime.GOMAXPROCS(maxprocs)
    defer runtime.GOMAXPROCS(old)

    start := time.Now()
    work()
    return time.Since(start)
}

func cpuBoundWork() {
    const goroutines = 10000
    done := make(chan struct{}, goroutines)
    for i := 0; i < goroutines; i++ {
        go func() {
            // Simulate CPU-bound work
            sum := 0
            for j := 0; j < 100000; j++ {
                sum += j
            }
            _ = sum
            done <- struct{}{}
        }()
    }
    for i := 0; i < goroutines; i++ {
        <-done
    }
}

func main() {
    for _, p := range []int{1, 2, 4, 8, 16} {
        d := benchmarkGOMAXPROCS(p, cpuBoundWork)
        fmt.Printf("GOMAXPROCS=%2d: %v\n", p, d)
    }
}
```

Example output on an 8-core machine:

```
GOMAXPROCS= 1: 2.341s
GOMAXPROCS= 2: 1.198s
GOMAXPROCS= 4: 621ms
GOMAXPROCS= 8: 318ms
GOMAXPROCS=16: 321ms   <- diminishing returns beyond NumCPU
```

## Section 6: Scheduler Tracing

### GODEBUG=schedtrace

The simplest scheduler tracing is via the `schedtrace` GODEBUG option:

```bash
GODEBUG=schedtrace=1000 ./myservice
```

Sample output (every 1000ms):

```
SCHED 1000ms: gomaxprocs=8 idleprocs=2 threads=12 spinningthreads=1 idlethreads=3 runqueue=0 [0 0 1 0 0 2 0 0]
SCHED 2000ms: gomaxprocs=8 idleprocs=0 threads=14 spinningthreads=2 idlethreads=2 runqueue=4 [3 2 1 4 0 2 1 3]
```

Fields:
- `gomaxprocs`: Current GOMAXPROCS value
- `idleprocs`: P's with no work
- `threads`: Total OS threads (M's)
- `spinningthreads`: M's spinning waiting for work
- `idlethreads`: M's parked (no P)
- `runqueue`: Global run queue depth
- `[...]`: Per-P local run queue depths

**Signs of scheduler trouble**:
- `runqueue` consistently > 0 indicates goroutines are waiting for a P
- `spinningthreads` = 0 and `idleprocs` > 0 indicates potential scheduling latency
- `threads` much larger than `gomaxprocs + max_goroutines` indicates goroutine leaks in syscalls

### scheddetail for Deep Tracing

```bash
GODEBUG=schedtrace=1000,scheddetail=1 ./myservice 2>&1 | head -100
```

This outputs per-goroutine state information. Useful for identifying goroutine leaks.

### go tool trace

The execution tracer provides the most detailed view:

```go
package main

import (
    "os"
    "runtime/trace"
    "time"
)

func main() {
    f, err := os.Create("trace.out")
    if err != nil {
        panic(err)
    }
    defer f.Close()

    if err := trace.Start(f); err != nil {
        panic(err)
    }
    defer trace.Stop()

    // Run workload for 5 seconds
    time.Sleep(5 * time.Second)
}
```

Analyze the trace:

```bash
go tool trace trace.out
```

The trace viewer shows:
- **Goroutine analysis**: Time in running, runnable, blocked states
- **Scheduler latency**: Time between goroutine becoming runnable and being scheduled
- **Blocking profiles**: Which system calls or channels are blocking
- **Proc utilization**: How busy each P is over time

### Interpreting Scheduler Latency

Scheduler latency is the time between when a goroutine becomes runnable (e.g., a channel receive completes) and when it starts executing. High scheduler latency manifests as high tail latency in request-handling services.

```go
// Measure scheduler latency
func measureSchedulerLatency() {
    const samples = 10000
    latencies := make([]time.Duration, samples)

    for i := 0; i < samples; i++ {
        ch := make(chan time.Time, 1)
        go func() {
            ch <- time.Now()
        }()
        sent := <-ch
        latencies[i] = time.Since(sent)
    }

    sort.Slice(latencies, func(i, j int) bool {
        return latencies[i] < latencies[j]
    })

    fmt.Printf("Scheduler latency p50: %v\n", latencies[samples/2])
    fmt.Printf("Scheduler latency p99: %v\n", latencies[samples*99/100])
    fmt.Printf("Scheduler latency p999: %v\n", latencies[samples*999/1000])
}
```

## Section 7: Advanced Scheduling Patterns

### Goroutine Pinning with runtime.LockOSThread

In rare cases, code must run on a specific OS thread (e.g., OpenGL, certain CGo libraries that use thread-local storage):

```go
func renderLoop() {
    // Pin this goroutine to its current OS thread.
    // The goroutine and the M are now permanently associated.
    runtime.LockOSThread()
    defer runtime.UnlockOSThread()

    // Initialize thread-local OpenGL context
    initGL()

    for {
        renderFrame()
    }
}
```

`LockOSThread` removes the M from the normal scheduler pool. The goroutine is now responsible for all CPU consumption on that thread. Use sparingly — each locked goroutine consumes one M permanently.

### GOMAXPROCS and the GC

The garbage collector uses additional goroutines for concurrent marking and sweeping. These GC goroutines compete with application goroutines for P's. During a GC cycle:

- Up to `GOMAXPROCS/4` P's may be dedicated to GC background work.
- STW (stop-the-world) pauses require all goroutines to reach a safe point.

For latency-sensitive workloads, setting `GOGC` higher (e.g., `GOGC=200`) reduces GC frequency at the cost of higher memory usage. The `debug.SetGCPercent` function controls this at runtime:

```go
import "runtime/debug"

// Reduce GC frequency — double the heap trigger threshold
debug.SetGCPercent(200)

// For memory-constrained environments, trigger GC more often
debug.SetGCPercent(50)

// Set a hard memory limit (Go 1.19+)
debug.SetMemoryLimit(512 * 1024 * 1024) // 512MB
```

### Work Queues and Goroutine Pools

For CPU-bound parallelism, a bounded goroutine pool prevents scheduler overload:

```go
package workerpool

import (
    "context"
    "sync"
)

type Pool struct {
    workers int
    jobs    chan func()
    wg      sync.WaitGroup
}

func New(workers int) *Pool {
    p := &Pool{
        workers: workers,
        jobs:    make(chan func(), workers*10),
    }
    p.start()
    return p
}

func (p *Pool) start() {
    for i := 0; i < p.workers; i++ {
        p.wg.Add(1)
        go func() {
            defer p.wg.Done()
            for job := range p.jobs {
                job()
            }
        }()
    }
}

func (p *Pool) Submit(ctx context.Context, job func()) error {
    select {
    case p.jobs <- job:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

func (p *Pool) Shutdown() {
    close(p.jobs)
    p.wg.Wait()
}
```

Size the pool to GOMAXPROCS for CPU-bound jobs:

```go
pool := workerpool.New(runtime.GOMAXPROCS(0))
```

## Section 8: Real-World GOMAXPROCS Scenarios

### Kubernetes CPU Requests vs Limits

The subtle difference between CPU requests and limits matters for GOMAXPROCS:

- **CPU request** (`resources.requests.cpu`): Guaranteed allocation. The pod is never throttled below this.
- **CPU limit** (`resources.requests.cpu`): Maximum allocation. The pod is throttled if it exceeds this.

`automaxprocs` reads the CPU limit (quota), not the request. For pods with burstable QoS (request != limit), the GOMAXPROCS derived from the limit is correct for worst-case scheduling, but the program may see higher throughput during off-peak hours when it bursts.

For guaranteed QoS pods (request == limit), the GOMAXPROCS is always stable.

```yaml
# Guaranteed QoS (request == limit) — predictable GOMAXPROCS
resources:
  requests:
    cpu: "4"
    memory: "4Gi"
  limits:
    cpu: "4"
    memory: "4Gi"
# automaxprocs will set GOMAXPROCS=4

# Burstable QoS (request < limit) — variable GOMAXPROCS
resources:
  requests:
    cpu: "1"
    memory: "1Gi"
  limits:
    cpu: "4"
    memory: "4Gi"
# automaxprocs will set GOMAXPROCS=4 (based on limit)
# But the pod may only get 1 CPU during contention
# This can cause scheduler overhead when the pod is throttled
```

Recommendation: For latency-sensitive services, use guaranteed QoS and let `automaxprocs` set GOMAXPROCS from the limit.

### NUMA Awareness

On multi-socket NUMA systems, optimal performance requires goroutines to run on CPUs in the same NUMA node as their data. Go does not natively support NUMA affinity, but you can approximate it:

```bash
# Pin the entire process to NUMA node 0
numactl --cpunodebind=0 --membind=0 ./myservice

# Or use cpuset cgroups in Kubernetes with topology manager
```

For Kubernetes, the topology manager with `single-numa-node` policy aligns CPU and memory allocation to a single NUMA node.

## Section 9: Profiling Scheduler Impact

### pprof CPU Profile Interpretation

```bash
# Capture a 30-second CPU profile
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# In pprof interactive mode
(pprof) top20
(pprof) list runtime.schedule
(pprof) web   # Opens a flame graph in browser
```

Functions to look for in CPU profiles that indicate scheduler overhead:

- `runtime.schedule`: Time in the scheduler itself
- `runtime.findRunnable`: Work-stealing loop
- `runtime.park_m`: Parking idle M's
- `runtime.mcall`: Switching from G to M's scheduler goroutine
- `runtime.gosched0`: Voluntary yield

If `runtime.schedule` or `runtime.findRunnable` show up significantly in profiles, it indicates goroutine churn or scheduler contention.

### Goroutine Profile

```bash
# List all goroutines with stack traces
go tool pprof http://localhost:6060/debug/pprof/goroutine

(pprof) top
(pprof) traces   # Full stack traces grouped by root
```

A goroutine count growing over time indicates a goroutine leak. Common causes:
- Goroutines blocked on channels that no longer have writers
- HTTP handlers that spawn goroutines but don't cancel context
- goroutines in infinite loops without termination conditions

## Section 10: Scheduler Debugging Checklist

A systematic approach to scheduler-related performance problems:

```
1. Measure first
   - Capture pprof CPU profile during load
   - Capture go tool trace for 5-10 seconds
   - Record goroutine count over time

2. Check GOMAXPROCS
   - Is automaxprocs imported?
   - Does GOMAXPROCS match the container CPU limit?
   - Is the container QoS Guaranteed?

3. Check goroutine count
   - Is the count stable or growing?
   - Are goroutines in unexpected states?
   - Any goroutines blocked on timers/channels indefinitely?

4. Check scheduler metrics (schedtrace)
   - Is the global run queue accumulating?
   - Are there idle P's when goroutines are runnable?
   - Is threads count much larger than GOMAXPROCS?

5. Check GC pressure
   - Is GC running more than 10% of wall clock time?
   - Is alloc rate sustainable?
   - Consider GOGC or SetMemoryLimit adjustments

6. Check for LockOSThread usage
   - Grep codebase for runtime.LockOSThread
   - Ensure every LockOSThread has a matching UnlockOSThread
   - LockOSThread in goroutines that exit without unlock leaks an M
```

## Summary

The Go scheduler achieves remarkable throughput through:

- **M:N multiplexing**: Many goroutines share few OS threads, enabling massive concurrency with minimal memory overhead.
- **Work stealing**: Load balances automatically without global locks.
- **Asynchronous preemption**: Ensures fairness even for tight CPU loops.
- **Spinning threads**: Minimizes goroutine scheduling latency for new work.

For production containers, the most impactful action is always importing `go.uber.org/automaxprocs` to align GOMAXPROCS with the cgroup CPU quota. Beyond that, the execution tracer and schedtrace diagnostics provide the ground truth needed to understand and optimize scheduler behavior in your specific workload.
