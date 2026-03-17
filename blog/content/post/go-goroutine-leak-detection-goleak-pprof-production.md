---
title: "Go Goroutine Leak Detection: goleak, Runtime Metrics, and Production Prevention"
date: 2031-03-25T00:00:00-05:00
draft: false
tags: ["Go", "Goroutines", "Memory Leaks", "pprof", "goleak", "Production", "Performance"]
categories:
- Go
- Performance
- Debugging
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to detecting and preventing goroutine leaks in Go services using goleak in tests, runtime.NumGoroutine monitoring, pprof goroutine dump analysis, and production alerting strategies for common leak patterns."
more_link: "yes"
url: "/go-goroutine-leak-detection-goleak-pprof-production/"
---

Goroutine leaks are the Go equivalent of memory leaks in garbage-collected languages: they don't cause immediate crashes, but accumulate silently until the service becomes unresponsive or OOM-killed. Unlike heap memory, leaked goroutines also hold onto any resources they reference — open connections, file handles, in-flight HTTP requests, and channel buffers — making the problem multiplicative.

This guide covers the complete prevention and detection toolkit: integrating goleak into the test suite to catch leaks before they reach production, using `runtime.NumGoroutine` and pprof for runtime analysis, understanding the canonical leak patterns (missing context cancellation, unbuffered channels with no receiver, infinite loops without exit conditions), and configuring production alerting before goroutine count becomes a page.

<!--more-->

# Go Goroutine Leak Detection: goleak, Runtime Metrics, and Production Prevention

## Section 1: Understanding Goroutine Leaks

### What Constitutes a Goroutine Leak

A goroutine is leaked when it's blocked on an operation that will never unblock, or is spinning indefinitely without a termination condition:

```go
// LEAK: goroutine blocks forever on a channel nobody writes to
func leakyHandler(req Request) {
    results := make(chan Result)  // unbuffered
    go func() {
        result := processRequest(req)
        results <- result  // blocks if caller has returned
    }()

    select {
    case <-time.After(100 * time.Millisecond):
        // Timeout: return early, but the goroutine is still trying to send
        return
    case r := <-results:
        handleResult(r)
    }
}
```

```go
// LEAK: goroutine started for each request, never cleaned up
func startBackgroundWorker(ctx context.Context) {
    go func() {
        for {
            // No ctx.Done() check — runs forever even after caller cancels
            doWork()
            time.Sleep(time.Second)
        }
    }()
}
```

### Common Goroutine Leak Patterns

**Pattern 1: Missing context cancellation check**

```go
// LEAKED
func fetchWithLeak(url string) error {
    go func() {
        resp, _ := http.Get(url)
        defer resp.Body.Close()
        // If caller times out and returns, this goroutine keeps running
        // processing the response body
        processBody(resp.Body)
    }()
    return nil
}

// FIXED
func fetchFixed(ctx context.Context, url string) error {
    go func() {
        req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
            return  // context cancelled, goroutine exits cleanly
        }
        defer resp.Body.Close()
        processBody(resp.Body)
    }()
    return nil
}
```

**Pattern 2: Unbuffered channel with abandoned sender**

```go
// LEAKED: if receiver returns early, sender blocks forever
func processItems(items []Item) []Result {
    ch := make(chan Result)  // unbuffered

    for _, item := range items {
        go func(i Item) {
            ch <- process(i)  // will block if processItems returns early
        }(item)
    }

    results := make([]Result, 0, len(items))
    for range items {
        select {
        case r := <-ch:
            results = append(results, r)
        case <-time.After(5 * time.Second):
            return results  // LEAK: remaining goroutines still trying to send
        }
    }
    return results
}

// FIXED: buffered channel or errgroup with cancellation
func processItemsFixed(ctx context.Context, items []Item) ([]Result, error) {
    ch := make(chan Result, len(items))  // buffered = senders never block

    var wg sync.WaitGroup
    for _, item := range items {
        wg.Add(1)
        go func(i Item) {
            defer wg.Done()
            select {
            case <-ctx.Done():
                return
            case ch <- process(i):
            }
        }(item)
    }

    // Close channel when all goroutines finish
    go func() {
        wg.Wait()
        close(ch)
    }()

    var results []Result
    for r := range ch {
        results = append(results, r)
    }
    return results, ctx.Err()
}
```

**Pattern 3: Ticker or Timer without Stop**

```go
// LEAKED: ticker goroutine runs forever
func startMetricsCollector() {
    go func() {
        ticker := time.NewTicker(10 * time.Second)
        // No ticker.Stop(), no way to terminate
        for range ticker.C {
            collectMetrics()
        }
    }()
}

// FIXED: use done channel or context
func startMetricsCollectorFixed(ctx context.Context) {
    go func() {
        ticker := time.NewTicker(10 * time.Second)
        defer ticker.Stop()  // important: always stop tickers

        for {
            select {
            case <-ctx.Done():
                return  // exits cleanly when context is cancelled
            case <-ticker.C:
                collectMetrics()
            }
        }
    }()
}
```

**Pattern 4: http.Server without timeout**

```go
// LEAKED: long-running HTTP handlers hold goroutines
func startServer() {
    // Without timeouts, a slow client can hold a handler goroutine open forever
    http.ListenAndServe(":8080", handler)
}

// FIXED: always set timeouts
func startServerFixed() {
    srv := &http.Server{
        Addr:         ":8080",
        Handler:      handler,
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  120 * time.Second,
    }
    srv.ListenAndServe()
}
```

## Section 2: goleak Integration in Tests

### Installation and Basic Usage

```bash
go get go.uber.org/goleak
```

```go
// pkg/worker/worker_test.go
package worker_test

import (
    "testing"

    "go.uber.org/goleak"
)

// TestMain installs goleak for all tests in the package
func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}

// Individual test usage
func TestWorkerProcesses(t *testing.T) {
    defer goleak.VerifyNone(t)

    w := NewWorker()
    w.Process("test-job")
    w.Stop()
    // goleak checks that no new goroutines were started and leaked
}
```

### goleak Options for Noisy Environments

Some libraries start background goroutines legitimately. goleak allows filtering:

```go
// Filter out known background goroutines from third-party libraries
var knownGoroutines = []goleak.Option{
    // Filter gRPC background goroutines
    goleak.IgnoreTopFunction("google.golang.org/grpc.(*ccBalancerWrapper).watcher"),
    goleak.IgnoreTopFunction("google.golang.org/grpc/internal/transport.(*controlBuffer).get"),
    // Filter database/sql background goroutines
    goleak.IgnoreTopFunction("database/sql.(*DB).connectionOpener"),
    // Filter testify's panic catcher
    goleak.IgnoreTopFunction("github.com/stretchr/testify/suite.(*Suite).Run.func1"),
    // Filter by current goroutines (capture before test, report only new ones)
    goleak.IgnoreCurrent(),
}

func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m, knownGoroutines...)
}

func TestSpecificCase(t *testing.T) {
    defer goleak.VerifyNone(t, knownGoroutines...)
    // Test code here
}
```

### Writing Leak-Detecting Tests for Common Patterns

```go
// testing/leaktest_test.go
package leaktest_test

import (
    "context"
    "testing"
    "time"

    "go.uber.org/goleak"
)

// Test that HTTP server goroutines don't leak after shutdown
func TestHTTPServerShutdown(t *testing.T) {
    defer goleak.VerifyNone(t)

    srv := NewHTTPServer(":0")  // random port

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    // Start server
    errCh := make(chan error, 1)
    go func() {
        errCh <- srv.Start()
    }()

    // Give server time to start
    time.Sleep(50 * time.Millisecond)

    // Graceful shutdown
    if err := srv.Shutdown(ctx); err != nil {
        t.Fatalf("shutdown error: %v", err)
    }

    // goleak.VerifyNone will check here that no goroutines from Start() are running
}

// Test that worker pool cleans up all goroutines
func TestWorkerPoolCleanup(t *testing.T) {
    defer goleak.VerifyNone(t)

    pool := NewWorkerPool(10)
    pool.Start()

    // Submit some work
    for i := 0; i < 100; i++ {
        pool.Submit(func() {
            time.Sleep(time.Millisecond)
        })
    }

    // Wait for all work to complete
    pool.Wait()
    pool.Stop()
    // All 10 worker goroutines should have exited
}

// Test context cancellation propagation
func TestContextCancellationClean(t *testing.T) {
    defer goleak.VerifyNone(t)

    ctx, cancel := context.WithCancel(context.Background())

    // Start a goroutine that should exit on context cancel
    started := make(chan struct{})
    go func() {
        close(started)
        select {
        case <-ctx.Done():
            return  // clean exit
        case <-time.After(10 * time.Second):
            // This path means the goroutine was abandoned
            t.Error("goroutine not cancelled")
        }
    }()

    <-started
    cancel()

    // Give goroutine time to exit
    time.Sleep(10 * time.Millisecond)
    // goleak.VerifyNone checks here
}
```

### goleak in Table-Driven Tests

```go
func TestDatabaseClient(t *testing.T) {
    tests := []struct {
        name    string
        setup   func(*testing.T) *DatabaseClient
        cleanup func(*DatabaseClient)
    }{
        {
            name: "connection pool cleanup",
            setup: func(t *testing.T) *DatabaseClient {
                return NewDatabaseClient("localhost:5432")
            },
            cleanup: func(c *DatabaseClient) {
                c.Close()
            },
        },
        {
            name: "query cancellation",
            setup: func(t *testing.T) *DatabaseClient {
                return NewDatabaseClient("localhost:5432")
            },
            cleanup: func(c *DatabaseClient) {
                c.Close()
            },
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            defer goleak.VerifyNone(t)

            client := tt.setup(t)
            defer tt.cleanup(client)

            // Run the actual test
            ctx, cancel := context.WithTimeout(context.Background(), time.Second)
            defer cancel()

            _, err := client.Query(ctx, "SELECT 1")
            if err != nil {
                t.Fatalf("query failed: %v", err)
            }
        })
    }
}
```

## Section 3: Runtime Metrics for Goroutine Monitoring

### Exposing Goroutine Count via Prometheus

```go
// internal/metrics/goroutines.go
package metrics

import (
    "runtime"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    goroutineCount = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_goroutines_active",
        Help: "Current number of goroutines.",
    })

    goroutineGrowthRate = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_goroutines_growth_rate",
        Help: "Rate of goroutine count change per minute.",
    })
)

// StartGoroutineMetricsCollector starts a background goroutine
// that updates Prometheus metrics for goroutine count.
// The returned stop function cancels collection.
func StartGoroutineMetricsCollector(ctx context.Context) {
    go func() {
        ticker := time.NewTicker(15 * time.Second)
        defer ticker.Stop()

        var prevCount float64
        prevTime := time.Now()

        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                current := float64(runtime.NumGoroutine())
                goroutineCount.Set(current)

                // Calculate growth rate (goroutines per minute)
                elapsed := time.Since(prevTime).Minutes()
                if elapsed > 0 {
                    rate := (current - prevCount) / elapsed
                    goroutineGrowthRate.Set(rate)
                }

                prevCount = current
                prevTime = time.Now()
            }
        }
    }()
}
```

### Structured Logging for Goroutine Anomalies

```go
// internal/health/goroutine_monitor.go
package health

import (
    "context"
    "log/slog"
    "runtime"
    "time"
)

type GoroutineMonitor struct {
    logger         *slog.Logger
    baseline       int
    warningFactor  float64
    criticalFactor float64
    interval       time.Duration
}

func NewGoroutineMonitor(logger *slog.Logger) *GoroutineMonitor {
    baseline := runtime.NumGoroutine()
    return &GoroutineMonitor{
        logger:         logger,
        baseline:       baseline,
        warningFactor:  3.0,   // warn if 3x baseline
        criticalFactor: 10.0,  // critical if 10x baseline
        interval:       30 * time.Second,
    }
}

func (m *GoroutineMonitor) Start(ctx context.Context) {
    go func() {
        ticker := time.NewTicker(m.interval)
        defer ticker.Stop()

        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                current := runtime.NumGoroutine()
                ratio := float64(current) / float64(m.baseline)

                attrs := []any{
                    "current", current,
                    "baseline", m.baseline,
                    "ratio", ratio,
                }

                switch {
                case ratio >= m.criticalFactor:
                    m.logger.Error("Critical goroutine leak detected",
                        append(attrs, "action", "check pprof /debug/pprof/goroutine")...)
                case ratio >= m.warningFactor:
                    m.logger.Warn("Potential goroutine leak",
                        attrs...)
                default:
                    m.logger.Debug("Goroutine count normal", attrs...)
                }
            }
        }
    }()
}
```

## Section 4: pprof Goroutine Dump Analysis

### Enabling pprof Endpoint

```go
// cmd/server/main.go
package main

import (
    "net/http"
    _ "net/http/pprof"  // side-effect import enables pprof handlers
    "log"
)

func main() {
    // Separate pprof server on different port (never expose to public internet)
    go func() {
        log.Println(http.ListenAndServe("localhost:6060", nil))
    }()

    // Main application server
    startMainServer()
}
```

### Capturing Goroutine Dumps

```bash
# Capture goroutine dump
curl -s http://localhost:6060/debug/pprof/goroutine?debug=2 > goroutine-dump.txt

# More detailed: include full stack traces with wait reasons
curl -s "http://localhost:6060/debug/pprof/goroutine?debug=2" | \
  head -500

# Capture and analyze with pprof tool
go tool pprof http://localhost:6060/debug/pprof/goroutine
# Then in pprof interactive mode:
# (pprof) top 20
# (pprof) traces
# (pprof) list functionName
```

### Analyzing the Goroutine Dump

A goroutine dump entry looks like:

```
goroutine 847 [chan receive, 47 minutes]:
github.com/mycompany/service/internal/worker.(*Worker).processLoop(0xc00012a200)
        /home/user/service/internal/worker/worker.go:89 +0x156
created by github.com/mycompany/service/internal/worker.NewWorker
        /home/user/service/internal/worker/worker.go:45 +0x2a8
```

Key fields:
- `goroutine 847`: goroutine ID
- `[chan receive, 47 minutes]`: state and duration — **47 minutes waiting on channel receive is a strong leak signal**
- Stack trace: where the goroutine is blocked and where it was created

**Common blocked states that indicate leaks:**
- `chan receive, X minutes` — waiting on empty channel, likely abandoned
- `chan send, X minutes` — trying to send on full/unbuffered channel, likely receiver gone
- `select, X minutes` — stuck in select with no cases ever ready
- `sync.Mutex.Lock, X minutes` — potential deadlock

### Automated Dump Analysis Script

```bash
#!/bin/bash
# analyze-goroutines.sh
# Fetch and analyze goroutine dump for leak indicators

SERVICE_URL="${1:-http://localhost:6060}"
THRESHOLD_MINUTES="${2:-5}"

echo "Fetching goroutine dump from ${SERVICE_URL}..."
DUMP=$(curl -s "${SERVICE_URL}/debug/pprof/goroutine?debug=2")

TOTAL=$(echo "${DUMP}" | grep -c "^goroutine " || echo 0)
echo "Total goroutines: ${TOTAL}"

echo ""
echo "=== Goroutines waiting more than ${THRESHOLD_MINUTES} minutes ==="
echo "${DUMP}" | awk -v threshold="${THRESHOLD_MINUTES}" '
/^goroutine [0-9]+ \[/ {
    # Extract wait time
    if (match($0, /[0-9]+ minutes/, arr)) {
        minutes = arr[0] + 0
        if (minutes >= threshold) {
            print
            in_stale = 1
        } else {
            in_stale = 0
        }
    }
    next
}
in_stale && /\S/ { print }
/^$/ { in_stale = 0 }
'

echo ""
echo "=== Goroutine state distribution ==="
echo "${DUMP}" | grep -oP '\[.*?\]' | sort | uniq -c | sort -rn | head -20

echo ""
echo "=== Top goroutine creation sites ==="
echo "${DUMP}" | grep "created by" | sort | uniq -c | sort -rn | head -20

echo ""
echo "=== Goroutines blocked on channel operations ==="
CHANNEL_BLOCKED=$(echo "${DUMP}" | grep -c "chan receive\|chan send" || echo 0)
echo "Channel-blocked goroutines: ${CHANNEL_BLOCKED}"
```

### Using pprof Go Tool Interactively

```bash
# Interactive pprof analysis
go tool pprof -http=:8081 http://localhost:6060/debug/pprof/goroutine

# Or from a saved profile
curl -s http://localhost:6060/debug/pprof/goroutine > goroutine.prof
go tool pprof -http=:8081 goroutine.prof

# Command-line analysis
go tool pprof http://localhost:6060/debug/pprof/goroutine << 'EOF'
top20
traces
EOF
```

## Section 5: Common Leak Patterns and Fixes

### Pattern: Worker Pool Without Done Channel

```go
// LEAKED: worker goroutines never exit
type LeakyPool struct {
    jobs chan Job
}

func NewLeakyPool(workers int) *LeakyPool {
    p := &LeakyPool{jobs: make(chan Job, 100)}
    for i := 0; i < workers; i++ {
        go func() {
            for job := range p.jobs {  // blocks until jobs is closed
                job.Execute()
            }
        }()
    }
    return p
}
// Problem: jobs channel is never closed, goroutines leak on shutdown

// FIXED: proper shutdown with WaitGroup and context
type WorkerPool struct {
    jobs    chan Job
    done    chan struct{}
    wg      sync.WaitGroup
    once    sync.Once
}

func NewWorkerPool(ctx context.Context, workers int) *WorkerPool {
    p := &WorkerPool{
        jobs: make(chan Job, 100),
        done: make(chan struct{}),
    }

    for i := 0; i < workers; i++ {
        p.wg.Add(1)
        go func() {
            defer p.wg.Done()
            for {
                select {
                case job, ok := <-p.jobs:
                    if !ok {
                        return  // channel closed
                    }
                    job.Execute()
                case <-ctx.Done():
                    return  // context cancelled
                }
            }
        }()
    }

    return p
}

func (p *WorkerPool) Stop() {
    p.once.Do(func() {
        close(p.jobs)
        p.wg.Wait()
    })
}
```

### Pattern: HTTP Client Without Draining Response Body

```go
// LEAKED: underlying TCP connection is not returned to pool
func fetchLeaky(url string) error {
    resp, err := http.Get(url)
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    // If we don't read the body completely, the connection can't be reused
    // Goroutines in the transport layer may accumulate
    if resp.StatusCode != 200 {
        return fmt.Errorf("unexpected status: %d", resp.StatusCode)
        // Body not drained! Connection not returned to pool.
    }
    // Process only a small part of the body
    buf := make([]byte, 100)
    resp.Body.Read(buf)
    return nil  // remaining body not drained
}

// FIXED: always drain the body
func fetchFixed(url string) error {
    resp, err := http.Get(url)
    if err != nil {
        return err
    }
    defer func() {
        // Always drain and close the body to return connection to pool
        io.Copy(io.Discard, resp.Body)
        resp.Body.Close()
    }()

    if resp.StatusCode != 200 {
        return fmt.Errorf("unexpected status: %d", resp.StatusCode)
    }

    var result MyResponse
    return json.NewDecoder(resp.Body).Decode(&result)
}
```

### Pattern: Goroutine Started in init()

```go
// LEAKED: init() goroutines run for the entire program lifetime
// but often aren't cancelled on test cleanup
func init() {
    go backgroundRefresh()  // impossible to stop in tests
}

// FIXED: use explicit lifecycle management
type Refresher struct {
    cancel context.CancelFunc
    done   chan struct{}
}

func NewRefresher() *Refresher {
    ctx, cancel := context.WithCancel(context.Background())
    r := &Refresher{
        cancel: cancel,
        done:   make(chan struct{}),
    }
    go func() {
        defer close(r.done)
        r.backgroundRefresh(ctx)
    }()
    return r
}

func (r *Refresher) Stop() {
    r.cancel()
    <-r.done  // wait for goroutine to finish
}
```

### Pattern: select with Default Causing Spin Loop

```go
// LEAKED (actually: high CPU usage): busy-wait loop
func processEvents(ch <-chan Event) {
    go func() {
        for {
            select {
            case e := <-ch:
                handle(e)
            default:
                // Spins when no events — CPU-intensive goroutine that never exits
                runtime.Gosched()  // doesn't help much
            }
        }
    }()
}

// FIXED: blocking select without default
func processEventsFixed(ctx context.Context, ch <-chan Event) {
    go func() {
        for {
            select {
            case <-ctx.Done():
                return
            case e, ok := <-ch:
                if !ok {
                    return  // channel closed
                }
                handle(e)
            }
        }
    }()
}
```

## Section 6: Production Alerting and Monitoring

### Prometheus Alert Rules

```yaml
# prometheus-goroutine-alerts.yaml
groups:
  - name: goroutine.leaks
    rules:
      - alert: GoroutineLeak
        expr: |
          go_goroutines > 1000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High goroutine count in {{ $labels.job }}"
          description: "{{ $labels.instance }} has {{ $value }} goroutines. Check for leaks."

      - alert: GoroutineExplosion
        expr: |
          go_goroutines > 5000
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Goroutine explosion in {{ $labels.job }}"
          description: "{{ $labels.instance }} has {{ $value }} goroutines. Service likely degraded."
          runbook: "https://wiki.internal/runbooks/goroutine-leak"

      - alert: GoroutineRapidGrowth
        expr: |
          rate(go_goroutines[5m]) > 10
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Goroutines growing rapidly in {{ $labels.job }}"
          description: "Goroutines in {{ $labels.instance }} growing at {{ $value }}/sec over 5m"
```

### Grafana Dashboard Query

```json
{
  "title": "Goroutine Monitoring",
  "panels": [
    {
      "title": "Goroutine Count Over Time",
      "type": "graph",
      "targets": [
        {
          "expr": "go_goroutines{job=~\"$job\"}",
          "legendFormat": "{{instance}}"
        }
      ],
      "alert": {
        "conditions": [
          {
            "evaluator": {
              "params": [1000],
              "type": "gt"
            },
            "query": {
              "params": ["A", "5m", "now"]
            }
          }
        ]
      }
    },
    {
      "title": "Goroutine Growth Rate (per minute)",
      "type": "graph",
      "targets": [
        {
          "expr": "rate(go_goroutines[5m]) * 60",
          "legendFormat": "{{instance}}"
        }
      ]
    }
  ]
}
```

### Automated Goroutine Dump Collection on Alert

```go
// internal/diagnostics/auto_dump.go
package diagnostics

import (
    "bytes"
    "context"
    "fmt"
    "os"
    "runtime/pprof"
    "time"
)

// WatchGoroutineCount monitors goroutine count and captures
// automatic dumps when thresholds are exceeded.
func WatchGoroutineCount(ctx context.Context, threshold int, dumpDir string) {
    go func() {
        ticker := time.NewTicker(30 * time.Second)
        defer ticker.Stop()

        prevCount := 0

        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                current := runtime.NumGoroutine()

                // Capture dump if count exceeds threshold
                // AND has grown significantly since last check
                if current > threshold && current > prevCount*2 {
                    filename := fmt.Sprintf("%s/goroutine-dump-%d-%s.txt",
                        dumpDir,
                        current,
                        time.Now().Format("20060102-150405"))

                    if err := captureGoroutineDump(filename); err == nil {
                        // Log that dump was captured
                        fmt.Fprintf(os.Stderr,
                            "WARN: Goroutine count %d exceeded threshold %d, dump saved to %s\n",
                            current, threshold, filename)
                    }
                }

                prevCount = current
            }
        }
    }()
}

func captureGoroutineDump(filename string) error {
    var buf bytes.Buffer
    if err := pprof.Lookup("goroutine").WriteTo(&buf, 2); err != nil {
        return err
    }

    return os.WriteFile(filename, buf.Bytes(), 0644)
}
```

## Section 7: errgroup for Safe Concurrent Goroutine Management

### errgroup Pattern

```go
// pkg/concurrent/processor.go
package concurrent

import (
    "context"

    "golang.org/x/sync/errgroup"
)

// ProcessConcurrently processes items concurrently with proper
// goroutine lifecycle management via errgroup.
// All goroutines are guaranteed to terminate when this function returns.
func ProcessConcurrently(
    ctx context.Context,
    items []Item,
    concurrency int,
    process func(context.Context, Item) error,
) error {
    // errgroup with context cancellation
    // If any goroutine returns an error, ctx is cancelled and all others stop
    g, gCtx := errgroup.WithContext(ctx)

    // Semaphore to limit concurrency
    sem := make(chan struct{}, concurrency)

    for _, item := range items {
        item := item  // capture loop variable

        // Acquire semaphore slot (respects context cancellation)
        select {
        case sem <- struct{}{}:
        case <-gCtx.Done():
            return g.Wait()
        }

        g.Go(func() error {
            defer func() { <-sem }()  // release semaphore on return
            return process(gCtx, item)
        })
    }

    // Wait for all goroutines to finish
    return g.Wait()
}
```

### Using errgroup in HTTP Fan-Out

```go
// Fetch multiple URLs concurrently with guaranteed cleanup
func fetchAll(ctx context.Context, urls []string) ([][]byte, error) {
    results := make([][]byte, len(urls))
    g, gCtx := errgroup.WithContext(ctx)

    for i, url := range urls {
        i, url := i, url
        g.Go(func() error {
            req, err := http.NewRequestWithContext(gCtx, http.MethodGet, url, nil)
            if err != nil {
                return fmt.Errorf("creating request for %s: %w", url, err)
            }

            resp, err := http.DefaultClient.Do(req)
            if err != nil {
                return fmt.Errorf("fetching %s: %w", url, err)
            }
            defer resp.Body.Close()

            data, err := io.ReadAll(resp.Body)
            if err != nil {
                return fmt.Errorf("reading body from %s: %w", url, err)
            }

            results[i] = data
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err
    }
    return results, nil
}
```

## Section 8: Testing Infrastructure for Goroutine Safety

### Test Helper for Goroutine Count Assertions

```go
// testutil/goroutines.go
package testutil

import (
    "fmt"
    "runtime"
    "testing"
    "time"
)

// AssertNoGoroutineLeak checks that goroutine count returns to
// baseline within the given timeout period.
func AssertNoGoroutineLeak(t *testing.T, timeout time.Duration) {
    t.Helper()
    baseline := runtime.NumGoroutine()

    cleanup := func() {
        t.Helper()
        deadline := time.Now().Add(timeout)

        for time.Now().Before(deadline) {
            current := runtime.NumGoroutine()
            if current <= baseline {
                return
            }
            // Give goroutines time to exit
            time.Sleep(10 * time.Millisecond)
            runtime.Gosched()
        }

        // Still leaking after timeout
        current := runtime.NumGoroutine()
        if current > baseline {
            var buf [1 << 20]byte
            n := runtime.Stack(buf[:], true)
            t.Errorf("goroutine leak: started with %d, ended with %d goroutines\n\n%s",
                baseline, current, string(buf[:n]))
        }
    }

    t.Cleanup(cleanup)
}

// GoroutineCount returns the current number of goroutines.
func GoroutineCount() int {
    return runtime.NumGoroutine()
}

// WaitForGoroutineCount waits until goroutine count reaches the expected value.
func WaitForGoroutineCount(t *testing.T, expected int, timeout time.Duration) {
    t.Helper()
    deadline := time.Now().Add(timeout)
    for time.Now().Before(deadline) {
        if runtime.NumGoroutine() == expected {
            return
        }
        time.Sleep(10 * time.Millisecond)
    }
    t.Errorf("timeout waiting for goroutine count %d, got %d",
        expected, runtime.NumGoroutine())
}
```

### Benchmark Detecting Goroutine Growth

```go
// BenchmarkNoGoroutineLeak verifies the function doesn't grow goroutines
// across multiple iterations.
func BenchmarkHTTPHandler(b *testing.B) {
    srv := httptest.NewServer(myHandler)
    defer srv.Close()

    initialGoroutines := runtime.NumGoroutine()

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        resp, err := http.Get(srv.URL + "/endpoint")
        if err != nil {
            b.Fatal(err)
        }
        io.Copy(io.Discard, resp.Body)
        resp.Body.Close()
    }
    b.StopTimer()

    // Force GC to clean up any finalizers
    runtime.GC()
    time.Sleep(10 * time.Millisecond)

    finalGoroutines := runtime.NumGoroutine()
    if finalGoroutines > initialGoroutines+5 {
        b.Errorf("goroutine leak: started %d, ended with %d",
            initialGoroutines, finalGoroutines)
    }
}
```

## Conclusion

Goroutine leak prevention is a discipline that starts in the design phase — every goroutine you start must have a clear, testable termination condition tied to either context cancellation, channel closure, or explicit shutdown signaling. The goleak library makes this testable: run it in `TestMain` and every test that exercises concurrent code will catch leaks immediately at development time rather than in production.

For running services, the combination of `runtime.NumGoroutine` metrics, Prometheus alerting on growth rate, and automated goroutine dump capture on threshold breach provides the operational visibility needed to catch the rare leaks that slip through testing. The pprof goroutine dump, particularly the wait time on blocked goroutines, is the definitive tool for identifying which code path created the problem.
