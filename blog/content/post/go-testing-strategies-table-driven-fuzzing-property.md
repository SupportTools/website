---
title: "Go Testing Strategies: Table-Driven Tests, Fuzzing, and Property Testing"
date: 2029-06-11T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "Fuzzing", "Property Testing", "TDD", "Quality"]
categories: ["Go", "Testing"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-oriented guide to Go testing strategies: table-driven test patterns, subtest parallelism, native go test -fuzz corpus management, the rapid library for property-based testing, and using benchmarks as regression tests."
more_link: "yes"
url: "/go-testing-strategies-table-driven-fuzzing-property/"
---

Testing in Go has a deliberately minimal standard library. The philosophy is that simple tools, used well, produce better test suites than complex frameworks. But minimal does not mean limited: table-driven tests, subtests, fuzzing, and property testing together cover the full testing spectrum from fast unit tests to deep exploratory testing. This guide shows each technique with practical examples drawn from real-world Go codebases.

<!--more-->

# Go Testing Strategies: Table-Driven Tests, Fuzzing, and Property Testing

## Table-Driven Tests: The Go Idiom

Table-driven tests are the dominant pattern in Go's standard library and most production codebases. They keep test data separate from test logic, make it easy to add new cases, and produce readable failure messages.

### Basic Table-Driven Pattern

```go
package parser_test

import (
    "testing"
    "time"

    "github.com/example/myapp/parser"
)

func TestParseDuration(t *testing.T) {
    tests := []struct {
        name    string
        input   string
        want    time.Duration
        wantErr bool
    }{
        {
            name:  "seconds",
            input: "30s",
            want:  30 * time.Second,
        },
        {
            name:  "minutes",
            input: "5m",
            want:  5 * time.Minute,
        },
        {
            name:  "hours and minutes",
            input: "1h30m",
            want:  90 * time.Minute,
        },
        {
            name:    "empty string",
            input:   "",
            wantErr: true,
        },
        {
            name:    "negative duration",
            input:   "-1s",
            wantErr: true,
        },
        {
            name:    "overflow",
            input:   "9999999999h",
            wantErr: true,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got, err := parser.ParseDuration(tt.input)
            if (err != nil) != tt.wantErr {
                t.Errorf("ParseDuration(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
                return
            }
            if !tt.wantErr && got != tt.want {
                t.Errorf("ParseDuration(%q) = %v, want %v", tt.input, got, tt.want)
            }
        })
    }
}
```

### Advanced Table Structure

For functions with many parameters or complex expectations, use a more structured approach:

```go
func TestHTTPHandler(t *testing.T) {
    type request struct {
        method  string
        path    string
        body    string
        headers map[string]string
    }
    type response struct {
        code    int
        body    string
        headers map[string]string
    }

    tests := []struct {
        name    string
        setup   func(t *testing.T) *Handler  // per-test setup function
        req     request
        want    response
    }{
        {
            name: "GET existing resource returns 200",
            setup: func(t *testing.T) *Handler {
                h := NewHandler(NewTestDB(t))
                h.db.Put("item-1", "value-1")
                return h
            },
            req:  request{method: "GET", path: "/items/item-1"},
            want: response{code: 200, body: `{"key":"item-1","value":"value-1"}`},
        },
        {
            name: "GET missing resource returns 404",
            setup: func(t *testing.T) *Handler {
                return NewHandler(NewTestDB(t))
            },
            req:  request{method: "GET", path: "/items/missing"},
            want: response{code: 404},
        },
        {
            name: "POST creates resource",
            setup: func(t *testing.T) *Handler {
                return NewHandler(NewTestDB(t))
            },
            req: request{
                method: "POST",
                path:   "/items",
                body:   `{"key":"new-item","value":"new-value"}`,
                headers: map[string]string{
                    "Content-Type": "application/json",
                },
            },
            want: response{code: 201},
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            handler := tt.setup(t)

            req := httptest.NewRequest(tt.req.method, tt.req.path, strings.NewReader(tt.req.body))
            for k, v := range tt.req.headers {
                req.Header.Set(k, v)
            }
            w := httptest.NewRecorder()

            handler.ServeHTTP(w, req)

            if w.Code != tt.want.code {
                t.Errorf("status = %d, want %d\nbody: %s", w.Code, tt.want.code, w.Body)
            }
            if tt.want.body != "" {
                // Use json.RawMessage comparison to ignore whitespace differences
                assertJSONEqual(t, tt.want.body, w.Body.String())
            }
        })
    }
}
```

### Shared Test Helpers

```go
// testhelpers_test.go — test utilities shared across test files in the package

func assertJSONEqual(t *testing.T, expected, actual string) {
    t.Helper()
    var e, a interface{}
    if err := json.Unmarshal([]byte(expected), &e); err != nil {
        t.Fatalf("expected JSON invalid: %v", err)
    }
    if err := json.Unmarshal([]byte(actual), &a); err != nil {
        t.Fatalf("actual JSON invalid: %v", err)
    }
    if !reflect.DeepEqual(e, a) {
        t.Errorf("JSON mismatch\nexpected: %s\n  actual: %s", expected, actual)
    }
}

// NewTestDB creates a temporary, automatically-cleaned-up database for testing
func NewTestDB(t *testing.T) *DB {
    t.Helper()
    dir := t.TempDir()
    db, err := OpenDB(filepath.Join(dir, "test.db"))
    if err != nil {
        t.Fatalf("OpenDB: %v", err)
    }
    t.Cleanup(func() { db.Close() })
    return db
}
```

## Subtests and Parallelism

### t.Run for Test Isolation

```go
func TestCacheOperations(t *testing.T) {
    // Setup shared across subtests (serial)
    cache := NewCache(100)

    t.Run("Set", func(t *testing.T) {
        if err := cache.Set("key1", "val1", time.Minute); err != nil {
            t.Fatalf("Set: %v", err)
        }
    })

    t.Run("Get existing", func(t *testing.T) {
        val, ok := cache.Get("key1")
        if !ok {
            t.Fatal("expected key1 to exist")
        }
        if val != "val1" {
            t.Errorf("Get = %q, want %q", val, "val1")
        }
    })

    t.Run("Get missing", func(t *testing.T) {
        _, ok := cache.Get("nonexistent")
        if ok {
            t.Error("expected missing key to return false")
        }
    })
}
```

### Parallel Subtests

```go
func TestParallelOperations(t *testing.T) {
    tests := []struct {
        name  string
        input int
        want  int
    }{
        {"zero", 0, 1},
        {"one", 1, 1},
        {"five", 5, 120},
        {"ten", 10, 3628800},
    }

    for _, tt := range tests {
        tt := tt // capture loop variable — CRITICAL for parallel subtests
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel() // Mark this subtest as safe to run in parallel

            got := factorial(tt.input)
            if got != tt.want {
                t.Errorf("factorial(%d) = %d, want %d", tt.input, got, tt.want)
            }
        })
    }
    // t.Run blocks until all parallel subtests complete before returning
}
```

Note: As of Go 1.22+, the loop variable capture (`tt := tt`) is no longer necessary because the language semantics were changed, but it is still commonly seen in existing codebases.

### TestMain for Global Setup

```go
// main_test.go
func TestMain(m *testing.M) {
    // Global setup (runs once before all tests)
    db := setupTestDatabase()
    testDB = db

    // Run all tests
    code := m.Run()

    // Global teardown
    db.Close()
    os.Exit(code)
}

var testDB *Database
```

## Go Native Fuzzing

Go 1.18 introduced native fuzzing with `go test -fuzz`. Fuzzing automatically generates test inputs to find crashes, panics, and logic errors that deterministic tests miss.

### Writing a Fuzz Test

```go
// The fuzz target function must be named FuzzXxx
// The first argument is always *testing.F
func FuzzParseDuration(f *testing.F) {
    // Seed corpus: initial inputs to start fuzzing from
    // These also run as regular tests under `go test` without -fuzz
    f.Add("1s")
    f.Add("1m30s")
    f.Add("2h45m")
    f.Add("")
    f.Add("-1s")
    f.Add("9999999h")

    f.Fuzz(func(t *testing.T, s string) {
        // The fuzzer will mutate `s` to find failures
        // The function must not panic on any input

        d, err := parser.ParseDuration(s)
        if err != nil {
            return // Errors are expected for invalid input
        }

        // Property: round-trip should be stable
        // If we format the duration and parse it again, we should get the same result
        formatted := d.String()
        d2, err := parser.ParseDuration(formatted)
        if err != nil {
            t.Errorf("round-trip parse failed: ParseDuration(%q).String() = %q, "+
                "then ParseDuration(%q) error: %v", s, formatted, formatted, err)
        }
        if d != d2 {
            t.Errorf("round-trip mismatch: ParseDuration(%q) = %v, "+
                "ParseDuration(%q) = %v", s, d, formatted, d2)
        }
    })
}
```

### Running the Fuzzer

```bash
# Run seed corpus only (fast, equivalent to regular tests)
go test ./... -run FuzzParseDuration

# Run fuzzer with a time limit
go test -fuzz=FuzzParseDuration -fuzztime=60s ./parser/

# Run fuzzer until a failure is found (or manually stopped)
go test -fuzz=FuzzParseDuration ./parser/

# Limit parallelism
go test -fuzz=FuzzParseDuration -parallel=4 ./parser/

# Run the fuzzer on all fuzz targets in a package
go test -fuzz=Fuzz ./parser/
```

### Corpus Management

```bash
# The fuzzer stores generated inputs that cause new coverage in:
# testdata/fuzz/FuzzParseDuration/
ls testdata/fuzz/FuzzParseDuration/

# Each file is a named corpus entry that can be inspected:
cat testdata/fuzz/FuzzParseDuration/abc123
# go test fuzz v1
# string("1h2147483647ns")

# When a crash is found, the failing input is saved to:
# testdata/fuzz/FuzzParseDuration/fuzz-123456789-deadbeef
# Running `go test` again will replay it to confirm the fix

# Add a specific interesting input to the corpus manually
mkdir -p testdata/fuzz/FuzzParseDuration
printf 'go test fuzz v1\nstring("edge-case-input")\n' > \
    testdata/fuzz/FuzzParseDuration/manual-edge-case

# Minimize a failing corpus entry (reduce it to the smallest input that still fails)
go test -run=FuzzParseDuration/fuzz-123456789-deadbeef -fuzz=FuzzParseDuration \
    -fuzzminimizetime=30s ./parser/
```

### Multi-Type Fuzz Targets

```go
// Fuzzing functions can accept multiple primitive types
func FuzzProcessRecord(f *testing.F) {
    f.Add([]byte("hello"), int64(42), true)
    f.Add([]byte{}, int64(-1), false)
    f.Add([]byte{0xFF, 0xFE}, int64(0), true)

    f.Fuzz(func(t *testing.T, data []byte, timestamp int64, active bool) {
        record := &Record{
            Data:      data,
            Timestamp: timestamp,
            Active:    active,
        }

        // Should never panic
        encoded, err := record.Encode()
        if err != nil {
            return
        }

        // Round-trip property
        decoded, err := DecodeRecord(encoded)
        if err != nil {
            t.Errorf("Decode(Encode(record)) error: %v", err)
            return
        }

        if !decoded.Equal(record) {
            t.Errorf("round-trip mismatch:\n  in:  %+v\n  out: %+v", record, decoded)
        }
    })
}
```

## Property-Based Testing with rapid

The `pgregory.net/rapid` library brings Haskell's QuickCheck-style property testing to Go. Property tests express invariants that must hold for all inputs, letting the library find counterexamples.

```bash
go get pgregory.net/rapid
```

### Basic Property Test

```go
import "pgregory.net/rapid"

func TestSortProperties(t *testing.T) {
    // rapid.Check runs the test function many times with generated inputs
    rapid.Check(t, func(t *rapid.T) {
        // Draw generates a random value of the specified type
        input := rapid.SliceOf(rapid.Int()).Draw(t, "input")

        result := sort.Ints(append([]int(nil), input...))
        // Note: rapid.SliceOf(rapid.Int()) returns []int, and sort.Ints sorts in-place

        sorted := make([]int, len(input))
        copy(sorted, input)
        slices.Sort(sorted)

        // Property 1: result is sorted
        for i := 1; i < len(sorted); i++ {
            if sorted[i-1] > sorted[i] {
                t.Fatalf("not sorted at index %d: %v[%d]=%d > %v[%d]=%d",
                    i, sorted, i-1, sorted[i-1], sorted, i, sorted[i])
            }
        }

        // Property 2: same elements (permutation)
        inputCopy := make([]int, len(input))
        copy(inputCopy, input)
        slices.Sort(inputCopy)
        if !slices.Equal(sorted, inputCopy) {
            t.Fatalf("elements changed: input sorted = %v, output = %v", inputCopy, sorted)
        }

        // Property 3: idempotent (sorting already-sorted is a no-op)
        sortedAgain := make([]int, len(sorted))
        copy(sortedAgain, sorted)
        slices.Sort(sortedAgain)
        if !slices.Equal(sorted, sortedAgain) {
            t.Fatalf("sort not idempotent: %v != %v", sorted, sortedAgain)
        }
    })
}
```

### Custom Generators

```go
// Define custom generators for your domain types
func genUser(t *rapid.T) User {
    return User{
        ID:    rapid.StringMatching(`[a-z]{3,20}`).Draw(t, "id"),
        Email: rapid.StringMatching(`[a-z]+@[a-z]+\.[a-z]{2,3}`).Draw(t, "email"),
        Age:   rapid.IntRange(0, 150).Draw(t, "age"),
        Role:  rapid.SampledFrom([]string{"admin", "user", "guest"}).Draw(t, "role"),
    }
}

func TestUserPersistence(t *testing.T) {
    db := NewTestDB(t)

    rapid.Check(t, func(t *rapid.T) {
        user := genUser(t)

        // Property: save and load round-trips correctly
        if err := db.SaveUser(user); err != nil {
            // If the invariant is "unique email" then duplicate emails are expected errors
            if errors.Is(err, ErrDuplicateEmail) {
                t.Skip("duplicate email — not an error for this property")
            }
            t.Fatalf("SaveUser: %v", err)
        }

        loaded, err := db.GetUser(user.ID)
        if err != nil {
            t.Fatalf("GetUser after save: %v", err)
        }

        if !loaded.Equal(user) {
            t.Fatalf("round-trip mismatch:\n  saved:  %+v\n  loaded: %+v", user, loaded)
        }
    })
}
```

### Stateful Property Tests with State Machine Testing

```go
// Model-based testing: run the same operations on a real implementation
// and a simple reference implementation, then compare results
type CacheModel struct {
    data map[string]string
}

func (m *CacheModel) Set(key, val string) { m.data[key] = val }
func (m *CacheModel) Get(key string) (string, bool) {
    v, ok := m.data[key]
    return v, ok
}
func (m *CacheModel) Delete(key string) { delete(m.data, key) }

func TestCacheStateMachine(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        cache := NewCache(1000)
        model := &CacheModel{data: make(map[string]string)}

        // Generate a sequence of operations
        n := rapid.IntRange(1, 100).Draw(t, "n_ops")
        for i := 0; i < n; i++ {
            key := rapid.StringMatching(`[a-z]{1,5}`).Draw(t, "key")
            op := rapid.IntRange(0, 2).Draw(t, "op")

            switch op {
            case 0: // Set
                val := rapid.String().Draw(t, "val")
                cache.Set(key, val, time.Minute)
                model.Set(key, val)

            case 1: // Get
                realVal, realOk := cache.Get(key)
                modelVal, modelOk := model.Get(key)
                if realOk != modelOk || realVal != modelVal {
                    t.Fatalf("Get(%q) mismatch: cache=(%q,%v) model=(%q,%v)",
                        key, realVal, realOk, modelVal, modelOk)
                }

            case 2: // Delete
                cache.Delete(key)
                model.Delete(key)
            }
        }
    })
}
```

## Benchmark-as-Test: Performance Regression Detection

### Benchmarks That Assert Results

```go
func BenchmarkBase64Encode(b *testing.B) {
    input := make([]byte, 1024)
    rand.Read(input)

    b.ReportAllocs()
    b.ResetTimer()

    for i := 0; i < b.N; i++ {
        encoded := base64.StdEncoding.EncodeToString(input)
        _ = encoded
    }
}

// Benchmark with sub-benchmarks for different sizes
func BenchmarkCompress(b *testing.B) {
    sizes := []int{1024, 64 * 1024, 1024 * 1024}

    for _, size := range sizes {
        size := size
        b.Run(fmt.Sprintf("size=%d", size), func(b *testing.B) {
            input := make([]byte, size)
            rand.Read(input)
            b.SetBytes(int64(size))
            b.ReportAllocs()
            b.ResetTimer()

            for i := 0; i < b.N; i++ {
                compressed, _ := compress(input)
                _ = compressed
            }
        })
    }
}
```

### benchstat for Regression Detection in CI

```bash
# Save baseline benchmark results
go test -bench=. -benchmem -count=10 ./... > old.txt

# Make changes, then run again
go test -bench=. -benchmem -count=10 ./... > new.txt

# Compare with benchstat
go install golang.org/x/perf/cmd/benchstat@latest
benchstat old.txt new.txt

# Example output:
# name             old time/op    new time/op    delta
# Base64Encode-8   1.23µs ± 2%   0.98µs ± 3%   -20.33%  (p=0.000 n=10+10)
# Compress/1KB-8   45.2µs ± 1%  45.8µs ± 2%     +1.33%  (p=0.041 n=10+10)
```

### CI Integration for Benchmark Regressions

```yaml
# .github/workflows/benchmark.yml
name: Benchmark

on: [pull_request]

jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0

    - uses: actions/setup-go@v5
      with:
        go-version: '1.23'

    - name: Run benchmarks on base branch
      run: |
        git checkout ${{ github.base_ref }}
        go test -bench=. -benchmem -count=10 ./... > /tmp/old.txt

    - name: Run benchmarks on PR branch
      run: |
        git checkout ${{ github.head_ref }}
        go test -bench=. -benchmem -count=10 ./... > /tmp/new.txt

    - name: Compare benchmarks
      run: |
        go install golang.org/x/perf/cmd/benchstat@latest
        benchstat -delta-test=utest -alpha=0.05 /tmp/old.txt /tmp/new.txt | tee /tmp/delta.txt
        # Fail if any benchmark regressed by more than 10%
        if grep -E '\+[0-9]{2,}\.' /tmp/delta.txt; then
          echo "Performance regression detected!"
          exit 1
        fi
```

## Test Coverage and Quality Gates

```bash
# Run tests with coverage
go test -coverprofile=coverage.out ./...

# View coverage in terminal
go tool cover -func=coverage.out | sort -k3 -rn | head -20

# Generate HTML coverage report
go tool cover -html=coverage.out -o coverage.html

# Coverage with race detector (find data races)
go test -race ./...

# Enforce minimum coverage threshold in CI
COVERAGE=$(go tool cover -func=coverage.out | grep total | awk '{print $3}' | tr -d '%')
MIN=80
if (( $(echo "$COVERAGE < $MIN" | bc -l) )); then
    echo "Coverage ${COVERAGE}% is below minimum ${MIN}%"
    exit 1
fi
```

### Test Flags Reference

```bash
# Run a specific test
go test -run TestParseDuration ./parser/

# Run tests matching a pattern (regex)
go test -run 'TestParse|TestFormat' ./...

# Run tests with verbose output
go test -v ./...

# Short mode: skip long-running tests (respect t.Skip)
go test -short ./...

# Run with timeout
go test -timeout=30s ./...

# Count: run each test multiple times (useful for flaky test detection)
go test -count=3 ./...

# Disable test caching
go test -count=1 ./...

# Run a fuzz target for a fixed time
go test -fuzz=FuzzFoo -fuzztime=30s ./pkg/

# Build and test for a specific OS/arch
GOOS=linux GOARCH=arm64 go test ./...
```

## Putting It All Together: A Testing Strategy

For a production Go service, layer the testing techniques:

```
1. Unit tests (table-driven)
   → Fast, deterministic, run on every commit
   → Cover happy path, error cases, and edge cases

2. Integration tests (t.Run with real DB/redis/etc.)
   → Use testcontainers-go for real dependencies
   → Run on every commit in CI with -short=false

3. Fuzz tests
   → Run continuously in a dedicated CI job
   → Corpus lives in testdata/, committed to git
   → New failures block the build

4. Property tests (rapid)
   → Focus on correctness invariants that are hard to enumerate
   → Run as part of the regular test suite (not continuous fuzzing)

5. Benchmark regression tests
   → Run on PRs that touch performance-critical code
   → Use benchstat to detect regressions > 10%
```

```bash
# Makefile targets for a complete test workflow
.PHONY: test test-unit test-integration test-fuzz test-bench

test-unit:
    go test -short -race -count=1 ./...

test-integration:
    go test -race -count=1 -timeout=300s ./...

test-fuzz:
    go test -fuzz=Fuzz -fuzztime=60s ./...

test-bench:
    go test -bench=. -benchmem -count=10 ./... > bench.txt

test: test-unit test-integration
```

Table-driven tests give you confidence through comprehensive case coverage. Fuzzing finds the bugs you did not think to write cases for. Property tests verify invariants hold across all inputs. Together, they produce test suites that catch both known and unknown failure modes — which is the goal of testing in the first place.
