---
title: "Go Benchmarking and Performance Testing: testing.B, pprof Integration, Benchstat, and Regression Detection"
date: 2028-08-21T00:00:00-05:00
draft: false
tags: ["Go", "Benchmarking", "Performance", "testing.B", "pprof", "Benchstat"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Go performance testing with testing.B, pprof CPU and memory profiling, benchstat statistical analysis, and automated regression detection in CI pipelines. Includes real-world patterns for HTTP handlers, database queries, and concurrent workloads."
more_link: "yes"
url: "/go-benchmarking-performance-testing-guide/"
---

Performance problems discovered in production are expensive. Performance problems caught during development are cheap. Go's built-in benchmarking toolchain — `testing.B`, `pprof`, `benchstat`, and `go tool trace` — forms a complete system for measuring, profiling, and statistically validating performance changes before they ship.

This guide builds a production-grade performance testing workflow: from writing meaningful benchmarks and profiling hot paths, to running benchstat comparisons in CI and blocking regressions automatically.

<!--more-->

# [Go Benchmarking and Performance Testing](#go-benchmarking-and-performance-testing)

## Section 1: testing.B Fundamentals

The `testing.B` type is the entry point for all Go benchmarks. Understanding its lifecycle and available controls is essential to writing benchmarks that measure what you intend.

### The Benchmark Lifecycle

```go
// bench/bench_test.go
package bench_test

import (
    "testing"
    "time"
)

// BenchmarkBasic demonstrates the minimal benchmark structure.
// testing.B runs the loop body b.N times, where b.N grows until
// the benchmark runs for at least 1 second (configurable with -benchtime).
func BenchmarkBasic(b *testing.B) {
    for i := 0; i < b.N; i++ {
        // work under measurement
        time.Sleep(1 * time.Nanosecond)
    }
}

// BenchmarkWithSetup shows expensive setup excluded from timing.
// b.ResetTimer() discards any time spent before it is called.
func BenchmarkWithSetup(b *testing.B) {
    // expensive setup — not counted
    data := make([]byte, 1<<20) // 1 MB
    for i := range data {
        data[i] = byte(i)
    }

    b.ResetTimer() // start timing here
    for i := 0; i < b.N; i++ {
        _ = sum(data)
    }
}

func sum(data []byte) int {
    total := 0
    for _, v := range data {
        total += int(v)
    }
    return total
}
```

### Reporting Allocations and Bytes

```go
// BenchmarkAllocations shows how to report both allocations and
// throughput metrics alongside the standard ns/op measurement.
func BenchmarkAllocations(b *testing.B) {
    b.ReportAllocs() // enables allocs/op and B/op columns

    b.SetBytes(1024) // enables MB/s throughput calculation

    for i := 0; i < b.N; i++ {
        buf := make([]byte, 1024)
        _ = buf
    }
}
```

Run with verbose output:

```bash
# Run benchmarks — never run alongside go test unit tests by default
go test -bench=. -benchmem ./bench/

# Output:
# BenchmarkBasic-8               1000000000         0.9811 ns/op
# BenchmarkWithSetup-8              100000        10234 ns/op
# BenchmarkAllocations-8          10000000          102.3 ns/op    1024 B/op    1 allocs/op    9752 MB/s
```

### Controlling Benchmark Duration and Count

```bash
# Run each benchmark for 5 seconds instead of 1
go test -bench=. -benchtime=5s ./...

# Run each benchmark exactly 1000 times regardless of duration
go test -bench=. -benchtime=1000x ./...

# Run benchmarks 5 times for statistical significance
go test -bench=. -count=5 ./...

# Run only benchmarks matching a regex
go test -bench=BenchmarkHTTP -benchmem -count=5 ./...
```

## Section 2: Table-Driven Benchmarks and Sub-Benchmarks

Table-driven benchmarks mirror the table-driven test pattern and enable systematic comparison of input sizes, algorithms, and configurations.

```go
// bench/string_test.go
package bench_test

import (
    "fmt"
    "strings"
    "testing"
    "unicode/utf8"
)

// BenchmarkStringConcat compares three approaches to building strings.
// Each sub-benchmark is an independent measurement.
func BenchmarkStringConcat(b *testing.B) {
    sizes := []int{10, 100, 1000, 10000}

    for _, n := range sizes {
        n := n // capture loop variable
        b.Run(fmt.Sprintf("concat_plus/n=%d", n), func(b *testing.B) {
            b.ReportAllocs()
            for i := 0; i < b.N; i++ {
                s := ""
                for j := 0; j < n; j++ {
                    s += "x"
                }
                _ = s
            }
        })

        b.Run(fmt.Sprintf("strings_builder/n=%d", n), func(b *testing.B) {
            b.ReportAllocs()
            for i := 0; i < b.N; i++ {
                var sb strings.Builder
                sb.Grow(n)
                for j := 0; j < n; j++ {
                    sb.WriteByte('x')
                }
                _ = sb.String()
            }
        })

        b.Run(fmt.Sprintf("byte_slice/n=%d", n), func(b *testing.B) {
            b.ReportAllocs()
            for i := 0; i < b.N; i++ {
                buf := make([]byte, 0, n)
                for j := 0; j < n; j++ {
                    buf = append(buf, 'x')
                }
                _ = string(buf)
            }
        })
    }
}

// BenchmarkUTF8Iteration compares byte vs rune iteration over UTF-8 strings.
func BenchmarkUTF8Iteration(b *testing.B) {
    inputs := []struct {
        name string
        s    string
    }{
        {"ascii_100", strings.Repeat("a", 100)},
        {"multibyte_100", strings.Repeat("日", 100)},
        {"mixed_100", strings.Repeat("aあ", 50)},
    }

    for _, tc := range inputs {
        tc := tc
        b.Run("range_rune/"+tc.name, func(b *testing.B) {
            b.SetBytes(int64(len(tc.s)))
            b.ReportAllocs()
            for i := 0; i < b.N; i++ {
                count := 0
                for range tc.s {
                    count++
                }
                _ = count
            }
        })

        b.Run("utf8_rune_count/"+tc.name, func(b *testing.B) {
            b.SetBytes(int64(len(tc.s)))
            b.ReportAllocs()
            for i := 0; i < b.N; i++ {
                _ = utf8.RuneCountInString(tc.s)
            }
        })
    }
}
```

### Parameterized Benchmarks with Shared State

```go
// bench/cache_test.go
package bench_test

import (
    "fmt"
    "sync"
    "testing"
)

// Cache is a simple thread-safe map for benchmarking.
type Cache struct {
    mu    sync.RWMutex
    store map[string][]byte
}

func NewCache() *Cache {
    return &Cache{store: make(map[string][]byte)}
}

func (c *Cache) Set(key string, value []byte) {
    c.mu.Lock()
    c.store[key] = value
    c.mu.Unlock()
}

func (c *Cache) Get(key string) ([]byte, bool) {
    c.mu.RLock()
    v, ok := c.store[key]
    c.mu.RUnlock()
    return v, ok
}

// BenchmarkCacheReadHeavy benchmarks a read-heavy workload with varying
// reader-to-writer ratios. Uses b.SetParallelism to control goroutine count.
func BenchmarkCacheReadHeavy(b *testing.B) {
    ratios := []struct {
        name    string
        writers int // out of 100 goroutines
    }{
        {"99r_1w", 1},
        {"95r_5w", 5},
        {"80r_20w", 20},
        {"50r_50w", 50},
    }

    for _, r := range ratios {
        r := r
        b.Run(r.name, func(b *testing.B) {
            cache := NewCache()
            // pre-populate
            for i := 0; i < 1000; i++ {
                cache.Set(fmt.Sprintf("key-%d", i), []byte("value"))
            }

            b.SetParallelism(100)
            b.ReportAllocs()
            b.ResetTimer()

            var counter int64
            b.RunParallel(func(pb *testing.PB) {
                localCounter := int64(0)
                for pb.Next() {
                    localCounter++
                    key := fmt.Sprintf("key-%d", localCounter%1000)
                    // simulate writer ratio
                    if localCounter%100 < int64(r.writers) {
                        cache.Set(key, []byte("updated"))
                    } else {
                        cache.Get(key)
                    }
                }
            })
            _ = counter
        })
    }
}
```

## Section 3: Benchmarking HTTP Handlers and Middleware

HTTP handler benchmarks require careful setup to avoid measuring the HTTP framework overhead rather than your application code.

```go
// bench/http_test.go
package bench_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "strings"
    "testing"
)

type OrderRequest struct {
    ProductID string  `json:"product_id"`
    Quantity  int     `json:"quantity"`
    Price     float64 `json:"price"`
}

type OrderResponse struct {
    OrderID string `json:"order_id"`
    Status  string `json:"status"`
    Total   float64 `json:"total"`
}

// processOrder simulates non-trivial handler logic.
func processOrder(r *OrderRequest) (*OrderResponse, error) {
    return &OrderResponse{
        OrderID: "ord-" + r.ProductID,
        Status:  "pending",
        Total:   r.Price * float64(r.Quantity),
    }, nil
}

// OrderHandler is the handler under test.
func OrderHandler(w http.ResponseWriter, r *http.Request) {
    var req OrderRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }
    resp, err := processOrder(&req)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(resp)
}

// BenchmarkOrderHandler measures full handler execution including JSON
// encoding/decoding, which is often the dominant cost in REST APIs.
func BenchmarkOrderHandler(b *testing.B) {
    handler := http.HandlerFunc(OrderHandler)

    body := `{"product_id":"prod-123","quantity":5,"price":9.99}`

    b.ReportAllocs()
    b.ResetTimer()

    for i := 0; i < b.N; i++ {
        req := httptest.NewRequest(http.MethodPost, "/orders", strings.NewReader(body))
        req.Header.Set("Content-Type", "application/json")
        w := httptest.NewRecorder()

        handler.ServeHTTP(w, req)

        if w.Code != http.StatusOK {
            b.Fatalf("unexpected status: %d", w.Code)
        }
    }
}

// BenchmarkOrderHandlerParallel measures handler throughput under concurrency.
// This catches contention on shared resources (connection pools, caches, etc.).
func BenchmarkOrderHandlerParallel(b *testing.B) {
    handler := http.HandlerFunc(OrderHandler)
    body := `{"product_id":"prod-123","quantity":5,"price":9.99}`

    b.ReportAllocs()
    b.ResetTimer()

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            req := httptest.NewRequest(http.MethodPost, "/orders", strings.NewReader(body))
            req.Header.Set("Content-Type", "application/json")
            w := httptest.NewRecorder()
            handler.ServeHTTP(w, req)
        }
    })
}

// BenchmarkJSONMarshalVariants compares encoding approaches.
func BenchmarkJSONMarshalVariants(b *testing.B) {
    resp := &OrderResponse{
        OrderID: "ord-abc-123",
        Status:  "pending",
        Total:   49.95,
    }

    b.Run("json_marshal", func(b *testing.B) {
        b.ReportAllocs()
        for i := 0; i < b.N; i++ {
            data, err := json.Marshal(resp)
            if err != nil {
                b.Fatal(err)
            }
            _ = data
        }
    })

    b.Run("json_encoder_discard", func(b *testing.B) {
        b.ReportAllocs()
        enc := json.NewEncoder(io_discard{})
        for i := 0; i < b.N; i++ {
            if err := enc.Encode(resp); err != nil {
                b.Fatal(err)
            }
        }
    })
}

// io_discard implements io.Writer and discards all writes.
type io_discard struct{}

func (io_discard) Write(p []byte) (int, error) { return len(p), nil }
```

## Section 4: Database Query Benchmarks with testcontainers

Benchmarking database code requires a real database. `testcontainers-go` provides ephemeral containers that start inside the test run itself.

```go
// bench/db_bench_test.go
package bench_test

import (
    "context"
    "database/sql"
    "fmt"
    "testing"
    "time"

    _ "github.com/lib/pq"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
    "github.com/testcontainers/testcontainers-go/wait"
)

func setupPostgres(tb testing.TB) *sql.DB {
    tb.Helper()
    ctx := context.Background()

    pgContainer, err := postgres.RunContainer(ctx,
        testcontainers.WithImage("postgres:16-alpine"),
        postgres.WithDatabase("benchdb"),
        postgres.WithUsername("bench"),
        postgres.WithPassword("bench"),
        testcontainers.WithWaitStrategy(
            wait.ForLog("database system is ready to accept connections").
                WithOccurrence(2).
                WithStartupTimeout(60*time.Second),
        ),
    )
    if err != nil {
        tb.Fatalf("start postgres: %v", err)
    }
    tb.Cleanup(func() { pgContainer.Terminate(ctx) })

    connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
    if err != nil {
        tb.Fatalf("connection string: %v", err)
    }

    db, err := sql.Open("postgres", connStr)
    if err != nil {
        tb.Fatalf("open db: %v", err)
    }
    tb.Cleanup(func() { db.Close() })

    // Create schema
    _, err = db.ExecContext(ctx, `
        CREATE TABLE IF NOT EXISTS orders (
            id          BIGSERIAL PRIMARY KEY,
            product_id  TEXT NOT NULL,
            user_id     TEXT NOT NULL,
            quantity    INT  NOT NULL,
            total       NUMERIC(10,2) NOT NULL,
            status      TEXT NOT NULL DEFAULT 'pending',
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    `)
    if err != nil {
        tb.Fatalf("create schema: %v", err)
    }

    // Seed data
    for i := 0; i < 10000; i++ {
        _, err := db.ExecContext(ctx,
            `INSERT INTO orders(product_id, user_id, quantity, total, status)
             VALUES($1, $2, $3, $4, $5)`,
            fmt.Sprintf("prod-%d", i%100),
            fmt.Sprintf("user-%d", i%500),
            (i%10)+1,
            float64((i%50)+1)*9.99,
            []string{"pending", "shipped", "delivered"}[i%3],
        )
        if err != nil {
            tb.Fatalf("seed: %v", err)
        }
    }

    return db
}

// BenchmarkDBQuery measures indexed vs non-indexed query performance.
func BenchmarkDBQuery(b *testing.B) {
    db := setupPostgres(b)
    ctx := context.Background()

    b.Run("indexed_user_lookup", func(b *testing.B) {
        b.ReportAllocs()
        b.ResetTimer()
        for i := 0; i < b.N; i++ {
            userID := fmt.Sprintf("user-%d", i%500)
            rows, err := db.QueryContext(ctx,
                `SELECT id, product_id, quantity, total FROM orders WHERE user_id=$1 LIMIT 10`,
                userID,
            )
            if err != nil {
                b.Fatal(err)
            }
            for rows.Next() {
                var id int64
                var pid string
                var qty int
                var total float64
                rows.Scan(&id, &pid, &qty, &total)
            }
            rows.Close()
        }
    })

    b.Run("non_indexed_total_range", func(b *testing.B) {
        b.ReportAllocs()
        b.ResetTimer()
        for i := 0; i < b.N; i++ {
            rows, err := db.QueryContext(ctx,
                `SELECT id, user_id FROM orders WHERE total > $1 AND total < $2 LIMIT 10`,
                10.0, 50.0,
            )
            if err != nil {
                b.Fatal(err)
            }
            for rows.Next() {
                var id int64
                var uid string
                rows.Scan(&id, &uid)
            }
            rows.Close()
        }
    })

    b.Run("prepared_stmt_user_lookup", func(b *testing.B) {
        stmt, err := db.PrepareContext(ctx,
            `SELECT id, product_id, quantity, total FROM orders WHERE user_id=$1 LIMIT 10`,
        )
        if err != nil {
            b.Fatal(err)
        }
        defer stmt.Close()

        b.ReportAllocs()
        b.ResetTimer()
        for i := 0; i < b.N; i++ {
            userID := fmt.Sprintf("user-%d", i%500)
            rows, err := stmt.QueryContext(ctx, userID)
            if err != nil {
                b.Fatal(err)
            }
            for rows.Next() {
                var id int64
                var pid string
                var qty int
                var total float64
                rows.Scan(&id, &pid, &qty, &total)
            }
            rows.Close()
        }
    })
}
```

## Section 5: pprof CPU Profiling

`pprof` captures call stacks at regular intervals (default 100 Hz) to identify hot functions. Integrating it with benchmarks gives you profiles exactly representative of your benchmark workload.

### Generating Profiles from Benchmarks

```bash
# Generate CPU profile during benchmark
go test -bench=BenchmarkOrderHandler -benchtime=10s -cpuprofile=cpu.prof ./bench/

# Generate memory (heap) profile
go test -bench=BenchmarkOrderHandler -benchtime=10s -memprofile=mem.prof ./bench/

# Generate goroutine blocking profile (contention on sync primitives)
go test -bench=BenchmarkCacheReadHeavy -benchtime=10s -blockprofile=block.prof ./bench/

# Generate mutex contention profile
go test -bench=BenchmarkCacheReadHeavy -benchtime=10s -mutexprofile=mutex.prof ./bench/
```

### Analyzing Profiles with pprof

```bash
# Interactive CLI exploration
go tool pprof cpu.prof

# Useful pprof commands inside the interactive shell:
(pprof) top10               # top 10 functions by cumulative CPU
(pprof) top10 -cum          # sort by cumulative (includes callees)
(pprof) list BenchmarkOrder # annotated source for a function
(pprof) web                 # open SVG flame graph in browser (requires graphviz)
(pprof) png > cpu_flame.png # save flame graph as PNG

# Web UI (serves at http://localhost:8080/ui/)
go tool pprof -http=:8080 cpu.prof

# Compare two profiles to find regressions
go tool pprof -base=cpu_before.prof cpu_after.prof
(pprof) top10 -cum
```

### Programmatic Profile Capture

For long-running services, capture profiles via HTTP:

```go
// server/profiling.go
package server

import (
    "net/http"
    _ "net/http/pprof" // registers /debug/pprof/* handlers as a side effect
    "runtime"
    "time"
)

// StartProfilingServer starts a pprof HTTP server on a separate port.
// Never expose this on a public port.
func StartProfilingServer(addr string) {
    // Enable block and mutex profiling (disabled by default)
    runtime.SetBlockProfileRate(1)    // every blocking event
    runtime.SetMutexProfileFraction(1) // every mutex contention

    go func() {
        // net/http/pprof registers its handlers on DefaultServeMux when imported
        http.ListenAndServe(addr, nil)
    }()
}

// CaptureProfiles captures CPU and heap profiles to files.
// Useful for capturing profiles in production on demand.
func CaptureProfiles(duration time.Duration, cpuPath, memPath string) error {
    import (
        "os"
        "runtime/pprof"
    )

    // CPU profile
    cpuFile, err := os.Create(cpuPath)
    if err != nil {
        return fmt.Errorf("create cpu profile: %w", err)
    }
    defer cpuFile.Close()

    if err := pprof.StartCPUProfile(cpuFile); err != nil {
        return fmt.Errorf("start cpu profile: %w", err)
    }
    time.Sleep(duration)
    pprof.StopCPUProfile()

    // Heap profile (after GC for accuracy)
    runtime.GC()
    memFile, err := os.Create(memPath)
    if err != nil {
        return fmt.Errorf("create mem profile: %w", err)
    }
    defer memFile.Close()

    if err := pprof.WriteHeapProfile(memFile); err != nil {
        return fmt.Errorf("write heap profile: %w", err)
    }

    return nil
}
```

Capture from a running service:

```bash
# Capture 30-second CPU profile from running service
curl -o cpu.prof http://localhost:6060/debug/pprof/profile?seconds=30

# Capture current heap profile
curl -o mem.prof http://localhost:6060/debug/pprof/heap

# Capture goroutine trace (all goroutine stacks)
curl -o goroutines.txt http://localhost:6060/debug/pprof/goroutine?debug=2

# Capture execution trace (scheduler, GC, goroutine scheduling events)
curl -o trace.out http://localhost:6060/debug/pprof/trace?seconds=5
go tool trace trace.out
```

## Section 6: Memory Profiling and Escape Analysis

### Heap vs Stack Allocation

Understanding Go's escape analysis helps eliminate unnecessary heap allocations:

```go
// bench/alloc_test.go
package bench_test

import (
    "fmt"
    "testing"
)

// Point escapes to heap when returned as interface{} or *Point.
type Point struct{ X, Y float64 }

// BenchmarkAllocationPatterns shows which code paths allocate on heap.
func BenchmarkAllocationPatterns(b *testing.B) {
    // This benchmark is best analyzed with -gcflags="-m" to see escape decisions.
    // go test -bench=BenchmarkAllocationPatterns -gcflags="-m" ./bench/

    b.Run("value_no_escape", func(b *testing.B) {
        b.ReportAllocs()
        for i := 0; i < b.N; i++ {
            p := Point{X: float64(i), Y: float64(i) * 2}
            // p stays on stack because it doesn't escape this scope
            _ = p.X + p.Y
        }
    })

    b.Run("pointer_escapes_return", func(b *testing.B) {
        b.ReportAllocs()
        for i := 0; i < b.N; i++ {
            p := newPoint(float64(i))
            _ = p.X
        }
    })

    b.Run("interface_escapes", func(b *testing.B) {
        b.ReportAllocs()
        for i := 0; i < b.N; i++ {
            var iface interface{} = Point{X: float64(i), Y: float64(i)}
            _ = iface
        }
    })

    b.Run("fmt_sprintf_allocates", func(b *testing.B) {
        b.ReportAllocs()
        for i := 0; i < b.N; i++ {
            s := fmt.Sprintf("key-%d", i)
            _ = s
        }
    })

    b.Run("manual_itoa_no_alloc", func(b *testing.B) {
        b.ReportAllocs()
        buf := make([]byte, 0, 32)
        for i := 0; i < b.N; i++ {
            buf = appendInt(buf[:0], i)
            _ = buf
        }
    })
}

func newPoint(x float64) *Point {
    return &Point{X: x, Y: x * 2} // escapes to heap
}

// appendInt is an allocation-free integer-to-string conversion.
func appendInt(buf []byte, n int) []byte {
    if n == 0 {
        return append(buf, '0')
    }
    if n < 0 {
        buf = append(buf, '-')
        n = -n
    }
    start := len(buf)
    for n > 0 {
        buf = append(buf, byte('0'+n%10))
        n /= 10
    }
    // reverse digits
    for i, j := start, len(buf)-1; i < j; i, j = i+1, j-1 {
        buf[i], buf[j] = buf[j], buf[i]
    }
    return buf
}
```

View escape analysis decisions:

```bash
# Show escape analysis decisions for all packages under bench/
go build -gcflags="-m -m" ./bench/ 2>&1 | grep -E "(escape|heap|stack)"

# Example output:
# ./alloc_test.go:24:16: Point{...} does not escape
# ./alloc_test.go:32:14: &Point{...} escapes to heap
# ./alloc_test.go:39:44: Point{...} escapes to heap (interface conversion)
```

### Analyzing Heap Profiles

```bash
# View top allocating functions
go tool pprof -alloc_objects mem.prof
(pprof) top10

# View top allocation sizes
go tool pprof -alloc_space mem.prof
(pprof) top10

# Show allocations in source
(pprof) list processOrder

# Inuse objects (live at time of profile — for memory leak detection)
go tool pprof -inuse_objects mem.prof
(pprof) top10
```

## Section 7: benchstat — Statistical Benchmark Comparison

`benchstat` computes statistical summaries of benchmark output and compares runs to determine if observed differences are statistically significant, not just noise.

### Installing benchstat

```bash
go install golang.org/x/perf/cmd/benchstat@latest
```

### Capturing and Comparing Runs

```bash
# Run benchmarks before a code change and save output
git stash  # or checkout baseline branch
go test -bench=. -benchmem -count=10 ./bench/ > before.txt

# Apply your change
git stash pop

# Run again after the change
go test -bench=. -benchmem -count=10 ./bench/ > after.txt

# Compare the two runs
benchstat before.txt after.txt
```

Example output:

```
name                        old time/op    new time/op    delta
OrderHandler-8                4.21µs ± 3%    2.87µs ± 2%  -31.83%  (p=0.000 n=10+10)
OrderHandlerParallel-8        1.12µs ± 5%    0.98µs ± 4%  -12.50%  (p=0.000 n=10+10)
StringConcat/n=100-8           8.14µs ± 2%    8.12µs ± 1%     ~     (p=0.720 n=10+10)
StringConcat/n=1000-8           841µs ± 3%     840µs ± 2%     ~     (p=0.853 n=10+10)

name                        old alloc/op   new alloc/op   delta
OrderHandler-8                 1.20kB ± 0%    0.80kB ± 0%  -33.33%  (p=0.000 n=10+10)
OrderHandlerParallel-8          960B ± 0%      640B ± 0%  -33.33%  (p=0.000 n=10+10)

name                        old allocs/op  new allocs/op  delta
OrderHandler-8                   12.0 ± 0%      8.0 ± 0%  -33.33%  (p=0.000 n=10+10)
```

The `p=0.000` indicates high statistical confidence (p-value threshold is 0.05 by default). Lines showing `~` indicate no statistically significant change.

### benchstat Filtering and Formatting

```bash
# Filter to show only regressions (delta > 0 is worse for time)
benchstat -filter "delta > 0.05" before.txt after.txt

# Show only allocation comparison
benchstat -metric allocs before.txt after.txt

# Compare three or more configurations
benchstat baseline.txt candidate_a.txt candidate_b.txt

# HTML output for embedding in reports
benchstat -html before.txt after.txt > comparison.html

# CSV output for spreadsheet analysis
benchstat -csv before.txt after.txt > comparison.csv
```

## Section 8: Automated Regression Detection in CI

Manual benchmarking is error-prone. Automating it in CI catches performance regressions before they merge.

### GitHub Actions Workflow

```yaml
# .github/workflows/benchmarks.yml
name: Benchmark Regression Check

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  benchmark:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # need full history for base branch checkout

      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
          cache: true

      - name: Install benchstat
        run: go install golang.org/x/perf/cmd/benchstat@latest

      - name: Run benchmarks on PR branch
        run: |
          go test \
            -bench=. \
            -benchmem \
            -count=10 \
            -benchtime=2s \
            -run='^$' \
            ./... | tee pr_bench.txt

      - name: Checkout base branch for comparison
        run: |
          git fetch origin ${{ github.base_ref }}
          git stash  # save any uncommitted changes

      - name: Run benchmarks on base branch
        run: |
          git checkout origin/${{ github.base_ref }}
          go test \
            -bench=. \
            -benchmem \
            -count=10 \
            -benchtime=2s \
            -run='^$' \
            ./... | tee base_bench.txt
          git checkout -  # restore PR branch

      - name: Compare results
        id: benchstat
        run: |
          # Exit code is non-zero if any benchmark regressed by more than threshold
          result=$(benchstat -threshold=0.10 base_bench.txt pr_bench.txt 2>&1)
          echo "result<<EOF" >> $GITHUB_OUTPUT
          echo "$result" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT

          # Fail the job if regressions detected (lines with positive delta)
          if echo "$result" | grep -qE '\+[0-9]+\.[0-9]+%.*p=0\.0(0[01]|00)'; then
            echo "regression=true" >> $GITHUB_OUTPUT
            exit 1
          fi
          echo "regression=false" >> $GITHUB_OUTPUT

      - name: Post results to PR
        if: always() && github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const result = `${{ steps.benchstat.outputs.result }}`;
            const regression = '${{ steps.benchstat.outputs.regression }}' === 'true';
            const emoji = regression ? '🔴' : '🟢';

            const body = `## ${emoji} Benchmark Results

            <details>
            <summary>Full comparison (base → PR)</summary>

            \`\`\`
            ${result}
            \`\`\`
            </details>

            ${regression ? '**Performance regression detected. Please investigate.**' : '**No significant regressions detected.**'}
            `;

            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: body,
            });

      - name: Store benchmark results
        if: github.ref == 'refs/heads/main'
        uses: actions/upload-artifact@v4
        with:
          name: benchmark-results-${{ github.sha }}
          path: |
            pr_bench.txt
            base_bench.txt
          retention-days: 90
```

### Continuous Benchmark Tracking with github-action-benchmark

For tracking benchmark trends over time (not just PR comparisons), use the community `benchmark-action`:

```yaml
# .github/workflows/bench-track.yml
name: Benchmark Tracking

on:
  push:
    branches: [main]

jobs:
  track:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"

      - name: Run benchmarks
        run: |
          go test -bench=. -benchmem -count=5 ./... \
            | tee bench_output.txt

      - name: Store benchmark result
        uses: benchmark-action/github-action-benchmark@v1
        with:
          tool: 'go'
          output-file-path: bench_output.txt
          github-token: ${{ secrets.GITHUB_TOKEN }}
          auto-push: true
          # Alert if benchmark is 10% slower than the last result
          alert-threshold: '110%'
          comment-on-alert: true
          fail-on-alert: true
          # Store results on gh-pages branch
          gh-pages-branch: gh-pages
          benchmark-data-dir-path: dev/bench
```

## Section 9: Writing a Custom Regression Checker

For more control than `benchstat` alone provides, implement a regression checker that integrates with your specific alerting thresholds and reporting formats.

```go
// tools/benchcheck/main.go
package main

import (
    "bufio"
    "flag"
    "fmt"
    "math"
    "os"
    "sort"
    "strconv"
    "strings"
)

type BenchResult struct {
    Name    string
    Runs    []float64 // ns/op values
    Allocs  []float64 // allocs/op values
    Bytes   []float64 // B/op values
}

// mean returns the arithmetic mean of a slice.
func mean(xs []float64) float64 {
    if len(xs) == 0 {
        return 0
    }
    sum := 0.0
    for _, x := range xs {
        sum += x
    }
    return sum / float64(len(xs))
}

// stddev returns the sample standard deviation.
func stddev(xs []float64) float64 {
    if len(xs) < 2 {
        return 0
    }
    m := mean(xs)
    variance := 0.0
    for _, x := range xs {
        diff := x - m
        variance += diff * diff
    }
    return math.Sqrt(variance / float64(len(xs)-1))
}

// parseBenchOutput parses go test -bench output into BenchResult map.
func parseBenchOutput(filename string) (map[string]*BenchResult, error) {
    f, err := os.Open(filename)
    if err != nil {
        return nil, fmt.Errorf("open %s: %w", filename, err)
    }
    defer f.Close()

    results := make(map[string]*BenchResult)
    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        line := scanner.Text()
        if !strings.HasPrefix(line, "Benchmark") {
            continue
        }
        fields := strings.Fields(line)
        if len(fields) < 4 {
            continue
        }
        name := fields[0]
        if _, ok := results[name]; !ok {
            results[name] = &BenchResult{Name: name}
        }
        r := results[name]

        // fields: Name  N  ns/op  [B/op  allocs/op  ...]
        for i := 2; i+1 < len(fields); i += 2 {
            val, err := strconv.ParseFloat(fields[i], 64)
            if err != nil {
                continue
            }
            unit := fields[i+1]
            switch unit {
            case "ns/op":
                r.Runs = append(r.Runs, val)
            case "B/op":
                r.Bytes = append(r.Bytes, val)
            case "allocs/op":
                r.Allocs = append(r.Allocs, val)
            }
        }
    }
    return results, scanner.Err()
}

type Regression struct {
    Name    string
    Metric  string
    Before  float64
    After   float64
    Delta   float64 // percentage change
}

func check(basePath, prPath string, threshold float64) ([]Regression, error) {
    base, err := parseBenchOutput(basePath)
    if err != nil {
        return nil, fmt.Errorf("parse base: %w", err)
    }
    pr, err := parseBenchOutput(prPath)
    if err != nil {
        return nil, fmt.Errorf("parse pr: %w", err)
    }

    var regressions []Regression

    for name, prResult := range pr {
        baseResult, ok := base[name]
        if !ok {
            continue // new benchmark, skip
        }

        type metric struct {
            name   string
            before []float64
            after  []float64
        }

        metrics := []metric{
            {"ns/op", baseResult.Runs, prResult.Runs},
            {"allocs/op", baseResult.Allocs, prResult.Allocs},
            {"B/op", baseResult.Bytes, prResult.Bytes},
        }

        for _, m := range metrics {
            if len(m.before) == 0 || len(m.after) == 0 {
                continue
            }
            beforeMean := mean(m.before)
            afterMean := mean(m.after)
            if beforeMean == 0 {
                continue
            }
            delta := (afterMean - beforeMean) / beforeMean * 100

            if delta > threshold*100 {
                regressions = append(regressions, Regression{
                    Name:   name,
                    Metric: m.name,
                    Before: beforeMean,
                    After:  afterMean,
                    Delta:  delta,
                })
            }
        }
    }

    sort.Slice(regressions, func(i, j int) bool {
        return regressions[i].Delta > regressions[j].Delta
    })

    return regressions, nil
}

func main() {
    base := flag.String("base", "before.txt", "base benchmark output file")
    pr := flag.String("pr", "after.txt", "PR benchmark output file")
    threshold := flag.Float64("threshold", 0.10, "regression threshold (0.10 = 10%)")
    flag.Parse()

    regressions, err := check(*base, *pr, *threshold)
    if err != nil {
        fmt.Fprintf(os.Stderr, "error: %v\n", err)
        os.Exit(2)
    }

    if len(regressions) == 0 {
        fmt.Println("✓ No performance regressions detected")
        os.Exit(0)
    }

    fmt.Printf("✗ %d regression(s) detected (threshold: %.0f%%):\n\n", len(regressions), *threshold*100)
    fmt.Printf("%-60s %-12s %-12s %-12s %-10s\n", "Benchmark", "Metric", "Before", "After", "Change")
    fmt.Println(strings.Repeat("-", 110))
    for _, r := range regressions {
        fmt.Printf("%-60s %-12s %-12.2f %-12.2f +%.2f%%\n",
            r.Name, r.Metric, r.Before, r.After, r.Delta)
    }
    os.Exit(1)
}
```

```bash
# Build and run
go build -o benchcheck ./tools/benchcheck/

./benchcheck -base before.txt -pr after.txt -threshold 0.05

# Output on regression:
# ✗ 2 regression(s) detected (threshold: 5%):
#
# Benchmark                                            Metric       Before       After        Change
# BenchmarkOrderHandler-8                              ns/op        2876.45      3412.00      +18.62%
# BenchmarkOrderHandler-8                              allocs/op    8.00         12.00        +50.00%
```

## Section 10: go tool trace — Scheduler and GC Analysis

While `pprof` shows where CPU time is spent, `go tool trace` shows *when* things happen: goroutine scheduling latency, GC pauses, network wait times, and syscall overhead.

```go
// bench/trace_test.go
package bench_test

import (
    "os"
    "runtime/trace"
    "testing"
)

// TestGenerateTrace generates a trace file for analysis.
// Run with: go test -run=TestGenerateTrace ./bench/
func TestGenerateTrace(t *testing.T) {
    f, err := os.Create("trace.out")
    if err != nil {
        t.Fatal(err)
    }
    defer f.Close()

    trace.Start(f)
    defer trace.Stop()

    // Run the workload you want to trace
    for i := 0; i < 1000; i++ {
        data := make([]byte, 1<<16)
        _ = sum(data)
    }
}
```

```bash
# Generate and view trace
go test -run=TestGenerateTrace ./bench/
go tool trace trace.out

# The trace viewer opens in your browser showing:
# - Goroutine timelines
# - GC events (STW phases highlighted in red)
# - Syscall events
# - Network polling events
# - Heap size over time
```

### Tracing User-Defined Regions

```go
// bench/trace_regions_test.go
package bench_test

import (
    "context"
    "runtime/trace"
    "testing"
)

// BenchmarkWithTraceRegions adds user-defined trace regions for
// finer-grained analysis in go tool trace.
func BenchmarkWithTraceRegions(b *testing.B) {
    for i := 0; i < b.N; i++ {
        ctx := context.Background()

        // Define a task — appears as a separate line in trace
        ctx, task := trace.NewTask(ctx, "ProcessOrder")

        // Define regions within the task
        r1 := trace.StartRegion(ctx, "validate")
        // validation work
        validateOrder("prod-123", 5)
        r1.End()

        r2 := trace.StartRegion(ctx, "compute_price")
        // computation work
        computePrice(9.99, 5)
        r2.End()

        trace.Log(ctx, "result", "pending")
        task.End()
    }
}

func validateOrder(productID string, qty int) bool {
    return productID != "" && qty > 0
}

func computePrice(unitPrice float64, qty int) float64 {
    return unitPrice * float64(qty)
}
```

## Section 11: Benchmark Anti-Patterns to Avoid

Understanding what makes a benchmark invalid is as important as knowing how to write one.

### Anti-Pattern 1: Dead Code Elimination

The compiler can eliminate work inside a loop if the result is never used:

```go
// WRONG: Compiler may eliminate the fibonacci call entirely
func BenchmarkFibWrong(b *testing.B) {
    for i := 0; i < b.N; i++ {
        fibonacci(20) // result discarded — compiler can remove this!
    }
}

// CORRECT: Assign to a package-level variable to prevent DCE
var sink int

func BenchmarkFibCorrect(b *testing.B) {
    var result int
    for i := 0; i < b.N; i++ {
        result = fibonacci(20)
    }
    sink = result // force the compiler to keep the work
}

func fibonacci(n int) int {
    if n <= 1 {
        return n
    }
    return fibonacci(n-1) + fibonacci(n-2)
}
```

### Anti-Pattern 2: Measuring the Wrong Thing

```go
// WRONG: measures JSON library + your logic, but mostly allocates
// for the test data construction
func BenchmarkWrongSetup(b *testing.B) {
    for i := 0; i < b.N; i++ {
        data := []byte(`{"product_id":"prod-123","quantity":5}`) // constant — moved to static by compiler
        var req OrderRequest
        json.Unmarshal(data, &req)
        processOrder(&req) // this is what we want to measure
    }
}

// CORRECT: isolate exactly what you're measuring
func BenchmarkCorrectIsolation(b *testing.B) {
    data := []byte(`{"product_id":"prod-123","quantity":5}`)
    var req OrderRequest
    json.Unmarshal(data, &req) // setup: parse once

    b.ResetTimer()
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        _, _ = processOrder(&req) // measure only this
    }
}
```

### Anti-Pattern 3: Insufficient Iteration Count

```bash
# WRONG: default -benchtime=1s with fast operations gives noisy results
# because the timer resolution is only ~1ms
go test -bench=BenchmarkFibCorrect -count=1

# CORRECT: use -count=10 and let benchstat do the statistics
go test -bench=BenchmarkFibCorrect -count=10 | benchstat /dev/stdin
```

### Anti-Pattern 4: Timer-Infected Benchmarks

```go
// WRONG: time.Now() inside the loop adds measurement overhead
func BenchmarkTimerInfected(b *testing.B) {
    for i := 0; i < b.N; i++ {
        start := time.Now() // adds ~30ns syscall overhead per iteration
        processOrder(&OrderRequest{ProductID: "x", Quantity: 1})
        _ = time.Since(start)
    }
}

// CORRECT: let testing.B handle timing; it is already doing this
func BenchmarkNoTimerOverhead(b *testing.B) {
    req := &OrderRequest{ProductID: "x", Quantity: 1}
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _, _ = processOrder(req)
    }
}
```

### Anti-Pattern 5: Shared State Mutations

```go
// WRONG: b.N iterations mutate a shared slice, causing different
// work per iteration and non-comparable results
func BenchmarkSharedMutation(b *testing.B) {
    data := make([]int, 0)
    for i := 0; i < b.N; i++ {
        data = append(data, i) // each iteration appends — grows without bound
    }
    _ = data
}

// CORRECT: pre-size or reset per iteration
func BenchmarkNoSharedMutation(b *testing.B) {
    for i := 0; i < b.N; i++ {
        data := make([]int, 0, 1000) // fresh slice each time
        for j := 0; j < 1000; j++ {
            data = append(data, j)
        }
        _ = data
    }
}
```

## Section 12: Real-World Benchmark Suite for a REST API

Putting it all together: a comprehensive benchmark suite for a realistic Go REST API service.

```go
// bench/api_suite_test.go
package bench_test

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"
    "sync/atomic"
)

// APIBenchSuite groups all benchmarks for the API layer.
// Run with: go test -bench=BenchmarkAPI -benchmem -count=10 ./bench/

var globalSink atomic.Value // prevents DCE across parallel benchmarks

// BenchmarkAPICreateOrder measures POST /orders with realistic payloads.
func BenchmarkAPICreateOrder(b *testing.B) {
    payloads := []struct {
        name string
        body []byte
    }{
        {
            "small",
            mustMarshal(map[string]interface{}{
                "product_id": "prod-abc",
                "quantity":   1,
                "price":      9.99,
            }),
        },
        {
            "large",
            mustMarshal(map[string]interface{}{
                "product_id":  "prod-xyz",
                "quantity":    100,
                "price":       999.99,
                "notes":       "Rush order for Q4 campaign. Please prioritize.",
                "tags":        []string{"priority", "q4", "campaign", "rush"},
                "metadata":    map[string]string{"source": "web", "campaign_id": "cm-2028-q4"},
            }),
        },
    }

    handler := http.HandlerFunc(OrderHandler)

    for _, p := range payloads {
        p := p
        b.Run(p.name, func(b *testing.B) {
            b.SetBytes(int64(len(p.body)))
            b.ReportAllocs()
            b.ResetTimer()

            for i := 0; i < b.N; i++ {
                req := httptest.NewRequest(
                    http.MethodPost, "/orders",
                    bytes.NewReader(p.body),
                )
                req.Header.Set("Content-Type", "application/json")
                w := httptest.NewRecorder()
                handler.ServeHTTP(w, req)

                if w.Code != http.StatusOK {
                    b.Fatalf("status %d: %s", w.Code, w.Body.String())
                }
                globalSink.Store(w.Body.Bytes())
            }
        })
    }
}

// BenchmarkAPIParallelThroughput measures maximum sustainable RPS.
// This is the most important benchmark for capacity planning.
func BenchmarkAPIParallelThroughput(b *testing.B) {
    handler := http.HandlerFunc(OrderHandler)
    body := mustMarshal(map[string]interface{}{
        "product_id": "prod-abc",
        "quantity":   1,
        "price":      9.99,
    })

    // Test at different concurrency levels
    parallelisms := []int{1, 2, 4, 8, 16, 32}

    for _, p := range parallelisms {
        p := p
        b.Run(fmt.Sprintf("goroutines=%d", p), func(b *testing.B) {
            b.SetParallelism(p)
            b.ReportAllocs()
            b.ResetTimer()

            b.RunParallel(func(pb *testing.PB) {
                for pb.Next() {
                    req := httptest.NewRequest(
                        http.MethodPost, "/orders",
                        bytes.NewReader(body),
                    )
                    req.Header.Set("Content-Type", "application/json")
                    w := httptest.NewRecorder()
                    handler.ServeHTTP(w, req)
                    globalSink.Store(w.Code)
                }
            })
        })
    }
}

// BenchmarkAPIPipeline simulates a realistic request pipeline with
// middleware: authentication → rate limiting → handler → logging.
func BenchmarkAPIPipeline(b *testing.B) {
    // Build the middleware chain
    handler := chain(
        http.HandlerFunc(OrderHandler),
        authMiddleware,
        rateLimitMiddleware,
        loggingMiddleware,
    )

    body := mustMarshal(map[string]interface{}{
        "product_id": "prod-abc",
        "quantity":   1,
        "price":      9.99,
    })

    b.ReportAllocs()
    b.ResetTimer()

    for i := 0; i < b.N; i++ {
        req := httptest.NewRequest(http.MethodPost, "/orders", bytes.NewReader(body))
        req.Header.Set("Content-Type", "application/json")
        req.Header.Set("Authorization", "Bearer test-token")
        w := httptest.NewRecorder()
        handler.ServeHTTP(w, req)
        globalSink.Store(w.Code)
    }
}

// chain builds a middleware chain (first middleware = outermost wrapper).
func chain(h http.Handler, middlewares ...func(http.Handler) http.Handler) http.Handler {
    for i := len(middlewares) - 1; i >= 0; i-- {
        h = middlewares[i](h)
    }
    return h
}

func authMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Simulate token validation (~500ns)
        token := r.Header.Get("Authorization")
        if token == "" {
            http.Error(w, "unauthorized", http.StatusUnauthorized)
            return
        }
        next.ServeHTTP(w, r)
    })
}

func rateLimitMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Simulate rate limit check
        next.ServeHTTP(w, r)
    })
}

func loggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        next.ServeHTTP(w, r)
        // Simulate async log write (no actual I/O in benchmark)
    })
}

func mustMarshal(v interface{}) []byte {
    data, err := json.Marshal(v)
    if err != nil {
        panic(err)
    }
    return data
}
```

## Section 13: Performance Testing Checklist

Use this checklist before shipping any performance-sensitive Go code:

```bash
# 1. Run benchmarks with sufficient count for statistical validity
go test -bench=. -benchmem -count=10 ./... > before.txt

# 2. Verify no dead code elimination (check -gcflags output)
go test -bench=. -benchmem -gcflags="-m" ./... 2>&1 | grep escape

# 3. Profile the slowest benchmark to find hot paths
go test -bench=BenchmarkSlowest -benchtime=30s -cpuprofile=cpu.prof ./...
go tool pprof -http=:8080 cpu.prof

# 4. Check for unexpected allocations
go test -bench=. -benchmem -count=1 ./... | grep "allocs/op" | sort -k4 -n -r | head -20

# 5. Run escape analysis to find unnecessary heap allocations
go build -gcflags="-m -m" ./... 2>&1 | grep "escapes to heap" | grep -v "_test.go"

# 6. Compare before/after with benchstat
benchstat before.txt after.txt

# 7. Run parallel benchmarks to detect contention
go test -bench=Parallel -benchmem -count=10 -cpu=1,2,4,8 ./...

# 8. Check GC pressure with GODEBUG
GODEBUG=gctrace=1 go test -bench=. -benchtime=5s ./... 2>&1 | grep "^gc"

# 9. Analyze trace for scheduler latency
go test -bench=BenchmarkCritical -benchtime=2s ./...
# (with trace instrumentation in the benchmark)
go tool trace trace.out
```

## Section 14: Environment Stability for Reproducible Results

Benchmark results are meaningless without environment control:

```bash
# Pin CPU frequency to prevent thermal throttling affecting results
# (Linux — requires root)
sudo cpupower frequency-set -g performance

# Disable CPU hyperthreading for more consistent results
# (Linux — requires root)
echo off | sudo tee /sys/devices/system/cpu/smt/control

# Run with CPU affinity to prevent migration
taskset -c 0,1,2,3 go test -bench=. -count=10 ./...

# Disable GC to isolate non-GC performance
GOGC=off go test -bench=. -benchtime=10s ./...

# Alternatively, force GC before each benchmark (the default)
# testing.B.ResetTimer() calls runtime.GC() implicitly in some versions

# Set GOMAXPROCS explicitly for reproducibility across machines
GOMAXPROCS=4 go test -bench=. -count=10 ./...

# Run on a quiet machine (minimal background processes)
# CI runners with dedicated nodes are more stable than developer laptops
```

### Makefile Integration

```makefile
# Makefile — benchmark targets

BENCH_COUNT ?= 10
BENCH_TIME  ?= 2s
BENCH_PKG   ?= ./...

.PHONY: bench bench-compare bench-profile bench-regression

# Run benchmarks and save to timestamped file
bench:
	@mkdir -p .benchmarks
	go test \
		-bench=. \
		-benchmem \
		-count=$(BENCH_COUNT) \
		-benchtime=$(BENCH_TIME) \
		-run='^$$' \
		$(BENCH_PKG) | tee .benchmarks/$(shell date +%Y%m%d_%H%M%S).txt

# Compare last two benchmark runs
bench-compare:
	@files=($$(ls -t .benchmarks/*.txt)); \
	if [ $${#files[@]} -lt 2 ]; then \
		echo "Need at least 2 benchmark runs. Run 'make bench' twice."; exit 1; \
	fi; \
	benchstat $${files[1]} $${files[0]}

# Profile the named benchmark
bench-profile: BENCH_NAME ?= BenchmarkOrderHandler
bench-profile:
	go test \
		-bench=$(BENCH_NAME) \
		-benchtime=30s \
		-cpuprofile=cpu.prof \
		-memprofile=mem.prof \
		$(BENCH_PKG)
	@echo "Run: go tool pprof -http=:8080 cpu.prof"

# Check for regressions against a saved baseline
bench-regression: BASELINE ?= .benchmarks/baseline.txt
bench-regression:
	@if [ ! -f "$(BASELINE)" ]; then \
		echo "No baseline found at $(BASELINE). Run: cp .benchmarks/<file>.txt $(BASELINE)"; \
		exit 1; \
	fi
	@$(MAKE) bench
	@latest=$$(ls -t .benchmarks/*.txt | head -1); \
	benchstat -threshold=0.05 $(BASELINE) $$latest

# Set current benchmarks as new baseline
bench-baseline:
	@latest=$$(ls -t .benchmarks/*.txt | head -1); \
	cp $$latest .benchmarks/baseline.txt; \
	echo "Baseline set to $$latest"
```

## Summary

A disciplined Go performance testing workflow delivers reliable, reproducible results that catch regressions early:

1. **Write meaningful benchmarks** — use `b.ReportAllocs()`, `b.SetBytes()`, and table-driven sub-benchmarks to measure exactly what matters. Avoid dead code elimination with package-level sinks.

2. **Profile with pprof** — CPU profiles find hot functions, memory profiles find unexpected allocations, block profiles find synchronization bottlenecks. Always profile with `-benchtime=30s` or longer for stable flame graphs.

3. **Analyze allocations** — use `-gcflags="-m"` to see escape analysis decisions, and eliminate heap allocations in hot paths by keeping values on the stack.

4. **Compare statistically with benchstat** — run with `-count=10` minimum, use `benchstat before.txt after.txt` to determine if differences are significant (`p < 0.05`).

5. **Automate regression detection in CI** — the GitHub Actions workflow shown captures benchmarks on both PR and base branches, compares with `benchstat`, and fails the build on regressions exceeding your threshold.

6. **Control the environment** — pin CPU frequency, set `GOMAXPROCS` explicitly, and run on dedicated CI nodes. A benchmark measured on a laptop under thermal throttling is worthless.

7. **Use `go tool trace`** for scheduler and GC analysis — `pprof` tells you *what* is slow, trace tells you *when* things happen, uncovering GC pause sensitivity and goroutine scheduling latency invisible to sampling profilers.
