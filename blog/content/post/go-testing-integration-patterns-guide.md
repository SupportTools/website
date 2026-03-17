---
title: "Go Integration Testing Patterns: Testcontainers, Real Databases, and HTTP Mocking"
date: 2028-02-03T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "Testcontainers", "PostgreSQL", "Integration Testing", "Benchmarks", "Fuzz Testing"]
categories: ["Go", "Testing", "Quality Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go integration testing patterns including testcontainers-go for PostgreSQL/Redis/Kafka, table-driven sub-tests, httptest.Server mocking, test parallelism, test fixtures, benchmarks, and fuzz testing with build tags."
more_link: "yes"
url: "/go-testing-integration-patterns-guide/"
---

Unit tests verify logic in isolation; integration tests verify behavior across real component boundaries. In Go, the gap between unit and integration tests is frequently bridged by mocks, but mocks are wrong in subtle ways — they do not exercise connection pooling, query planning, serialization edge cases, or network protocol details. Testcontainers-go solves this by spinning up real Docker containers for PostgreSQL, Redis, Kafka, and other dependencies within the test process, with automatic lifecycle management and parallel-safe container isolation.

<!--more-->

# Go Integration Testing Patterns: Testcontainers, Real Databases, and HTTP Mocking

## Build Tags for Integration Tests

Integration tests require Docker and take longer than unit tests. Use build tags to keep them separate from the unit test suite.

```go
//go:build integration
// +build integration

// This file will only be compiled when the integration build tag is present.
// Run unit tests: go test ./...
// Run integration tests: go test -tags integration ./...
// Run all tests: go test -tags integration ./... (and run unit tests too)
```

### Directory Structure

```
.
├── internal/
│   ├── store/
│   │   ├── user_store.go
│   │   ├── user_store_test.go          # Unit tests (no tag)
│   │   └── user_store_integration_test.go  # Integration tests (build tag)
│   └── cache/
│       ├── redis_cache.go
│       └── redis_cache_integration_test.go
├── pkg/
│   └── messaging/
│       ├── kafka_producer.go
│       └── kafka_producer_integration_test.go
└── testutil/
    ├── containers.go    # Shared container setup helpers
    └── fixtures.go      # Test data factories
```

## Testcontainers-go Setup

### PostgreSQL Container

```go
// testutil/containers.go
//go:build integration

package testutil

import (
    "context"
    "database/sql"
    "fmt"
    "testing"
    "time"

    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
    "github.com/testcontainers/testcontainers-go/wait"
    _ "github.com/lib/pq"  // PostgreSQL driver
)

// PostgresContainer wraps a testcontainers postgres container with helpers.
type PostgresContainer struct {
    container *postgres.PostgresContainer
    DB        *sql.DB
    DSN       string
}

// NewPostgresContainer starts a PostgreSQL container for testing.
// The container is automatically cleaned up when the test ends via t.Cleanup.
func NewPostgresContainer(t *testing.T) *PostgresContainer {
    t.Helper()
    ctx := context.Background()

    // Start a PostgreSQL container with specific configuration
    pgContainer, err := postgres.RunContainer(ctx,
        testcontainers.WithImage("postgres:16.3-alpine"),
        // Set the database, user, and password
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("testuser"),
        postgres.WithPassword("testpassword"),
        // Wait until PostgreSQL accepts connections before returning
        testcontainers.WithWaitStrategy(
            wait.ForLog("database system is ready to accept connections").
                WithOccurrence(2).
                WithStartupTimeout(30*time.Second),
        ),
        // Initialize the schema on startup
        postgres.WithInitScripts("../../migrations/001_create_tables.sql"),
    )
    if err != nil {
        t.Fatalf("starting postgres container: %v", err)
    }

    // Register cleanup
    t.Cleanup(func() {
        if err := pgContainer.Terminate(ctx); err != nil {
            t.Logf("terminating postgres container: %v", err)
        }
    })

    // Get the connection string
    dsn, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
    if err != nil {
        t.Fatalf("getting postgres connection string: %v", err)
    }

    // Open a connection pool
    db, err := sql.Open("postgres", dsn)
    if err != nil {
        t.Fatalf("opening postgres connection: %v", err)
    }

    // Verify connectivity
    if err := db.PingContext(ctx); err != nil {
        t.Fatalf("pinging postgres: %v", err)
    }

    t.Cleanup(func() { db.Close() })

    return &PostgresContainer{
        container: pgContainer,
        DB:        db,
        DSN:       dsn,
    }
}

// Truncate deletes all rows from the specified tables.
// Use this to reset state between sub-tests.
func (pc *PostgresContainer) Truncate(t *testing.T, tables ...string) {
    t.Helper()
    for _, table := range tables {
        _, err := pc.DB.ExecContext(context.Background(),
            fmt.Sprintf("TRUNCATE TABLE %s CASCADE", table))
        if err != nil {
            t.Fatalf("truncating table %s: %v", table, err)
        }
    }
}
```

### Redis Container

```go
// testutil/redis_container.go
//go:build integration

package testutil

import (
    "context"
    "testing"
    "time"

    "github.com/redis/go-redis/v9"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/redis"
    "github.com/testcontainers/testcontainers-go/wait"
)

// RedisContainer wraps a testcontainers redis container.
type RedisContainer struct {
    container testcontainers.Container
    Client    *redis.Client
    Addr      string
}

// NewRedisContainer starts a Redis container for testing.
func NewRedisContainer(t *testing.T) *RedisContainer {
    t.Helper()
    ctx := context.Background()

    redisContainer, err := redis.RunContainer(ctx,
        testcontainers.WithImage("redis:7.2-alpine"),
        // Wait for Redis to be ready to accept connections
        testcontainers.WithWaitStrategy(
            wait.ForLog("Ready to accept connections").
                WithStartupTimeout(15*time.Second),
        ),
    )
    if err != nil {
        t.Fatalf("starting redis container: %v", err)
    }

    t.Cleanup(func() {
        redisContainer.Terminate(ctx)
    })

    addr, err := redisContainer.Endpoint(ctx, "")
    if err != nil {
        t.Fatalf("getting redis address: %v", err)
    }

    client := redis.NewClient(&redis.Options{
        Addr: addr,
    })

    if err := client.Ping(ctx).Err(); err != nil {
        t.Fatalf("pinging redis: %v", err)
    }

    t.Cleanup(func() { client.Close() })

    return &RedisContainer{
        Client: client,
        Addr:   addr,
    }
}
```

### Kafka Container

```go
// testutil/kafka_container.go
//go:build integration

package testutil

import (
    "context"
    "testing"
    "time"

    "github.com/testcontainers/testcontainers-go/modules/kafka"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/wait"
)

// KafkaContainer wraps a testcontainers Kafka container.
type KafkaContainer struct {
    container *kafka.KafkaContainer
    Brokers   []string
}

// NewKafkaContainer starts a Kafka container using KRaft mode (no ZooKeeper).
func NewKafkaContainer(t *testing.T) *KafkaContainer {
    t.Helper()
    ctx := context.Background()

    kafkaContainer, err := kafka.RunContainer(ctx,
        testcontainers.WithImage("confluentinc/cp-kafka:7.6.0"),
        kafka.WithClusterID("test-cluster"),
        testcontainers.WithWaitStrategy(
            wait.ForLog("Kafka Server started").
                WithStartupTimeout(60*time.Second),
        ),
    )
    if err != nil {
        t.Fatalf("starting kafka container: %v", err)
    }

    t.Cleanup(func() {
        kafkaContainer.Terminate(ctx)
    })

    brokers, err := kafkaContainer.Brokers(ctx)
    if err != nil {
        t.Fatalf("getting kafka brokers: %v", err)
    }

    return &KafkaContainer{
        container: kafkaContainer,
        Brokers:   brokers,
    }
}
```

## Integration Test: User Store

```go
// internal/store/user_store_integration_test.go
//go:build integration

package store_test

import (
    "context"
    "testing"

    "github.com/my-org/myapp/internal/store"
    "github.com/my-org/myapp/testutil"
)

// TestUserStore_Integration tests the UserStore against a real PostgreSQL database.
// Each top-level test gets its own container; sub-tests share the container
// but isolate data via per-test transactions or table truncation.
func TestUserStore_Integration(t *testing.T) {
    // Start PostgreSQL once for all sub-tests in this test function
    // Containers are expensive to start; share them when possible
    pg := testutil.NewPostgresContainer(t)
    userStore := store.NewUserStore(pg.DB)

    // Run sub-tests sequentially (share container, reset data between tests)
    // Use t.Run for logical grouping even when not running in parallel
    t.Run("CreateAndFind", func(t *testing.T) {
        pg.Truncate(t, "users")
        ctx := context.Background()

        // Create a user
        user := &store.User{
            Email: "test@example.com",
            Name:  "Test User",
        }
        created, err := userStore.Create(ctx, user)
        if err != nil {
            t.Fatalf("creating user: %v", err)
        }
        if created.ID == 0 {
            t.Error("expected non-zero ID after create")
        }

        // Find the user
        found, err := userStore.FindByEmail(ctx, "test@example.com")
        if err != nil {
            t.Fatalf("finding user: %v", err)
        }
        if found.ID != created.ID {
            t.Errorf("expected ID %d, got %d", created.ID, found.ID)
        }
    })

    t.Run("UniqueEmailConstraint", func(t *testing.T) {
        pg.Truncate(t, "users")
        ctx := context.Background()

        user := &store.User{
            Email: "duplicate@example.com",
            Name:  "First User",
        }
        if _, err := userStore.Create(ctx, user); err != nil {
            t.Fatalf("creating first user: %v", err)
        }

        // Attempt to create a duplicate
        duplicate := &store.User{
            Email: "duplicate@example.com",
            Name:  "Second User",
        }
        _, err := userStore.Create(ctx, duplicate)
        if err == nil {
            t.Error("expected error for duplicate email, got nil")
        }
        // Verify it's specifically a duplicate key error
        if !store.IsUniqueViolation(err) {
            t.Errorf("expected unique violation error, got: %v", err)
        }
    })

    // Table-driven test for multiple update scenarios
    t.Run("UpdateUser", func(t *testing.T) {
        tests := []struct {
            name      string
            initial   store.User
            update    store.UserUpdate
            wantEmail string
            wantName  string
            wantErr   bool
        }{
            {
                name:    "UpdateName",
                initial: store.User{Email: "a@example.com", Name: "Old Name"},
                update:  store.UserUpdate{Name: stringPtr("New Name")},
                wantEmail: "a@example.com",
                wantName:  "New Name",
            },
            {
                name:    "UpdateEmailToExisting",
                initial: store.User{Email: "b@example.com", Name: "User B"},
                update:  store.UserUpdate{Email: stringPtr("a@example.com")},
                wantErr: true,
            },
            {
                name:    "UpdateBothFields",
                initial: store.User{Email: "c@example.com", Name: "User C"},
                update:  store.UserUpdate{
                    Email: stringPtr("c-new@example.com"),
                    Name:  stringPtr("User C Updated"),
                },
                wantEmail: "c-new@example.com",
                wantName:  "User C Updated",
            },
        }

        for _, tt := range tests {
            tt := tt // Capture loop variable
            t.Run(tt.name, func(t *testing.T) {
                pg.Truncate(t, "users")
                ctx := context.Background()

                // Create the initial user
                created, err := userStore.Create(ctx, &tt.initial)
                if err != nil {
                    t.Fatalf("creating initial user: %v", err)
                }

                // Apply the update
                updated, err := userStore.Update(ctx, created.ID, tt.update)

                if tt.wantErr {
                    if err == nil {
                        t.Error("expected error, got nil")
                    }
                    return
                }

                if err != nil {
                    t.Fatalf("unexpected error updating user: %v", err)
                }
                if updated.Email != tt.wantEmail {
                    t.Errorf("email: got %q, want %q", updated.Email, tt.wantEmail)
                }
                if updated.Name != tt.wantName {
                    t.Errorf("name: got %q, want %q", updated.Name, tt.wantName)
                }
            })
        }
    })
}

func stringPtr(s string) *string { return &s }
```

## Parallel Integration Tests

When integration tests are independent (different containers or different database schemas), they can run in parallel to reduce total test time.

```go
// internal/store/parallel_integration_test.go
//go:build integration

package store_test

import (
    "context"
    "testing"

    "github.com/my-org/myapp/internal/store"
    "github.com/my-org/myapp/testutil"
)

// TestUserStore_Parallel demonstrates parallel integration tests.
// Each parallel test gets its own PostgreSQL container.
// This is more resource-intensive but guarantees complete isolation.
func TestUserStore_Parallel(t *testing.T) {
    tests := []struct {
        name      string
        seedUsers []store.User
        query     string
        wantCount int
    }{
        {
            name:      "EmptyDatabase",
            query:     "active@example.com",
            wantCount: 0,
        },
        {
            name: "WithSeedData",
            seedUsers: []store.User{
                {Email: "user1@example.com", Name: "User 1"},
                {Email: "user2@example.com", Name: "User 2"},
            },
            query:     "user1@example.com",
            wantCount: 1,
        },
    }

    for _, tt := range tests {
        tt := tt // Capture loop variable for parallel execution
        t.Run(tt.name, func(t *testing.T) {
            // Mark this sub-test as parallel
            // All parallel sub-tests run concurrently
            t.Parallel()

            // Each parallel test gets its own container
            // This is safe because containers are isolated
            pg := testutil.NewPostgresContainer(t)
            userStore := store.NewUserStore(pg.DB)
            ctx := context.Background()

            // Seed test data
            for i := range tt.seedUsers {
                if _, err := userStore.Create(ctx, &tt.seedUsers[i]); err != nil {
                    t.Fatalf("seeding user: %v", err)
                }
            }

            // Execute the test
            results, err := userStore.SearchByEmail(ctx, tt.query)
            if err != nil {
                t.Fatalf("searching: %v", err)
            }
            if len(results) != tt.wantCount {
                t.Errorf("got %d results, want %d", len(results), tt.wantCount)
            }
        })
    }
}
```

## httptest.Server for External API Mocking

```go
// pkg/external/payment_client_test.go
package external_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/my-org/myapp/pkg/external"
)

// TestPaymentClient tests the payment client against an httptest server
// that simulates the payment gateway API.
func TestPaymentClient(t *testing.T) {
    tests := []struct {
        name           string
        amount         int64
        serverResponse func(w http.ResponseWriter, r *http.Request)
        wantErr        bool
        wantTransID    string
    }{
        {
            name:   "SuccessfulCharge",
            amount: 1000,
            serverResponse: func(w http.ResponseWriter, r *http.Request) {
                // Verify the request method and path
                if r.Method != http.MethodPost {
                    http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
                    return
                }
                // Verify the Authorization header
                if r.Header.Get("Authorization") == "" {
                    http.Error(w, "unauthorized", http.StatusUnauthorized)
                    return
                }
                w.Header().Set("Content-Type", "application/json")
                json.NewEncoder(w).Encode(map[string]string{
                    "transaction_id": "txn_abc123",
                    "status":         "succeeded",
                })
            },
            wantTransID: "txn_abc123",
        },
        {
            name:   "InsufficientFunds",
            amount: 999999,
            serverResponse: func(w http.ResponseWriter, r *http.Request) {
                w.WriteHeader(http.StatusPaymentRequired)
                json.NewEncoder(w).Encode(map[string]string{
                    "error": "insufficient_funds",
                    "code":  "card_declined",
                })
            },
            wantErr: true,
        },
        {
            name:   "GatewayTimeout",
            amount: 500,
            serverResponse: func(w http.ResponseWriter, r *http.Request) {
                // Simulate a gateway timeout
                w.WriteHeader(http.StatusGatewayTimeout)
            },
            wantErr: true,
        },
    }

    for _, tt := range tests {
        tt := tt
        t.Run(tt.name, func(t *testing.T) {
            // Start a test HTTP server
            server := httptest.NewTLSServer(http.HandlerFunc(tt.serverResponse))
            defer server.Close()

            // Create the payment client pointed at the test server
            // The test server's TLS cert is trusted via server.Client()
            client := external.NewPaymentClient(
                server.URL,
                "test-api-key",
                external.WithHTTPClient(server.Client()),
            )

            transID, err := client.Charge(tt.amount, "usd", "tok_test")

            if tt.wantErr {
                if err == nil {
                    t.Error("expected error, got nil")
                }
                return
            }

            if err != nil {
                t.Fatalf("unexpected error: %v", err)
            }
            if transID != tt.wantTransID {
                t.Errorf("transaction ID: got %q, want %q", transID, tt.wantTransID)
            }
        })
    }
}

// TestPaymentClient_RequestCapture demonstrates capturing and inspecting requests
func TestPaymentClient_RequestCapture(t *testing.T) {
    var capturedRequest *http.Request

    server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Capture the request for assertion after the call
        capturedRequest = r.Clone(r.Context())
        json.NewEncoder(w).Encode(map[string]string{"transaction_id": "txn_test"})
    }))
    defer server.Close()

    client := external.NewPaymentClient(server.URL, "my-api-key")
    client.Charge(1000, "usd", "tok_visa")

    // Assert on the captured request
    if capturedRequest == nil {
        t.Fatal("no request captured")
    }
    if capturedRequest.Header.Get("Authorization") != "Bearer my-api-key" {
        t.Errorf("wrong auth header: %q", capturedRequest.Header.Get("Authorization"))
    }
    if capturedRequest.Header.Get("Content-Type") != "application/json" {
        t.Errorf("wrong content type: %q", capturedRequest.Header.Get("Content-Type"))
    }
}
```

## Test Fixtures and Factories

```go
// testutil/fixtures.go
package testutil

import (
    "fmt"
    "math/rand"
    "time"

    "github.com/my-org/myapp/internal/domain"
)

// UserFactory creates User domain objects for testing with sensible defaults.
// Fields can be overridden via functional options.
type UserFactory struct {
    counter int
}

// UserOption is a functional option for UserFactory.
type UserOption func(*domain.User)

// WithEmail overrides the generated email address.
func WithEmail(email string) UserOption {
    return func(u *domain.User) {
        u.Email = email
    }
}

// WithRole sets the user's role.
func WithRole(role domain.Role) UserOption {
    return func(u *domain.User) {
        u.Role = role
    }
}

// Build creates a User with unique values and applies options.
func (f *UserFactory) Build(opts ...UserOption) *domain.User {
    f.counter++
    u := &domain.User{
        Email:     fmt.Sprintf("user-%d@example.com", f.counter),
        Name:      fmt.Sprintf("Test User %d", f.counter),
        Role:      domain.RoleUser,
        CreatedAt: time.Now().UTC(),
    }
    for _, opt := range opts {
        opt(u)
    }
    return u
}

// BuildN creates n users with unique values.
func (f *UserFactory) BuildN(n int, opts ...UserOption) []*domain.User {
    users := make([]*domain.User, n)
    for i := range users {
        users[i] = f.Build(opts...)
    }
    return users
}

// OrderFactory creates Order domain objects for testing.
type OrderFactory struct {
    counter int
}

// Build creates an Order with unique values.
func (f *OrderFactory) Build(userID int64, opts ...func(*domain.Order)) *domain.Order {
    f.counter++
    o := &domain.Order{
        UserID:    userID,
        Reference: fmt.Sprintf("ORD-%04d", f.counter),
        Total:     int64(rand.Intn(10000) + 100),  // 1.00 to 101.00 USD
        Currency:  "usd",
        Status:    domain.OrderStatusPending,
        CreatedAt: time.Now().UTC(),
    }
    for _, opt := range opts {
        opt(o)
    }
    return o
}

// Global factories for use in tests
var (
    Users  = &UserFactory{}
    Orders = &OrderFactory{}
)
```

## Benchmarks

```go
// internal/store/benchmarks_test.go
package store_test

import (
    "context"
    "testing"
)

// BenchmarkUserStore_Create measures the throughput of user creation.
// Run with: go test -bench=BenchmarkUserStore -benchmem -count=3
func BenchmarkUserStore_Create(b *testing.B) {
    pg := newTestDB(b)  // Reuse container setup from integration helpers
    store := NewUserStore(pg)
    ctx := context.Background()

    b.ReportAllocs()
    b.ResetTimer()

    for i := 0; i < b.N; i++ {
        user := &User{
            Email: fmt.Sprintf("bench-%d@example.com", i),
            Name:  "Benchmark User",
        }
        if _, err := store.Create(ctx, user); err != nil {
            b.Fatalf("create failed: %v", err)
        }
    }
}

// BenchmarkUserStore_FindByEmail measures lookup performance with an index.
func BenchmarkUserStore_FindByEmail(b *testing.B) {
    pg := newTestDB(b)
    s := NewUserStore(pg)
    ctx := context.Background()

    // Seed 10000 users
    for i := 0; i < 10000; i++ {
        s.Create(ctx, &User{
            Email: fmt.Sprintf("seed-%d@example.com", i),
            Name:  "Seed User",
        })
    }

    b.ReportAllocs()
    b.ResetTimer()

    for i := 0; i < b.N; i++ {
        // Query for a user in the middle of the dataset
        idx := i % 10000
        _, err := s.FindByEmail(ctx, fmt.Sprintf("seed-%d@example.com", idx))
        if err != nil {
            b.Fatalf("find failed: %v", err)
        }
    }
}

// BenchmarkJSONMarshaling measures JSON marshaling performance for the API response.
func BenchmarkJSONMarshaling(b *testing.B) {
    users := make([]User, 100)
    for i := range users {
        users[i] = User{
            ID:    int64(i),
            Email: fmt.Sprintf("user-%d@example.com", i),
            Name:  "Test User",
        }
    }

    b.ReportAllocs()
    b.ResetTimer()

    for i := 0; i < b.N; i++ {
        data, err := json.Marshal(users)
        if err != nil {
            b.Fatal(err)
        }
        // Prevent the compiler from optimizing away the result
        _ = data
    }
}
```

## Fuzz Testing

```go
// internal/parser/fuzz_test.go
package parser_test

import (
    "testing"
    "unicode/utf8"

    "github.com/my-org/myapp/internal/parser"
)

// FuzzParseUserInput discovers inputs that cause the parser to panic
// or produce invalid output.
// Run with: go test -fuzz=FuzzParseUserInput -fuzztime=30s
func FuzzParseUserInput(f *testing.F) {
    // Seed corpus: representative valid and edge-case inputs
    f.Add("simple input")
    f.Add("")
    f.Add("with spaces and punctuation: !@#$%")
    f.Add("unicode: 你好世界")
    f.Add("\x00\x01\x02")          // Null bytes
    f.Add("a" + string(make([]byte, 1000))) // Large input
    f.Add("<script>alert('xss')</script>")  // HTML injection attempt
    f.Add("'; DROP TABLE users; --")         // SQL injection attempt

    f.Fuzz(func(t *testing.T, input string) {
        // The fuzzer should never panic
        result, err := parser.ParseUserInput(input)

        // Invariants that must hold for any input:
        if err == nil {
            // Valid parse results must be valid UTF-8
            if !utf8.ValidString(result.Normalized) {
                t.Errorf("non-UTF8 result for input %q: %q",
                    input, result.Normalized)
            }

            // Normalized output must not be longer than input
            if len(result.Normalized) > len(input)*2 {
                t.Errorf("output much longer than input: input len=%d, output len=%d",
                    len(input), len(result.Normalized))
            }

            // Result must not contain null bytes
            for _, b := range []byte(result.Normalized) {
                if b == 0 {
                    t.Error("result contains null byte")
                    break
                }
            }
        }
    })
}

// FuzzParseJSON finds inputs that cause JSON parsing to fail unexpectedly.
// The parser should handle malformed JSON gracefully (return error, not panic).
func FuzzParseJSON(f *testing.F) {
    f.Add(`{"key": "value"}`)
    f.Add(`{}`)
    f.Add(`null`)
    f.Add(`{"nested": {"key": 123}}`)
    f.Add(`[1, 2, 3]`)

    f.Fuzz(func(t *testing.T, data []byte) {
        // ParseJSON must never panic, regardless of input
        // It should return an error for invalid JSON, not crash
        defer func() {
            if r := recover(); r != nil {
                t.Fatalf("ParseJSON panicked on input %q: %v", data, r)
            }
        }()

        result, err := parser.ParseJSON(data)
        if err != nil {
            // Error is acceptable for invalid input
            return
        }
        if result == nil {
            t.Error("nil result with nil error")
        }
    })
}
```

## Shared Test Database Setup with TestMain

```go
// internal/store/testmain_test.go
//go:build integration

package store_test

import (
    "database/sql"
    "fmt"
    "os"
    "testing"

    "github.com/my-org/myapp/testutil"
)

var testDB *sql.DB

// TestMain is the entry point for the test binary.
// It starts shared infrastructure once for the entire package.
func TestMain(m *testing.M) {
    // Start a shared PostgreSQL container for the entire test package.
    // This amortizes container startup time across all tests in the package.
    cleanup, db, err := testutil.SetupTestDatabase()
    if err != nil {
        fmt.Fprintf(os.Stderr, "setting up test database: %v\n", err)
        os.Exit(1)
    }
    testDB = db

    // Run all tests in this package
    code := m.Run()

    // Cleanup after all tests complete
    cleanup()

    os.Exit(code)
}

// newTestDB returns the shared test database for TestMain-based tests.
// This is more efficient than starting a new container per test.
func newTestDB(tb testing.TB) *sql.DB {
    tb.Helper()
    if testDB == nil {
        tb.Fatal("testDB is nil — did you call TestMain?")
    }
    return testDB
}
```

## Testing with Test Containers: Cache Integration Test

```go
// internal/cache/redis_cache_integration_test.go
//go:build integration

package cache_test

import (
    "context"
    "testing"
    "time"

    "github.com/my-org/myapp/internal/cache"
    "github.com/my-org/myapp/testutil"
)

func TestRedisCache_Integration(t *testing.T) {
    redis := testutil.NewRedisContainer(t)
    c := cache.NewRedisCache(redis.Client, cache.Options{
        DefaultTTL: 5 * time.Minute,
        KeyPrefix:  "test:",
    })
    ctx := context.Background()

    t.Run("SetAndGet", func(t *testing.T) {
        if err := c.Set(ctx, "key1", "value1", 0); err != nil {
            t.Fatalf("set: %v", err)
        }

        var got string
        found, err := c.Get(ctx, "key1", &got)
        if err != nil {
            t.Fatalf("get: %v", err)
        }
        if !found {
            t.Error("expected key to be found")
        }
        if got != "value1" {
            t.Errorf("got %q, want %q", got, "value1")
        }
    })

    t.Run("TTLExpiration", func(t *testing.T) {
        if err := c.Set(ctx, "expiring-key", "value", 100*time.Millisecond); err != nil {
            t.Fatalf("set: %v", err)
        }

        // Key should exist immediately
        var got string
        found, _ := c.Get(ctx, "expiring-key", &got)
        if !found {
            t.Error("key should exist before expiry")
        }

        // Wait for TTL to expire
        time.Sleep(200 * time.Millisecond)

        found, _ = c.Get(ctx, "expiring-key", &got)
        if found {
            t.Error("key should not exist after expiry")
        }
    })

    t.Run("Delete", func(t *testing.T) {
        c.Set(ctx, "to-delete", "value", 0)

        if err := c.Delete(ctx, "to-delete"); err != nil {
            t.Fatalf("delete: %v", err)
        }

        var got string
        found, _ := c.Get(ctx, "to-delete", &got)
        if found {
            t.Error("key should not exist after delete")
        }
    })
}
```

## Makefile Targets for Test Workflows

```makefile
# Makefile

# Run unit tests (fast, no external dependencies)
.PHONY: test
test:
    go test ./... -count=1 -timeout 60s

# Run integration tests (requires Docker)
.PHONY: test-integration
test-integration:
    go test -tags integration ./... -count=1 -timeout 300s -v

# Run tests with race detector
.PHONY: test-race
test-race:
    go test -race ./... -count=1 -timeout 120s

# Run benchmarks
.PHONY: bench
bench:
    go test -bench=. -benchmem -count=3 ./... | tee bench.txt
    benchstat bench.txt

# Run fuzz tests (30 seconds each)
.PHONY: fuzz
fuzz:
    go test -fuzz=FuzzParseUserInput -fuzztime=30s ./internal/parser/
    go test -fuzz=FuzzParseJSON -fuzztime=30s ./internal/parser/

# Generate coverage report
.PHONY: coverage
coverage:
    go test -coverprofile=coverage.out ./...
    go tool cover -html=coverage.out -o coverage.html
    go tool cover -func=coverage.out | tail -1

# Run all test types
.PHONY: test-all
test-all: test test-integration test-race
```

## Summary

Go integration testing with testcontainers-go provides the correctness guarantees of real dependencies without the operational complexity of maintaining shared test infrastructure. Each test gets a fresh container with known state, eliminating test pollution. Table-driven tests with sub-tests provide structured coverage of edge cases while keeping test code maintainable. Parallel test execution via `t.Parallel()` reduces total test time when tests can be isolated — either through separate containers or careful data scoping. `httptest.Server` enables precise control over external API behavior including error responses, slow responses, and malformed payloads. Benchmarks quantify performance regressions before they reach production. Fuzz testing finds input-handling bugs that no developer would think to write test cases for. The combination of these patterns, organized with build tags to separate fast unit tests from slower integration tests, provides confidence at every layer of the application stack.
