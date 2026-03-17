---
title: "Go Testing Patterns: Table-Driven Tests, Golden Files, and Property-Based Testing with rapid"
date: 2030-03-10T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Testing", "TDD", "Property-Based Testing", "Golden Files", "rapid"]
categories: ["Go", "Testing"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Go testing strategies including advanced table-driven test design, golden file testing for complex outputs, and property-based testing with pgregory.net/rapid for finding edge cases automatically."
more_link: "yes"
url: "/go-testing-patterns-table-driven-golden-files-rapid/"
---

Go's testing philosophy favors simplicity and pragmatism — a single `testing.T` type, no special assertion libraries required, and tests that are just Go functions. Despite this apparent simplicity, the ecosystem has developed sophisticated patterns for testing complex systems: table-driven tests that scale to hundreds of cases without duplication, golden file testing for outputs that are too complex to hardcode in test functions, and property-based testing that explores the input space automatically to find edge cases your manual tests miss. This guide covers all three approaches with production-quality examples.

<!--more-->

## Table-Driven Tests: Beyond the Basics

The table-driven test pattern is idiomatic Go, but most implementations only scratch the surface. The key insight is that a well-designed test table is essentially a specification of behavior.

### Foundational Pattern

```go
package parser_test

import (
    "errors"
    "testing"
    "time"

    "github.com/example/myapp/parser"
)

func TestParseConfig(t *testing.T) {
    t.Parallel()

    tests := []struct {
        name    string
        input   string
        want    *parser.Config
        wantErr error
    }{
        {
            name:  "minimal valid config",
            input: `{"port": 8080}`,
            want: &parser.Config{
                Port:    8080,
                Timeout: 30 * time.Second, // Default
            },
        },
        {
            name: "full config with all fields",
            input: `{
                "port": 9090,
                "timeout_seconds": 60,
                "log_level": "debug",
                "workers": 4
            }`,
            want: &parser.Config{
                Port:      9090,
                Timeout:   60 * time.Second,
                LogLevel:  "debug",
                Workers:   4,
            },
        },
        {
            name:    "invalid JSON",
            input:   `{invalid`,
            wantErr: parser.ErrInvalidJSON,
        },
        {
            name:    "port out of range",
            input:   `{"port": 70000}`,
            wantErr: parser.ErrInvalidPort,
        },
        {
            name:    "negative timeout",
            input:   `{"timeout_seconds": -1}`,
            wantErr: parser.ErrInvalidTimeout,
        },
        {
            name:  "zero port uses default",
            input: `{"port": 0}`,
            want: &parser.Config{
                Port:    8080, // Default
                Timeout: 30 * time.Second,
            },
        },
        {
            name:  "empty string uses defaults",
            input: `{}`,
            want: &parser.Config{
                Port:    8080,
                Timeout: 30 * time.Second,
            },
        },
    }

    for _, tc := range tests {
        tc := tc // Capture for parallel subtests
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()

            got, err := parser.ParseConfig(tc.input)

            // Error assertion
            if tc.wantErr != nil {
                if err == nil {
                    t.Fatalf("ParseConfig(%q) = nil error, want %v", tc.input, tc.wantErr)
                }
                if !errors.Is(err, tc.wantErr) {
                    t.Fatalf("ParseConfig(%q) error = %v, want %v", tc.input, err, tc.wantErr)
                }
                return
            }
            if err != nil {
                t.Fatalf("ParseConfig(%q) unexpected error: %v", tc.input, err)
            }

            // Value assertion using comparison helper
            if got.Port != tc.want.Port {
                t.Errorf("Port = %d, want %d", got.Port, tc.want.Port)
            }
            if got.Timeout != tc.want.Timeout {
                t.Errorf("Timeout = %v, want %v", got.Timeout, tc.want.Timeout)
            }
            if tc.want.LogLevel != "" && got.LogLevel != tc.want.LogLevel {
                t.Errorf("LogLevel = %q, want %q", got.LogLevel, tc.want.LogLevel)
            }
        })
    }
}
```

### Advanced Table-Driven Patterns: Test Fixtures and Setup

For tests that require setup and teardown per test case:

```go
package integration_test

import (
    "context"
    "database/sql"
    "testing"
    "time"

    "github.com/example/myapp/store"
)

type userStoreTestCase struct {
    name    string
    setup   func(t *testing.T, db *sql.DB) // Per-test setup
    action  func(t *testing.T, s *store.UserStore) (interface{}, error)
    verify  func(t *testing.T, result interface{}, err error)
    cleanup func(t *testing.T, db *sql.DB) // Per-test cleanup
}

func TestUserStore(t *testing.T) {
    // Shared setup: one DB per test function
    db := setupTestDatabase(t)

    tests := []userStoreTestCase{
        {
            name: "create user succeeds with valid data",
            setup: func(t *testing.T, db *sql.DB) {
                // Ensure table is empty for this test
                db.ExecContext(context.Background(), "DELETE FROM users")
            },
            action: func(t *testing.T, s *store.UserStore) (interface{}, error) {
                return s.Create(context.Background(), &store.User{
                    Name:  "Alice",
                    Email: "alice@example.com",
                })
            },
            verify: func(t *testing.T, result interface{}, err error) {
                if err != nil {
                    t.Fatalf("Create failed: %v", err)
                }
                user := result.(*store.User)
                if user.ID == 0 {
                    t.Error("expected non-zero ID after creation")
                }
                if user.CreatedAt.IsZero() {
                    t.Error("expected CreatedAt to be set")
                }
            },
        },
        {
            name: "duplicate email returns ErrDuplicate",
            setup: func(t *testing.T, db *sql.DB) {
                db.ExecContext(context.Background(), "DELETE FROM users")
                db.ExecContext(context.Background(),
                    "INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com')")
            },
            action: func(t *testing.T, s *store.UserStore) (interface{}, error) {
                return s.Create(context.Background(), &store.User{
                    Name:  "Bob2",
                    Email: "bob@example.com", // Duplicate
                })
            },
            verify: func(t *testing.T, result interface{}, err error) {
                if !errors.Is(err, store.ErrDuplicate) {
                    t.Errorf("expected ErrDuplicate, got %v", err)
                }
            },
        },
        {
            name: "find non-existent user returns nil",
            action: func(t *testing.T, s *store.UserStore) (interface{}, error) {
                return s.FindByID(context.Background(), 99999)
            },
            verify: func(t *testing.T, result interface{}, err error) {
                if err != nil {
                    t.Fatalf("unexpected error: %v", err)
                }
                if result != nil {
                    t.Errorf("expected nil result for non-existent user, got %v", result)
                }
            },
        },
    }

    for _, tc := range tests {
        tc := tc
        t.Run(tc.name, func(t *testing.T) {
            // Not parallel - integration tests with shared DB are often sequential
            if tc.setup != nil {
                tc.setup(t, db)
            }
            if tc.cleanup != nil {
                t.Cleanup(func() { tc.cleanup(t, db) })
            }

            s := store.NewUserStore(db)
            result, err := tc.action(t, s)
            tc.verify(t, result, err)
        })
    }
}

func setupTestDatabase(t *testing.T) *sql.DB {
    t.Helper()
    db, err := sql.Open("pgx", "postgres://test:test@localhost:5432/testdb?sslmode=disable")
    if err != nil {
        t.Fatalf("opening test database: %v", err)
    }
    t.Cleanup(func() { db.Close() })

    // Run migrations
    if err := runMigrations(db); err != nil {
        t.Fatalf("running migrations: %v", err)
    }
    return db
}
```

### Parameterized Sub-Benchmarks

Table-driven patterns apply to benchmarks too:

```go
func BenchmarkParser(b *testing.B) {
    cases := []struct {
        name  string
        input []byte
        size  string
    }{
        {"small", generateConfig(10), "10 fields"},
        {"medium", generateConfig(100), "100 fields"},
        {"large", generateConfig(1000), "1000 fields"},
    }

    for _, bc := range cases {
        bc := bc
        b.Run(bc.size, func(b *testing.B) {
            b.ReportAllocs()
            b.SetBytes(int64(len(bc.input)))
            b.ResetTimer()
            for i := 0; i < b.N; i++ {
                _, err := parser.Parse(bc.input)
                if err != nil {
                    b.Fatal(err)
                }
            }
        })
    }
}
```

## Golden File Testing

Golden files store expected outputs in separate files, making them easy to inspect, diff, and update when behavior intentionally changes. This pattern is essential for testing complex output like generated code, HTML rendering, JSON serialization of complex structures, or SQL query generation.

### Basic Golden File Helper

```go
// testutil/golden.go
package testutil

import (
    "flag"
    "os"
    "path/filepath"
    "testing"
)

// update flag: run tests with -update to regenerate golden files
var update = flag.Bool("update", false, "update golden files")

// GoldenFile manages golden file comparison for tests
type GoldenFile struct {
    t    *testing.T
    dir  string
}

// NewGoldenFile creates a GoldenFile helper rooted at dir
func NewGoldenFile(t *testing.T, dir string) *GoldenFile {
    t.Helper()
    return &GoldenFile{t: t, dir: dir}
}

// Assert compares content against the golden file named after name.
// If -update flag is set, the golden file is written with content.
func (g *GoldenFile) Assert(name string, content []byte) {
    g.t.Helper()

    path := filepath.Join(g.dir, name+".golden")

    if *update {
        if err := os.MkdirAll(g.dir, 0755); err != nil {
            g.t.Fatalf("creating golden dir %s: %v", g.dir, err)
        }
        if err := os.WriteFile(path, content, 0644); err != nil {
            g.t.Fatalf("writing golden file %s: %v", path, err)
        }
        g.t.Logf("updated golden file: %s", path)
        return
    }

    golden, err := os.ReadFile(path)
    if err != nil {
        if os.IsNotExist(err) {
            g.t.Fatalf("golden file %s does not exist. Run with -update to create it", path)
        }
        g.t.Fatalf("reading golden file %s: %v", path, err)
    }

    if string(golden) != string(content) {
        g.t.Errorf("output differs from golden file %s\n"+
            "Run with -update to regenerate.\n\n"+
            "diff:\n%s",
            path,
            diff(string(golden), string(content)),
        )
    }
}

// diff produces a human-readable diff between two strings
func diff(expected, actual string) string {
    // Simple line-by-line diff
    expectedLines := strings.Split(expected, "\n")
    actualLines := strings.Split(actual, "\n")

    var result strings.Builder
    maxLen := len(expectedLines)
    if len(actualLines) > maxLen {
        maxLen = len(actualLines)
    }

    for i := 0; i < maxLen; i++ {
        var expLine, actLine string
        if i < len(expectedLines) {
            expLine = expectedLines[i]
        }
        if i < len(actualLines) {
            actLine = actualLines[i]
        }
        if expLine != actLine {
            result.WriteString(fmt.Sprintf("line %d:\n  - %q\n  + %q\n", i+1, expLine, actLine))
        }
    }
    return result.String()
}
```

### Using Golden Files for Code Generation Tests

```go
// generator/generator_test.go
package generator_test

import (
    "testing"

    "github.com/example/myapp/generator"
    "github.com/example/myapp/testutil"
)

func TestCodeGenerator(t *testing.T) {
    t.Parallel()

    gf := testutil.NewGoldenFile(t, "testdata/golden")

    tests := []struct {
        name   string
        schema *generator.Schema
    }{
        {
            name: "simple_struct",
            schema: &generator.Schema{
                Name: "User",
                Fields: []generator.Field{
                    {Name: "ID", Type: "int64", Tags: map[string]string{"json": "id", "db": "id"}},
                    {Name: "Name", Type: "string", Tags: map[string]string{"json": "name", "db": "name"}},
                    {Name: "Email", Type: "string", Tags: map[string]string{"json": "email", "db": "email"}},
                },
            },
        },
        {
            name: "struct_with_relationships",
            schema: &generator.Schema{
                Name: "Order",
                Fields: []generator.Field{
                    {Name: "ID", Type: "int64"},
                    {Name: "UserID", Type: "int64", Relationship: &generator.Relationship{
                        Type:       "belongs_to",
                        ForeignKey: "user_id",
                        TargetType: "User",
                    }},
                    {Name: "Items", Type: "[]OrderItem", Relationship: &generator.Relationship{
                        Type:       "has_many",
                        ForeignKey: "order_id",
                        TargetType: "OrderItem",
                    }},
                },
            },
        },
        {
            name: "struct_with_validations",
            schema: &generator.Schema{
                Name: "Product",
                Fields: []generator.Field{
                    {Name: "Name", Type: "string", Validations: []string{"required", "min=1", "max=255"}},
                    {Name: "Price", Type: "float64", Validations: []string{"required", "min=0"}},
                    {Name: "SKU", Type: "string", Validations: []string{"required", "alphanum"}},
                },
            },
        },
    }

    for _, tc := range tests {
        tc := tc
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()

            got, err := generator.Generate(tc.schema)
            if err != nil {
                t.Fatalf("Generate failed: %v", err)
            }

            gf.Assert(tc.name, got)
        })
    }
}
```

```
# testdata/golden/simple_struct.golden
// Code generated by generator. DO NOT EDIT.

package models

import "time"

// User represents a user record.
type User struct {
    ID    int64  `json:"id" db:"id"`
    Name  string `json:"name" db:"name"`
    Email string `json:"email" db:"email"`
}

// UserRepository provides database access for User.
type UserRepository struct {
    db *sql.DB
}
```

```bash
# Update all golden files when intentional changes are made
go test ./generator/... -update

# Run tests normally (no -update flag)
go test ./generator/...

# On CI, never pass -update; failing golden tests indicate
# unexpected output changes that need review
```

### JSON Golden Files with Normalization

When testing JSON output, normalization ensures deterministic comparison:

```go
// testutil/json_golden.go
package testutil

import (
    "bytes"
    "encoding/json"
    "testing"
)

// AssertJSONGolden normalizes and compares JSON output against a golden file
func (g *GoldenFile) AssertJSON(name string, v interface{}) {
    g.t.Helper()

    // Marshal with sorted keys and indentation for human-readable diffs
    raw, err := json.Marshal(v)
    if err != nil {
        g.t.Fatalf("marshaling value: %v", err)
    }

    // Normalize: unmarshal and re-marshal with indent
    var normalized interface{}
    if err := json.Unmarshal(raw, &normalized); err != nil {
        g.t.Fatalf("normalizing JSON: %v", err)
    }

    var buf bytes.Buffer
    enc := json.NewEncoder(&buf)
    enc.SetIndent("", "  ")
    enc.SetEscapeHTML(false)
    if err := enc.Encode(normalized); err != nil {
        g.t.Fatalf("encoding normalized JSON: %v", err)
    }

    g.Assert(name+".json", buf.Bytes())
}

// Usage in tests:
// gf.AssertJSON("api_response", responseStruct)
```

## Property-Based Testing with pgregory.net/rapid

Property-based testing (PBT) generates random inputs and verifies that properties (invariants) hold for all of them. Where table-driven tests verify specific cases, PBT finds edge cases you didn't anticipate.

### Installation and Basic Concepts

```bash
go get pgregory.net/rapid@latest
```

The key concepts in rapid:
- **Generator (`*rapid.T`)**: Generates random values with `rapid.Int()`, `rapid.StringOf()`, etc.
- **Property**: A function that must be true for all generated inputs
- **Shrinking**: When a failure is found, rapid automatically finds the minimal failing case

```go
package parser_test

import (
    "testing"
    "unicode"

    "pgregory.net/rapid"
)

// Property: parsing a valid config and re-serializing produces equivalent output
func TestParseRoundTrip(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        // Generate a random valid config
        cfg := rapid.Custom[*parser.Config](func(t *rapid.T) *parser.Config {
            return &parser.Config{
                Port:    rapid.IntRange(1, 65535).Draw(t, "port"),
                Workers: rapid.IntRange(1, 100).Draw(t, "workers"),
                LogLevel: rapid.SampledFrom([]string{
                    "debug", "info", "warn", "error",
                }).Draw(t, "log_level"),
            }
        }).Draw(t, "config")

        // Serialize to JSON
        data, err := json.Marshal(cfg)
        if err != nil {
            t.Fatalf("marshaling: %v", err)
        }

        // Parse back
        cfg2, err := parser.ParseConfig(string(data))
        if err != nil {
            t.Fatalf("ParseConfig(%q): %v", data, err)
        }

        // Property: round-trip must be lossless
        if cfg.Port != cfg2.Port {
            t.Fatalf("Port: %d != %d", cfg.Port, cfg2.Port)
        }
        if cfg.Workers != cfg2.Workers {
            t.Fatalf("Workers: %d != %d", cfg.Workers, cfg2.Workers)
        }
        if cfg.LogLevel != cfg2.LogLevel {
            t.Fatalf("LogLevel: %q != %q", cfg.LogLevel, cfg2.LogLevel)
        }
    })
}
```

### Custom Generators

For complex domain types, write custom generators that produce only valid inputs:

```go
package store_test

import (
    "testing"
    "time"
    "unicode"

    "pgregory.net/rapid"

    "github.com/example/myapp/store"
)

// validEmail generates syntactically valid email addresses
var validEmail = rapid.Custom[string](func(t *rapid.T) string {
    // Generate local part: letters and digits only (simplified)
    localLen := rapid.IntRange(1, 20).Draw(t, "local_len")
    localParts := make([]rune, localLen)
    for i := range localParts {
        localParts[i] = rapid.RuneFrom(nil, unicode.Letter, unicode.Digit).Draw(t, "local_char")
    }
    local := string(localParts)

    domain := rapid.SampledFrom([]string{
        "example.com", "test.org", "acme.io", "company.net",
    }).Draw(t, "domain")

    return local + "@" + domain
})

// validUser generates a valid User struct
var validUser = rapid.Custom[*store.User](func(t *rapid.T) *store.User {
    return &store.User{
        Name:  rapid.StringMatching(`[A-Za-z][A-Za-z0-9 ]{1,49}`).Draw(t, "name"),
        Email: validEmail.Draw(t, "email"),
        Age:   rapid.IntRange(13, 120).Draw(t, "age"),
    }
})

// Property: a freshly created user can always be retrieved by ID
func TestUserCreateThenFindByID(t *testing.T) {
    db := setupTestDatabase(t)
    s := store.NewUserStore(db)

    rapid.Check(t, func(t *rapid.T) {
        ctx := context.Background()
        user := validUser.Draw(t, "user")

        // Clean slate for each check
        db.ExecContext(ctx, "DELETE FROM users")

        // Create
        created, err := s.Create(ctx, user)
        if err != nil {
            t.Fatalf("Create(%v): %v", user, err)
        }

        // Property: created ID must be positive
        if created.ID <= 0 {
            t.Fatalf("expected positive ID, got %d", created.ID)
        }

        // Property: can always find by ID
        found, err := s.FindByID(ctx, created.ID)
        if err != nil {
            t.Fatalf("FindByID(%d): %v", created.ID, err)
        }
        if found == nil {
            t.Fatalf("FindByID(%d) returned nil for just-created user", created.ID)
        }

        // Property: retrieved data matches what was stored
        if found.Name != user.Name {
            t.Fatalf("Name mismatch: created %q, retrieved %q", user.Name, found.Name)
        }
        if found.Email != user.Email {
            t.Fatalf("Email mismatch: created %q, retrieved %q", user.Email, found.Email)
        }
    })
}
```

### Testing Encoding/Decoding Invariants

PBT excels at finding encoding bugs through round-trip properties:

```go
// Property-based tests for a custom binary codec
func TestCodecRoundTrip(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        // Generate a random message
        msg := &codec.Message{
            ID:      rapid.Uint64().Draw(t, "id"),
            Version: rapid.Byte().Draw(t, "version"),
            Payload: rapid.SliceOfN(rapid.Byte(), 0, 65535).Draw(t, "payload"),
            Tags:    rapid.MapOf(
                rapid.StringMatching(`[a-z]{1,32}`),
                rapid.StringMatching(`[a-z0-9_-]{1,64}`),
            ).Draw(t, "tags"),
        }

        // Encode
        encoded, err := codec.Encode(msg)
        if err != nil {
            // If encoding fails, that's a bug
            t.Fatalf("Encode(%v): %v", msg, err)
        }

        // Property: encoded length must be reasonable
        if len(encoded) == 0 {
            t.Fatal("encoded length must not be zero")
        }
        // Upper bound: header (16) + payload + tags (generous estimate)
        maxExpected := 16 + len(msg.Payload) + len(msg.Tags)*200
        if len(encoded) > maxExpected {
            t.Fatalf("encoded too large: %d > %d", len(encoded), maxExpected)
        }

        // Decode
        decoded, err := codec.Decode(encoded)
        if err != nil {
            t.Fatalf("Decode after Encode: %v (encoded: %x)", err, encoded)
        }

        // Property: ID must survive round-trip exactly
        if decoded.ID != msg.ID {
            t.Fatalf("ID: encoded %d, decoded %d", msg.ID, decoded.ID)
        }

        // Property: Payload must survive round-trip exactly
        if !bytes.Equal(decoded.Payload, msg.Payload) {
            t.Fatalf("Payload mismatch: sent %d bytes, received %d bytes",
                len(msg.Payload), len(decoded.Payload))
        }

        // Property: all tags must survive round-trip
        for k, v := range msg.Tags {
            if decoded.Tags[k] != v {
                t.Fatalf("Tag %q: encoded %q, decoded %q", k, v, decoded.Tags[k])
            }
        }
    })
}
```

### Stateful Property-Based Testing

rapid supports stateful (model-based) testing where you build a sequence of operations and verify that your implementation matches a reference model:

```go
package cache_test

import (
    "testing"

    "pgregory.net/rapid"

    "github.com/example/myapp/cache"
)

// referenceCache is a simple map-based implementation that serves as the oracle
type referenceCache map[string]string

type cacheStateMachine struct {
    // System under test
    cache *cache.LRUCache

    // Reference implementation (must be correct by inspection)
    ref referenceCache

    // Track capacity to verify eviction
    capacity int
    order    []string // insertion order for LRU verification
}

// Initial state
func (m *cacheStateMachine) Init(t *rapid.T) {
    m.capacity = rapid.IntRange(1, 10).Draw(t, "capacity")
    m.cache = cache.NewLRU(m.capacity)
    m.ref = make(referenceCache)
    m.order = nil
}

// Operation: Set
func (m *cacheStateMachine) Set(t *rapid.T) {
    key := rapid.StringMatching(`[a-z]{1,5}`).Draw(t, "key")
    value := rapid.StringMatching(`[A-Za-z0-9]{1,20}`).Draw(t, "value")

    m.cache.Set(key, value)
    m.ref[key] = value

    // Track order for LRU eviction verification
    for i, k := range m.order {
        if k == key {
            m.order = append(m.order[:i], m.order[i+1:]...)
            break
        }
    }
    m.order = append(m.order, key)

    // Apply LRU eviction to reference if over capacity
    for len(m.order) > m.capacity {
        evicted := m.order[0]
        m.order = m.order[1:]
        delete(m.ref, evicted)
    }
}

// Operation: Get
func (m *cacheStateMachine) Get(t *rapid.T) {
    key := rapid.StringMatching(`[a-z]{1,5}`).Draw(t, "key")

    got, ok := m.cache.Get(key)
    refVal, refOK := m.ref[key]

    // Property: presence must agree with reference
    if ok != refOK {
        t.Fatalf("Get(%q): cache.ok=%v, ref.ok=%v", key, ok, refOK)
    }

    // Property: if present, values must agree
    if ok && got != refVal {
        t.Fatalf("Get(%q): cache=%q, ref=%q", key, got, refVal)
    }
}

// Operation: Delete
func (m *cacheStateMachine) Delete(t *rapid.T) {
    key := rapid.StringMatching(`[a-z]{1,5}`).Draw(t, "key")

    m.cache.Delete(key)
    delete(m.ref, key)
    for i, k := range m.order {
        if k == key {
            m.order = append(m.order[:i], m.order[i+1:]...)
            break
        }
    }
}

// Check is called after every sequence of operations
func (m *cacheStateMachine) Check(t *rapid.T) {
    // Property: cache size must match reference
    if m.cache.Len() != len(m.ref) {
        t.Fatalf("cache.Len()=%d, ref.Len()=%d", m.cache.Len(), len(m.ref))
    }
}

func TestLRUCacheStateMachine(t *testing.T) {
    rapid.Check(t, rapid.StateMachineActions(&cacheStateMachine{}))
}
```

### rapid Configuration for CI

```go
// In CI, run more iterations to find more bugs
func TestWithMoreIterations(t *testing.T) {
    // Increase iterations for expensive-to-run property tests
    rapid.Check(t, func(t *rapid.T) {
        // ... test body
    }, rapid.Settings{
        Steps:      1000,  // Default is 100
        Seed:       0,     // 0 = use random seed
        MaxShrinks: 100,   // Maximum shrinking steps
    })
}

// To reproduce a specific failure, use the seed printed on failure
// Example: rapid: trying seed 0x1a2b3c4d5e6f
func TestReproduceFailing(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        // ... test body
    }, rapid.Settings{
        Seed: 0x1a2b3c4d5e6f,  // Reproduces the specific failure
    })
}
```

## Testing Helpers and Utilities

### testify-free Assertion Helpers

```go
// testutil/assert.go
package testutil

import (
    "fmt"
    "reflect"
    "testing"
)

// Equal fails the test if got != want using deep equality
func Equal(t *testing.T, got, want interface{}) {
    t.Helper()
    if !reflect.DeepEqual(got, want) {
        t.Errorf("got %v, want %v", got, want)
    }
}

// NoError fails the test if err != nil
func NoError(t *testing.T, err error) {
    t.Helper()
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
}

// ErrorIs fails if !errors.Is(err, target)
func ErrorIs(t *testing.T, err, target error) {
    t.Helper()
    if !errors.Is(err, target) {
        t.Fatalf("error %v does not match target %v", err, target)
    }
}

// Contains fails if the string s does not contain substr
func Contains(t *testing.T, s, substr string) {
    t.Helper()
    if !strings.Contains(s, substr) {
        t.Errorf("%q does not contain %q", s, substr)
    }
}

// Eventually retries assertion until it passes or timeout expires
func Eventually(t *testing.T, condition func() bool, timeout, tick time.Duration, msg string) {
    t.Helper()
    deadline := time.Now().Add(timeout)
    for time.Now().Before(deadline) {
        if condition() {
            return
        }
        time.Sleep(tick)
    }
    t.Fatalf("condition not met within %v: %s", timeout, msg)
}
```

### Faking External Dependencies

```go
// testutil/fakes.go - HTTP server for testing external API calls
package testutil

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"
)

// FakeHTTPServer builds a test HTTP server with canned responses
type FakeHTTPServer struct {
    *httptest.Server
    responses map[string]FakeResponse
    calls     []RecordedCall
}

type FakeResponse struct {
    StatusCode int
    Body       interface{}
    Headers    map[string]string
}

type RecordedCall struct {
    Method string
    Path   string
    Body   []byte
}

func NewFakeHTTPServer(t *testing.T, responses map[string]FakeResponse) *FakeHTTPServer {
    f := &FakeHTTPServer{responses: responses}

    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        resp, ok := responses[r.URL.Path]
        if !ok {
            t.Errorf("unexpected request to %s %s", r.Method, r.URL.Path)
            http.Error(w, "not found", http.StatusNotFound)
            return
        }

        // Record the call
        body := make([]byte, 0)
        if r.Body != nil {
            body, _ = io.ReadAll(r.Body)
        }
        f.calls = append(f.calls, RecordedCall{
            Method: r.Method,
            Path:   r.URL.Path,
            Body:   body,
        })

        for k, v := range resp.Headers {
            w.Header().Set(k, v)
        }
        w.WriteHeader(resp.StatusCode)
        if resp.Body != nil {
            json.NewEncoder(w).Encode(resp.Body)
        }
    })

    f.Server = httptest.NewServer(mux)
    t.Cleanup(f.Server.Close)
    return f
}

func (f *FakeHTTPServer) Calls() []RecordedCall {
    return f.calls
}

func (f *FakeHTTPServer) CallCount(path string) int {
    count := 0
    for _, c := range f.calls {
        if c.Path == path {
            count++
        }
    }
    return count
}

// Usage:
// server := testutil.NewFakeHTTPServer(t, map[string]testutil.FakeResponse{
//     "/api/users": {StatusCode: 200, Body: []User{{ID: 1, Name: "Alice"}}},
// })
// client := NewAPIClient(server.URL)
// users, err := client.ListUsers(ctx)
// if server.CallCount("/api/users") != 1 { ... }
```

## Key Takeaways

Go's testing ecosystem rewards investment in test infrastructure that enables fast, reliable, and comprehensive verification. The key principles for production-quality Go testing are:

1. Table-driven tests should be the default for any function with more than 2-3 test cases — the `tc := tc` capture is required before Go 1.22 for parallel subtests, but can be omitted in 1.22+ with the fixed loop variable semantics
2. Golden files should be committed to version control alongside source code — they serve as documentation of expected behavior and make diffs of output changes visible in code review
3. Always run `go test -update` before committing to regenerate golden files after intentional changes, then review the diff in the golden files as part of the PR
4. Property-based testing with rapid is most valuable for pure functions with well-defined mathematical properties (codecs, parsers, data structures, algorithms) and for finding edge cases in complex state machines
5. The `rapid.StateMachineActions` pattern should be your go-to for testing any mutable data structure or system with multiple operations — it finds sequences of operations that expose bugs that individual unit tests miss
6. Avoid global test state — each test case should be able to run in isolation, and `t.Cleanup` is the correct mechanism for cleanup (not defer directly in test functions, which runs before subtest cleanup)
7. Use `t.Helper()` in all assertion helper functions so that failure messages point to the calling test line, not the helper implementation
8. For CI pipelines, set `GOFLAGS=-count=1` to prevent test result caching, and consider `-race` for all non-benchmark tests to catch data races early
