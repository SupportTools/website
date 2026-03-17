---
title: "Go Microservices Testing: Contract Tests, Integration Tests, and Test Containers"
date: 2030-09-06T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "Contract Testing", "Pact", "Testcontainers", "Integration Testing", "Microservices", "WireMock"]
categories:
- Go
- Testing
- Microservices
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise testing strategy for Go microservices covering contract testing with Pact, integration test design with testcontainers-go, database seeding patterns, mocking external services with WireMock, and managing test environments at scale."
more_link: "yes"
url: "/go-microservices-testing-contract-integration-testcontainers/"
---

Testing microservices in isolation is straightforward. Testing the interactions between microservices is where most enterprise test suites fail. Unit tests catch logic bugs but miss integration failures. Manual end-to-end tests in staging catch integration bugs but run slowly, require full environment availability, and often break on unrelated deployments. Contract tests and integration tests with containerized dependencies fill the gap — providing fast, deterministic, and accurate validation of cross-service behavior without requiring a full production-like environment. This guide covers the complete enterprise testing stack for Go microservices: Pact-based consumer-driven contract tests, testcontainers-go for realistic integration tests with real databases and message queues, external service mocking with WireMock, and patterns for scaling this approach across dozens of services.

<!--more-->

## Testing Strategy Overview

A well-designed microservices test suite follows the testing pyramid but adapts it for distributed systems:

```
           ┌─────────────────────────────┐
           │     End-to-End Tests        │  Few, expensive, run in staging
           │  (full environment, slow)   │
           ├─────────────────────────────┤
           │    Contract Tests           │  Medium count, run in CI per PR
           │  (Pact provider/consumer)   │
           ├─────────────────────────────┤
           │   Integration Tests         │  Many, run against real containers
           │  (testcontainers-go)        │
           ├─────────────────────────────┤
           │      Unit Tests             │  Largest set, run locally and CI
           │   (no external deps)        │
           └─────────────────────────────┘
```

The critical insight is that contract tests replace a significant portion of end-to-end tests by verifying the API contract between each pair of services independently, while integration tests verify that each service correctly integrates with its own dependencies (databases, queues, caches).

## Contract Testing with Pact

Pact is a consumer-driven contract testing framework. The consumer (the service that calls an API) defines the expected behavior in a **pact file**. The provider (the service that serves the API) verifies that it satisfies the pact without the consumer being present.

### Installing Pact for Go

```bash
go get github.com/pact-foundation/pact-go/v2@latest

# Initialize pact-go (downloads native libraries)
go run github.com/pact-foundation/pact-go/v2 install
```

### Consumer Test: Define the Contract

The consumer test creates a mock server that the consumer code talks to, then records the interaction as a pact:

```go
// consumer/pact_test.go
package consumer_test

import (
    "fmt"
    "net/http"
    "testing"

    "github.com/pact-foundation/pact-go/v2/consumer"
    "github.com/pact-foundation/pact-go/v2/matchers"
    orderclient "github.com/example/checkout/internal/clients/order"
)

func TestOrderServiceConsumerPact(t *testing.T) {
    mockProvider, err := consumer.NewV4Pact(consumer.MockHTTPProviderConfig{
        Consumer: "checkout-service",
        Provider: "order-service",
        PactDir:  "./pacts",
        LogDir:   "./logs",
    })
    if err != nil {
        t.Fatal(err)
    }

    // Define the interaction: GET /orders/{orderId}
    err = mockProvider.
        AddInteraction().
        Given("order ord-12345 exists").
        UponReceiving("a request for order ord-12345").
        WithRequest(consumer.Request{
            Method: http.MethodGet,
            Path:   matchers.String("/orders/ord-12345"),
            Headers: matchers.MapMatcher{
                "Accept": matchers.String("application/json"),
            },
        }).
        WillRespondWith(consumer.Response{
            Status: 200,
            Headers: matchers.MapMatcher{
                "Content-Type": matchers.String("application/json"),
            },
            Body: matchers.MatchV2(map[string]interface{}{
                "order_id":    matchers.Like("ord-12345"),
                "customer_id": matchers.Like("cust-001"),
                "status":      matchers.Term("PENDING", "PENDING|CONFIRMED|SHIPPED|DELIVERED|CANCELLED"),
                "total_cents": matchers.Like(int64(4999)),
                "items": matchers.EachLike(map[string]interface{}{
                    "sku":      matchers.Like("SKU-001"),
                    "quantity": matchers.Like(1),
                    "price_cents": matchers.Like(int64(4999)),
                }, 1),
            }),
        }).
        ExecuteTest(t, func(config consumer.MockServerConfig) error {
            // Use the real client code against the mock server
            client := orderclient.New(fmt.Sprintf("http://%s:%d", config.Host, config.Port))
            order, err := client.GetOrder(t.Context(), "ord-12345")
            if err != nil {
                return fmt.Errorf("GetOrder failed: %w", err)
            }
            if order.OrderID != "ord-12345" {
                return fmt.Errorf("expected order_id=ord-12345, got %q", order.OrderID)
            }
            return nil
        })

    if err != nil {
        t.Fatal(err)
    }
}

// Test for creating an order
func TestOrderServiceCreateConsumerPact(t *testing.T) {
    mockProvider, err := consumer.NewV4Pact(consumer.MockHTTPProviderConfig{
        Consumer: "checkout-service",
        Provider: "order-service",
        PactDir:  "./pacts",
    })
    if err != nil {
        t.Fatal(err)
    }

    err = mockProvider.
        AddInteraction().
        Given("valid customer cust-001 exists").
        UponReceiving("a request to create an order").
        WithRequest(consumer.Request{
            Method: http.MethodPost,
            Path:   matchers.String("/orders"),
            Headers: matchers.MapMatcher{
                "Content-Type": matchers.String("application/json"),
            },
            Body: matchers.MatchV2(map[string]interface{}{
                "customer_id": matchers.Like("cust-001"),
                "items": matchers.EachLike(map[string]interface{}{
                    "sku":      matchers.Like("SKU-001"),
                    "quantity": matchers.Like(1),
                }, 1),
            }),
        }).
        WillRespondWith(consumer.Response{
            Status: 201,
            Body: matchers.MatchV2(map[string]interface{}{
                "order_id": matchers.Regex("ord-[a-f0-9]{8}", "ord-abcdef12"),
                "status":   matchers.String("PENDING"),
            }),
        }).
        ExecuteTest(t, func(config consumer.MockServerConfig) error {
            client := orderclient.New(fmt.Sprintf("http://%s:%d", config.Host, config.Port))
            result, err := client.CreateOrder(t.Context(), orderclient.CreateOrderRequest{
                CustomerID: "cust-001",
                Items: []orderclient.OrderItem{
                    {SKU: "SKU-001", Quantity: 1},
                },
            })
            if err != nil {
                return fmt.Errorf("CreateOrder failed: %w", err)
            }
            if result.Status != "PENDING" {
                return fmt.Errorf("expected PENDING, got %q", result.Status)
            }
            return nil
        })

    if err != nil {
        t.Fatal(err)
    }
}
```

### Provider Verification Test

The provider test starts the real order service and verifies it satisfies the pact published by the consumer:

```go
// provider/pact_verify_test.go
package provider_test

import (
    "fmt"
    "net/http/httptest"
    "testing"

    "github.com/pact-foundation/pact-go/v2/provider"
    "github.com/example/order/internal/app"
    "github.com/example/order/internal/testfixtures"
)

func TestOrderServiceProviderPact(t *testing.T) {
    // Start the real order service with a test database
    db := testfixtures.NewTestDatabase(t)
    srv := httptest.NewServer(app.NewHandler(db))
    t.Cleanup(srv.Close)

    verifier := provider.NewVerifier()
    err := verifier.VerifyProvider(t, provider.VerifyRequest{
        ProviderBaseURL: srv.URL,
        Provider:        "order-service",

        // Pull pacts from Pact Broker in CI; use local files in development
        BrokerURL:           "https://pactbroker.example.com",
        BrokerToken:         "<pact-broker-token>",
        ConsumerVersionSelectors: []provider.ConsumerVersionSelector{
            {MainBranch: true},
            {DeployedOrReleased: true},
        },

        // Alternatively, use local pact files during development:
        // PactURLs: []string{"../consumer/pacts/checkout-service-order-service.json"},

        // State handlers provision test data for each "Given" state
        StateHandlers: provider.StateHandlers{
            "order ord-12345 exists": func(setup bool, s provider.ProviderStateV3) (provider.ProviderStateV3Response, error) {
                if setup {
                    order := testfixtures.SeedOrder(db, "ord-12345", "cust-001", "PENDING")
                    return provider.ProviderStateV3Response{
                        "order_id": order.ID,
                    }, nil
                }
                testfixtures.DeleteOrder(db, "ord-12345")
                return provider.ProviderStateV3Response{}, nil
            },
            "valid customer cust-001 exists": func(setup bool, s provider.ProviderStateV3) (provider.ProviderStateV3Response, error) {
                if setup {
                    testfixtures.SeedCustomer(db, "cust-001")
                }
                return provider.ProviderStateV3Response{}, nil
            },
        },

        PublishVerificationResults: true,
        ProviderVersion:            getGitCommit(),
        ProviderVersionBranch:      getGitBranch(),
    })

    if err != nil {
        t.Fatal(err)
    }
}

func getGitCommit() string {
    // In CI, this comes from the environment
    if v := os.Getenv("GIT_COMMIT"); v != "" {
        return v
    }
    out, _ := exec.Command("git", "rev-parse", "--short", "HEAD").Output()
    return strings.TrimSpace(string(out))
}
```

### Pact Broker CI Integration

```yaml
# .github/workflows/contract-tests.yaml
name: Contract Tests

on:
  push:
    branches: [main, feature/**]
  pull_request:

jobs:
  consumer-pact:
    name: Generate Consumer Pacts
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-go@v5
      with:
        go-version: '1.23'

    - name: Run Consumer Pact Tests
      run: go test ./consumer/... -run TestOrderServiceConsumerPact -v
      working-directory: checkout-service

    - name: Publish Pacts to Broker
      run: |
        docker run --rm \
          -v $(pwd)/checkout-service/pacts:/pacts \
          pactfoundation/pact-cli broker publish \
          --broker-base-url https://pactbroker.example.com \
          --broker-token ${{ secrets.PACT_BROKER_TOKEN }} \
          --consumer-app-version ${{ github.sha }} \
          --branch ${{ github.ref_name }} \
          /pacts

  provider-pact:
    name: Verify Provider Pacts
    runs-on: ubuntu-latest
    needs: consumer-pact
    steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-go@v5
      with:
        go-version: '1.23'

    - name: Run Provider Pact Verification
      env:
        PACT_BROKER_TOKEN: ${{ secrets.PACT_BROKER_TOKEN }}
        GIT_COMMIT: ${{ github.sha }}
      run: go test ./provider/... -run TestOrderServiceProviderPact -v -timeout 120s
      working-directory: order-service
```

## Integration Tests with testcontainers-go

testcontainers-go starts real Docker containers (PostgreSQL, Redis, Kafka, etc.) for the duration of a test, providing accurate integration test behavior without mocking.

### Installing testcontainers-go

```bash
go get github.com/testcontainers/testcontainers-go@latest
go get github.com/testcontainers/testcontainers-go/modules/postgres@latest
go get github.com/testcontainers/testcontainers-go/modules/redis@latest
go get github.com/testcontainers/testcontainers-go/modules/kafka@latest
```

### PostgreSQL Integration Test

```go
// internal/repository/order_repository_test.go
package repository_test

import (
    "context"
    "database/sql"
    "testing"
    "time"

    _ "github.com/lib/pq"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
    "github.com/testcontainers/testcontainers-go"
    "github.com/example/order/internal/repository"
    "github.com/example/order/internal/migrations"
)

func setupPostgres(t *testing.T) *sql.DB {
    t.Helper()
    ctx := context.Background()

    pgContainer, err := postgres.RunContainer(ctx,
        testcontainers.WithImage("postgres:16-alpine"),
        postgres.WithDatabase("orders_test"),
        postgres.WithUsername("testuser"),
        postgres.WithPassword("testpassword"),
        postgres.WithInitScripts(), // empty — use migrations
        testcontainers.WithWaitStrategy(
            wait.ForLog("database system is ready to accept connections").
                WithOccurrence(2).
                WithStartupTimeout(30*time.Second),
        ),
    )
    if err != nil {
        t.Fatalf("starting postgres container: %v", err)
    }
    t.Cleanup(func() {
        if err := pgContainer.Terminate(ctx); err != nil {
            t.Logf("terminating postgres container: %v", err)
        }
    })

    connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
    if err != nil {
        t.Fatalf("getting connection string: %v", err)
    }

    db, err := sql.Open("postgres", connStr)
    if err != nil {
        t.Fatalf("opening database: %v", err)
    }
    t.Cleanup(func() { db.Close() })

    // Run migrations
    if err := migrations.Up(db); err != nil {
        t.Fatalf("running migrations: %v", err)
    }

    return db
}

func TestOrderRepository_CreateAndGet(t *testing.T) {
    db := setupPostgres(t)
    repo := repository.NewOrderRepository(db)
    ctx := context.Background()

    // Create
    created, err := repo.Create(ctx, repository.CreateOrderInput{
        CustomerID:  "cust-001",
        TotalCents:  4999,
        Items: []repository.OrderItemInput{
            {SKU: "SKU-001", Quantity: 1, PriceCents: 4999},
        },
    })
    if err != nil {
        t.Fatalf("Create: %v", err)
    }
    if created.ID == "" {
        t.Fatal("expected non-empty order ID")
    }
    if created.Status != "PENDING" {
        t.Errorf("expected PENDING, got %q", created.Status)
    }

    // Get
    fetched, err := repo.GetByID(ctx, created.ID)
    if err != nil {
        t.Fatalf("GetByID: %v", err)
    }
    if fetched.CustomerID != "cust-001" {
        t.Errorf("customer_id mismatch: %q", fetched.CustomerID)
    }
    if len(fetched.Items) != 1 {
        t.Errorf("expected 1 item, got %d", len(fetched.Items))
    }
}

func TestOrderRepository_StatusTransition(t *testing.T) {
    db := setupPostgres(t)
    repo := repository.NewOrderRepository(db)
    ctx := context.Background()

    order, _ := repo.Create(ctx, repository.CreateOrderInput{
        CustomerID: "cust-002",
        TotalCents: 1000,
    })

    // Valid transition: PENDING → CONFIRMED
    if err := repo.UpdateStatus(ctx, order.ID, "CONFIRMED"); err != nil {
        t.Fatalf("UpdateStatus CONFIRMED: %v", err)
    }

    // Invalid transition: CONFIRMED → PENDING (should fail)
    if err := repo.UpdateStatus(ctx, order.ID, "PENDING"); err == nil {
        t.Error("expected error for invalid transition CONFIRMED→PENDING")
    }
}
```

### Database Seeding Patterns

```go
// internal/testfixtures/seeder.go
package testfixtures

import (
    "database/sql"
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
    "testing"
    "time"

    "github.com/google/uuid"
)

// Seeder provides deterministic test data seeding.
type Seeder struct {
    db *sql.DB
}

func NewSeeder(db *sql.DB) *Seeder {
    return &Seeder{db: db}
}

// SeedFromFile loads and executes SQL from a fixture file.
func (s *Seeder) SeedFromFile(t *testing.T, path string) {
    t.Helper()
    data, err := os.ReadFile(path)
    if err != nil {
        t.Fatalf("reading fixture %q: %v", path, err)
    }
    if _, err := s.db.Exec(string(data)); err != nil {
        t.Fatalf("executing fixture %q: %v", path, err)
    }
}

// SeedOrder creates a deterministic order for testing.
func (s *Seeder) SeedOrder(t *testing.T, overrides map[string]interface{}) string {
    t.Helper()
    id := uuid.New().String()
    customerID := getString(overrides, "customer_id", "cust-fixture-001")
    status := getString(overrides, "status", "PENDING")
    totalCents := getInt64(overrides, "total_cents", 9999)

    _, err := s.db.Exec(`
        INSERT INTO orders (id, customer_id, status, total_cents, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $5)
    `, id, customerID, status, totalCents, time.Now())
    if err != nil {
        t.Fatalf("seeding order: %v", err)
    }

    t.Cleanup(func() {
        s.db.Exec("DELETE FROM orders WHERE id = $1", id)
    })

    return id
}

func getString(m map[string]interface{}, key, def string) string {
    if v, ok := m[key].(string); ok {
        return v
    }
    return def
}

func getInt64(m map[string]interface{}, key string, def int64) int64 {
    if v, ok := m[key].(int64); ok {
        return v
    }
    return def
}
```

### Kafka Integration Test

```go
// internal/events/publisher_test.go
package events_test

import (
    "context"
    "encoding/json"
    "testing"
    "time"

    "github.com/testcontainers/testcontainers-go/modules/kafka"
    "github.com/example/order/internal/events"
    "github.com/segmentio/kafka-go"
)

func TestOrderEventPublisher(t *testing.T) {
    ctx := context.Background()

    kafkaContainer, err := kafka.RunContainer(ctx,
        testcontainers.WithImage("confluentinc/cp-kafka:7.6.0"),
        kafka.WithClusterID("test-cluster"),
    )
    if err != nil {
        t.Fatalf("starting kafka: %v", err)
    }
    t.Cleanup(func() { kafkaContainer.Terminate(ctx) })

    brokers, err := kafkaContainer.Brokers(ctx)
    if err != nil {
        t.Fatalf("getting brokers: %v", err)
    }

    publisher := events.NewOrderEventPublisher(brokers)

    // Publish an event
    err = publisher.Publish(ctx, events.OrderCreatedEvent{
        OrderID:    "ord-test-001",
        CustomerID: "cust-001",
        TotalCents: 4999,
    })
    if err != nil {
        t.Fatalf("Publish: %v", err)
    }

    // Verify the event was produced by consuming it
    reader := kafka.NewReader(kafka.ReaderConfig{
        Brokers: brokers,
        Topic:   "order.created",
        GroupID: "test-consumer",
    })
    t.Cleanup(func() { reader.Close() })

    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    msg, err := reader.ReadMessage(ctx)
    if err != nil {
        t.Fatalf("reading message: %v", err)
    }

    var event events.OrderCreatedEvent
    if err := json.Unmarshal(msg.Value, &event); err != nil {
        t.Fatalf("unmarshalling event: %v", err)
    }
    if event.OrderID != "ord-test-001" {
        t.Errorf("order_id mismatch: %q", event.OrderID)
    }
}
```

### Redis Integration Test

```go
// internal/cache/order_cache_test.go
package cache_test

import (
    "context"
    "testing"
    "time"

    "github.com/testcontainers/testcontainers-go/modules/redis"
    ordercache "github.com/example/order/internal/cache"
)

func TestOrderCache(t *testing.T) {
    ctx := context.Background()

    redisContainer, err := redis.RunContainer(ctx,
        testcontainers.WithImage("redis:7-alpine"),
        redis.WithSnapshotting(10, 1),
        redis.WithLogLevel(redis.LogLevelVerbose),
    )
    if err != nil {
        t.Fatalf("starting redis: %v", err)
    }
    t.Cleanup(func() { redisContainer.Terminate(ctx) })

    addr, err := redisContainer.Endpoint(ctx, "")
    if err != nil {
        t.Fatalf("getting endpoint: %v", err)
    }

    cache := ordercache.New(addr, 5*time.Minute)

    // Set and get
    err = cache.SetOrder(ctx, "ord-001", &ordercache.CachedOrder{
        OrderID: "ord-001",
        Status:  "PENDING",
    })
    if err != nil {
        t.Fatalf("SetOrder: %v", err)
    }

    order, err := cache.GetOrder(ctx, "ord-001")
    if err != nil {
        t.Fatalf("GetOrder: %v", err)
    }
    if order.Status != "PENDING" {
        t.Errorf("status mismatch: %q", order.Status)
    }

    // Eviction
    cache.InvalidateOrder(ctx, "ord-001")
    _, err = cache.GetOrder(ctx, "ord-001")
    if err != ordercache.ErrCacheMiss {
        t.Errorf("expected cache miss, got: %v", err)
    }
}
```

## Mocking External Services with WireMock

For external services (payment processors, shipping APIs, third-party enrichment services) that cannot be containerized locally, WireMock provides a flexible HTTP mock server:

```go
// internal/payments/client_test.go
package payments_test

import (
    "context"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/wait"
    paymentsclient "github.com/example/checkout/internal/clients/payments"
)

func TestPaymentClient_ChargeCard(t *testing.T) {
    ctx := context.Background()

    // Start WireMock container
    wireMockContainer, err := testcontainers.GenericContainer(ctx,
        testcontainers.GenericContainerRequest{
            ContainerRequest: testcontainers.ContainerRequest{
                Image:        "wiremock/wiremock:3.3.1",
                ExposedPorts: []string{"8080/tcp"},
                WaitingFor:   wait.ForHTTP("/__admin/health").WithPort("8080/tcp"),
            },
            Started: true,
        },
    )
    if err != nil {
        t.Fatalf("starting wiremock: %v", err)
    }
    t.Cleanup(func() { wireMockContainer.Terminate(ctx) })

    endpoint, err := wireMockContainer.Endpoint(ctx, "http")
    if err != nil {
        t.Fatalf("getting endpoint: %v", err)
    }

    // Configure stub via WireMock admin API
    stubBody := `{
      "request": {
        "method": "POST",
        "url": "/v1/charges",
        "bodyPatterns": [
          {"matchesJsonPath": "$.amount_cents"}
        ]
      },
      "response": {
        "status": 201,
        "headers": {"Content-Type": "application/json"},
        "jsonBody": {
          "charge_id": "ch_test_001",
          "status": "succeeded",
          "amount_cents": 4999
        }
      }
    }`

    resp, err := http.Post(
        endpoint+"/__admin/mappings",
        "application/json",
        strings.NewReader(stubBody),
    )
    if err != nil || resp.StatusCode != 201 {
        t.Fatalf("configuring wiremock stub: %v (status %d)", err, resp.StatusCode)
    }

    // Test the real client
    client := paymentsclient.New(endpoint)
    charge, err := client.ChargeCard(ctx, paymentsclient.ChargeRequest{
        CardToken:   "tok_test_visa",
        AmountCents: 4999,
        Currency:    "USD",
    })
    if err != nil {
        t.Fatalf("ChargeCard: %v", err)
    }
    if charge.Status != "succeeded" {
        t.Errorf("expected succeeded, got %q", charge.Status)
    }
}
```

### Using httptest for Simpler External Service Mocking

For simpler cases, Go's built-in `httptest` package is often sufficient:

```go
// Lightweight mock for payment gateway
func newMockPaymentGateway(t *testing.T, responses map[string]mockResponse) *httptest.Server {
    t.Helper()
    return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        key := r.Method + " " + r.URL.Path
        if resp, ok := responses[key]; ok {
            w.Header().Set("Content-Type", "application/json")
            w.WriteHeader(resp.StatusCode)
            json.NewEncoder(w).Encode(resp.Body)
            return
        }
        t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
        w.WriteHeader(http.StatusInternalServerError)
    }))
}

type mockResponse struct {
    StatusCode int
    Body       interface{}
}

func TestCheckoutService_SuccessfulPayment(t *testing.T) {
    paymentServer := newMockPaymentGateway(t, map[string]mockResponse{
        "POST /v1/charges": {
            StatusCode: 201,
            Body: map[string]interface{}{
                "charge_id": "ch_mock_001",
                "status":    "succeeded",
            },
        },
    })
    t.Cleanup(paymentServer.Close)

    orderServer := newMockOrderService(t, map[string]mockResponse{
        "POST /orders": {
            StatusCode: 201,
            Body: map[string]interface{}{
                "order_id": "ord-mock-001",
                "status":   "PENDING",
            },
        },
    })
    t.Cleanup(orderServer.Close)

    svc := checkout.NewService(
        paymentsclient.New(paymentServer.URL),
        orderclient.New(orderServer.URL),
    )

    result, err := svc.Checkout(context.Background(), checkout.CheckoutRequest{
        CustomerID: "cust-001",
        CardToken:  "tok_visa",
        Items:      []checkout.Item{{SKU: "SKU-001", Quantity: 1}},
    })
    if err != nil {
        t.Fatalf("Checkout: %v", err)
    }
    if result.OrderID == "" {
        t.Error("expected non-empty order_id")
    }
}
```

## Shared Test Infrastructure Patterns

### TestMain for Shared Container Lifecycle

When multiple tests in the same package use the same container, use `TestMain` to start it once:

```go
// internal/repository/main_test.go
package repository_test

import (
    "context"
    "database/sql"
    "os"
    "testing"

    "github.com/testcontainers/testcontainers-go/modules/postgres"
    "github.com/example/order/internal/migrations"
)

var testDB *sql.DB

func TestMain(m *testing.M) {
    ctx := context.Background()

    pgContainer, err := postgres.RunContainer(ctx,
        testcontainers.WithImage("postgres:16-alpine"),
        postgres.WithDatabase("orders_test"),
        postgres.WithUsername("testuser"),
        postgres.WithPassword("testpassword"),
    )
    if err != nil {
        panic(err)
    }
    defer pgContainer.Terminate(ctx)

    connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
    if err != nil {
        panic(err)
    }

    testDB, err = sql.Open("postgres", connStr)
    if err != nil {
        panic(err)
    }
    defer testDB.Close()

    if err := migrations.Up(testDB); err != nil {
        panic(err)
    }

    os.Exit(m.Run())
}

// Each test truncates relevant tables for isolation
func TestOrderRepository_Create(t *testing.T) {
    t.Cleanup(func() {
        testDB.Exec("TRUNCATE TABLE orders CASCADE")
    })
    // ... test using testDB
}
```

### Parallel Test Execution

```go
func TestOrderRepository_Parallel(t *testing.T) {
    t.Parallel()  // Enable parallel execution

    db := setupPostgres(t)  // Each parallel test gets its own container
    repo := repository.NewOrderRepository(db)
    // ...
}
```

For speed at scale, use Ryuk (testcontainers' resource cleanup daemon) and set appropriate Docker resource limits to prevent container sprawl during parallel CI runs.

## Managing Test Environments at Scale

### Go Build Tags for Test Categories

```go
//go:build integration
// +build integration

// File: internal/repository/order_repository_integration_test.go
// Run with: go test -tags integration ./...

package repository_test

// Heavy integration tests that require Docker
```

```go
//go:build contract
// +build contract

// File: consumer/pact_test.go
// Run with: go test -tags contract ./...
```

```makefile
# Makefile
.PHONY: test test-unit test-integration test-contract

test-unit:
	go test -race -count=1 ./...

test-integration:
	go test -tags integration -race -timeout 300s -count=1 ./...

test-contract:
	go test -tags contract -race -timeout 120s -count=1 ./...

test-all: test-unit test-integration test-contract
```

### CI Pipeline Structure

```yaml
# .github/workflows/test.yaml
jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-go@v5
      with:
        go-version: '1.23'
    - run: go test -race -count=1 -coverprofile=coverage.out ./...
    - uses: codecov/codecov-action@v4

  integration-tests:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-go@v5
      with:
        go-version: '1.23'
    - name: Run integration tests
      run: go test -tags integration -race -timeout 300s -count=1 -v ./...
      env:
        TESTCONTAINERS_RYUK_DISABLED: "false"
        DOCKER_HOST: unix:///var/run/docker.sock

  contract-tests:
    runs-on: ubuntu-latest
    needs: unit-tests
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-go@v5
      with:
        go-version: '1.23'
    - run: go test -tags contract -race -timeout 120s -count=1 ./...
      env:
        PACT_BROKER_TOKEN: ${{ secrets.PACT_BROKER_TOKEN }}
```

## Summary

A robust Go microservices test strategy combines three complementary layers: unit tests for logic isolation, testcontainers-go integration tests for database and message queue accuracy, and Pact contract tests for cross-service API compatibility. The key operational principles are: use `TestMain` for shared container lifecycle to reduce test time in large packages, apply build tags to segregate test categories and control CI pipeline cost, publish pact files to a Pact Broker for cross-team visibility, and use `StateHandlers` in provider verification tests to provision exactly the data each consumer interaction requires. This approach eliminates the class of integration failures that unit tests cannot detect while keeping CI pipeline times well under the threshold where developers stop running tests locally.
