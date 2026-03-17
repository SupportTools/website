---
title: "Table-Driven Testing in Go: Patterns for Complex Systems"
date: 2028-03-06T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "Table-Driven Tests", "Fuzzing", "Benchmarks", "TDD"]
categories: ["Go", "Testing"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to table-driven testing in Go, covering parallel subtests, golden files, fuzzing, benchmarks, httptest patterns, clock injection, and coverage profiling for enterprise systems."
more_link: "yes"
url: "/go-testing-table-driven-patterns-guide/"
---

Table-driven testing is the idiomatic Go approach to testing multiple input/output combinations without duplicating test logic. When applied systematically across a large service codebase, it compresses hundreds of test scenarios into readable, maintainable structures while enabling parallel execution, property-based testing via fuzzing, and performance regression tracking through benchmarks. This guide covers the full spectrum of table-driven patterns applicable to production Go services.

<!--more-->

## Table-Driven Test Anatomy

### Basic Structure

A minimal table-driven test uses a slice of anonymous structs, each representing one test case:

```go
package parser_test

import (
    "testing"

    "github.com/example/service/parser"
)

func TestParseAmount(t *testing.T) {
    t.Helper()

    tests := []struct {
        name    string
        input   string
        want    int64
        wantErr bool
    }{
        {
            name:  "integer cents",
            input: "1099",
            want:  1099,
        },
        {
            name:  "decimal dollars",
            input: "10.99",
            want:  1099,
        },
        {
            name:  "zero value",
            input: "0",
            want:  0,
        },
        {
            name:    "empty string",
            input:   "",
            wantErr: true,
        },
        {
            name:    "negative amount",
            input:   "-5.00",
            wantErr: true,
        },
        {
            name:    "overflow value",
            input:   "99999999999999.99",
            wantErr: true,
        },
    }

    for _, tc := range tests {
        tc := tc // capture range variable
        t.Run(tc.name, func(t *testing.T) {
            got, err := parser.ParseAmount(tc.input)
            if (err != nil) != tc.wantErr {
                t.Errorf("ParseAmount(%q) error = %v, wantErr %v", tc.input, err, tc.wantErr)
                return
            }
            if !tc.wantErr && got != tc.want {
                t.Errorf("ParseAmount(%q) = %d, want %d", tc.input, got, tc.want)
            }
        })
    }
}
```

### Naming Conventions

Subtest names become part of the `-run` filter. Use consistent, grep-friendly names:

```go
// Prefer: descriptive snake_case or slash-separated context
{name: "valid/integer"},
{name: "valid/decimal"},
{name: "invalid/empty"},
{name: "invalid/overflow"},

// Run only invalid cases
// go test -run TestParseAmount/invalid
```

## Parallel Subtests with t.Parallel()

Parallelizing subtests reduces wall-clock time for I/O-bound or CPU-intensive test suites. The `tc := tc` capture is mandatory before Go 1.22; from Go 1.22 onward the loop variable is scoped per iteration.

```go
func TestProcessPayments(t *testing.T) {
    tests := []struct {
        name    string
        payment Payment
        want    Result
        wantErr bool
    }{
        // ... test cases
    }

    for _, tc := range tests {
        tc := tc
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel() // Mark this subtest as safe to run concurrently

            svc := NewPaymentService(testDB(t))
            got, err := svc.Process(context.Background(), tc.payment)
            if (err != nil) != tc.wantErr {
                t.Fatalf("Process() error = %v, wantErr %v", err, tc.wantErr)
            }
            if diff := cmp.Diff(tc.want, got); diff != "" {
                t.Errorf("Process() mismatch (-want +got):\n%s", diff)
            }
        })
    }
}
```

### Parallel Test Groups

When initialization is expensive, use a parallel group pattern to run subtests in parallel while sharing setup:

```go
func TestIntegration(t *testing.T) {
    // Shared, expensive setup
    db := setupTestDatabase(t)
    svc := NewService(db)

    t.Run("group", func(t *testing.T) {
        tests := buildTestCases(svc)
        for _, tc := range tests {
            tc := tc
            t.Run(tc.name, func(t *testing.T) {
                t.Parallel()
                // subtests run in parallel within this group,
                // but the outer "group" test waits for all of them
                runTestCase(t, tc)
            })
        }
    })
    // Cleanup runs after the group (and all its parallel subtests) complete
}
```

## Test Fixtures and Golden Files

### Golden File Pattern

Golden files store expected output on disk. They eliminate large string literals in test code and make it easy to update expected output when behavior changes intentionally.

```go
package render_test

import (
    "flag"
    "os"
    "path/filepath"
    "testing"

    "github.com/google/go-cmp/cmp"
)

var update = flag.Bool("update", false, "update golden files")

func TestRenderTemplate(t *testing.T) {
    tests := []struct {
        name    string
        data    TemplateData
        golden  string
    }{
        {
            name:   "empty_cart",
            data:   TemplateData{Items: nil, Total: 0},
            golden: "testdata/empty_cart.html",
        },
        {
            name: "single_item",
            data: TemplateData{
                Items: []Item{{Name: "Widget", Price: 999, Qty: 1}},
                Total: 999,
            },
            golden: "testdata/single_item.html",
        },
    }

    for _, tc := range tests {
        tc := tc
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()

            got, err := RenderTemplate(tc.data)
            if err != nil {
                t.Fatalf("RenderTemplate() error: %v", err)
            }

            if *update {
                // go test -update rewrites golden files
                if err := os.MkdirAll(filepath.Dir(tc.golden), 0755); err != nil {
                    t.Fatal(err)
                }
                if err := os.WriteFile(tc.golden, []byte(got), 0644); err != nil {
                    t.Fatal(err)
                }
                return
            }

            want, err := os.ReadFile(tc.golden)
            if err != nil {
                t.Fatalf("read golden file: %v", err)
            }

            if diff := cmp.Diff(string(want), got); diff != "" {
                t.Errorf("RenderTemplate() mismatch (-want +got):\n%s", diff)
            }
        })
    }
}
```

Update golden files when intentional changes are made:

```bash
go test ./render/... -update
git diff testdata/  # review changes before committing
```

### Fixture Helpers

Centralize fixture loading to avoid repetition:

```go
// testhelpers/fixtures.go
package testhelpers

import (
    "encoding/json"
    "os"
    "path/filepath"
    "testing"
)

func LoadFixture[T any](t *testing.T, name string) T {
    t.Helper()
    path := filepath.Join("testdata", name)
    data, err := os.ReadFile(path)
    if err != nil {
        t.Fatalf("load fixture %s: %v", name, err)
    }
    var v T
    if err := json.Unmarshal(data, &v); err != nil {
        t.Fatalf("unmarshal fixture %s: %v", name, err)
    }
    return v
}
```

## Fuzzing with go test -fuzz

Fuzzing generates random inputs to discover edge cases that hand-crafted test tables miss. Fuzz targets run as standard unit tests when a corpus entry exists, and as continuous mutation engines with `-fuzz`.

```go
package parser_test

import (
    "testing"
    "unicode/utf8"

    "github.com/example/service/parser"
)

func FuzzParseAmount(f *testing.F) {
    // Seed corpus — these run as normal unit test cases too
    f.Add("0")
    f.Add("10.99")
    f.Add("1099")
    f.Add("-1")
    f.Add("")
    f.Add("abc")
    f.Add("9999999999999999999")
    f.Add("0.001")

    f.Fuzz(func(t *testing.T, input string) {
        // The function must not panic on any input
        // Panics are automatically caught and reported as failures
        result, err := parser.ParseAmount(input)

        // Property: if err is nil, result must be non-negative
        if err == nil && result < 0 {
            t.Errorf("ParseAmount(%q) returned negative value %d without error", input, result)
        }

        // Property: valid UTF-8 inputs must not cause encoding errors
        if utf8.ValidString(input) && err != nil {
            // Acceptable — just verify error is descriptive
            if err.Error() == "" {
                t.Errorf("ParseAmount(%q) returned empty error message", input)
            }
        }
    })
}
```

Run fuzzing for a time-bounded session during CI:

```bash
# Run fuzz target for 60 seconds
go test -fuzz=FuzzParseAmount -fuzztime=60s ./parser/...

# Run only the seed corpus (fast, deterministic, CI-safe)
go test -run=FuzzParseAmount ./parser/...
```

Discovered failures are stored in `testdata/fuzz/FuzzParseAmount/` and become permanent regression tests.

### Fuzz-Based Round-Trip Testing

```go
func FuzzMarshalUnmarshalOrder(f *testing.F) {
    f.Add([]byte(`{"id":"123","amount":999}`))

    f.Fuzz(func(t *testing.T, data []byte) {
        var order Order
        if err := json.Unmarshal(data, &order); err != nil {
            return // Skip invalid JSON — not what we're testing
        }

        // Round-trip: marshal back and unmarshal again
        data2, err := json.Marshal(order)
        if err != nil {
            t.Fatalf("marshal failed after successful unmarshal: %v", err)
        }

        var order2 Order
        if err := json.Unmarshal(data2, &order2); err != nil {
            t.Fatalf("second unmarshal failed: %v", err)
        }

        if diff := cmp.Diff(order, order2); diff != "" {
            t.Errorf("round-trip mismatch (-want +got):\n%s", diff)
        }
    })
}
```

## Benchmark Tables

Benchmark tables measure performance across input sizes or configurations, enabling regression detection in CI.

```go
func BenchmarkProcessBatch(b *testing.B) {
    benchmarks := []struct {
        name      string
        batchSize int
    }{
        {"batch_10", 10},
        {"batch_100", 100},
        {"batch_1000", 1000},
        {"batch_10000", 10000},
    }

    for _, bm := range benchmarks {
        bm := bm
        b.Run(bm.name, func(b *testing.B) {
            batch := generateBatch(bm.batchSize)
            svc := newBenchService(b)

            b.ResetTimer()
            b.ReportAllocs()
            b.SetBytes(int64(bm.batchSize))

            for i := 0; i < b.N; i++ {
                _, err := svc.ProcessBatch(context.Background(), batch)
                if err != nil {
                    b.Fatal(err)
                }
            }
        })
    }
}
```

Run benchmarks and compare with `benchstat`:

```bash
# Baseline
go test -bench=BenchmarkProcessBatch -benchmem -count=5 ./... > old.txt

# After optimization
go test -bench=BenchmarkProcessBatch -benchmem -count=5 ./... > new.txt

# Statistical comparison
benchstat old.txt new.txt
```

### Memory Allocation Benchmarks

```go
func BenchmarkParseAllocations(b *testing.B) {
    inputs := []struct {
        name  string
        input string
    }{
        {"small", "10.99"},
        {"medium", "1234567.89"},
        {"large", "9999999999.99"},
    }

    for _, bm := range inputs {
        bm := bm
        b.Run(bm.name, func(b *testing.B) {
            b.ReportAllocs()
            for i := 0; i < b.N; i++ {
                _, _ = parser.ParseAmount(bm.input)
            }
        })
    }
}
```

## httptest.Server Patterns

Testing HTTP handlers and clients with `httptest` avoids real network calls while exercising the full request/response cycle.

### Handler Testing with Table Cases

```go
package api_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "strings"
    "testing"

    "github.com/example/service/api"
)

func TestOrdersHandler(t *testing.T) {
    tests := []struct {
        name           string
        method         string
        path           string
        body           string
        setupMock      func(*MockOrderService)
        wantStatusCode int
        wantBody       string
    }{
        {
            name:   "GET existing order",
            method: "GET",
            path:   "/orders/123",
            setupMock: func(m *MockOrderService) {
                m.GetOrderFn = func(_ context.Context, id string) (*Order, error) {
                    return &Order{ID: "123", Amount: 1099}, nil
                }
            },
            wantStatusCode: http.StatusOK,
            wantBody:       `{"id":"123","amount":1099}`,
        },
        {
            name:   "GET nonexistent order",
            method: "GET",
            path:   "/orders/999",
            setupMock: func(m *MockOrderService) {
                m.GetOrderFn = func(_ context.Context, id string) (*Order, error) {
                    return nil, ErrNotFound
                }
            },
            wantStatusCode: http.StatusNotFound,
        },
        {
            name:   "POST valid order",
            method: "POST",
            path:   "/orders",
            body:   `{"amount":1099,"currency":"USD"}`,
            setupMock: func(m *MockOrderService) {
                m.CreateOrderFn = func(_ context.Context, req CreateOrderRequest) (*Order, error) {
                    return &Order{ID: "new-456", Amount: req.Amount}, nil
                }
            },
            wantStatusCode: http.StatusCreated,
        },
        {
            name:           "POST invalid JSON",
            method:         "POST",
            path:           "/orders",
            body:           `{invalid json`,
            setupMock:      func(m *MockOrderService) {},
            wantStatusCode: http.StatusBadRequest,
        },
    }

    for _, tc := range tests {
        tc := tc
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()

            mock := &MockOrderService{}
            tc.setupMock(mock)

            router := api.NewRouter(mock)
            rec := httptest.NewRecorder()
            req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
            req.Header.Set("Content-Type", "application/json")

            router.ServeHTTP(rec, req)

            if rec.Code != tc.wantStatusCode {
                t.Errorf("status = %d, want %d\nbody: %s", rec.Code, tc.wantStatusCode, rec.Body)
            }

            if tc.wantBody != "" {
                var gotJSON, wantJSON interface{}
                if err := json.Unmarshal(rec.Body.Bytes(), &gotJSON); err != nil {
                    t.Fatalf("unmarshal response: %v", err)
                }
                if err := json.Unmarshal([]byte(tc.wantBody), &wantJSON); err != nil {
                    t.Fatalf("unmarshal expected: %v", err)
                }
                if diff := cmp.Diff(wantJSON, gotJSON); diff != "" {
                    t.Errorf("body mismatch (-want +got):\n%s", diff)
                }
            }
        })
    }
}
```

### HTTP Client Testing with Fake Servers

```go
func TestExternalAPIClient(t *testing.T) {
    tests := []struct {
        name        string
        serverResp  string
        serverCode  int
        want        *ExternalData
        wantErr     bool
    }{
        {
            name:       "successful response",
            serverResp: `{"value":42,"unit":"USD"}`,
            serverCode: http.StatusOK,
            want:       &ExternalData{Value: 42, Unit: "USD"},
        },
        {
            name:       "server error",
            serverResp: `{"error":"internal"}`,
            serverCode: http.StatusInternalServerError,
            wantErr:    true,
        },
        {
            name:       "rate limited",
            serverResp: `{"error":"rate limit exceeded"}`,
            serverCode: http.StatusTooManyRequests,
            wantErr:    true,
        },
    }

    for _, tc := range tests {
        tc := tc
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()

            srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.WriteHeader(tc.serverCode)
                w.Write([]byte(tc.serverResp))
            }))
            defer srv.Close()

            client := NewExternalAPIClient(srv.URL)
            got, err := client.FetchData(context.Background(), "test-key")

            if (err != nil) != tc.wantErr {
                t.Fatalf("FetchData() error = %v, wantErr %v", err, tc.wantErr)
            }
            if !tc.wantErr {
                if diff := cmp.Diff(tc.want, got); diff != "" {
                    t.Errorf("FetchData() mismatch (-want +got):\n%s", diff)
                }
            }
        })
    }
}
```

## Testing Time-Dependent Code with Clock Injection

Direct calls to `time.Now()` make tests flaky and non-deterministic. Inject a clock interface to control time in tests.

### Clock Interface

```go
// clock/clock.go
package clock

import "time"

// Clock is an interface for time-dependent operations.
type Clock interface {
    Now() time.Time
    Since(t time.Time) time.Duration
    After(d time.Duration) <-chan time.Time
}

// Real returns the system clock.
func Real() Clock { return realClock{} }

type realClock struct{}

func (realClock) Now() time.Time                         { return time.Now() }
func (realClock) Since(t time.Time) time.Duration        { return time.Since(t) }
func (realClock) After(d time.Duration) <-chan time.Time  { return time.After(d) }

// Fake is a controllable clock for testing.
type Fake struct {
    current time.Time
}

func NewFake(t time.Time) *Fake { return &Fake{current: t} }

func (f *Fake) Now() time.Time                        { return f.current }
func (f *Fake) Since(t time.Time) time.Duration       { return f.current.Sub(t) }
func (f *Fake) After(d time.Duration) <-chan time.Time {
    ch := make(chan time.Time, 1)
    ch <- f.current.Add(d)
    return ch
}
func (f *Fake) Advance(d time.Duration)               { f.current = f.current.Add(d) }
func (f *Fake) Set(t time.Time)                       { f.current = t }
```

### Using Clock Injection in Tests

```go
func TestSessionExpiry(t *testing.T) {
    baseTime := time.Date(2026, 3, 15, 10, 0, 0, 0, time.UTC)

    tests := []struct {
        name        string
        createdAt   time.Time
        checkAt     time.Time
        ttl         time.Duration
        wantExpired bool
    }{
        {
            name:        "fresh session",
            createdAt:   baseTime,
            checkAt:     baseTime.Add(5 * time.Minute),
            ttl:         30 * time.Minute,
            wantExpired: false,
        },
        {
            name:        "session at exact TTL boundary",
            createdAt:   baseTime,
            checkAt:     baseTime.Add(30 * time.Minute),
            ttl:         30 * time.Minute,
            wantExpired: true,
        },
        {
            name:        "session past TTL",
            createdAt:   baseTime,
            checkAt:     baseTime.Add(31 * time.Minute),
            ttl:         30 * time.Minute,
            wantExpired: true,
        },
        {
            name:        "zero TTL never expires",
            createdAt:   baseTime,
            checkAt:     baseTime.Add(365 * 24 * time.Hour),
            ttl:         0,
            wantExpired: false,
        },
    }

    for _, tc := range tests {
        tc := tc
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()

            clk := clock.NewFake(tc.createdAt)
            store := NewSessionStore(clk, tc.ttl)

            sessionID := store.Create("user-1")

            clk.Set(tc.checkAt)

            session, err := store.Get(sessionID)
            if tc.wantExpired {
                if err != ErrSessionExpired {
                    t.Errorf("Get() error = %v, want ErrSessionExpired", err)
                }
            } else {
                if err != nil {
                    t.Fatalf("Get() unexpected error: %v", err)
                }
                if session.UserID != "user-1" {
                    t.Errorf("session.UserID = %q, want %q", session.UserID, "user-1")
                }
            }
        })
    }
}
```

### Rate Limiter Testing with Fake Clock

```go
func TestRateLimiter(t *testing.T) {
    baseTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

    tests := []struct {
        name        string
        limit       int
        window      time.Duration
        requests    []time.Duration // offsets from baseTime
        wantAllowed []bool
    }{
        {
            name:        "within limit",
            limit:       3,
            window:      time.Minute,
            requests:    []time.Duration{0, 10 * time.Second, 20 * time.Second},
            wantAllowed: []bool{true, true, true},
        },
        {
            name:        "exceed limit",
            limit:       2,
            window:      time.Minute,
            requests:    []time.Duration{0, 10 * time.Second, 20 * time.Second},
            wantAllowed: []bool{true, true, false},
        },
        {
            name:        "window reset allows new requests",
            limit:       2,
            window:      time.Minute,
            requests:    []time.Duration{0, 10 * time.Second, 61 * time.Second, 70 * time.Second},
            wantAllowed: []bool{true, true, true, true},
        },
    }

    for _, tc := range tests {
        tc := tc
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()

            clk := clock.NewFake(baseTime)
            rl := NewRateLimiter(clk, tc.limit, tc.window)

            for i, offset := range tc.requests {
                clk.Set(baseTime.Add(offset))
                got := rl.Allow("user-1")
                if got != tc.wantAllowed[i] {
                    t.Errorf("request[%d] at offset %v: Allow() = %v, want %v",
                        i, offset, got, tc.wantAllowed[i])
                }
            }
        })
    }
}
```

## Coverage Profiling and Gap Analysis

### Generating Coverage Profiles

```bash
# Run tests with coverage for all packages
go test -coverprofile=coverage.out -covermode=atomic ./...

# View per-package coverage summary
go tool cover -func=coverage.out | tail -1

# View annotated HTML report
go tool cover -html=coverage.out -o coverage.html
```

### Coverage by Package

```bash
# List packages below coverage threshold
go test -coverprofile=coverage.out ./... 2>/dev/null
go tool cover -func=coverage.out | awk '
  /^total:/ { next }
  {
    split($3, a, "%")
    if (a[1]+0 < 80) print $0
  }
' | sort -t% -k1 -n
```

### Enforcing Coverage Thresholds in CI

```bash
#!/bin/bash
# ci/check-coverage.sh
set -euo pipefail

THRESHOLD=80

go test -coverprofile=coverage.out -covermode=atomic ./...

COVERAGE=$(go tool cover -func=coverage.out | \
  grep '^total:' | \
  awk '{gsub(/%/, "", $3); print int($3)}')

echo "Total coverage: ${COVERAGE}%"

if [ "${COVERAGE}" -lt "${THRESHOLD}" ]; then
  echo "ERROR: Coverage ${COVERAGE}% is below threshold ${THRESHOLD}%"
  exit 1
fi

echo "Coverage check passed"
```

### Identifying Untested Code Paths

Use `go test -coverprofile` with `go tool cover -html` to find untested branches. For programmatic analysis:

```bash
# Find functions with 0% coverage
go tool cover -func=coverage.out | \
  awk '$3 == "0.0%" {print "UNCOVERED:", $1, $2}'

# Find files with below-threshold coverage
go tool cover -func=coverage.out | \
  grep -v '^total:' | \
  awk -F: '{
    file = $1
    split($NF, a, "%")
    cov[file] += a[1]+0
    cnt[file]++
  }
  END {
    for (f in cov) {
      avg = cov[f] / cnt[f]
      if (avg < 70) printf "%.1f%%\t%s\n", avg, f
    }
  }' | sort -n
```

## Advanced Table Patterns

### Shared Test State with Subtests

When test cases depend on ordered state changes (database records, file system), use a single test with sequential subtests rather than parallel ones:

```go
func TestUserLifecycle(t *testing.T) {
    db := setupTestDatabase(t)
    repo := NewUserRepository(db)

    // Each subtest builds on the state left by the previous
    steps := []struct {
        name string
        fn   func(t *testing.T, repo UserRepository) string
    }{
        {
            name: "create user",
            fn: func(t *testing.T, r UserRepository) string {
                id, err := r.Create(context.Background(), User{Name: "Alice", Email: "alice@example.com"})
                if err != nil {
                    t.Fatalf("Create() error: %v", err)
                }
                return id
            },
        },
        {
            name: "update user",
            fn: func(t *testing.T, r UserRepository) string {
                // uses state from create step via closure
                return ""
            },
        },
    }

    var lastID string
    for _, step := range steps {
        step := step
        t.Run(step.name, func(t *testing.T) {
            // Sequential: no t.Parallel()
            id := step.fn(t, repo)
            if id != "" {
                lastID = id
            }
            _ = lastID
        })
    }
}
```

### Parameterized Helpers with require

Wrap repeated assertion patterns into typed helpers:

```go
// testhelpers/assert.go
package testhelpers

import (
    "testing"

    "github.com/google/go-cmp/cmp"
)

func AssertEqual[T any](t *testing.T, got, want T, opts ...cmp.Option) {
    t.Helper()
    if diff := cmp.Diff(want, got, opts...); diff != "" {
        t.Errorf("mismatch (-want +got):\n%s", diff)
    }
}

func AssertNoError(t *testing.T, err error) {
    t.Helper()
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
}

func AssertError(t *testing.T, err error, target error) {
    t.Helper()
    if err == nil {
        t.Fatalf("expected error %v, got nil", target)
    }
    if !errors.Is(err, target) {
        t.Fatalf("expected error %v, got %v", target, err)
    }
}
```

### Table-Driven Middleware Tests

```go
func TestAuthMiddleware(t *testing.T) {
    tests := []struct {
        name           string
        authHeader     string
        mockValidate   func(token string) (*Claims, error)
        wantStatusCode int
        wantUserID     string
    }{
        {
            name:       "valid bearer token",
            authHeader: "Bearer valid-token-xyz",
            mockValidate: func(token string) (*Claims, error) {
                return &Claims{UserID: "user-1", Role: "admin"}, nil
            },
            wantStatusCode: http.StatusOK,
            wantUserID:     "user-1",
        },
        {
            name:           "missing authorization header",
            authHeader:     "",
            mockValidate:   func(token string) (*Claims, error) { return nil, nil },
            wantStatusCode: http.StatusUnauthorized,
        },
        {
            name:       "invalid token",
            authHeader: "Bearer expired-token",
            mockValidate: func(token string) (*Claims, error) {
                return nil, ErrTokenExpired
            },
            wantStatusCode: http.StatusUnauthorized,
        },
        {
            name:           "malformed header",
            authHeader:     "Token invalid-format",
            mockValidate:   func(token string) (*Claims, error) { return nil, nil },
            wantStatusCode: http.StatusUnauthorized,
        },
    }

    for _, tc := range tests {
        tc := tc
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()

            validator := &MockTokenValidator{ValidateFn: tc.mockValidate}
            middleware := NewAuthMiddleware(validator)

            var capturedUserID string
            handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                claims := ClaimsFromContext(r.Context())
                if claims != nil {
                    capturedUserID = claims.UserID
                }
                w.WriteHeader(http.StatusOK)
            }))

            rec := httptest.NewRecorder()
            req := httptest.NewRequest("GET", "/protected", nil)
            if tc.authHeader != "" {
                req.Header.Set("Authorization", tc.authHeader)
            }

            handler.ServeHTTP(rec, req)

            if rec.Code != tc.wantStatusCode {
                t.Errorf("status = %d, want %d", rec.Code, tc.wantStatusCode)
            }
            if tc.wantUserID != "" && capturedUserID != tc.wantUserID {
                t.Errorf("userID = %q, want %q", capturedUserID, tc.wantUserID)
            }
        })
    }
}
```

## CI Integration

A complete test pipeline configuration:

```yaml
# .github/workflows/test.yml
name: Test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: "1.22"
          cache: true

      - name: Run tests
        run: |
          go test \
            -race \
            -coverprofile=coverage.out \
            -covermode=atomic \
            -timeout=10m \
            ./...

      - name: Check coverage threshold
        run: |
          COVERAGE=$(go tool cover -func=coverage.out | \
            grep '^total:' | awk '{gsub(/%/,"",$3); print int($3)}')
          echo "Coverage: ${COVERAGE}%"
          [ "${COVERAGE}" -ge 80 ] || (echo "Coverage below 80%" && exit 1)

      - name: Run fuzz tests (seed corpus only)
        run: go test -run='Fuzz' ./...

      - name: Run benchmarks (smoke test, no regression check)
        run: go test -bench=. -benchtime=1x ./...

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: coverage.out
```

## Summary

Table-driven tests reduce test maintenance overhead, improve readability, and make coverage gaps obvious. The patterns in this guide — parallel subtests for speed, golden files for complex output, clock injection for time-dependent logic, fuzz targets for edge cases, and benchmark tables for performance regression tracking — form a complete testing toolkit for production Go services. The key discipline is consistency: once the team adopts a shared pattern (clock interfaces, fixture loaders, assertion helpers), new tests slot in quickly and the test suite remains legible as the codebase grows.
