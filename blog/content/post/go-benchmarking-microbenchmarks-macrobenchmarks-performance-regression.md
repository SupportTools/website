---
title: "Go Benchmarking: Micro-benchmarks, Macro-benchmarks, and Continuous Performance Testing"
date: 2029-07-07T00:00:00-05:00
draft: false
tags: ["Go", "Benchmarking", "Performance", "testing.B", "benchstat", "Profiling", "CI/CD"]
categories: ["Go", "Performance", "Testing"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go benchmarking: testing.B patterns, benchstat for statistical comparison, benchdiff for automated regression detection, avoiding measurement noise, profiling from benchmarks, and integrating performance testing into CI/CD pipelines."
more_link: "yes"
url: "/go-benchmarking-microbenchmarks-macrobenchmarks-performance-regression/"
---

Premature optimization is the root of all evil, but so is discovering a 3x performance regression in production. Effective Go benchmarking provides the evidence needed to make optimization decisions and catch regressions before they reach users. This post covers the complete Go benchmarking toolkit: from `testing.B` fundamentals to CI/CD integration with automated regression detection.

<!--more-->

# Go Benchmarking: Micro-benchmarks, Macro-benchmarks, and Continuous Performance Testing

## The Benchmarking Hierarchy

Good performance testing operates at multiple levels:

1. **Micro-benchmarks** (`testing.B`): Measure a single function or algorithm. Highly reproducible but may not reflect real-world behavior due to in-cache effects, inlining, and simplified data.

2. **Macro-benchmarks**: Measure the full system under realistic load. Harder to reproduce but reflects actual user-facing performance.

3. **Continuous performance tracking**: Detect regressions automatically in CI/CD before they merge.

Each level serves a different purpose. Micro-benchmarks are for optimization experiments. Macro-benchmarks are for validating that optimizations survive the full system. Continuous tracking is for preventing regression.

## Section 1: testing.B Fundamentals

### Basic Benchmark Structure

```go
package mypackage_test

import (
    "testing"
)

// Benchmark prefix is mandatory
func BenchmarkMyFunction(b *testing.B) {
    // Setup outside the timer
    input := generateTestData(1000)

    b.ReportAllocs() // report memory allocations
    b.ResetTimer()   // exclude setup time from measurement

    for i := 0; i < b.N; i++ {
        // This code is timed
        _ = MyFunction(input)
    }
}
```

```bash
# Run all benchmarks in a package
go test -bench=. ./...

# Run specific benchmark by regex
go test -bench=BenchmarkMyFunction ./pkg/mypackage/

# Run with memory allocation reporting
go test -bench=. -benchmem ./...

# Run for a fixed duration (default is until b.N stabilizes, up to 1 second)
go test -bench=. -benchtime=5s ./...

# Run a fixed number of iterations (useful for comparison)
go test -bench=. -benchtime=1000000x ./...

# Example output:
# BenchmarkMyFunction-16   1000000   1245 ns/op   512 B/op   3 allocs/op
# (name)     (GOMAXPROCS)  (N)       (time/op)    (bytes)    (allocs)
```

### Sub-Benchmarks for Parameter Sweeps

```go
func BenchmarkSort(b *testing.B) {
    sizes := []int{10, 100, 1000, 10000, 100000}

    for _, size := range sizes {
        b.Run(fmt.Sprintf("size=%d", size), func(b *testing.B) {
            data := generateRandomInts(size)
            b.ReportAllocs()
            b.ResetTimer()

            for i := 0; i < b.N; i++ {
                // Make a copy so each iteration sorts fresh data
                tmp := make([]int, len(data))
                copy(tmp, data)
                sort.Ints(tmp)
            }
        })
    }
}
```

```bash
# Run only the size=1000 sub-benchmark
go test -bench='BenchmarkSort/size=1000' ./...

# Run all sub-benchmarks matching size=
go test -bench='BenchmarkSort/size=' ./...
```

### The Benchmark Timer

```go
func BenchmarkWithExpensiveSetup(b *testing.B) {
    // b.N will be run multiple times with different values
    // Reset the timer after any per-b.N setup
    for i := 0; i < b.N; i++ {
        // Expensive per-iteration setup that should NOT be measured
        data := buildComplexTestCase(i)

        b.StartTimer() // resume timing
        result := processData(data)
        b.StopTimer()  // pause timing

        // Validation outside timer
        if err := validateResult(result); err != nil {
            b.Fatalf("iteration %d failed validation: %v", i, err)
        }
    }
}
```

### Reporting Custom Metrics

```go
func BenchmarkThroughput(b *testing.B) {
    server := startTestServer(b)
    client := newTestClient(server.URL)

    payloadSize := 4096
    payload := make([]byte, payloadSize)

    b.ReportAllocs()
    b.SetBytes(int64(payloadSize)) // used to compute throughput (MB/s)
    b.ResetTimer()

    for i := 0; i < b.N; i++ {
        if err := client.Send(payload); err != nil {
            b.Fatal(err)
        }
    }

    // Output will include: X.XX MB/s
}
```

```go
// Reporting custom named metrics
func BenchmarkDatabaseQuery(b *testing.B) {
    db := setupTestDB(b)
    query := "SELECT * FROM orders WHERE customer_id = $1 LIMIT 100"

    var rowsRead int64
    b.ReportAllocs()
    b.ResetTimer()

    for i := 0; i < b.N; i++ {
        rows, err := db.QueryContext(context.Background(), query, i%1000)
        if err != nil {
            b.Fatal(err)
        }
        n := 0
        for rows.Next() {
            n++
        }
        rows.Close()
        rowsRead += int64(n)
    }

    // Report additional derived metrics
    b.ReportMetric(float64(rowsRead)/float64(b.N), "rows/op")
    b.ReportMetric(float64(rowsRead)/b.Elapsed().Seconds(), "rows/sec")
}
```

## Section 2: Avoiding Measurement Noise

### The Compiler Optimization Problem

The Go compiler may optimize away the entire computation being benchmarked if it determines the result is unused. This produces unrealistically fast benchmarks.

```go
// WRONG: compiler may eliminate the function call entirely
func BenchmarkBad(b *testing.B) {
    x := 42
    for i := 0; i < b.N; i++ {
        computeSomething(x) // result discarded, may be compiled out
    }
}

// CORRECT: use a sink variable to prevent elimination
var globalSink interface{}

func BenchmarkCorrect(b *testing.B) {
    x := 42
    var result int
    for i := 0; i < b.N; i++ {
        result = computeSomething(x)
    }
    globalSink = result // force the result to escape to the heap
}

// ALSO CORRECT: use testing.B's own mechanism
func BenchmarkWithSink(b *testing.B) {
    x := 42
    for i := 0; i < b.N; i++ {
        r := computeSomething(x)
        _ = r // using _ is NOT enough; use a global or return
    }
    // Use b.N to force dependency
}
```

The safest pattern is the global sink variable. Assigning to a package-level variable prevents the compiler from dead-code-eliminating the computation.

### Controlling GOMAXPROCS

Benchmarks run with GOMAXPROCS set to the number of available CPUs by default. For single-goroutine benchmarks, fix GOMAXPROCS to 1 for reproducibility:

```go
func BenchmarkSingleThread(b *testing.B) {
    runtime.GOMAXPROCS(1)
    defer runtime.GOMAXPROCS(runtime.NumCPU())

    // ... benchmark
}

// Or set it via the -cpu flag
// go test -bench=. -cpu=1,2,4,8 ./...
// This runs each benchmark with GOMAXPROCS=1, 2, 4, and 8
```

### Parallel Benchmarks

```go
// BenchmarkParallel measures concurrent performance
func BenchmarkParallel(b *testing.B) {
    // Setup shared state
    cache := newCache()

    b.RunParallel(func(pb *testing.PB) {
        // Each goroutine gets its own pb
        key := fmt.Sprintf("key-%d", rand.Intn(1000))
        for pb.Next() {
            cache.Get(key)
        }
    })
}
```

### Cache Warming Effects

```go
// L1/L2 cache effects can dramatically affect benchmark results
// This benchmark is cache-warm (realistic for hot paths)
func BenchmarkCacheWarm(b *testing.B) {
    data := make([]int, 1024) // fits in L1 cache
    for i := range data {
        data[i] = i
    }
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _ = sumSlice(data)
    }
}

// This benchmark simulates cold cache (realistic for infrequent operations)
func BenchmarkCacheCold(b *testing.B) {
    // Large data that doesn't fit in cache
    data := make([]int, 32*1024*1024) // 256MB
    for i := range data {
        data[i] = i
    }
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        // Access random locations to defeat prefetcher
        idx := rand.Intn(len(data))
        _ = data[idx]
    }
}
```

### Using `-count` for Statistical Reliability

A single benchmark run can have significant variance due to OS scheduling, garbage collection, and background processes. Run multiple times and use `benchstat` for statistical analysis:

```bash
# Run each benchmark 10 times
go test -bench=. -benchmem -count=10 ./pkg/mypackage/ | tee bench_current.txt

# Minimum 5 runs, ideally 10-20 for production performance decisions
```

## Section 3: benchstat — Statistical Comparison

`benchstat` computes statistics from multiple benchmark runs and compares two sets of results.

### Installation and Basic Usage

```bash
# Install benchstat (Go 1.21+ ships it as a tool)
go install golang.org/x/perf/cmd/benchstat@latest

# Analyze a single run set
benchstat bench_current.txt

# Output:
# name               time/op      alloc/op     allocs/op
# MyFunction-16      1.24µs ± 2%  512B ± 0%    3.00 ± 0%

# Compare two run sets
benchstat bench_before.txt bench_after.txt

# Output:
# name               old time/op    new time/op    delta
# MyFunction-16      1.24µs ± 2%    0.89µs ± 1%   -28.2%  (p=0.000 n=10+10)
# ParseJSON-16       4.82µs ± 3%    4.79µs ± 2%    ~      (p=0.843 n=10+10)
```

The `delta` column shows the change, and the p-value tells you the statistical significance. A `~` means the change is not statistically significant.

### Interpreting benchstat Output

```
name               old time/op    new time/op    delta
MyFunction-16      1.24µs ± 2%    0.89µs ± 1%   -28.2%  (p=0.000 n=10+10)
```

- `±2%` — coefficient of variation (lower = more stable measurements)
- `p=0.000` — p-value from Mann-Whitney U test (p < 0.05 = statistically significant)
- `n=10+10` — 10 samples in each set

A ±CV of >5% indicates noisy measurements. Potential causes:
- Background CPU load (close other applications)
- Garbage collection during measurement (`GOGC=off` for micro-benchmarks)
- Power management (disable CPU frequency scaling)
- Turbo boost inconsistency (pin CPU frequency)

### Reducing Benchmark Noise on Linux

```bash
# Disable CPU frequency scaling
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > $cpu
done

# Disable turbo boost (Intel)
echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo

# Increase scheduling priority of the benchmark process
sudo nice -n -20 go test -bench=. -count=10 ./...

# Or use taskset to pin to a specific CPU
taskset -c 0 go test -bench=. -count=10 ./...
```

## Section 4: Profiling from Benchmarks

Benchmarks integrate directly with Go's profiling infrastructure. This is the recommended way to profile because it eliminates the measurement overhead of a full HTTP server.

### CPU Profiling

```bash
# Generate CPU profile from benchmark
go test -bench=BenchmarkMyFunction -cpuprofile=cpu.prof ./pkg/mypackage/

# Analyze with pprof (interactive)
go tool pprof cpu.prof
(pprof) top10
(pprof) web        # opens SVG in browser
(pprof) list MyFunction  # annotated source with per-line counts

# Or as a web server
go tool pprof -http=:8080 cpu.prof
```

### Memory Profiling

```bash
# Generate memory profile from benchmark
go test -bench=BenchmarkMyFunction -memprofile=mem.prof ./pkg/mypackage/

# Analyze allocations
go tool pprof -alloc_objects mem.prof
(pprof) top10
(pprof) list MyFunction

# Analyze by inuse memory (long-running analysis)
go tool pprof -inuse_space mem.prof
```

### Flame Graphs

```bash
# Install go-torch or use the built-in pprof web UI
go tool pprof -http=:8080 cpu.prof
# Navigate to http://localhost:8080 → Flame Graph view
```

### Profiling a Specific Benchmark Iteration

```go
// Profile from within the benchmark using runtime/pprof
func BenchmarkWithProfile(b *testing.B) {
    if os.Getenv("PROFILE_ENABLED") == "1" {
        f, _ := os.Create("cpu.prof")
        pprof.StartCPUProfile(f)
        defer pprof.StopCPUProfile()
    }

    for i := 0; i < b.N; i++ {
        doExpensiveWork()
    }
}
```

## Section 5: Macro-benchmarks

Macro-benchmarks test the system end-to-end under realistic load. The goal is to catch performance regressions that micro-benchmarks miss due to interactions between components.

### HTTP Load Testing with hey

```bash
# Install hey
go install github.com/rakyll/hey@latest

# Basic load test
hey -n 100000 -c 100 http://localhost:8080/api/v1/orders

# With specific request body
hey -n 50000 -c 50 \
    -m POST \
    -H "Content-Type: application/json" \
    -d '{"customer_id":"test","amount":99.99}' \
    http://localhost:8080/api/v1/orders

# Output:
# Summary:
#   Total:        12.4563 secs
#   Slowest:      0.8432 secs
#   Fastest:      0.0012 secs
#   Average:      0.0248 secs
#   Requests/sec: 8029.1
#
# Response time histogram:
#   0.001 [1]     |
#   0.085 [94532] |∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎∎
#
# Latency distribution:
#   10%  0.0089 secs
#   50%  0.0201 secs
#   75%  0.0312 secs
#   90%  0.0445 secs
#   95%  0.0623 secs
#   99%  0.1234 secs
```

### gRPC Load Testing with ghz

```bash
# Install ghz
go install github.com/bojand/ghz/cmd/ghz@latest

# Load test a gRPC service
ghz \
  --proto api/order.proto \
  --call orders.OrderService.CreateOrder \
  --data '{"customer_id": "test", "amount": 99.99}' \
  --concurrency 50 \
  --total 100000 \
  localhost:50051

# Continuous load test with target RPS
ghz \
  --proto api/order.proto \
  --call orders.OrderService.CreateOrder \
  --data '{"customer_id": "test"}' \
  --rps 1000 \           # target 1000 RPS
  --duration 60s \       # for 60 seconds
  localhost:50051
```

### Writing Custom Macro-benchmarks

```go
// A macro-benchmark that tests the full service stack
package macrobench_test

import (
    "context"
    "fmt"
    "net/http"
    "net/http/httptest"
    "sync"
    "testing"
    "time"
)

func BenchmarkEndToEnd(b *testing.B) {
    // Start the full application server
    srv := setupRealServer(b)
    defer srv.Close()

    client := &http.Client{
        Transport: &http.Transport{
            MaxIdleConns:    100,
            IdleConnTimeout: 90 * time.Second,
        },
    }

    b.ReportAllocs()
    b.ResetTimer()

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            req, _ := http.NewRequest("GET",
                fmt.Sprintf("%s/api/v1/orders/123", srv.URL), nil)
            resp, err := client.Do(req)
            if err != nil {
                b.Error(err)
                return
            }
            resp.Body.Close()
            if resp.StatusCode != http.StatusOK {
                b.Errorf("expected 200, got %d", resp.StatusCode)
            }
        }
    })
}
```

## Section 6: benchdiff — Automated Regression Detection

`benchdiff` automates the comparison of benchmark results across Git commits:

```bash
# Install benchdiff
go install github.com/WillAbides/benchdiff@latest

# Compare current branch against main
benchdiff \
  --baseline-ref=main \
  --bench=. \
  --count=10 \
  --packages=./... \
  --tolerance=0.10    # flag regressions > 10%

# Output example:
# Benchmark                     Change
# BenchmarkMyFunction           -28.2% (improvement)
# BenchmarkJSONParse            +0.3%  (within tolerance)
# BenchmarkDatabaseQuery        +15.1% REGRESSION (exceeds 10% tolerance)
```

## Section 7: CI/CD Performance Regression Detection

### GitHub Actions Workflow

```yaml
# .github/workflows/benchmarks.yml
name: Performance Benchmarks

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0  # need full history for baseline comparison

    - uses: actions/setup-go@v5
      with:
        go-version: '1.24'

    - name: Install benchmark tools
      run: |
        go install golang.org/x/perf/cmd/benchstat@latest
        go install github.com/WillAbides/benchdiff@latest

    - name: Run benchmarks (current branch)
      run: |
        go test -bench=. -benchmem -count=10 \
          ./... 2>&1 | tee bench_new.txt

    - name: Get baseline benchmarks (main branch)
      run: |
        git stash
        git checkout main
        go test -bench=. -benchmem -count=10 \
          ./... 2>&1 | tee bench_base.txt
        git checkout -

    - name: Compare results
      run: |
        benchstat bench_base.txt bench_new.txt | tee bench_comparison.txt

    - name: Check for regressions
      run: |
        # Fail if any benchmark regressed more than 15%
        if grep -E '\+[0-9]{2,}\.[0-9]+%' bench_comparison.txt | grep -v '~'; then
          echo "Performance regression detected!"
          cat bench_comparison.txt
          exit 1
        fi

    - name: Upload benchmark results
      uses: actions/upload-artifact@v4
      with:
        name: benchmark-results
        path: |
          bench_new.txt
          bench_base.txt
          bench_comparison.txt

    - name: Comment on PR
      if: github.event_name == 'pull_request'
      uses: actions/github-script@v7
      with:
        script: |
          const fs = require('fs');
          const comparison = fs.readFileSync('bench_comparison.txt', 'utf8');
          github.rest.issues.createComment({
            issue_number: context.issue.number,
            owner: context.repo.owner,
            repo: context.repo.repo,
            body: '## Benchmark Comparison\n```\n' + comparison + '\n```'
          });
```

### Storing Benchmark History

For long-term trend analysis, store benchmark results in a time-series format:

```bash
# Store results with timestamp and commit SHA
COMMIT=$(git rev-parse --short HEAD)
DATE=$(date +%Y-%m-%d)

go test -bench=. -benchmem -count=5 ./... \
  | sed "s/^/commit=$COMMIT date=$DATE /" \
  >> benchmark_history.txt

# Or use benchmarks.golang.org/x/benchmarks protocol
# and store in a database for visualization
```

### Using continuous-benchmarks with GitHub Pages

```yaml
# .github/workflows/bench-history.yml
- name: Store benchmark results
  uses: benchmark-action/github-action-benchmark@v1
  with:
    tool: 'go'
    output-file-path: bench_new.txt
    github-token: ${{ secrets.GITHUB_TOKEN }}
    auto-push: true
    alert-threshold: '115%'  # alert if 15% slower than stored baseline
    comment-on-alert: true
    fail-on-alert: true
    alert-comment-cc-users: '@mmattox'
    gh-pages-branch: gh-pages
    benchmark-data-dir-path: perf
```

## Section 8: Common Benchmarking Mistakes

### Mistake 1: Benchmarking Hot Code Paths Without Warmup

```go
// WRONG: first iterations may be slower due to cold JIT/cache
func BenchmarkNoWarmup(b *testing.B) {
    for i := 0; i < b.N; i++ {
        _ = compute()
    }
}

// CORRECT: pre-warm caches and JIT
func BenchmarkWithWarmup(b *testing.B) {
    // Run once to warm up before timing starts
    for i := 0; i < 1000; i++ {
        _ = compute()
    }

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _ = compute()
    }
}
```

### Mistake 2: Ignoring GC Pressure

```go
// Benchmarking with GC interference
func BenchmarkWithGC(b *testing.B) {
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        // This allocates, so GC will run at unpredictable times
        result := make([]byte, 4096)
        process(result)
        _ = result
    }
}

// For micro-benchmarks that shouldn't include GC:
func BenchmarkNoGC(b *testing.B) {
    // Disable GC during the benchmark for cleaner measurements
    prev := debug.SetGCPercent(-1)
    defer debug.SetGCPercent(prev)

    // Pre-allocate to prevent GC during benchmark
    buf := make([]byte, 4096)
    b.ReportAllocs()
    b.ResetTimer()

    for i := 0; i < b.N; i++ {
        process(buf)
    }
}
```

### Mistake 3: Micro-benchmark Confirms Optimization but Macro-benchmark Contradicts

Always validate micro-benchmark optimizations with macro-benchmarks. An optimization that works at the micro level may be neutralized by:

- Lock contention hidden by sequential micro-benchmarks
- Memory allocation patterns that differ under concurrent load
- Cache effects that favor the micro-benchmark's small data set

```go
// Micro: validates the algorithm
func BenchmarkAlgorithm(b *testing.B) {
    data := generateSmallDataset()
    for i := 0; i < b.N; i++ {
        _ = newFasterAlgorithm(data)
    }
}

// Macro: validates under realistic conditions
func BenchmarkAlgorithmConcurrent(b *testing.B) {
    data := generateRealisticDataset() // larger, varied data
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            _ = newFasterAlgorithm(data)
        }
    })
}
```

### Mistake 4: Benchmarking the Test Framework Overhead

```go
// The fmt.Sprintf can dominate the benchmark
func BenchmarkBadSetup(b *testing.B) {
    for i := 0; i < b.N; i++ {
        key := fmt.Sprintf("key-%d", i)  // this is expensive!
        _ = cache.Get(key)
    }
}

// Pre-compute test data outside the loop
func BenchmarkGoodSetup(b *testing.B) {
    keys := make([]string, b.N)
    for i := range keys {
        keys[i] = fmt.Sprintf("key-%d", i%1000)
    }
    b.ResetTimer()

    for i := 0; i < b.N; i++ {
        _ = cache.Get(keys[i])
    }
}
```

## Section 9: Profiling in Production

Profiling in production via continuous profiling tools provides data that benchmarks cannot replicate:

```go
// Import and configure continuous profiler
import "github.com/DataDog/dd-trace-go/profiler"

func main() {
    if err := profiler.Start(
        profiler.WithService("api-server"),
        profiler.WithEnv("production"),
        profiler.WithVersion("1.2.3"),
        profiler.WithProfileTypes(
            profiler.CPUProfile,
            profiler.HeapProfile,
            profiler.GoroutineProfile,
            profiler.MutexProfile,
        ),
    ); err != nil {
        log.Fatal(err)
    }
    defer profiler.Stop()

    // ... run server
}
```

This sends CPU and memory profiles to Datadog (or similar) every 60 seconds, allowing you to see performance trends over time and correlate profiling data with incidents.

For open-source alternatives, use the `net/http/pprof` endpoint with Grafana's continuous profiler integration:

```go
import _ "net/http/pprof"  // registers /debug/pprof/ endpoints

// In your HTTP server:
go func() {
    log.Fatal(http.ListenAndServe(":6060", nil))
}()
```

## Conclusion

Effective Go benchmarking requires discipline at every level:

- Use `testing.B` with `b.ReportAllocs()` and `b.ResetTimer()` for accurate micro-benchmarks
- Always use a global sink variable or `b.N`-dependent computation to prevent dead-code elimination
- Run `go test -count=10` and analyze with `benchstat` to avoid drawing conclusions from noisy single-run results
- Profile from benchmarks using `-cpuprofile` and `-memprofile` to understand where time is actually spent
- Validate micro-benchmark improvements with macro-benchmarks under concurrent load
- Integrate benchmark comparison into CI/CD with `benchstat` comparison and regression thresholds

The investment in a solid benchmarking infrastructure pays dividends when a code review reveals a suspicious change: instead of debating whether the change is faster, you run the benchmarks and the data decides.
