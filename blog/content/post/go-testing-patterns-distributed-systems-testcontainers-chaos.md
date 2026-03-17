---
title: "Go Testing Patterns for Distributed Systems: testcontainers-go, Network Simulation, Chaos Injection, and Golden File Testing"
date: 2031-12-29T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Testing", "testcontainers", "Chaos Engineering", "Distributed Systems", "Integration Testing"]
categories:
- Go
- Testing
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go testing strategies for distributed systems: using testcontainers-go for realistic integration tests, simulating network partitions and latency with toxiproxy, injecting chaos with fault injection middleware, and maintaining accuracy with golden file testing."
more_link: "yes"
url: "/go-testing-patterns-distributed-systems-testcontainers-chaos/"
---

Testing distributed systems requires more than unit tests and mocks. The bugs that cause production outages — timeout cascades, partial write failures, network partitions, schema drift — are precisely the ones that unit tests cannot catch. This guide builds a complete Go testing infrastructure for distributed systems: realistic integration tests with testcontainers-go, network fault injection with toxiproxy, chaos-in-process middleware for partial failure scenarios, and golden file testing for complex output verification.

<!--more-->

# Go Testing Patterns for Distributed Systems

## Section 1: The Testing Pyramid for Distributed Systems

The classic testing pyramid (unit > integration > end-to-end) needs adjustment for distributed systems:

```
                    ┌─────────────────┐
                    │   E2E Tests     │  ← Few, slow, flaky but realistic
                    │  (production-   │    Kubernetes-native environments
                    │   like env)     │
                    └────────┬────────┘
               ┌─────────────┴─────────────┐
               │   Integration Tests       │  ← testcontainers-go
               │   (real dependencies)     │    toxiproxy, chaos injection
               └─────────────┬─────────────┘
          ┌───────────────────┴───────────────────┐
          │            Component Tests            │  ← Mock external I/O
          │     (service + real data layer)       │    golden files
          └───────────────────┬───────────────────┘
     ┌──────────────────────────────────────────────────┐
     │                   Unit Tests                     │  ← Pure functions
     │           (pure logic, no I/O)                   │    table-driven
     └──────────────────────────────────────────────────┘
```

The integration layer is where the most value is for distributed systems. Real database behavior (constraint violations, deadlocks, replication lag) cannot be faithfully mocked.

## Section 2: testcontainers-go — Realistic Integration Tests

testcontainers-go provides a Go API for Docker, allowing tests to spin up real infrastructure containers and discard them after each test run.

### Installation and Setup

```bash
go get github.com/testcontainers/testcontainers-go@v0.31.0
go get github.com/testcontainers/testcontainers-go/modules/postgres
go get github.com/testcontainers/testcontainers-go/modules/redis
go get github.com/testcontainers/testcontainers-go/modules/kafka
go get github.com/testcontainers/testcontainers-go/modules/localstack
```

### Test Infrastructure Setup

Create a shared test infrastructure package:

```go
// internal/testutil/infrastructure.go
package testutil

import (
    "context"
    "database/sql"
    "fmt"
    "testing"
    "time"

    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
    "github.com/testcontainers/testcontainers-go/modules/redis"
    "github.com/testcontainers/testcontainers-go/wait"
    _ "github.com/lib/pq"
)

// TestInfrastructure holds all test containers for a test suite.
type TestInfrastructure struct {
    PostgresContainer *postgres.PostgresContainer
    RedisContainer    *redis.RedisContainer
    PostgresDSN       string
    RedisAddr         string
    DB                *sql.DB
}

// SetupTestInfrastructure creates all required containers for integration tests.
// It registers cleanup with t.Cleanup, so callers do not need to handle teardown.
func SetupTestInfrastructure(t *testing.T) *TestInfrastructure {
    t.Helper()
    ctx := context.Background()

    // Start PostgreSQL
    pgContainer, err := postgres.RunContainer(ctx,
        testcontainers.WithImage("postgres:16-alpine"),
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("testuser"),
        postgres.WithPassword("testpass"),
        testcontainers.WithWaitStrategy(
            wait.ForLog("database system is ready to accept connections").
                WithOccurrence(2).
                WithStartupTimeout(60*time.Second),
        ),
    )
    if err != nil {
        t.Fatalf("start postgres container: %v", err)
    }
    t.Cleanup(func() {
        if err := pgContainer.Terminate(ctx); err != nil {
            t.Logf("terminate postgres: %v", err)
        }
    })

    pgDSN, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
    if err != nil {
        t.Fatalf("get postgres connection string: %v", err)
    }

    // Apply schema migrations
    db, err := sql.Open("postgres", pgDSN)
    if err != nil {
        t.Fatalf("open postgres: %v", err)
    }
    t.Cleanup(func() { db.Close() })

    if err := applyMigrations(db); err != nil {
        t.Fatalf("apply migrations: %v", err)
    }

    // Start Redis
    redisContainer, err := redis.RunContainer(ctx,
        testcontainers.WithImage("redis:7-alpine"),
        testcontainers.WithWaitStrategy(
            wait.ForLog("Ready to accept connections").
                WithStartupTimeout(30*time.Second),
        ),
    )
    if err != nil {
        t.Fatalf("start redis container: %v", err)
    }
    t.Cleanup(func() {
        if err := redisContainer.Terminate(ctx); err != nil {
            t.Logf("terminate redis: %v", err)
        }
    })

    redisAddr, err := redisContainer.Endpoint(ctx, "")
    if err != nil {
        t.Fatalf("get redis endpoint: %v", err)
    }

    return &TestInfrastructure{
        PostgresContainer: pgContainer,
        RedisContainer:    redisContainer,
        PostgresDSN:       pgDSN,
        RedisAddr:         redisAddr,
        DB:                db,
    }
}

func applyMigrations(db *sql.DB) error {
    // Use golang-migrate or goose for schema migrations
    // Simple inline migration for the example:
    migrations := []string{
        `CREATE TABLE IF NOT EXISTS users (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email       TEXT NOT NULL UNIQUE,
            name        TEXT NOT NULL,
            status      INT2 NOT NULL DEFAULT 0,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS orders (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     UUID NOT NULL REFERENCES users(id),
            total       NUMERIC(12,2) NOT NULL,
            status      INT2 NOT NULL DEFAULT 0,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)`,
    }

    for _, migration := range migrations {
        if _, err := db.Exec(migration); err != nil {
            return fmt.Errorf("execute migration: %w", err)
        }
    }
    return nil
}
```

### Integration Test Example

```go
// internal/repository/user_repository_integration_test.go
package repository_test

import (
    "context"
    "testing"

    "github.com/google/uuid"
    "github.com/yourorg/yourapp/internal/domain"
    "github.com/yourorg/yourapp/internal/repository"
    "github.com/yourorg/yourapp/internal/testutil"
)

func TestUserRepository_Integration(t *testing.T) {
    if testing.Short() {
        t.Skip("Skipping integration test in short mode")
    }

    infra := testutil.SetupTestInfrastructure(t)
    repo := repository.NewUserRepository(infra.DB)
    ctx := context.Background()

    t.Run("create and retrieve user", func(t *testing.T) {
        user, err := repo.CreateUser(ctx, repository.CreateUserParams{
            Email: "alice@example.com",
            Name:  "Alice",
        })
        if err != nil {
            t.Fatalf("create user: %v", err)
        }
        if user.ID == uuid.Nil {
            t.Error("expected non-nil UUID")
        }
        if user.Email != "alice@example.com" {
            t.Errorf("email: got %q, want %q", user.Email, "alice@example.com")
        }

        got, err := repo.GetUser(ctx, user.ID)
        if err != nil {
            t.Fatalf("get user: %v", err)
        }
        if got.Email != user.Email {
            t.Errorf("retrieved user email mismatch: got %q, want %q", got.Email, user.Email)
        }
    })

    t.Run("unique email constraint violation", func(t *testing.T) {
        _, err := repo.CreateUser(ctx, repository.CreateUserParams{
            Email: "bob@example.com",
            Name:  "Bob",
        })
        if err != nil {
            t.Fatalf("create first user: %v", err)
        }

        _, err = repo.CreateUser(ctx, repository.CreateUserParams{
            Email: "bob@example.com",
            Name:  "Bob Duplicate",
        })
        if err == nil {
            t.Fatal("expected error for duplicate email, got nil")
        }

        // Verify the error is a domain-level duplicate error, not a raw pg error
        if !domain.IsConflictError(err) {
            t.Errorf("expected ConflictError, got: %T: %v", err, err)
        }
    })

    t.Run("list users with pagination", func(t *testing.T) {
        // Pre-populate test data
        for i := 0; i < 10; i++ {
            _, err := repo.CreateUser(ctx, repository.CreateUserParams{
                Email: fmt.Sprintf("user%d@example.com", i),
                Name:  fmt.Sprintf("User %d", i),
            })
            if err != nil {
                t.Fatalf("create user %d: %v", i, err)
            }
        }

        page1, count, err := repo.ListUsers(ctx, repository.ListUsersParams{
            Status: domain.StatusPending,
            Limit:  5,
            Offset: 0,
        })
        if err != nil {
            t.Fatalf("list users page 1: %v", err)
        }
        if len(page1) != 5 {
            t.Errorf("page 1: got %d users, want 5", len(page1))
        }
        if count < 10 {
            t.Errorf("total count: got %d, want >= 10", count)
        }
    })
}
```

### Kafka Integration Tests

```go
// internal/messaging/producer_test.go
package messaging_test

import (
    "context"
    "encoding/json"
    "testing"
    "time"

    "github.com/testcontainers/testcontainers-go/modules/kafka"
    "github.com/yourorg/yourapp/internal/messaging"
)

func TestOrderProducer_Integration(t *testing.T) {
    if testing.Short() {
        t.Skip("Skipping Kafka integration test")
    }

    ctx := context.Background()

    kafkaContainer, err := kafka.RunContainer(ctx,
        kafka.WithClusterID("test-cluster"),
        testcontainers.WithImage("confluentinc/cp-kafka:7.6.1"),
    )
    if err != nil {
        t.Fatalf("start kafka: %v", err)
    }
    t.Cleanup(func() { kafkaContainer.Terminate(ctx) })

    brokers, err := kafkaContainer.Brokers(ctx)
    if err != nil {
        t.Fatalf("get kafka brokers: %v", err)
    }

    producer, err := messaging.NewOrderProducer(messaging.ProducerConfig{
        Brokers: brokers,
        Topic:   "orders-events",
    })
    if err != nil {
        t.Fatalf("create producer: %v", err)
    }
    defer producer.Close()

    t.Run("produce and consume message", func(t *testing.T) {
        order := &messaging.OrderEvent{
            OrderID: "ord-001",
            UserID:  "usr-001",
            Total:   99.99,
            Status:  "pending",
        }

        if err := producer.PublishOrderEvent(ctx, order); err != nil {
            t.Fatalf("publish order event: %v", err)
        }

        // Create consumer to verify the message
        consumer, err := messaging.NewOrderConsumer(messaging.ConsumerConfig{
            Brokers: brokers,
            Topic:   "orders-events",
            GroupID: "test-consumer-group",
        })
        if err != nil {
            t.Fatalf("create consumer: %v", err)
        }
        defer consumer.Close()

        // Read with timeout
        msgCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
        defer cancel()

        received, err := consumer.ReadOne(msgCtx)
        if err != nil {
            t.Fatalf("read message: %v", err)
        }

        var got messaging.OrderEvent
        if err := json.Unmarshal(received.Value, &got); err != nil {
            t.Fatalf("unmarshal message: %v", err)
        }

        if got.OrderID != order.OrderID {
            t.Errorf("order ID: got %q, want %q", got.OrderID, order.OrderID)
        }
    })
}
```

## Section 3: Network Simulation with toxiproxy

toxiproxy is a TCP proxy that injects network faults: latency, bandwidth limits, packet loss, connection resets, and timeouts.

### Installing toxiproxy for Tests

```bash
go get github.com/Shopify/toxiproxy/v2/client@v2.9.0
```

### Test Helper for Network Simulation

```go
// internal/testutil/toxiproxy.go
package testutil

import (
    "context"
    "fmt"
    "testing"
    "time"

    toxiproxy "github.com/Shopify/toxiproxy/v2/client"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/wait"
)

// NetworkSimulator wraps toxiproxy for test-time network fault injection.
type NetworkSimulator struct {
    client      *toxiproxy.Client
    proxies     map[string]*toxiproxy.Proxy
    toxiContainer testcontainers.Container
}

// NewNetworkSimulator creates a toxiproxy container and client.
func NewNetworkSimulator(t *testing.T) *NetworkSimulator {
    t.Helper()
    ctx := context.Background()

    req := testcontainers.ContainerRequest{
        Image:        "ghcr.io/shopify/toxiproxy:2.9.0",
        ExposedPorts: []string{"8474/tcp"},
        WaitingFor: wait.ForHTTP("/version").
            WithPort("8474").
            WithStartupTimeout(30 * time.Second),
    }
    container, err := testcontainers.GenericContainer(ctx,
        testcontainers.GenericContainerRequest{
            ContainerRequest: req,
            Started:          true,
        },
    )
    if err != nil {
        t.Fatalf("start toxiproxy: %v", err)
    }
    t.Cleanup(func() { container.Terminate(ctx) })

    apiPort, err := container.MappedPort(ctx, "8474")
    if err != nil {
        t.Fatalf("get toxiproxy API port: %v", err)
    }

    apiHost, err := container.Host(ctx)
    if err != nil {
        t.Fatalf("get toxiproxy host: %v", err)
    }

    client := toxiproxy.NewClient(fmt.Sprintf("%s:%s", apiHost, apiPort.Port()))

    return &NetworkSimulator{
        client:        client,
        proxies:       make(map[string]*toxiproxy.Proxy),
        toxiContainer: container,
    }
}

// CreateProxy creates a TCP proxy from a local port to an upstream address.
func (ns *NetworkSimulator) CreateProxy(t *testing.T, name, upstream string) (localAddr string) {
    t.Helper()
    ctx := context.Background()

    host, err := ns.toxiContainer.Host(ctx)
    if err != nil {
        t.Fatalf("get toxiproxy host: %v", err)
    }

    proxy, err := ns.client.CreateProxy(name,
        fmt.Sprintf("0.0.0.0:0"),  // auto-assign port
        upstream,
    )
    if err != nil {
        t.Fatalf("create proxy %q: %v", name, err)
    }
    ns.proxies[name] = proxy

    // Get the assigned port
    p, err := ns.client.Proxy(name)
    if err != nil {
        t.Fatalf("get proxy %q: %v", name, err)
    }

    t.Cleanup(func() {
        if err := p.Delete(); err != nil {
            t.Logf("delete proxy %q: %v", name, err)
        }
    })

    return fmt.Sprintf("%s:%s", host, extractPort(p.Listen))
}

// AddLatency injects constant latency to a proxy.
func (ns *NetworkSimulator) AddLatency(t *testing.T, proxyName string, latencyMs, jitterMs int) {
    t.Helper()
    proxy := ns.proxies[proxyName]

    _, err := proxy.AddToxic("latency", "latency", "downstream", 1.0,
        toxiproxy.Attributes{
            "latency": latencyMs,
            "jitter":  jitterMs,
        },
    )
    if err != nil {
        t.Fatalf("add latency toxic to %q: %v", proxyName, err)
    }
    t.Cleanup(func() {
        proxy.RemoveToxic("latency")
    })
}

// AddBandwidthLimit throttles a proxy to the specified KB/s.
func (ns *NetworkSimulator) AddBandwidthLimit(t *testing.T, proxyName string, kbps int) {
    t.Helper()
    proxy := ns.proxies[proxyName]

    _, err := proxy.AddToxic("bandwidth", "bandwidth", "downstream", 1.0,
        toxiproxy.Attributes{
            "rate": kbps,
        },
    )
    if err != nil {
        t.Fatalf("add bandwidth toxic to %q: %v", proxyName, err)
    }
    t.Cleanup(func() {
        proxy.RemoveToxic("bandwidth")
    })
}

// DisconnectProxy simulates a network partition by taking the proxy down.
func (ns *NetworkSimulator) DisconnectProxy(t *testing.T, proxyName string) {
    t.Helper()
    proxy := ns.proxies[proxyName]
    if err := proxy.Disable(); err != nil {
        t.Fatalf("disable proxy %q: %v", proxyName, err)
    }
    t.Cleanup(func() {
        proxy.Enable()
    })
}

// AddSlicedData injects data slicing (splits TCP packets into tiny pieces)
func (ns *NetworkSimulator) AddSlicedData(t *testing.T, proxyName string, averageSize, delay int) {
    t.Helper()
    proxy := ns.proxies[proxyName]

    _, err := proxy.AddToxic("slicer", "slicer", "downstream", 1.0,
        toxiproxy.Attributes{
            "average_size": averageSize,
            "size_variation": 0,
            "delay": delay,
        },
    )
    if err != nil {
        t.Fatalf("add slicer toxic to %q: %v", proxyName, err)
    }
    t.Cleanup(func() {
        proxy.RemoveToxic("slicer")
    })
}

func extractPort(addr string) string {
    for i := len(addr) - 1; i >= 0; i-- {
        if addr[i] == ':' {
            return addr[i+1:]
        }
    }
    return addr
}
```

### Network Simulation Test

```go
// internal/service/user_service_network_test.go
package service_test

import (
    "context"
    "testing"
    "time"

    "github.com/yourorg/yourapp/internal/service"
    "github.com/yourorg/yourapp/internal/testutil"
)

func TestUserService_WithNetworkFaults(t *testing.T) {
    if testing.Short() {
        t.Skip("Skipping network fault tests in short mode")
    }

    infra := testutil.SetupTestInfrastructure(t)
    netSim := testutil.NewNetworkSimulator(t)

    // Create a proxy between the service and postgres
    proxyAddr := netSim.CreateProxy(t, "postgres", stripProto(infra.PostgresDSN))

    // Create a service configured to use the proxy
    svc, err := service.NewUserService(service.Config{
        DatabaseDSN: fmt.Sprintf("postgresql://testuser:testpass@%s/testdb?sslmode=disable", proxyAddr),
    })
    if err != nil {
        t.Fatalf("create service: %v", err)
    }

    t.Run("handles high latency gracefully", func(t *testing.T) {
        // Inject 200ms latency with 50ms jitter
        netSim.AddLatency(t, "postgres", 200, 50)

        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()

        start := time.Now()
        _, err := svc.GetUser(ctx, someUserID)
        elapsed := time.Since(start)

        if err != nil {
            t.Fatalf("unexpected error under high latency: %v", err)
        }
        if elapsed < 200*time.Millisecond {
            t.Errorf("expected >= 200ms latency, got %v", elapsed)
        }
        if elapsed > 5*time.Second {
            t.Errorf("request timed out: took %v", elapsed)
        }
    })

    t.Run("circuit breaker opens under partition", func(t *testing.T) {
        netSim.DisconnectProxy(t, "postgres")

        ctx := context.Background()
        var lastErr error
        errorCount := 0

        // Send 10 requests; expect them all to fail quickly (circuit open)
        for i := 0; i < 10; i++ {
            _, err := svc.GetUser(ctx, someUserID)
            if err != nil {
                lastErr = err
                errorCount++
            }
        }

        if errorCount == 0 {
            t.Error("expected errors during network partition, got none")
        }

        // Verify error is a connectivity error, not a data error
        if !service.IsConnectivityError(lastErr) {
            t.Errorf("expected ConnectivityError, got: %T: %v", lastErr, lastErr)
        }
    })

    t.Run("recovers after partition heals", func(t *testing.T) {
        // Disable proxy (partition)
        netSim.DisconnectProxy(t, "postgres")

        // Attempt requests during partition
        ctx := context.Background()
        for i := 0; i < 3; i++ {
            svc.GetUser(ctx, someUserID) // ignore errors
        }

        // Re-enable proxy (partition heals) — cleanup in DisconnectProxy handles this
        // But we can force it here too:
        // netSim.EnableProxy(t, "postgres")

        time.Sleep(100 * time.Millisecond) // let circuit half-open

        // After recovery, requests should succeed
        // (This test verifies circuit breaker recovers)
        // In the real test, you'd call netSim.EnableProxy explicitly before retrying
    })
}
```

## Section 4: Chaos Injection Middleware

In-process chaos injection allows testing failure scenarios without external tools:

```go
// internal/chaos/injector.go
package chaos

import (
    "context"
    "math/rand"
    "sync"
    "time"
)

// ChaosLevel controls how aggressively chaos is injected.
type ChaosLevel int

const (
    ChaosNone    ChaosLevel = iota
    ChaosMild               // 1-5% failure rate
    ChaosMedium             // 10-20% failure rate
    ChaosHigh               // 30-50% failure rate
)

// Injector provides configurable in-process chaos for testing.
type Injector struct {
    mu      sync.RWMutex
    level   ChaosLevel
    latency time.Duration
    rng     *rand.Rand
}

// NewInjector creates a new chaos injector with the given level.
func NewInjector(level ChaosLevel) *Injector {
    return &Injector{
        level: level,
        rng:   rand.New(rand.NewSource(time.Now().UnixNano())),
    }
}

// MaybeError randomly returns an error based on the chaos level.
func (c *Injector) MaybeError(ctx context.Context, sentinel error) error {
    c.mu.RLock()
    level := c.level
    c.mu.RUnlock()

    var threshold float64
    switch level {
    case ChaosNone:
        return nil
    case ChaosMild:
        threshold = 0.02
    case ChaosMedium:
        threshold = 0.15
    case ChaosHigh:
        threshold = 0.40
    }

    if c.rng.Float64() < threshold {
        return sentinel
    }
    return nil
}

// MaybeDelay randomly injects latency based on the chaos level.
func (c *Injector) MaybeDelay(ctx context.Context) error {
    c.mu.RLock()
    level := c.level
    c.mu.RUnlock()

    var maxDelay time.Duration
    var probability float64

    switch level {
    case ChaosNone:
        return nil
    case ChaosMild:
        maxDelay = 100 * time.Millisecond
        probability = 0.05
    case ChaosMedium:
        maxDelay = 500 * time.Millisecond
        probability = 0.20
    case ChaosHigh:
        maxDelay = 2 * time.Second
        probability = 0.50
    }

    if c.rng.Float64() < probability {
        delay := time.Duration(c.rng.Int63n(int64(maxDelay)))
        select {
        case <-time.After(delay):
        case <-ctx.Done():
            return ctx.Err()
        }
    }
    return nil
}

// SetLevel changes the chaos level at runtime (useful for progressive failure testing).
func (c *Injector) SetLevel(level ChaosLevel) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.level = level
}
```

### Chaos-Aware Repository Wrapper

```go
// internal/repository/chaos_user_repository.go
package repository

import (
    "context"
    "errors"

    "github.com/google/uuid"
    "github.com/yourorg/yourapp/internal/chaos"
    "github.com/yourorg/yourapp/internal/domain"
)

var (
    ErrChaosTimeout     = errors.New("chaos: simulated timeout")
    ErrChaosDatabaseDown = errors.New("chaos: simulated database unavailable")
)

// ChaosUserRepository wraps UserRepository with configurable failure injection.
type ChaosUserRepository struct {
    delegate *UserRepository
    injector *chaos.Injector
}

// NewChaosUserRepository creates a chaos-injecting wrapper.
func NewChaosUserRepository(delegate *UserRepository, injector *chaos.Injector) *ChaosUserRepository {
    return &ChaosUserRepository{delegate: delegate, injector: injector}
}

func (r *ChaosUserRepository) GetUser(ctx context.Context, id uuid.UUID) (*domain.User, error) {
    if err := r.injector.MaybeDelay(ctx); err != nil {
        return nil, err
    }
    if err := r.injector.MaybeError(ctx, ErrChaosTimeout); err != nil {
        return nil, err
    }
    return r.delegate.GetUser(ctx, id)
}

func (r *ChaosUserRepository) CreateUser(ctx context.Context, params CreateUserParams) (*domain.User, error) {
    if err := r.injector.MaybeDelay(ctx); err != nil {
        return nil, err
    }
    // For writes, use the more severe error
    if err := r.injector.MaybeError(ctx, ErrChaosDatabaseDown); err != nil {
        return nil, err
    }
    return r.delegate.CreateUser(ctx, params)
}
```

### Chaos Test Scenarios

```go
// internal/service/user_service_chaos_test.go
package service_test

import (
    "context"
    "sync"
    "testing"
    "time"

    "github.com/yourorg/yourapp/internal/chaos"
    "github.com/yourorg/yourapp/internal/repository"
    "github.com/yourorg/yourapp/internal/service"
    "github.com/yourorg/yourapp/internal/testutil"
)

func TestUserService_ChaosResilience(t *testing.T) {
    infra := testutil.SetupTestInfrastructure(t)

    t.Run("service handles partial failures with retries", func(t *testing.T) {
        injector := chaos.NewInjector(chaos.ChaosMedium)
        chaosRepo := repository.NewChaosUserRepository(
            repository.NewUserRepository(infra.DB),
            injector,
        )
        svc := service.NewUserService(chaosRepo)

        // Pre-create a user to fetch
        ctx := context.Background()
        user, err := repository.NewUserRepository(infra.DB).CreateUser(ctx, repository.CreateUserParams{
            Email: "chaos-test@example.com",
            Name:  "Chaos Test",
        })
        if err != nil {
            t.Fatalf("setup: create user: %v", err)
        }

        const numRequests = 100
        var successCount, failCount int
        var mu sync.Mutex

        var wg sync.WaitGroup
        for i := 0; i < numRequests; i++ {
            wg.Add(1)
            go func() {
                defer wg.Done()
                ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
                defer cancel()

                _, err := svc.GetUser(ctx, user.ID)
                mu.Lock()
                if err == nil {
                    successCount++
                } else {
                    failCount++
                }
                mu.Unlock()
            }()
        }
        wg.Wait()

        // With medium chaos (15% failure rate) and retries, we expect >80% success
        successRate := float64(successCount) / float64(numRequests)
        t.Logf("Success rate under medium chaos: %.1f%%", successRate*100)

        if successRate < 0.75 {
            t.Errorf("success rate too low under medium chaos: %.1f%%", successRate*100)
        }
    })

    t.Run("progressive failure escalation", func(t *testing.T) {
        injector := chaos.NewInjector(chaos.ChaosNone)
        chaosRepo := repository.NewChaosUserRepository(
            repository.NewUserRepository(infra.DB),
            injector,
        )
        svc := service.NewUserService(chaosRepo)

        ctx := context.Background()
        user, _ := repository.NewUserRepository(infra.DB).CreateUser(ctx, repository.CreateUserParams{
            Email: "escalation-test@example.com",
            Name:  "Escalation Test",
        })

        levels := []chaos.ChaosLevel{
            chaos.ChaosNone,
            chaos.ChaosMild,
            chaos.ChaosMedium,
            chaos.ChaosHigh,
        }
        levelNames := []string{"None", "Mild", "Medium", "High"}

        for i, level := range levels {
            injector.SetLevel(level)

            var successes int
            for j := 0; j < 50; j++ {
                _, err := svc.GetUser(context.Background(), user.ID)
                if err == nil {
                    successes++
                }
            }

            t.Logf("Chaos level %s: %d/50 successes (%.0f%%)",
                levelNames[i], successes, float64(successes)/50*100)
        }
    })
}
```

## Section 5: Golden File Testing

Golden file tests compare actual output against a "golden" reference file stored on disk. They are excellent for complex structured outputs: JSON API responses, generated code, SQL query plans, protobuf-serialized data.

### Golden File Framework

```go
// internal/testutil/golden.go
package testutil

import (
    "bytes"
    "flag"
    "os"
    "path/filepath"
    "testing"
)

// update is set with -update flag to regenerate golden files.
var update = flag.Bool("update", false, "update golden test files")

// GoldenPath returns the path to the golden file for a test.
func GoldenPath(t *testing.T, name string) string {
    t.Helper()
    return filepath.Join("testdata", "golden", t.Name(), name+".golden")
}

// AssertGolden compares got against the golden file content.
// If -update is set, it writes got to the golden file instead.
func AssertGolden(t *testing.T, name string, got []byte) {
    t.Helper()

    goldenPath := GoldenPath(t, name)

    if *update {
        if err := os.MkdirAll(filepath.Dir(goldenPath), 0755); err != nil {
            t.Fatalf("create golden dir: %v", err)
        }
        if err := os.WriteFile(goldenPath, got, 0644); err != nil {
            t.Fatalf("write golden file %q: %v", goldenPath, err)
        }
        t.Logf("Updated golden file: %s", goldenPath)
        return
    }

    want, err := os.ReadFile(goldenPath)
    if err != nil {
        if os.IsNotExist(err) {
            t.Fatalf("golden file %q does not exist. Run with -update to create it.", goldenPath)
        }
        t.Fatalf("read golden file %q: %v", goldenPath, err)
    }

    if !bytes.Equal(got, want) {
        t.Errorf("output does not match golden file %q\n\nGot:\n%s\n\nWant:\n%s",
            goldenPath, got, want)
    }
}

// AssertGoldenString is a convenience wrapper for string output.
func AssertGoldenString(t *testing.T, name, got string) {
    t.Helper()
    AssertGolden(t, name, []byte(got))
}

// AssertGoldenJSON pretty-prints a JSON value and compares against the golden file.
func AssertGoldenJSON(t *testing.T, name string, v interface{}) {
    t.Helper()
    data, err := json.MarshalIndent(v, "", "  ")
    if err != nil {
        t.Fatalf("marshal to JSON: %v", err)
    }
    data = append(data, '\n') // trailing newline for clean diffs
    AssertGolden(t, name, data)
}
```

### Using Golden Files for API Response Testing

```go
// internal/api/user_handler_test.go
package api_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"
    "time"

    "github.com/yourorg/yourapp/internal/api"
    "github.com/yourorg/yourapp/internal/testutil"
)

func TestUserHandler_GetUser_Golden(t *testing.T) {
    infra := testutil.SetupTestInfrastructure(t)
    handler := api.NewUserHandler(infra.DB)

    // Seed deterministic test data
    fixedTime, _ := time.Parse(time.RFC3339, "2024-01-15T10:30:00Z")
    user := seedUserWithFixedTime(t, infra.DB, fixedTime)

    t.Run("get existing user", func(t *testing.T) {
        req := httptest.NewRequest(http.MethodGet, "/users/"+user.ID.String(), nil)
        req.Header.Set("Accept", "application/json")
        w := httptest.NewRecorder()

        handler.ServeHTTP(w, req)

        if w.Code != http.StatusOK {
            t.Fatalf("status: got %d, want %d\nbody: %s", w.Code, http.StatusOK, w.Body)
        }

        // Normalize the JSON for stable comparison
        var got interface{}
        if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
            t.Fatalf("unmarshal response: %v", err)
        }
        testutil.AssertGoldenJSON(t, "get-user-response", got)
    })

    t.Run("get non-existent user", func(t *testing.T) {
        req := httptest.NewRequest(http.MethodGet, "/users/00000000-0000-0000-0000-000000000001", nil)
        w := httptest.NewRecorder()

        handler.ServeHTTP(w, req)

        if w.Code != http.StatusNotFound {
            t.Fatalf("status: got %d, want 404\nbody: %s", w.Code, w.Body)
        }

        testutil.AssertGoldenString(t, "user-not-found-error", w.Body.String())
    })
}
```

The golden file for the first test would be stored at:
`testdata/golden/TestUserHandler_GetUser_Golden/get_existing_user/get-user-response.golden`

Contents:
```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "alice@example.com",
    "name": "Alice",
    "status": "pending",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z"
  }
}
```

Update golden files when intentional changes are made:

```bash
go test ./internal/api/... -run TestUserHandler -update
```

## Section 6: Table-Driven Tests with testify

```go
// internal/domain/status_test.go
package domain_test

import (
    "encoding/json"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "github.com/yourorg/yourapp/internal/domain"
)

func TestStatus_MarshalJSON(t *testing.T) {
    tests := []struct {
        name    string
        status  domain.Status
        want    string
        wantErr bool
    }{
        {name: "unknown", status: domain.StatusUnknown, want: `"unknown"`},
        {name: "pending", status: domain.StatusPending, want: `"pending"`},
        {name: "processing", status: domain.StatusProcessing, want: `"processing"`},
        {name: "completed", status: domain.StatusCompleted, want: `"completed"`},
        {name: "failed", status: domain.StatusFailed, want: `"failed"`},
        {name: "cancelled", status: domain.StatusCancelled, want: `"cancelled"`},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got, err := json.Marshal(tt.status)
            if tt.wantErr {
                require.Error(t, err)
                return
            }
            require.NoError(t, err)
            assert.JSONEq(t, tt.want, string(got))
        })
    }
}

func TestStatus_ParseStatus(t *testing.T) {
    tests := []struct {
        input   string
        want    domain.Status
        wantErr bool
    }{
        {input: "unknown", want: domain.StatusUnknown},
        {input: "pending", want: domain.StatusPending},
        {input: "PENDING", wantErr: true}, // case-sensitive
        {input: "", wantErr: true},
        {input: "invalid", wantErr: true},
    }

    for _, tt := range tests {
        t.Run(tt.input, func(t *testing.T) {
            got, err := domain.ParseStatus(tt.input)
            if tt.wantErr {
                assert.Error(t, err)
                return
            }
            require.NoError(t, err)
            assert.Equal(t, tt.want, got)
        })
    }
}
```

## Section 7: Benchmark Tests for Performance Regression Detection

```go
// internal/repository/user_repository_bench_test.go
package repository_test

import (
    "context"
    "fmt"
    "testing"

    "github.com/yourorg/yourapp/internal/repository"
    "github.com/yourorg/yourapp/internal/testutil"
)

func BenchmarkUserRepository_GetUser(b *testing.B) {
    if testing.Short() {
        b.Skip("Skipping benchmark in short mode")
    }

    infra := testutil.SetupTestInfrastructure(&testing.T{})
    repo := repository.NewUserRepository(infra.DB)
    ctx := context.Background()

    // Pre-seed a user
    user, _ := repo.CreateUser(ctx, repository.CreateUserParams{
        Email: "bench@example.com",
        Name:  "Bench User",
    })

    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            _, err := repo.GetUser(ctx, user.ID)
            if err != nil {
                b.Fatal(err)
            }
        }
    })
}

func BenchmarkUserRepository_ListUsers(b *testing.B) {
    if testing.Short() {
        b.Skip("Skipping benchmark in short mode")
    }

    infra := testutil.SetupTestInfrastructure(&testing.T{})
    repo := repository.NewUserRepository(infra.DB)
    ctx := context.Background()

    // Pre-seed data
    for i := 0; i < 10000; i++ {
        repo.CreateUser(ctx, repository.CreateUserParams{
            Email: fmt.Sprintf("user%d@example.com", i),
            Name:  fmt.Sprintf("User %d", i),
        })
    }

    pageSizes := []int{10, 50, 100}
    for _, pageSize := range pageSizes {
        b.Run(fmt.Sprintf("page_size_%d", pageSize), func(b *testing.B) {
            b.ResetTimer()
            for i := 0; i < b.N; i++ {
                _, _, err := repo.ListUsers(ctx, repository.ListUsersParams{
                    Limit:  pageSize,
                    Offset: 0,
                })
                if err != nil {
                    b.Fatal(err)
                }
            }
        })
    }
}
```

## Section 8: Test Parallelism and Isolation

```go
// TestMain provides global test setup and controls parallelism
func TestMain(m *testing.M) {
    // Parse flags including -update for golden files
    flag.Parse()

    // Set testcontainers log level
    testcontainers.Logger = log.New(io.Discard, "", 0)

    os.Exit(m.Run())
}

// Use t.Parallel() for tests that can run concurrently
func TestSomething(t *testing.T) {
    t.Parallel()
    // ...
}

// For database tests, use savepoints for rollback-based isolation
func withTestTransaction(t *testing.T, db *sql.DB, fn func(tx *sql.Tx)) {
    t.Helper()
    tx, err := db.Begin()
    if err != nil {
        t.Fatalf("begin tx: %v", err)
    }
    t.Cleanup(func() {
        if err := tx.Rollback(); err != nil && err != sql.ErrTxDone {
            t.Logf("rollback: %v", err)
        }
    })
    fn(tx)
}
```

## Section 9: CI Configuration for Integration Tests

```yaml
# .github/workflows/integration-tests.yml
name: Integration Tests

on:
  push:
    branches: [main]
  pull_request:

jobs:
  integration-tests:
    runs-on: ubuntu-latest
    services:
      # Docker-in-Docker is handled by testcontainers automatically
      # when using GitHub Actions with ubuntu runners (Docker is pre-installed)

    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: "1.23"
          cache: true

      - name: Run unit tests
        run: go test -short ./... -count=1

      - name: Run integration tests
        run: |
          go test \
            -run "Integration|Network|Chaos" \
            ./... \
            -timeout 10m \
            -count=1 \
            -v \
            2>&1 | tee test-output.txt

      - name: Upload test output
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-output
          path: test-output.txt

      - name: Check golden files are up to date
        run: |
          go test ./... -run Golden -update
          git diff --exit-code testdata/golden/ || \
            (echo "Golden files are out of date. Run 'go test ./... -run Golden -update'" && exit 1)
```

This testing stack — testcontainers for realistic infrastructure, toxiproxy for network simulation, chaos injection middleware for partial failure testing, and golden files for output verification — gives Go distributed system teams the confidence to ship changes without production surprises.
