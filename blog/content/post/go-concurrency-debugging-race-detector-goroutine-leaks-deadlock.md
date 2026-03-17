---
title: "Go Concurrency Debugging: Race Detector, Goroutine Leaks, and Deadlock Detection"
date: 2029-03-17T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Debugging", "Race Detector", "Goroutine Leaks", "Production"]
categories:
- Go
- Debugging
author: "Matthew Mattox - mmattox@support.tools"
description: "A systematic guide to diagnosing and fixing Go concurrency bugs — covering race detector usage, goroutine leak detection with pprof, deadlock root cause analysis, and production instrumentation patterns for concurrent services."
more_link: "yes"
url: "/go-concurrency-debugging-race-detector-goroutine-leaks-deadlock/"
---

Concurrency bugs in Go are among the most difficult to reproduce and diagnose. Data races produce corrupted state that manifests unpredictably. Goroutine leaks cause memory to grow monotonically until the process is killed. Deadlocks halt the entire program with no obvious indication of the circular dependency. The Go runtime provides first-class tooling for each of these failure modes, but using the tools effectively requires understanding what they measure and where their blind spots lie.

<!--more-->

## The Go Race Detector

### How It Works

The race detector is a compile-time instrumentation tool built on ThreadSanitizer. When `-race` is enabled, the compiler inserts shadow memory operations around every memory access. If two goroutines access the same memory location concurrently and at least one access is a write, the detector reports a race condition with full stack traces for both goroutines.

The race detector imposes ~5-10x CPU overhead and 10-20x memory overhead. It is enabled during testing and development, never in production.

### Running Tests with Race Detection

```bash
# Run all tests with race detector
go test -race ./...

# Run a specific test with verbose output and race detection
go test -race -run TestConcurrentMap -v ./internal/cache/

# Run the race detector during benchmark
go test -race -bench=BenchmarkConcurrentAccess -benchtime=30s ./...

# Build a binary with race detection for staging verification
go build -race -o ./bin/server-race ./cmd/server/
```

### Interpreting Race Reports

```
==================
WARNING: DATA RACE
Read at 0x00c0000b4050 by goroutine 8:
  main.workerRead()
      /home/user/app/worker.go:42 +0x68
  main.startWorkers.func1()
      /home/user/app/worker.go:25 +0x5c

Previous write at 0x00c0000b4050 by goroutine 7:
  main.workerWrite()
      /home/user/app/worker.go:35 +0x84
  main.startWorkers.func2()
      /home/user/app/worker.go:28 +0x5c

Goroutine 8 (running) created at:
  main.startWorkers()
      /home/user/app/worker.go:23 +0xb8

Goroutine 7 (running) created at:
  main.startWorkers()
      /home/user/app/worker.go:26 +0xd4
==================
```

The report identifies:
1. The conflicting goroutines and what each was doing
2. The memory address involved
3. The exact source location of each access
4. Where each goroutine was created

### Common Race Patterns and Fixes

**Pattern 1: Shared map without synchronization**

```go
// RACE: concurrent reads and writes to a map
type BadCache struct {
    data map[string]string
}

func (c *BadCache) Set(key, value string) {
    c.data[key] = value // concurrent write — races with any reader
}

func (c *BadCache) Get(key string) (string, bool) {
    v, ok := c.data[key] // concurrent read — races with any writer
    return v, ok
}

// FIX: use sync.RWMutex
type SafeCache struct {
    mu   sync.RWMutex
    data map[string]string
}

func (c *SafeCache) Set(key, value string) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.data[key] = value
}

func (c *SafeCache) Get(key string) (string, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    v, ok := c.data[key]
    return v, ok
}
```

**Pattern 2: Goroutine closure capturing loop variable**

```go
// RACE: all goroutines capture the same 'i' variable
func startWorkers(n int) {
    for i := 0; i < n; i++ {
        go func() {
            fmt.Println(i) // captures 'i' by reference — races
        }()
    }
}

// FIX: pass as parameter (Go 1.22+ fixes loop variable capture by default)
func startWorkersFixed(n int) {
    for i := 0; i < n; i++ {
        i := i // shadow the loop variable (pre Go 1.22)
        go func() {
            fmt.Println(i) // each goroutine has its own 'i'
        }()
    }
}
```

**Pattern 3: Struct field accessed without lock**

```go
type Server struct {
    mu        sync.Mutex
    connCount int    // protected by mu
    startTime time.Time // NOT protected — read without lock
}

func (s *Server) IncrementConns() {
    s.mu.Lock()
    s.connCount++
    s.mu.Unlock()
    // startTime is read elsewhere without the lock — race
}

// FIX: clearly document which fields each lock protects,
// and ensure all accesses hold the appropriate lock
type SafeServer struct {
    mu        sync.Mutex
    // Both fields protected by mu:
    connCount int
    startTime time.Time
}
```

**Pattern 4: sync/atomic for single variables**

```go
// For simple counters, atomic operations avoid lock overhead
type Metrics struct {
    requestCount atomic.Int64
    errorCount   atomic.Int64
    totalLatency atomic.Int64
}

func (m *Metrics) RecordRequest(latencyNs int64, isError bool) {
    m.requestCount.Add(1)
    m.totalLatency.Add(latencyNs)
    if isError {
        m.errorCount.Add(1)
    }
}

func (m *Metrics) Average() float64 {
    count := m.requestCount.Load()
    if count == 0 {
        return 0
    }
    return float64(m.totalLatency.Load()) / float64(count)
}
```

## Goroutine Leak Detection

A goroutine leak occurs when a goroutine is created but never terminates — typically because it is waiting on a channel or context that will never be signalled.

### Detecting Leaks with pprof

```go
package main

import (
    "net/http"
    _ "net/http/pprof"  // Side-effect import registers pprof handlers
    "log"
)

func main() {
    // Register pprof on a separate port from the main server
    go func() {
        log.Println(http.ListenAndServe("localhost:6060", nil))
    }()

    // ... main application logic ...
}
```

```bash
# Capture goroutine profiles at two points in time and compare
curl -s http://localhost:6060/debug/pprof/goroutine?debug=1 > goroutines-before.txt
# Wait for suspected leak to accumulate (e.g., 60 seconds)
curl -s http://localhost:6060/debug/pprof/goroutine?debug=1 > goroutines-after.txt

# Compare goroutine counts
head -1 goroutines-before.txt  # "goroutine profile: total NNNN"
head -1 goroutines-after.txt

# Use pprof CLI for interactive analysis
go tool pprof http://localhost:6060/debug/pprof/goroutine
# In the pprof shell:
# top10       — show top goroutine stacks by count
# list MyFunc — show source for a specific function
# web         — open SVG graph in browser
```

### Testing for Goroutine Leaks

Use `goleak` for automated goroutine leak detection in tests:

```go
package server_test

import (
    "context"
    "testing"
    "time"

    "go.uber.org/goleak"
)

func TestMain(m *testing.M) {
    // goleak.VerifyTestMain checks for leaked goroutines after all tests complete
    goleak.VerifyTestMain(m)
}

func TestServer_GracefulShutdown(t *testing.T) {
    // goleak.VerifyNone checks at the end of a single test
    defer goleak.VerifyNone(t)

    s := NewServer(":0")
    go s.Start()

    // Trigger shutdown
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    s.Shutdown(ctx)

    // goleak.VerifyNone will fail if any goroutines started by this test
    // are still running when the test returns
}
```

### Common Goroutine Leak Patterns

**Pattern 1: Goroutine blocked on an unbuffered channel send with no receiver**

```go
// LEAK: if the receiver exits early, this goroutine blocks forever
func leakyWorker(results chan<- Result) {
    for {
        r := doWork()
        results <- r // blocks if receiver is gone
    }
}

// FIX: use context cancellation as an escape hatch
func safeWorker(ctx context.Context, results chan<- Result) {
    for {
        select {
        case <-ctx.Done():
            return
        default:
        }

        r := doWork()
        select {
        case results <- r:
        case <-ctx.Done():
            return
        }
    }
}
```

**Pattern 2: HTTP request goroutines not respecting server shutdown**

```go
// LEAK: goroutines started from handlers may outlive the server's grace period
func handler(w http.ResponseWriter, r *http.Request) {
    go func() {
        // This goroutine is not tied to the request context
        // and will leak if the HTTP server shuts down
        longRunningTask()
    }()
    w.WriteHeader(http.StatusAccepted)
}

// FIX: pass request context (or a background context derived from app lifecycle)
func handlerFixed(appCtx context.Context) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        taskCtx, cancel := context.WithTimeout(appCtx, 30*time.Second)
        go func() {
            defer cancel()
            longRunningTaskWithContext(taskCtx)
        }()
        w.WriteHeader(http.StatusAccepted)
    }
}
```

**Pattern 3: Timer or ticker not stopped**

```go
// LEAK: time.After creates a timer that leaks until it fires
func pollForResult(timeout time.Duration) (Result, error) {
    for {
        if r, ok := tryGetResult(); ok {
            return r, nil
        }
        // time.After creates a new timer every iteration
        // Each timer goroutine leaks until timeout fires
        select {
        case <-time.After(100 * time.Millisecond):
        }
    }
}

// FIX: use time.NewTimer and stop it explicitly
func pollForResultFixed(ctx context.Context) (Result, error) {
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return Result{}, ctx.Err()
        case <-ticker.C:
            if r, ok := tryGetResult(); ok {
                return r, nil
            }
        }
    }
}
```

### Monitoring Goroutine Count in Production

```go
package metrics

import (
    "runtime"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    goroutineGauge = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_goroutines_active",
        Help: "Current number of active goroutines",
    })
)

func StartGoroutineReporter(interval time.Duration) {
    go func() {
        ticker := time.NewTicker(interval)
        defer ticker.Stop()
        for range ticker.C {
            goroutineGauge.Set(float64(runtime.NumGoroutine()))
        }
    }()
}
```

Prometheus alert for goroutine growth:

```yaml
- alert: GoroutineLeakSuspected
  expr: |
    deriv(go_goroutines_active[15m]) > 5
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "Goroutine count growing in {{ $labels.job }}"
    description: "Goroutine count is increasing by {{ $value | printf \"%.1f\" }}/s over the last 15 minutes in {{ $labels.job }}. This may indicate a goroutine leak."
```

## Deadlock Detection

Go's runtime detects one type of deadlock: when **all goroutines are blocked**. When this occurs, the runtime panics with:

```
fatal error: all goroutines are asleep - deadlock!
```

However, partial deadlocks — where some goroutines are blocked on a cycle while others continue — are not detected by the runtime. These are far more common in production.

### Runtime Deadlock Example

```go
func demonstrateDeadlock() {
    var mu1, mu2 sync.Mutex

    // Goroutine 1: acquires mu1 then waits for mu2
    go func() {
        mu1.Lock()
        defer mu1.Unlock()
        time.Sleep(10 * time.Millisecond)
        mu2.Lock() // Waits here — goroutine 2 holds mu2
        defer mu2.Unlock()
    }()

    // Goroutine 2: acquires mu2 then waits for mu1
    go func() {
        mu2.Lock()
        defer mu2.Unlock()
        time.Sleep(10 * time.Millisecond)
        mu1.Lock() // Waits here — goroutine 1 holds mu1
        defer mu1.Unlock()
    }()

    // If main exits immediately, the deadlock may not be detected
    time.Sleep(1 * time.Second)
}
```

### Diagnosing Partial Deadlocks

```bash
# Send SIGQUIT to dump all goroutine stacks (does not kill the process)
kill -SIGQUIT $(pgrep myserver)

# Or trigger via pprof endpoint with full stack traces
curl -s "http://localhost:6060/debug/pprof/goroutine?debug=2" | \
  grep -A 10 "semacquire\|chan receive\|chan send\|lock"
```

Look for goroutines stuck in:
- `sync.(*Mutex).Lock()` — holding lock order cycles
- `sync.(*WaitGroup).Wait()` — WaitGroup never reaches zero
- channel operations — sender/receiver cycle

### Deadlock-Resistant Lock Patterns

**Use lock ordering to prevent deadlocks involving multiple mutexes:**

```go
type Account struct {
    id      int
    mu      sync.Mutex
    balance int64
}

// DEADLOCK RISK: if Transfer(A, B) and Transfer(B, A) run concurrently
func transferUnsafe(from, to *Account, amount int64) error {
    from.mu.Lock()
    defer from.mu.Unlock()
    to.mu.Lock()   // Risk: reverse order in concurrent call creates cycle
    defer to.mu.Unlock()
    // ...
    return nil
}

// SAFE: always acquire locks in consistent order (by account ID)
func transferSafe(from, to *Account, amount int64) error {
    // Enforce a canonical lock order based on account ID
    first, second := from, to
    if from.id > to.id {
        first, second = to, from
    }

    first.mu.Lock()
    defer first.mu.Unlock()
    second.mu.Lock()
    defer second.mu.Unlock()

    if from.balance < amount {
        return fmt.Errorf("insufficient balance: have %d, need %d", from.balance, amount)
    }
    from.balance -= amount
    to.balance += amount
    return nil
}
```

**Use `TryLock` with timeout for debugging lock contention:**

```go
// Go 1.18+ provides sync.Mutex.TryLock()
func tryAcquireWithTimeout(mu *sync.Mutex, timeout time.Duration) bool {
    deadline := time.Now().Add(timeout)
    for time.Now().Before(deadline) {
        if mu.TryLock() {
            return true
        }
        time.Sleep(time.Millisecond)
    }
    return false
}

// Usage: detect and log lock contention in development
func criticalSection(mu *sync.Mutex) {
    if !tryAcquireWithTimeout(mu, 5*time.Second) {
        // Log a goroutine dump to identify who is holding the lock
        buf := make([]byte, 1<<20)
        n := runtime.Stack(buf, true)
        log.Printf("Lock contention detected. Current goroutines:\n%s", buf[:n])
        mu.Lock() // Block normally — don't deadlock
    }
    defer mu.Unlock()
    // ... critical section ...
}
```

### WaitGroup Deadlock Prevention

```go
// DEADLOCK: WaitGroup counter goes negative
func badWaitGroup() {
    var wg sync.WaitGroup
    wg.Add(1)
    wg.Done()
    wg.Done() // panic: negative WaitGroup counter
}

// DEADLOCK: Add after Wait
func badWaitGroupTiming() {
    var wg sync.WaitGroup
    go func() {
        time.Sleep(100 * time.Millisecond)
        wg.Add(1) // Add after Wait may not be seen
        defer wg.Done()
    }()
    wg.Wait() // Returns immediately since Add hasn't been called yet
}

// CORRECT pattern: Add before goroutine launch
func correctWaitGroup(n int) {
    var wg sync.WaitGroup
    wg.Add(n) // Add the full count before launching any goroutines
    for i := 0; i < n; i++ {
        go func(id int) {
            defer wg.Done()
            doWork(id)
        }(i)
    }
    wg.Wait()
}
```

## Production Debugging Workflow

### Complete Concurrency Debugging Checklist

```bash
# Step 1: Run tests with race detector
go test -race -count=3 ./... 2>&1 | tee race-output.txt

# Step 2: Check for goroutine leaks in integration tests
go test -race -run TestIntegration -v ./... 2>&1 | \
  grep -E "goroutine|RACE|LEAK"

# Step 3: Profile a running service for goroutine accumulation
# Capture 5 profiles 30 seconds apart and compare counts
for i in 1 2 3 4 5; do
  timestamp=$(date +%s)
  curl -s "http://localhost:6060/debug/pprof/goroutine" \
    -o "goroutines-${timestamp}.prof"
  echo "Profile ${i} captured at ${timestamp}"
  sleep 30
done

# Compare goroutine profiles using pprof
go tool pprof -base goroutines-first.prof goroutines-last.prof
# In pprof: top - shows net goroutine growth between captures

# Step 4: Capture full goroutine stack dump for deadlock analysis
curl -s "http://localhost:6060/debug/pprof/goroutine?debug=2" | \
  grep -B 1 -A 15 "semacquire" | head -100

# Step 5: Check mutex contention
go tool pprof http://localhost:6060/debug/pprof/mutex
```

### Instrumented Mutex for Production Tracing

```go
package sync

import (
    "runtime"
    "sync"
    "time"

    "go.opentelemetry.io/otel/metric"
)

// TracedMutex wraps sync.Mutex with contention tracing
type TracedMutex struct {
    mu       sync.Mutex
    name     string
    waitTime metric.Float64Histogram
}

func NewTracedMutex(name string, meter metric.Meter) *TracedMutex {
    hist, _ := meter.Float64Histogram(
        "mutex_wait_seconds",
        metric.WithDescription("Time spent waiting to acquire mutex"),
    )
    return &TracedMutex{name: name, waitTime: hist}
}

func (t *TracedMutex) Lock() {
    start := time.Now()
    t.mu.Lock()
    waited := time.Since(start)
    if waited > time.Millisecond {
        // Record contention — only when it's significant
        t.waitTime.Record(context.Background(), waited.Seconds(),
            metric.WithAttributes(attribute.String("mutex", t.name)))
    }
}

func (t *TracedMutex) Unlock() {
    t.mu.Unlock()
}
```

## Summary: Concurrency Safety Checklist

For every concurrent component, verify:

1. **Race detector passes**: `go test -race ./...` reports zero data races
2. **Goroutine leak test**: goleak is integrated into test suites
3. **Context propagation**: every goroutine receives a cancellable context
4. **Lock ordering**: documented and enforced for multi-mutex operations
5. **Channel lifecycle**: every channel has a clear owner responsible for close
6. **WaitGroup discipline**: `Add(n)` called before goroutine launch; never negative
7. **Timer cleanup**: every `time.NewTimer` and `time.NewTicker` has `defer Stop()`
8. **Production monitoring**: goroutine count exported to Prometheus with alerting
