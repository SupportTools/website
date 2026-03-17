---
title: "Go Testing Patterns: Table-Driven Tests, Subtests, and Test Fixtures at Scale"
date: 2031-01-21T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Testing", "TDD", "Unit Tests", "Integration Tests", "Testify"]
categories:
- Go
- Testing
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go testing at enterprise scale: table-driven tests, t.Run parallelism, testify vs standard library, TestMain fixtures, golden file testing, and structuring test packages for large codebases."
more_link: "yes"
url: "/go-testing-patterns-table-driven-subtests-fixtures-scale/"
---

Go's testing philosophy favors simplicity, but at enterprise scale, unsophisticated test suites become liabilities. Tests that are slow, flaky, hard to read, or difficult to extend delay releases and erode confidence. This guide covers the patterns that make Go test suites fast and maintainable: table-driven tests with parallel subtests, test fixtures with proper lifecycle management using TestMain, golden file testing for complex output validation, package organization strategies, and the practical trade-offs between testify and the standard library.

<!--more-->

# Go Testing Patterns: Table-Driven Tests, Subtests, and Test Fixtures at Scale

## Foundations: The Go Testing Model

Before diving into patterns, understanding Go's testing primitives is essential. The `testing` package provides:

- `*testing.T` for test management (failure, logging, cleanup)
- `*testing.B` for benchmarks
- `*testing.F` for fuzzing
- `*testing.M` for test binary lifecycle control (TestMain)

Go test files live alongside production code (`package foo`) or in a separate test package (`package foo_test`). Both styles have their place.

```go
// Internal tests (package foo) - test unexported identifiers
package foo

// External tests (package foo_test) - test the public API
package foo_test
```

Use `package foo_test` by default. It forces you to test through the public API, which catches API design issues early and produces tests that serve as accurate documentation.

## Table-Driven Tests: Structure and Anti-Patterns

The table-driven pattern is idiomatic Go. Every Go test author uses it, but many use it poorly.

### Basic Structure

```go
package validator_test

import (
    "testing"
    "github.com/example/myapp/validator"
)

func TestValidateEmail(t *testing.T) {
    tests := []struct {
        name    string
        input   string
        wantErr bool
        errMsg  string
    }{
        {
            name:    "valid simple email",
            input:   "user@example.com",
            wantErr: false,
        },
        {
            name:    "valid email with plus addressing",
            input:   "user+tag@example.com",
            wantErr: false,
        },
        {
            name:    "missing at sign",
            input:   "userexample.com",
            wantErr: true,
            errMsg:  "missing @ sign",
        },
        {
            name:    "empty string",
            input:   "",
            wantErr: true,
            errMsg:  "email cannot be empty",
        },
        {
            name:    "local part too long",
            input:   string(make([]byte, 65)) + "@example.com",
            wantErr: true,
            errMsg:  "local part exceeds 64 characters",
        },
        {
            name:    "international domain",
            input:   "user@münchen.de",
            wantErr: false,
        },
    }

    for _, tt := range tests {
        tt := tt // capture range variable for parallel safety
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel() // run subtests in parallel

            err := validator.ValidateEmail(tt.input)

            if tt.wantErr {
                if err == nil {
                    t.Errorf("ValidateEmail(%q) = nil, want error containing %q",
                        tt.input, tt.errMsg)
                    return
                }
                if tt.errMsg != "" && !containsError(err, tt.errMsg) {
                    t.Errorf("ValidateEmail(%q) error = %q, want error containing %q",
                        tt.input, err, tt.errMsg)
                }
                return
            }

            if err != nil {
                t.Errorf("ValidateEmail(%q) = %v, want nil", tt.input, err)
            }
        })
    }
}

func containsError(err error, msg string) bool {
    return strings.Contains(err.Error(), msg)
}
```

### Anti-Patterns to Avoid

```go
// ANTI-PATTERN 1: Magic booleans without names
tests := []struct {
    string
    string
    bool
    bool
}{
    {"user@example.com", "", false, false}, // What do the bools mean?
}

// BETTER: Named fields
tests := []struct {
    name       string
    input      string
    wantErr    bool
    wantResult bool
}{}

// ANTI-PATTERN 2: Not capturing loop variable before t.Parallel()
for _, tt := range tests {
    t.Run(tt.name, func(t *testing.T) {
        t.Parallel()
        // BUG: tt is shared across goroutines, all tests may use last value
        _ = tt.input
    })
}

// FIX: Capture before t.Parallel()
for _, tt := range tests {
    tt := tt  // Shadow with local copy
    t.Run(tt.name, func(t *testing.T) {
        t.Parallel()
        _ = tt.input  // Safe: local tt
    })
}

// Note: In Go 1.22+, loop variables are captured per-iteration automatically,
// but the tt := tt pattern remains a good practice for clarity and compatibility.

// ANTI-PATTERN 3: Shared mutable state between parallel tests
var results []string // SHARED - DATA RACE in parallel tests

// FIX: Each subtest maintains its own state, no sharing
```

### Rich Test Cases with Multiple Assertions

For complex functions with rich output, structure test cases to check all relevant aspects:

```go
package parser_test

import (
    "testing"
    "time"
    "github.com/example/myapp/parser"
)

func TestParseOrder(t *testing.T) {
    t.Parallel()

    tests := []struct {
        name      string
        input     string
        want      *parser.Order
        wantErr   bool
        errType   error
    }{
        {
            name:  "complete valid order",
            input: `{"id":"ord-123","items":[{"sku":"ABC","qty":2}],"total":49.98}`,
            want: &parser.Order{
                ID:    "ord-123",
                Items: []parser.OrderItem{{SKU: "ABC", Quantity: 2}},
                Total: 49.98,
            },
        },
        {
            name:    "missing order ID",
            input:   `{"items":[{"sku":"ABC","qty":1}],"total":24.99}`,
            wantErr: true,
            errType: parser.ErrMissingOrderID,
        },
        {
            name:    "negative total",
            input:   `{"id":"ord-456","items":[],"total":-1.0}`,
            wantErr: true,
            errType: parser.ErrInvalidTotal,
        },
    }

    for _, tt := range tests {
        tt := tt
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel()

            got, err := parser.ParseOrder([]byte(tt.input))

            if tt.wantErr {
                if err == nil {
                    t.Fatal("ParseOrder() = nil error, want error")
                }
                if tt.errType != nil {
                    if !errors.Is(err, tt.errType) {
                        t.Errorf("ParseOrder() error = %T(%v), want %T", err, err, tt.errType)
                    }
                }
                return
            }

            if err != nil {
                t.Fatalf("ParseOrder() unexpected error: %v", err)
            }

            // Deep equality check
            if diff := cmp.Diff(tt.want, got); diff != "" {
                t.Errorf("ParseOrder() mismatch (-want +got):\n%s", diff)
            }
        })
    }
}
```

## Subtests and Parallel Execution

### Controlling Parallelism

```go
func TestDatabase(t *testing.T) {
    // Outer test is NOT parallel - it manages shared resources
    db := setupTestDB(t)

    // Each subtest CAN be parallel within this group
    t.Run("create user", func(t *testing.T) {
        t.Parallel()
        // Uses db - safe if db supports concurrent access
    })

    t.Run("list users", func(t *testing.T) {
        t.Parallel()
        // Uses db
    })

    // The outer test waits for all subtests before proceeding
    // This is the "pause/resume" behavior of t.Parallel()
}
```

### Subtest Groups for Complex Scenarios

```go
func TestHTTPHandler(t *testing.T) {
    t.Parallel()

    handler := setupHandler(t)
    server := httptest.NewServer(handler)
    t.Cleanup(server.Close)

    t.Run("authentication", func(t *testing.T) {
        t.Parallel()

        t.Run("missing token returns 401", func(t *testing.T) {
            t.Parallel()
            resp, err := http.Get(server.URL + "/api/resource")
            if err != nil {
                t.Fatal(err)
            }
            defer resp.Body.Close()
            if resp.StatusCode != http.StatusUnauthorized {
                t.Errorf("status = %d, want 401", resp.StatusCode)
            }
        })

        t.Run("invalid token returns 401", func(t *testing.T) {
            t.Parallel()
            req, _ := http.NewRequest(http.MethodGet, server.URL+"/api/resource", nil)
            req.Header.Set("Authorization", "Bearer invalid-token")
            resp, err := http.DefaultClient.Do(req)
            if err != nil {
                t.Fatal(err)
            }
            defer resp.Body.Close()
            if resp.StatusCode != http.StatusUnauthorized {
                t.Errorf("status = %d, want 401", resp.StatusCode)
            }
        })
    })

    t.Run("resources", func(t *testing.T) {
        t.Parallel()

        token := getTestToken(t)

        t.Run("GET returns 200", func(t *testing.T) {
            t.Parallel()
            req, _ := http.NewRequest(http.MethodGet, server.URL+"/api/resource/1", nil)
            req.Header.Set("Authorization", "Bearer "+token)
            // ...
        })
    })
}
```

## TestMain: Test Fixture Lifecycle

TestMain controls the test binary lifecycle, enabling expensive setup/teardown that runs once for the entire package.

### Database Integration Test Fixture

```go
// testmain_test.go
package store_test

import (
    "context"
    "database/sql"
    "fmt"
    "log"
    "os"
    "testing"
    "time"

    _ "github.com/lib/pq"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/wait"
)

var testDB *sql.DB
var testDSN string

func TestMain(m *testing.M) {
    // Setup: called once before any test in this package
    ctx := context.Background()

    var cleanup func()
    var err error

    if os.Getenv("TEST_DATABASE_URL") != "" {
        // Use existing database (CI environment)
        testDSN = os.Getenv("TEST_DATABASE_URL")
    } else {
        // Start a PostgreSQL container for local development
        testDSN, cleanup, err = startPostgresContainer(ctx)
        if err != nil {
            log.Fatalf("Failed to start test database: %v", err)
        }
    }

    testDB, err = sql.Open("postgres", testDSN)
    if err != nil {
        log.Fatalf("Failed to open database: %v", err)
    }

    // Wait for database to be ready
    for i := 0; i < 30; i++ {
        if err = testDB.PingContext(ctx); err == nil {
            break
        }
        time.Sleep(500 * time.Millisecond)
    }
    if err != nil {
        log.Fatalf("Database never became ready: %v", err)
    }

    // Apply schema
    if err = applySchema(testDB); err != nil {
        log.Fatalf("Failed to apply schema: %v", err)
    }

    // Run all tests
    code := m.Run()

    // Teardown
    testDB.Close()
    if cleanup != nil {
        cleanup()
    }

    os.Exit(code)
}

func startPostgresContainer(ctx context.Context) (dsn string, cleanup func(), err error) {
    container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
        ContainerRequest: testcontainers.ContainerRequest{
            Image:        "postgres:15-alpine",
            ExposedPorts: []string{"5432/tcp"},
            Env: map[string]string{
                "POSTGRES_PASSWORD": "testpass",
                "POSTGRES_USER":     "testuser",
                "POSTGRES_DB":       "testdb",
            },
            WaitingFor: wait.ForLog("database system is ready to accept connections").
                WithOccurrence(2).
                WithStartupTimeout(60 * time.Second),
        },
        Started: true,
    })
    if err != nil {
        return "", nil, fmt.Errorf("start container: %w", err)
    }

    host, err := container.Host(ctx)
    if err != nil {
        return "", nil, err
    }

    port, err := container.MappedPort(ctx, "5432")
    if err != nil {
        return "", nil, err
    }

    dsn = fmt.Sprintf("postgres://testuser:testpass@%s:%s/testdb?sslmode=disable",
        host, port.Port())

    cleanup = func() {
        if err := container.Terminate(ctx); err != nil {
            log.Printf("Failed to terminate container: %v", err)
        }
    }

    return dsn, cleanup, nil
}

func applySchema(db *sql.DB) error {
    schema := `
        CREATE TABLE IF NOT EXISTS users (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email       TEXT NOT NULL UNIQUE,
            name        TEXT NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS orders (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     UUID NOT NULL REFERENCES users(id),
            total       NUMERIC(10,2) NOT NULL,
            status      TEXT NOT NULL DEFAULT 'pending',
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `
    _, err := db.Exec(schema)
    return err
}
```

### Test Helper Functions with t.Cleanup

```go
// helpers_test.go
package store_test

import (
    "context"
    "testing"
    "github.com/google/uuid"
    "github.com/example/myapp/store"
)

// newTestUser creates a user and registers cleanup to delete it after the test.
func newTestUser(t *testing.T, opts ...func(*store.User)) *store.User {
    t.Helper()

    u := &store.User{
        Email: fmt.Sprintf("test-%s@example.com", uuid.New().String()[:8]),
        Name:  "Test User",
    }
    for _, opt := range opts {
        opt(u)
    }

    s := store.New(testDB)
    created, err := s.CreateUser(context.Background(), u)
    if err != nil {
        t.Fatalf("newTestUser: %v", err)
    }

    // Automatic cleanup when the test finishes
    t.Cleanup(func() {
        if err := s.DeleteUser(context.Background(), created.ID); err != nil {
            t.Logf("cleanup: failed to delete test user %s: %v", created.ID, err)
        }
    })

    return created
}

// isolatedTestDB returns a fresh database with an isolated schema per test.
// Use for tests that require completely isolated state.
func isolatedTestDB(t *testing.T) *sql.DB {
    t.Helper()

    schemaName := "test_" + strings.ReplaceAll(uuid.New().String(), "-", "_")

    _, err := testDB.Exec(fmt.Sprintf("CREATE SCHEMA %s", schemaName))
    if err != nil {
        t.Fatalf("create schema: %v", err)
    }

    // Set search_path for this connection
    db, err := sql.Open("postgres", testDSN+"&search_path="+schemaName)
    if err != nil {
        t.Fatalf("open isolated db: %v", err)
    }

    if err := applySchema(db); err != nil {
        t.Fatalf("apply schema: %v", err)
    }

    t.Cleanup(func() {
        db.Close()
        testDB.Exec(fmt.Sprintf("DROP SCHEMA %s CASCADE", schemaName))
    })

    return db
}
```

## Golden File Testing

Golden files store expected output in files rather than inline in test code. They are invaluable for testing complex output: API responses, rendered templates, generated code, or formatted reports.

### Implementation

```go
// golden/golden.go
package golden

import (
    "bytes"
    "flag"
    "os"
    "path/filepath"
    "testing"
)

var update = flag.Bool("update", false, "update golden files")

// Assert compares got to the golden file content.
// If -update flag is provided, overwrites the golden file.
func Assert(t *testing.T, got []byte) {
    t.Helper()

    name := filepath.Join("testdata", t.Name()+".golden")
    // Replace slashes in subtest names with OS separator
    name = filepath.Clean(name)

    if *update {
        dir := filepath.Dir(name)
        if err := os.MkdirAll(dir, 0755); err != nil {
            t.Fatalf("golden: mkdir %s: %v", dir, err)
        }
        if err := os.WriteFile(name, got, 0644); err != nil {
            t.Fatalf("golden: write %s: %v", name, err)
        }
        t.Logf("golden: updated %s", name)
        return
    }

    want, err := os.ReadFile(name)
    if err != nil {
        if os.IsNotExist(err) {
            t.Fatalf("golden: file not found: %s\n\nRun tests with -update to create it", name)
        }
        t.Fatalf("golden: read %s: %v", name, err)
    }

    if !bytes.Equal(want, got) {
        t.Errorf("golden file mismatch for %s:\n\nGot:\n%s\n\nWant:\n%s\n\nRun tests with -update to accept new output",
            name, got, want)
    }
}

// AssertString is a convenience wrapper for string output.
func AssertString(t *testing.T, got string) {
    t.Helper()
    Assert(t, []byte(got))
}
```

### Using Golden Files in Tests

```go
// template_test.go
package renderer_test

import (
    "bytes"
    "testing"
    "github.com/example/myapp/renderer"
    "github.com/example/myapp/golden"
)

func TestRenderInvoice(t *testing.T) {
    t.Parallel()

    tests := []struct {
        name    string
        invoice renderer.Invoice
    }{
        {
            name: "simple_single_item",
            invoice: renderer.Invoice{
                Number:     "INV-001",
                CustomerID: "cust-123",
                Items: []renderer.InvoiceItem{
                    {Description: "Widget", Quantity: 2, UnitPrice: 9.99},
                },
            },
        },
        {
            name: "multiple_items_with_discount",
            invoice: renderer.Invoice{
                Number:     "INV-002",
                CustomerID: "cust-456",
                Discount:   0.10,
                Items: []renderer.InvoiceItem{
                    {Description: "Widget A", Quantity: 5, UnitPrice: 9.99},
                    {Description: "Widget B", Quantity: 1, UnitPrice: 99.99},
                },
            },
        },
    }

    for _, tt := range tests {
        tt := tt
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel()

            var buf bytes.Buffer
            if err := renderer.RenderInvoice(&buf, tt.invoice); err != nil {
                t.Fatalf("RenderInvoice: %v", err)
            }

            golden.AssertString(t, buf.String())
        })
    }
}
```

Run with `-update` to regenerate golden files:

```bash
# Generate/update golden files
go test ./... -run TestRenderInvoice -update

# Normal test run (compare against golden files)
go test ./...
```

Golden files are committed to the repository:

```
testdata/
  TestRenderInvoice/
    simple_single_item.golden
    multiple_items_with_discount.golden
```

## Testify vs Standard Library

### When to Use Each

The standard library is sufficient for most tests:

```go
// Standard library - verbose but zero dependencies
if got != want {
    t.Errorf("Foo() = %v, want %v", got, want)
}

// Testify - more expressive, better error messages
assert.Equal(t, want, got)
require.NoError(t, err)
```

### The case for testify

Testify's `require` package stops the test immediately on failure, preventing cascading nil-pointer panics:

```go
package store_test

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "github.com/example/myapp/store"
)

func TestCreateAndRetrieveUser(t *testing.T) {
    t.Parallel()

    s := store.New(testDB)
    ctx := context.Background()

    // require stops the test immediately if this fails
    // Without require, a nil user would panic on the next line
    user, err := s.CreateUser(ctx, &store.User{
        Email: "alice@example.com",
        Name:  "Alice",
    })
    require.NoError(t, err, "CreateUser should succeed")
    require.NotNil(t, user, "CreateUser should return a user")

    // assert continues the test even if these fail, collecting all failures
    assert.NotEmpty(t, user.ID, "user should have an ID")
    assert.Equal(t, "alice@example.com", user.Email)
    assert.Equal(t, "Alice", user.Name)
    assert.False(t, user.CreatedAt.IsZero(), "created_at should be set")

    // Retrieve and verify
    retrieved, err := s.GetUser(ctx, user.ID)
    require.NoError(t, err)
    assert.Equal(t, user.ID, retrieved.ID)
    assert.Equal(t, user.Email, retrieved.Email)
}
```

### google/go-cmp for Deep Comparison

For complex structs, `google/go-cmp` provides better diff output than `reflect.DeepEqual` or testify's `Equal`:

```go
import "github.com/google/go-cmp/cmp"

func TestProcessOrder(t *testing.T) {
    got, err := ProcessOrder(input)
    require.NoError(t, err)

    want := &Order{
        ID:     "ord-123",
        Status: "processed",
        Items:  []Item{{SKU: "ABC", Price: 9.99}},
    }

    // cmp.Diff provides a readable diff:
    // (-want +got):
    //   &Order{
    //     ID:     "ord-123",
    // -   Status: "processed",
    // +   Status: "pending",
    //   }
    if diff := cmp.Diff(want, got,
        // Ignore unexported fields
        cmpopts.IgnoreUnexported(Order{}),
        // Ignore time fields with tolerance
        cmpopts.EquateApproxTime(time.Second),
    ); diff != "" {
        t.Errorf("ProcessOrder() mismatch (-want +got):\n%s", diff)
    }
}
```

## Test Package Organization at Scale

### Internal vs External Test Packages

```
myapp/
├── store/
│   ├── store.go           # Package store
│   ├── store_test.go      # Package store_test (external - tests public API)
│   ├── store_internal_test.go  # Package store (internal - tests private functions)
│   ├── helpers_test.go    # Package store_test (shared test helpers)
│   └── testdata/          # Test fixtures and golden files
│       └── TestRenderInvoice/
│           └── simple_single_item.golden
```

```go
// store_internal_test.go - tests internal/unexported behavior
package store  // Note: same package, not store_test

import "testing"

func TestInternalNormalize(t *testing.T) {
    // Can access unexported normalize() function
    got := normalize("  ALICE@EXAMPLE.COM  ")
    if got != "alice@example.com" {
        t.Errorf("normalize() = %q, want %q", got, "alice@example.com")
    }
}
```

### Shared Test Infrastructure

Large codebases benefit from a `testutil` package:

```go
// testutil/db.go
// Package testutil provides shared test helpers.
// Import with import _ "github.com/example/myapp/testutil" for side effects only,
// or import "github.com/example/myapp/testutil" for helper functions.
package testutil

import (
    "database/sql"
    "testing"
    "os"
)

// PostgresDB returns a database connection for integration tests.
// It skips the test if TEST_DATABASE_URL is not set.
func PostgresDB(t *testing.T) *sql.DB {
    t.Helper()

    dsn := os.Getenv("TEST_DATABASE_URL")
    if dsn == "" {
        t.Skip("TEST_DATABASE_URL not set; skipping integration test")
    }

    db, err := sql.Open("postgres", dsn)
    if err != nil {
        t.Fatalf("testutil.PostgresDB: %v", err)
    }

    t.Cleanup(func() { db.Close() })
    return db
}

// MustReadFile reads a file and fails the test if it cannot be read.
func MustReadFile(t *testing.T, path string) []byte {
    t.Helper()
    data, err := os.ReadFile(path)
    if err != nil {
        t.Fatalf("testutil.MustReadFile: %v", err)
    }
    return data
}
```

### Build Tags for Test Categories

```go
//go:build integration

// integration_test.go
package store_test

import (
    "testing"
    "github.com/example/myapp/testutil"
)

func TestCreateUserIntegration(t *testing.T) {
    db := testutil.PostgresDB(t)
    // ...
}
```

Running different test categories:

```bash
# Unit tests only (default)
go test ./...

# Integration tests only
go test -tags=integration ./...

# Both
go test -tags=integration,unit ./...

# With race detector (always in CI)
go test -race ./...

# With coverage
go test -race -coverprofile=coverage.out ./...
go tool cover -html=coverage.out -o coverage.html
```

## Benchmarks as Tests

```go
func BenchmarkValidateEmail(b *testing.B) {
    cases := []string{
        "user@example.com",
        "very.long.email.address.with.many.parts@subdomain.example.co.uk",
        "invalid-email",
    }

    for _, c := range cases {
        c := c
        b.Run(c, func(b *testing.B) {
            b.ReportAllocs()
            for i := 0; i < b.N; i++ {
                _ = validator.ValidateEmail(c)
            }
        })
    }
}
```

```bash
# Run benchmarks
go test -bench=BenchmarkValidateEmail -benchmem -count=5 ./validator/

# Compare benchmark results
go test -bench=. -benchmem -count=5 ./... > before.txt
# Make changes
go test -bench=. -benchmem -count=5 ./... > after.txt
benchstat before.txt after.txt
```

## HTTP Handler Testing Patterns

```go
package api_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "strings"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "github.com/example/myapp/api"
)

func TestCreateUserHandler(t *testing.T) {
    t.Parallel()

    tests := []struct {
        name         string
        body         string
        contentType  string
        wantStatus   int
        wantBody     map[string]interface{}
    }{
        {
            name:        "valid request",
            body:        `{"email":"alice@example.com","name":"Alice"}`,
            contentType: "application/json",
            wantStatus:  http.StatusCreated,
            wantBody: map[string]interface{}{
                "email": "alice@example.com",
                "name":  "Alice",
            },
        },
        {
            name:       "missing content type",
            body:       `{"email":"alice@example.com","name":"Alice"}`,
            wantStatus: http.StatusUnsupportedMediaType,
        },
        {
            name:        "invalid JSON",
            body:        `{invalid`,
            contentType: "application/json",
            wantStatus:  http.StatusBadRequest,
        },
        {
            name:        "missing email",
            body:        `{"name":"Alice"}`,
            contentType: "application/json",
            wantStatus:  http.StatusUnprocessableEntity,
            wantBody: map[string]interface{}{
                "error": "email is required",
            },
        },
    }

    for _, tt := range tests {
        tt := tt
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel()

            // Create handler with mock store
            mockStore := &mockUserStore{}
            handler := api.NewHandler(mockStore)

            req := httptest.NewRequest(http.MethodPost, "/users", strings.NewReader(tt.body))
            if tt.contentType != "" {
                req.Header.Set("Content-Type", tt.contentType)
            }

            rec := httptest.NewRecorder()
            handler.ServeHTTP(rec, req)

            assert.Equal(t, tt.wantStatus, rec.Code)

            if tt.wantBody != nil {
                var gotBody map[string]interface{}
                require.NoError(t, json.NewDecoder(rec.Body).Decode(&gotBody))
                for k, v := range tt.wantBody {
                    assert.Equal(t, v, gotBody[k], "body[%q]", k)
                }
            }
        })
    }
}
```

## CI Integration

```yaml
# .github/workflows/test.yaml
name: Test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: testpass
          POSTGRES_USER: testuser
          POSTGRES_DB: testdb
        ports:
        - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-go@v5
      with:
        go-version: '1.22'
        cache: true

    - name: Run unit tests
      run: go test -race -coverprofile=unit-coverage.out ./...

    - name: Run integration tests
      env:
        TEST_DATABASE_URL: postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable
      run: go test -race -tags=integration -coverprofile=integration-coverage.out ./...

    - name: Upload coverage
      uses: codecov/codecov-action@v4
      with:
        files: unit-coverage.out,integration-coverage.out
```

## Conclusion

The patterns in this guide compose into a testing strategy that scales with codebase complexity:

1. **Table-driven tests**: Always capture range variables before `t.Parallel()`; use named struct fields; validate both success and failure paths
2. **TestMain**: Reserve for expensive shared resources (containers, schema migration); use `t.Cleanup` for per-test resources
3. **Golden files**: Ideal for complex output validation where inline expected values become maintenance burdens
4. **testify**: Use `require` for preconditions (nil checks before dereferencing), `assert` for comprehensive failure collection; `google/go-cmp` for deep struct comparison with useful diffs
5. **Package structure**: Default to `package foo_test`; use build tags to separate unit from integration tests; maintain a `testutil` package for shared helpers

The investment in well-structured tests pays dividends every time a regression is caught before it reaches production, and every time a new team member can understand the expected behavior of a function by reading its tests.
