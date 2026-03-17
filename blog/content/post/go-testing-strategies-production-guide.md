---
title: "Go Testing Strategies: Table-Driven Tests, Integration Tests, and Benchmarks"
date: 2027-09-09T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "Benchmarks"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive Go testing guide: table-driven patterns, testify vs stdlib, mock generation with mockery, integration tests with testcontainers, parallel execution, CI coverage enforcement, and benchmark analysis."
more_link: "yes"
url: "/go-testing-strategies-production-guide/"
---

A Go test suite that takes 20 minutes to run, requires a live database, and hits 30% coverage provides false confidence while slowing every CI run. Production-grade testing requires deliberate architectural choices: table-driven patterns for exhaustive case coverage, mock generation for isolation, testcontainers for real dependency integration, parallel execution for speed, and coverage gates enforced in CI. This guide covers each layer with complete, runnable examples.

<!--more-->

## Section 1: Table-Driven Tests

Table-driven tests are the idiomatic Go pattern for covering multiple input/output combinations without duplicating test boilerplate:

```go
package calculator_test

import (
    "testing"

    "github.com/example/myapp/calculator"
)

func TestDivide(t *testing.T) {
    tests := []struct {
        name      string
        a, b      float64
        want      float64
        wantErr   bool
        errString string
    }{
        {
            name: "positive division",
            a:    10, b: 4,
            want: 2.5,
        },
        {
            name: "negative dividend",
            a:    -9, b: 3,
            want: -3.0,
        },
        {
            name:      "division by zero",
            a:         5, b: 0,
            wantErr:   true,
            errString: "division by zero",
        },
        {
            name: "zero dividend",
            a:    0, b: 5,
            want: 0.0,
        },
        {
            name: "fractional result",
            a:    1, b: 3,
            want: 0.3333333333333333,
        },
    }

    for _, tc := range tests {
        tc := tc // capture range variable for parallel sub-tests
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()
            got, err := calculator.Divide(tc.a, tc.b)
            if tc.wantErr {
                if err == nil {
                    t.Fatalf("expected error containing %q, got nil", tc.errString)
                }
                if !strings.Contains(err.Error(), tc.errString) {
                    t.Fatalf("error %q does not contain %q", err.Error(), tc.errString)
                }
                return
            }
            if err != nil {
                t.Fatalf("unexpected error: %v", err)
            }
            if got != tc.want {
                t.Errorf("Divide(%v, %v) = %v, want %v", tc.a, tc.b, got, tc.want)
            }
        })
    }
}
```

### Structural Table Tests for Complex Types

For tests involving structs, use `cmp.Diff` to get readable diffs on failure:

```go
package user_test

import (
    "testing"
    "time"

    "github.com/google/go-cmp/cmp"
    "github.com/google/go-cmp/cmp/cmpopts"
)

func TestParseUserCSV(t *testing.T) {
    tests := []struct {
        name    string
        input   string
        want    []User
        wantErr bool
    }{
        {
            name:  "single user",
            input: "alice,alice@example.com,30",
            want: []User{
                {Name: "alice", Email: "alice@example.com", Age: 30},
            },
        },
        {
            name:    "missing email",
            input:   "alice,,30",
            wantErr: true,
        },
        {
            name:  "multiple users",
            input: "alice,alice@example.com,30\nbob,bob@example.com,25",
            want: []User{
                {Name: "alice", Email: "alice@example.com", Age: 30},
                {Name: "bob", Email: "bob@example.com", Age: 25},
            },
        },
    }

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            got, err := ParseUserCSV(tc.input)
            if (err != nil) != tc.wantErr {
                t.Fatalf("ParseUserCSV() error = %v, wantErr %v", err, tc.wantErr)
            }
            if diff := cmp.Diff(tc.want, got,
                cmpopts.IgnoreFields(User{}, "CreatedAt"),
                cmpopts.EquateEmpty(),
            ); diff != "" {
                t.Errorf("ParseUserCSV() mismatch (-want +got):\n%s", diff)
            }
        })
    }
}
```

## Section 2: testify vs Standard Library

The standard library provides everything necessary for unit tests. `testify` reduces boilerplate and improves readability for complex assertions:

```go
// Standard library
if got != want {
    t.Errorf("got %v, want %v", got, want)
}
if err != nil {
    t.Fatalf("unexpected error: %v", err)
}

// testify/assert — continues after failure
assert.Equal(t, want, got)
assert.NoError(t, err)

// testify/require — stops test on failure (use for preconditions)
require.NoError(t, err)
require.NotNil(t, result)
```

Prefer `require` for setup steps and `assert` for the actual assertions. Mixing them correctly prevents misleading nil pointer panics after setup failure:

```go
func TestUserService_Create(t *testing.T) {
    svc, err := NewUserService(testDB)
    require.NoError(t, err, "service setup must succeed")
    require.NotNil(t, svc)

    user, err := svc.Create(context.Background(), "Alice", "alice@example.com")
    require.NoError(t, err) // stop here if creation failed

    assert.Equal(t, "Alice", user.Name)
    assert.Equal(t, "alice@example.com", user.Email)
    assert.NotZero(t, user.ID)
    assert.WithinDuration(t, time.Now(), user.CreatedAt, 5*time.Second)
}
```

## Section 3: Mock Generation with mockery

Manual mocks diverge from interfaces over time. `mockery` generates mocks from interfaces automatically:

```bash
go install github.com/vektra/mockery/v2@v2.43.2

# Generate mocks for a specific interface.
mockery --name=UserRepository --dir=internal/repository --output=internal/mocks --outpkg=mocks

# Generate all interfaces in a package.
mockery --all --dir=internal/service --output=internal/mocks
```

`.mockery.yaml` for project-wide configuration:

```yaml
with-expecter: true
mockname: "Mock{{.InterfaceName}}"
outpkg: mocks
dir: "internal/mocks"
packages:
  github.com/example/myapp/internal/repository:
    interfaces:
      UserRepository:
      OrderRepository:
  github.com/example/myapp/internal/service:
    interfaces:
      EmailService:
```

Using the generated mock in tests:

```go
package service_test

import (
    "context"
    "errors"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
    "github.com/example/myapp/internal/mocks"
    "github.com/example/myapp/internal/service"
)

func TestUserService_GetByEmail_NotFound(t *testing.T) {
    repo := mocks.NewMockUserRepository(t)
    repo.EXPECT().
        FindByEmail(mock.Anything, "unknown@example.com").
        Return(nil, ErrNotFound).
        Once()

    svc := service.NewUserService(repo)
    _, err := svc.GetByEmail(context.Background(), "unknown@example.com")

    assert.ErrorIs(t, err, ErrNotFound)
    repo.AssertExpectations(t)
}

func TestUserService_GetByEmail_RepoError(t *testing.T) {
    repo := mocks.NewMockUserRepository(t)
    dbErr := errors.New("connection refused")
    repo.EXPECT().
        FindByEmail(mock.Anything, mock.AnythingOfType("string")).
        Return(nil, dbErr)

    svc := service.NewUserService(repo)
    _, err := svc.GetByEmail(context.Background(), "any@example.com")

    assert.Error(t, err)
    assert.Contains(t, err.Error(), "connection refused")
}
```

## Section 4: Integration Tests with testcontainers

`testcontainers-go` spins up real Docker containers for databases and message brokers in tests:

```bash
go get github.com/testcontainers/testcontainers-go@v0.31.0
go get github.com/testcontainers/testcontainers-go/modules/postgres@v0.31.0
```

```go
package repository_test

import (
    "context"
    "testing"

    "github.com/stretchr/testify/require"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/wait"
)

func TestUserRepository_Integration(t *testing.T) {
    if testing.Short() {
        t.Skip("skipping integration test in short mode")
    }

    ctx := context.Background()
    pgContainer, err := postgres.RunContainer(ctx,
        testcontainers.WithImage("postgres:16-alpine"),
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("testuser"),
        postgres.WithPassword("EXAMPLE_DB_PASSWORD_REPLACE_ME"),
        testcontainers.WithWaitStrategy(
            wait.ForLog("database system is ready to accept connections").
                WithOccurrence(2),
        ),
    )
    require.NoError(t, err)
    t.Cleanup(func() { pgContainer.Terminate(ctx) })

    connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
    require.NoError(t, err)

    repo, err := NewPostgresUserRepository(connStr)
    require.NoError(t, err)

    // Run migrations.
    require.NoError(t, repo.Migrate(ctx))

    t.Run("create and retrieve user", func(t *testing.T) {
        user, err := repo.Create(ctx, "Alice", "alice@example.com")
        require.NoError(t, err)
        require.NotZero(t, user.ID)

        found, err := repo.FindByID(ctx, user.ID)
        require.NoError(t, err)
        assert.Equal(t, user.ID, found.ID)
        assert.Equal(t, "Alice", found.Name)
    })

    t.Run("duplicate email returns conflict", func(t *testing.T) {
        _, err := repo.Create(ctx, "Bob", "alice@example.com")
        assert.ErrorIs(t, err, ErrEmailConflict)
    })
}
```

### TestMain for Shared Container

For packages with many integration tests, start the container once in `TestMain`:

```go
var testRepo *PostgresUserRepository

func TestMain(m *testing.M) {
    ctx := context.Background()
    pgContainer, err := postgres.RunContainer(ctx,
        testcontainers.WithImage("postgres:16-alpine"),
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("testuser"),
        postgres.WithPassword("EXAMPLE_DB_PASSWORD_REPLACE_ME"),
    )
    if err != nil {
        log.Fatalf("start postgres: %v", err)
    }
    defer pgContainer.Terminate(ctx)

    connStr, _ := pgContainer.ConnectionString(ctx, "sslmode=disable")
    testRepo, _ = NewPostgresUserRepository(connStr)
    testRepo.Migrate(ctx)

    os.Exit(m.Run())
}
```

## Section 5: Parallel Test Execution

Parallel tests significantly reduce wall-clock CI time for I/O-bound test suites:

```go
func TestParallelSuite(t *testing.T) {
    // t.Parallel() at the parent makes sub-tests run concurrently
    // with other top-level tests.
    t.Parallel()

    tests := []struct {
        name  string
        input int
        want  int
    }{
        {"double zero", 0, 0},
        {"double one", 1, 2},
        {"double five", 5, 10},
    }

    for _, tc := range tests {
        tc := tc // critical: capture loop variable before goroutine launch
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()
            got := Double(tc.input)
            assert.Equal(t, tc.want, got)
        })
    }
}
```

Detect data races in parallel tests with:

```bash
go test -race ./...
```

### Test Isolation with Subtests and Cleanup

```go
func TestWithCleanup(t *testing.T) {
    db := setupTestDB(t)
    t.Cleanup(func() {
        db.Close()
        // Cleanup runs even if the test panics.
    })

    t.Run("operation A", func(t *testing.T) {
        t.Parallel()
        // Uses db; cleanup runs after all sub-tests complete.
    })
}
```

## Section 6: Coverage Enforcement in CI

Gate merges on a minimum coverage threshold using the standard toolchain:

```bash
# Run tests and write coverage profile.
go test -coverprofile=coverage.out -covermode=atomic ./...

# Print per-package summary.
go tool cover -func=coverage.out

# Generate HTML report.
go tool cover -html=coverage.out -o coverage.html

# Fail if total coverage is below 80%.
COVERAGE=$(go tool cover -func=coverage.out | grep '^total:' | awk '{print $3}' | tr -d '%')
if (( $(echo "$COVERAGE < 80" | bc -l) )); then
    echo "Coverage ${COVERAGE}% is below 80% threshold"
    exit 1
fi
```

GitHub Actions workflow:

```yaml
name: Test

on: [push, pull_request]

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
        run: go test -race -coverprofile=coverage.out -covermode=atomic ./...

      - name: Enforce coverage threshold
        run: |
          COVERAGE=$(go tool cover -func=coverage.out | grep '^total:' | awk '{print $3}' | tr -d '%')
          echo "Total coverage: ${COVERAGE}%"
          if (( $(echo "$COVERAGE < 80" | bc -l) )); then
            echo "Coverage below 80% threshold"
            exit 1
          fi

      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v4
        with:
          files: coverage.out
          token: ${{ secrets.CODECOV_TOKEN }}
```

## Section 7: Benchmark Writing and Analysis

Benchmarks verify that performance improvements hold and detect regressions before they ship:

```go
package cache_test

import (
    "fmt"
    "testing"
)

func BenchmarkCacheGet(b *testing.B) {
    cache := NewCache(1000)
    // Pre-populate so we measure Get, not miss paths.
    for i := 0; i < 1000; i++ {
        cache.Set(fmt.Sprintf("key%d", i), i)
    }

    b.ResetTimer()
    b.ReportAllocs()
    b.RunParallel(func(pb *testing.PB) {
        i := 0
        for pb.Next() {
            _ = cache.Get(fmt.Sprintf("key%d", i%1000))
            i++
        }
    })
}

func BenchmarkCacheSet(b *testing.B) {
    sizes := []int{100, 1_000, 10_000, 100_000}
    for _, size := range sizes {
        b.Run(fmt.Sprintf("size=%d", size), func(b *testing.B) {
            cache := NewCache(size)
            b.ResetTimer()
            b.ReportAllocs()
            for i := 0; i < b.N; i++ {
                cache.Set(fmt.Sprintf("key%d", i%size), i)
            }
        })
    }
}
```

Run benchmarks and compare with `benchstat`:

```bash
# Baseline
go test -bench=BenchmarkCacheGet -benchmem -count=10 ./... > old.txt

# After change
go test -bench=BenchmarkCacheGet -benchmem -count=10 ./... > new.txt

# Install benchstat
go install golang.org/x/perf/cmd/benchstat@latest

# Compare
benchstat old.txt new.txt
```

Example `benchstat` output:

```text
name         old time/op    new time/op    delta
CacheGet-8     125ns ± 3%     98ns ± 2%   -21.6%  (p=0.000 n=10+10)

name         old allocs/op  new allocs/op  delta
CacheGet-8      2.00 ± 0%      0.00 ± 0%   -100%  (p=0.000 n=10+10)
```

### CPU and Memory Profiling in Benchmarks

```bash
# CPU profile
go test -bench=BenchmarkCacheGet -cpuprofile=cpu.prof ./...
go tool pprof -http=:6060 cpu.prof

# Memory profile
go test -bench=BenchmarkCacheSet -memprofile=mem.prof ./...
go tool pprof -http=:6060 mem.prof
```

## Section 8: Golden File Tests

For tests where the expected output is complex (JSON responses, generated code, rendered templates), golden files prevent large inline literals:

```go
package render_test

import (
    "flag"
    "os"
    "path/filepath"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

var update = flag.Bool("update", false, "update golden files")

func TestRenderReport(t *testing.T) {
    input := ReportData{Title: "Q3 Revenue", Total: 42000}
    got, err := RenderReport(input)
    require.NoError(t, err)

    goldenPath := filepath.Join("testdata", "golden", t.Name()+".json")

    if *update {
        require.NoError(t, os.MkdirAll(filepath.Dir(goldenPath), 0755))
        require.NoError(t, os.WriteFile(goldenPath, got, 0644))
        t.Logf("updated golden file %s", goldenPath)
        return
    }

    want, err := os.ReadFile(goldenPath)
    require.NoError(t, err, "golden file missing; run with -update to create it")
    assert.JSONEq(t, string(want), string(got))
}
```

Run with `-update` flag after intentional output changes:

```bash
go test ./... -run TestRenderReport -update
```

## Section 9: Fuzz Testing

Go 1.18+ includes native fuzzing support. Fuzz tests find edge cases that table-driven tests miss:

```go
package parser_test

import (
    "testing"
    "unicode/utf8"
)

func FuzzParseConfig(f *testing.F) {
    // Seed corpus — representative valid inputs.
    f.Add(`{"key":"value"}`)
    f.Add(`{"timeout":30,"workers":4}`)
    f.Add(`{}`)

    f.Fuzz(func(t *testing.T, data string) {
        // The parser must never panic on arbitrary input.
        cfg, err := ParseConfig(data)
        if err != nil {
            return // errors are expected; panics are not
        }
        // Invariant: parsed config is always valid UTF-8.
        if !utf8.ValidString(cfg.String()) {
            t.Errorf("ParseConfig returned invalid UTF-8")
        }
    })
}
```

Run the fuzzer until a failing input is found or for a fixed duration:

```bash
# Fuzz for 60 seconds
go test -fuzz=FuzzParseConfig -fuzztime=60s ./...

# Reproduce a specific failing corpus entry
go test -run=FuzzParseConfig/testdata/fuzz/FuzzParseConfig/some-input ./...
```

## Section 10: Test Organization Best Practices

Structure tests to maximise clarity and CI efficiency:

```text
// Build tag to exclude integration tests from unit test runs
//go:build integration

package repository_test
```

Run selectively:

```bash
# Unit tests only (fast, no external dependencies)
go test -short ./...

# Integration tests only
go test -tags=integration ./...

# All tests
go test -tags=integration -race -count=1 ./...
```

Makefile targets:

```makefile
.PHONY: test test-unit test-integration test-bench

test-unit:
	go test -short -race -count=1 -coverprofile=coverage.out ./...

test-integration:
	go test -tags=integration -race -count=1 ./...

test-bench:
	go test -bench=. -benchmem -count=5 ./...

test: test-unit test-integration
```
