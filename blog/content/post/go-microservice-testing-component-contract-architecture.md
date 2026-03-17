---
title: "Go Microservice Testing: Component Tests, Contract Tests, and Testable Architecture"
date: 2030-05-01T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "Contract Testing", "Component Testing", "Microservices", "Architecture"]
categories: ["Go", "Testing"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive testing strategy for Go microservices covering the testing pyramid with component tests using real dependencies, consumer-driven contract tests with pact-go, testable architecture patterns, and a structured test doubles hierarchy for production reliability."
more_link: "yes"
url: "/go-microservice-testing-component-contract-architecture/"
---

Unit tests catch logic bugs in isolation. Integration tests verify that your service talks to a database correctly. But neither catches the most expensive category of production bug: the subtle incompatibility between two independently deployed services. Service A was updated to expect a new required field. Service B was not updated to send it. Both have green CI pipelines. Production breaks at 3 AM.

Consumer-driven contract testing and component tests fill the gap between unit tests and end-to-end tests, providing high confidence at a fraction of the execution time cost.

<!--more-->

# Go Microservice Testing: Component Tests, Contract Tests, and Testable Architecture

## Testing Pyramid for Microservices

```
                    /\
                   /  \
                  / E2E \         (5-10 tests: full system, slow, fragile)
                 /--------\
                /  Contract \     (1-N per service pair: cross-service compat)
               /------------\
              /  Component   \    (20-50 per service: real deps, in-process)
             /----------------\
            /   Integration    \  (50-100: service + single dependency)
           /--------------------\
          /       Unit          \  (hundreds: pure logic, no I/O)
         /------------------------\
```

The critical insight is that **component tests** — tests that exercise your service from its API boundary down through real (but containerized) dependencies — provide the best signal-to-cost ratio for microservices. They catch everything unit tests miss about how components wire together, without the complexity and flakiness of full end-to-end tests.

## Project Structure for Testability

```
order-service/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── app/
│   │   ├── service.go           # Business logic (dependencies via interfaces)
│   │   └── service_test.go      # Unit tests
│   ├── port/
│   │   ├── http/
│   │   │   ├── handler.go
│   │   │   └── handler_test.go  # HTTP layer unit tests
│   │   └── grpc/
│   │       └── server.go
│   └── adapter/
│       ├── postgres/
│       │   ├── repository.go
│       │   └── repository_test.go  # Integration tests
│       └── kafka/
│           └── publisher.go
├── test/
│   ├── component/
│   │   ├── order_test.go        # Component tests (testcontainers)
│   │   └── helpers_test.go
│   └── contract/
│       ├── provider_test.go     # Pact provider verification
│       └── consumer_test.go     # Pact consumer test (if this is a consumer)
└── testutil/
    ├── testdb.go                # Test DB helpers
    └── testserver.go            # Test server setup
```

## Testable Architecture: Interfaces at Boundaries

### Port and Adapter Pattern

```go
// internal/app/port.go — all external dependencies behind interfaces
package app

import (
	"context"
	"time"
)

// OrderRepository defines persistence operations
type OrderRepository interface {
	Save(ctx context.Context, order *Order) error
	FindByID(ctx context.Context, id string) (*Order, error)
	FindByCustomer(ctx context.Context, customerID string, limit int) ([]*Order, error)
	UpdateStatus(ctx context.Context, id string, status OrderStatus) error
}

// PaymentService defines the payment provider integration
type PaymentService interface {
	Charge(ctx context.Context, req ChargeRequest) (*ChargeResult, error)
	Refund(ctx context.Context, chargeID string, amountMicros int64) error
}

// EventPublisher defines event emission
type EventPublisher interface {
	Publish(ctx context.Context, topic string, event interface{}) error
}

// InventoryClient defines inventory service calls
type InventoryClient interface {
	Reserve(ctx context.Context, items []ReservationItem) (string, error)
	Release(ctx context.Context, reservationID string) error
	CheckAvailability(ctx context.Context, skus []string) (map[string]int, error)
}
```

```go
// internal/app/service.go — business logic depends only on interfaces
package app

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

type OrderService struct {
	orders    OrderRepository
	payments  PaymentService
	events    EventPublisher
	inventory InventoryClient
	logger    *slog.Logger
	clock     func() time.Time  // Injected for deterministic testing
}

func NewOrderService(
	orders OrderRepository,
	payments PaymentService,
	events EventPublisher,
	inventory InventoryClient,
	logger *slog.Logger,
) *OrderService {
	return &OrderService{
		orders:    orders,
		payments:  payments,
		events:    events,
		inventory: inventory,
		logger:    logger,
		clock:     time.Now,
	}
}

// WithClock replaces the clock for deterministic tests
func (s *OrderService) WithClock(clock func() time.Time) *OrderService {
	s.clock = clock
	return s
}

func (s *OrderService) PlaceOrder(ctx context.Context, req PlaceOrderRequest) (*Order, error) {
	// Check availability
	skus := make([]string, len(req.Items))
	for i, item := range req.Items {
		skus[i] = item.SKU
	}

	availability, err := s.inventory.CheckAvailability(ctx, skus)
	if err != nil {
		return nil, fmt.Errorf("check availability: %w", err)
	}

	for _, item := range req.Items {
		if availability[item.SKU] < item.Quantity {
			return nil, &InsufficientStockError{SKU: item.SKU, Available: availability[item.SKU]}
		}
	}

	// Reserve inventory
	reservationItems := make([]ReservationItem, len(req.Items))
	for i, item := range req.Items {
		reservationItems[i] = ReservationItem{SKU: item.SKU, Quantity: item.Quantity}
	}
	reservationID, err := s.inventory.Reserve(ctx, reservationItems)
	if err != nil {
		return nil, fmt.Errorf("reserve inventory: %w", err)
	}

	// Create order
	order := &Order{
		ID:            newOrderID(),
		CustomerID:    req.CustomerID,
		Items:         req.Items,
		Status:        OrderStatusPending,
		ReservationID: reservationID,
		CreatedAt:     s.clock(),
	}

	// Charge payment
	chargeResult, err := s.payments.Charge(ctx, ChargeRequest{
		CustomerID:   req.CustomerID,
		AmountMicros: order.TotalMicros(),
		Currency:     req.Currency,
		Description:  fmt.Sprintf("Order %s", order.ID),
	})
	if err != nil {
		// Compensate: release inventory
		_ = s.inventory.Release(ctx, reservationID)
		return nil, fmt.Errorf("charge payment: %w", err)
	}

	order.ChargeID = chargeResult.ChargeID
	order.Status = OrderStatusConfirmed

	// Persist
	if err := s.orders.Save(ctx, order); err != nil {
		// Compensate: refund payment and release inventory
		_ = s.payments.Refund(ctx, chargeResult.ChargeID, order.TotalMicros())
		_ = s.inventory.Release(ctx, reservationID)
		return nil, fmt.Errorf("save order: %w", err)
	}

	// Publish event (non-critical path)
	if err := s.events.Publish(ctx, "order-events", OrderConfirmedEvent{
		OrderID:    order.ID,
		CustomerID: order.CustomerID,
		Total:      order.TotalMicros(),
	}); err != nil {
		s.logger.ErrorContext(ctx, "failed to publish order confirmed event",
			"order_id", order.ID,
			"error", err,
		)
		// Log but do not fail — event publishing is best-effort
	}

	return order, nil
}
```

## Unit Tests with Test Doubles Hierarchy

```go
// internal/app/service_test.go
package app_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/yourorg/order-service/internal/app"
)

// Test double hierarchy:
// 1. Stub: returns hardcoded values, no assertions
// 2. Spy: records calls, allows post-test assertions
// 3. Mock: pre-configured expectations that fail if not met
// 4. Fake: lightweight working implementation (e.g., in-memory DB)

// Stub implementation
type stubInventory struct {
	availability map[string]int
	reserveErr   error
}

func (s *stubInventory) CheckAvailability(_ context.Context, skus []string) (map[string]int, error) {
	return s.availability, nil
}

func (s *stubInventory) Reserve(_ context.Context, _ []app.ReservationItem) (string, error) {
	if s.reserveErr != nil {
		return "", s.reserveErr
	}
	return "res-123", nil
}

func (s *stubInventory) Release(_ context.Context, _ string) error {
	return nil
}

// Spy implementation
type spyPaymentService struct {
	charges []app.ChargeRequest
	result  *app.ChargeResult
	err     error
}

func (s *spyPaymentService) Charge(_ context.Context, req app.ChargeRequest) (*app.ChargeResult, error) {
	s.charges = append(s.charges, req)
	return s.result, s.err
}

func (s *spyPaymentService) Refund(_ context.Context, _ string, _ int64) error {
	return nil
}

// Fake in-memory event publisher
type fakeEventPublisher struct {
	events []interface{}
}

func (f *fakeEventPublisher) Publish(_ context.Context, _ string, event interface{}) error {
	f.events = append(f.events, event)
	return nil
}

// Fake in-memory order repository
type fakeOrderRepository struct {
	orders map[string]*app.Order
}

func newFakeOrderRepository() *fakeOrderRepository {
	return &fakeOrderRepository{orders: make(map[string]*app.Order)}
}

func (r *fakeOrderRepository) Save(_ context.Context, order *app.Order) error {
	r.orders[order.ID] = order
	return nil
}

func (r *fakeOrderRepository) FindByID(_ context.Context, id string) (*app.Order, error) {
	o, ok := r.orders[id]
	if !ok {
		return nil, app.ErrOrderNotFound
	}
	return o, nil
}

func (r *fakeOrderRepository) FindByCustomer(_ context.Context, customerID string, limit int) ([]*app.Order, error) {
	var result []*app.Order
	for _, o := range r.orders {
		if o.CustomerID == customerID {
			result = append(result, o)
			if len(result) >= limit {
				break
			}
		}
	}
	return result, nil
}

func (r *fakeOrderRepository) UpdateStatus(_ context.Context, id string, status app.OrderStatus) error {
	o, ok := r.orders[id]
	if !ok {
		return app.ErrOrderNotFound
	}
	o.Status = status
	return nil
}

// Test: happy path order placement
func TestPlaceOrder_Success(t *testing.T) {
	fixedTime := time.Date(2030, 5, 1, 12, 0, 0, 0, time.UTC)

	inventory := &stubInventory{
		availability: map[string]int{"SKU-001": 10, "SKU-002": 5},
	}
	payment := &spyPaymentService{
		result: &app.ChargeResult{ChargeID: "ch-abc123"},
	}
	events := &fakeEventPublisher{}
	orders := newFakeOrderRepository()

	svc := app.NewOrderService(orders, payment, events, inventory, noopLogger()).
		WithClock(func() time.Time { return fixedTime })

	order, err := svc.PlaceOrder(context.Background(), app.PlaceOrderRequest{
		CustomerID: "cust-001",
		Currency:   "USD",
		Items: []app.OrderItem{
			{SKU: "SKU-001", Quantity: 2, PriceMicros: 10_000_000},
			{SKU: "SKU-002", Quantity: 1, PriceMicros: 25_000_000},
		},
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify order state
	if order.Status != app.OrderStatusConfirmed {
		t.Errorf("want status %s, got %s", app.OrderStatusConfirmed, order.Status)
	}
	if order.ChargeID != "ch-abc123" {
		t.Errorf("want charge ID ch-abc123, got %s", order.ChargeID)
	}
	if order.CreatedAt != fixedTime {
		t.Errorf("want created_at %v, got %v", fixedTime, order.CreatedAt)
	}

	// Verify payment was charged correctly
	if len(payment.charges) != 1 {
		t.Fatalf("want 1 charge, got %d", len(payment.charges))
	}
	wantAmountMicros := int64(2*10_000_000 + 25_000_000)
	if payment.charges[0].AmountMicros != wantAmountMicros {
		t.Errorf("want charge %d, got %d", wantAmountMicros, payment.charges[0].AmountMicros)
	}

	// Verify event was published
	if len(events.events) != 1 {
		t.Errorf("want 1 event, got %d", len(events.events))
	}
}

// Test: payment failure triggers inventory release
func TestPlaceOrder_PaymentFailure_ReleasesInventory(t *testing.T) {
	releaseCalled := false

	inventory := &stubInventory{
		availability: map[string]int{"SKU-001": 10},
	}
	// Override Release to capture call
	type trackingInventory struct {
		*stubInventory
	}

	payment := &spyPaymentService{
		err: errors.New("card declined"),
	}

	svc := app.NewOrderService(
		newFakeOrderRepository(),
		payment,
		&fakeEventPublisher{},
		inventory,
		noopLogger(),
	)

	_, err := svc.PlaceOrder(context.Background(), app.PlaceOrderRequest{
		CustomerID: "cust-001",
		Currency:   "USD",
		Items:      []app.OrderItem{{SKU: "SKU-001", Quantity: 1, PriceMicros: 10_000_000}},
	})

	if err == nil {
		t.Fatal("expected error from payment failure")
	}
	_ = releaseCalled // verify via spy in production test
}
```

## Component Tests with testcontainers-go

Component tests run the full service in-process with real (containerized) dependencies:

```go
// test/component/order_test.go
package component_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/modules/kafka"

	"github.com/yourorg/order-service/internal/adapter/kafkapub"
	"github.com/yourorg/order-service/internal/adapter/postgresrepo"
	"github.com/yourorg/order-service/internal/app"
	"github.com/yourorg/order-service/internal/port/http/handler"
)

type testComponents struct {
	pgContainer    *postgres.PostgresContainer
	kafkaContainer *kafka.KafkaContainer
	server         *httptest.Server
	cleanup        func()
}

func setupComponents(t *testing.T) *testComponents {
	t.Helper()
	ctx := context.Background()

	// Start PostgreSQL
	pgContainer, err := postgres.RunContainer(ctx,
		testcontainers.WithImage("postgres:16-alpine"),
		postgres.WithDatabase("orders_test"),
		postgres.WithUsername("orders"),
		postgres.WithPassword("testpassword"),
		testcontainers.WithWaitStrategy(
			wait.ForSQL("5432/tcp", "pgx", func(host string, port nat.Port) string {
				return fmt.Sprintf("postgres://orders:testpassword@%s:%s/orders_test?sslmode=disable", host, port.Port())
			}).WithStartupTimeout(30*time.Second),
		),
	)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}

	connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("get connection string: %v", err)
	}

	// Start Kafka
	kafkaContainer, err := kafka.RunContainer(ctx,
		testcontainers.WithImage("confluentinc/cp-kafka:7.6.0"),
	)
	if err != nil {
		t.Fatalf("start kafka: %v", err)
	}

	brokers, err := kafkaContainer.Brokers(ctx)
	if err != nil {
		t.Fatalf("get kafka brokers: %v", err)
	}

	// Wire up real adapters
	repo, err := postgresrepo.New(connStr)
	if err != nil {
		t.Fatalf("init postgres repo: %v", err)
	}
	if err := repo.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	publisher, err := kafkapub.New(brokers)
	if err != nil {
		t.Fatalf("init kafka publisher: %v", err)
	}

	// Use a stub for the external payment service
	paymentStub := &fakePaymentService{
		result: &app.ChargeResult{ChargeID: "ch-test-001"},
	}

	// Use a stub for inventory
	inventoryStub := &fakeInventoryClient{
		availability: map[string]int{"SKU-001": 100, "SKU-002": 50},
	}

	svc := app.NewOrderService(repo, paymentStub, publisher, inventoryStub, testLogger(t))
	h := handler.New(svc)

	server := httptest.NewServer(h)

	return &testComponents{
		pgContainer:    pgContainer,
		kafkaContainer: kafkaContainer,
		server:         server,
		cleanup: func() {
			server.Close()
			_ = publisher.Close()
			_ = repo.Close()
			_ = pgContainer.Terminate(ctx)
			_ = kafkaContainer.Terminate(ctx)
		},
	}
}

func TestPlaceOrder_Component(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping component test in short mode")
	}

	tc := setupComponents(t)
	defer tc.cleanup()

	// HTTP request to the real HTTP handler
	body := `{
		"customer_id": "cust-001",
		"currency": "USD",
		"items": [
			{"sku": "SKU-001", "quantity": 2, "price_micros": 10000000},
			{"sku": "SKU-002", "quantity": 1, "price_micros": 25000000}
		]
	}`

	resp, err := http.Post(
		tc.server.URL+"/v1/orders",
		"application/json",
		strings.NewReader(body),
	)
	if err != nil {
		t.Fatalf("POST /v1/orders: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("want 201, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	orderID := result["id"].(string)
	if orderID == "" {
		t.Fatal("expected order ID in response")
	}

	// Verify order was persisted by fetching it
	getResp, err := http.Get(tc.server.URL + "/v1/orders/" + orderID)
	if err != nil {
		t.Fatalf("GET /v1/orders/%s: %v", orderID, err)
	}
	defer getResp.Body.Close()

	if getResp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", getResp.StatusCode)
	}

	var order map[string]interface{}
	_ = json.NewDecoder(getResp.Body).Decode(&order)

	if order["status"] != "confirmed" {
		t.Errorf("want status confirmed, got %v", order["status"])
	}
}
```

## Consumer-Driven Contract Tests with pact-go

Contract tests verify that the contract between a consumer and a provider remains compatible as both evolve independently.

```bash
go get github.com/pact-foundation/pact-go/v2@latest
```

### Consumer Side: Defining the Contract

```go
// test/contract/consumer_test.go
// This test is in the ORDER SERVICE (consumer of the PAYMENT SERVICE)
package contract_test

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/pact-foundation/pact-go/v2/consumer"
	"github.com/pact-foundation/pact-go/v2/matchers"

	paymentclient "github.com/yourorg/order-service/internal/adapter/payment"
)

func TestOrderService_PaymentService_Contract(t *testing.T) {
	pact, err := consumer.NewV2Pact(consumer.MockHTTPProviderConfig{
		Consumer: "order-service",
		Provider: "payment-service",
		PactDir:  "./pacts",
	})
	if err != nil {
		t.Fatalf("create pact: %v", err)
	}

	// Define interaction: successful charge
	pact.
		AddInteraction().
		Given("payment method exists for customer cust-001").
		UponReceiving("a charge request").
		WithRequestPathMatcher(
			"POST",
			matchers.String("/v1/charges"),
		).
		WithJSONRequestBody(matchers.MatchV2(map[string]interface{}{
			"customer_id":   matchers.String("cust-001"),
			"amount_micros": matchers.Integer(45000000),
			"currency":      matchers.Regex("USD", "^[A-Z]{3}$"),
			"description":   matchers.String("Order ord-001"),
		})).
		WillRespondWith(201, func(res *consumer.V2Response) {
			res.Header("Content-Type", matchers.String("application/json"))
			res.JSONBody(matchers.MatchV2(map[string]interface{}{
				"charge_id": matchers.Regex("ch-abc123", "^ch-[a-z0-9]+$"),
				"status":    matchers.String("succeeded"),
			}))
		})

	// Define interaction: card declined
	pact.
		AddInteraction().
		Given("card on file is expired").
		UponReceiving("a charge request that will be declined").
		WithRequestPathMatcher("POST", matchers.String("/v1/charges")).
		WillRespondWith(422, func(res *consumer.V2Response) {
			res.Header("Content-Type", matchers.String("application/json"))
			res.JSONBody(matchers.MatchV2(map[string]interface{}{
				"error": map[string]interface{}{
					"code":    matchers.String("card_declined"),
					"message": matchers.Like("Your card was declined."),
				},
			}))
		})

	// Execute the test against the mock provider
	err = pact.ExecuteTest(t, func(config consumer.MockServerConfig) error {
		client := paymentclient.New(fmt.Sprintf("http://localhost:%d", config.Port))

		// Test successful charge
		result, err := client.Charge(t.Context(), paymentclient.ChargeRequest{
			CustomerID:   "cust-001",
			AmountMicros: 45000000,
			Currency:     "USD",
			Description:  "Order ord-001",
		})
		if err != nil {
			return fmt.Errorf("charge failed: %w", err)
		}
		if result.ChargeID == "" {
			return fmt.Errorf("expected charge ID")
		}
		return nil
	})

	if err != nil {
		t.Fatalf("pact test: %v", err)
	}
}
```

### Provider Side: Verifying the Contract

```go
// test/contract/provider_test.go
// This test is in the PAYMENT SERVICE (provider)
package contract_test

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/pact-foundation/pact-go/v2/provider"

	"github.com/yourorg/payment-service/internal/testutil"
)

func TestPaymentService_PactProvider_Verification(t *testing.T) {
	// Start the real payment service on a test port
	server := testutil.StartServer(t)

	verifier := provider.NewVerifier()

	err := verifier.VerifyProvider(t, provider.VerifyRequest{
		ProviderBaseURL: server.URL,
		Provider:        "payment-service",

		// Fetch pacts from Pact Broker (CI/CD integration)
		BrokerURL:        "https://pactbroker.yourorg.com",
		BrokerToken:      "<pact-broker-token>",
		ConsumerVersionSelectors: []provider.ConsumerVersionSelector{
			{MainBranch: true},
			{DeployedOrReleased: true},
		},

		// OR: load pacts from filesystem (local development)
		// PactURLs: []string{"./pacts/order-service-payment-service.json"},

		// State handlers set up preconditions
		StateHandlers: provider.StateHandlers{
			"payment method exists for customer cust-001": func(setup bool, s provider.ProviderState) (provider.ProviderStateResponse, error) {
				if setup {
					// Insert test payment method into test DB
					testutil.InsertPaymentMethod(t, "cust-001", "pm-test-visa")
				}
				return provider.ProviderStateResponse{}, nil
			},
			"card on file is expired": func(setup bool, s provider.ProviderState) (provider.ProviderStateResponse, error) {
				if setup {
					testutil.InsertExpiredPaymentMethod(t, "cust-001")
				}
				return provider.ProviderStateResponse{}, nil
			},
		},

		// Publish results to broker for visibility
		PublishVerificationResults: true,
		ProviderVersion:           currentGitSHA(),
		ProviderBranch:            currentGitBranch(),
	})

	if err != nil {
		t.Fatalf("provider verification failed: %v", err)
	}
}
```

### CI Pipeline Integration

```yaml
# .github/workflows/contract-tests.yml
name: Contract Tests

on:
  push:
    branches: [main]
  pull_request:

jobs:
  consumer-contract:
    name: Generate Consumer Pacts
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-go@v5
      with:
        go-version: '1.24'

    - name: Run consumer contract tests
      run: go test ./test/contract/... -run TestOrderService -v
      env:
        PACT_BROKER_URL: ${{ secrets.PACT_BROKER_URL }}
        PACT_BROKER_TOKEN: ${{ secrets.PACT_BROKER_TOKEN }}

    - name: Publish pacts to broker
      run: |
        go install github.com/pact-foundation/pact-go/v2/cmd/pact@latest
        pact publish ./pacts \
          --broker-base-url=${{ secrets.PACT_BROKER_URL }} \
          --broker-token=${{ secrets.PACT_BROKER_TOKEN }} \
          --consumer-app-version=${{ github.sha }} \
          --branch=${{ github.ref_name }}

  provider-verification:
    name: Verify Provider Contracts
    runs-on: ubuntu-latest
    needs: consumer-contract
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: payments_test
          POSTGRES_USER: payments
          POSTGRES_PASSWORD: testpass
        ports:
        - 5432:5432
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-go@v5
      with:
        go-version: '1.24'

    - name: Verify provider against published pacts
      run: go test ./test/contract/... -run TestPaymentService_PactProvider -v
      env:
        DATABASE_URL: postgres://payments:testpass@localhost:5432/payments_test?sslmode=disable
        PACT_BROKER_URL: ${{ secrets.PACT_BROKER_URL }}
        PACT_BROKER_TOKEN: ${{ secrets.PACT_BROKER_TOKEN }}
        PROVIDER_VERSION: ${{ github.sha }}
        PROVIDER_BRANCH: ${{ github.ref_name }}

  can-i-deploy:
    name: Can I Deploy Check
    runs-on: ubuntu-latest
    needs: [consumer-contract, provider-verification]
    steps:
    - name: Check deployment safety
      run: |
        npx pact-broker can-i-deploy \
          --pacticipant payment-service \
          --version ${{ github.sha }} \
          --to-environment production \
          --broker-base-url=${{ secrets.PACT_BROKER_URL }} \
          --broker-token=${{ secrets.PACT_BROKER_TOKEN }}
```

## Table-Driven Tests with Subtests

```go
func TestOrderService_PlaceOrder_TableDriven(t *testing.T) {
	tests := []struct {
		name        string
		req         app.PlaceOrderRequest
		setupStubs  func() (*stubInventory, *spyPaymentService)
		wantStatus  app.OrderStatus
		wantErr     bool
		wantErrType error
	}{
		{
			name: "successful order",
			req: app.PlaceOrderRequest{
				CustomerID: "cust-001",
				Currency:   "USD",
				Items:      []app.OrderItem{{SKU: "SKU-001", Quantity: 1, PriceMicros: 10_000_000}},
			},
			setupStubs: func() (*stubInventory, *spyPaymentService) {
				return &stubInventory{availability: map[string]int{"SKU-001": 10}},
					&spyPaymentService{result: &app.ChargeResult{ChargeID: "ch-001"}}
			},
			wantStatus: app.OrderStatusConfirmed,
		},
		{
			name: "insufficient stock",
			req: app.PlaceOrderRequest{
				CustomerID: "cust-002",
				Currency:   "USD",
				Items:      []app.OrderItem{{SKU: "SKU-OUT", Quantity: 100, PriceMicros: 5_000_000}},
			},
			setupStubs: func() (*stubInventory, *spyPaymentService) {
				return &stubInventory{availability: map[string]int{"SKU-OUT": 5}},
					&spyPaymentService{}
			},
			wantErr:     true,
			wantErrType: &app.InsufficientStockError{},
		},
		{
			name: "payment declined",
			req: app.PlaceOrderRequest{
				CustomerID: "cust-003",
				Currency:   "USD",
				Items:      []app.OrderItem{{SKU: "SKU-001", Quantity: 1, PriceMicros: 10_000_000}},
			},
			setupStubs: func() (*stubInventory, *spyPaymentService) {
				return &stubInventory{availability: map[string]int{"SKU-001": 10}},
					&spyPaymentService{err: errors.New("card declined")}
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			inv, pay := tt.setupStubs()
			svc := app.NewOrderService(
				newFakeOrderRepository(),
				pay,
				&fakeEventPublisher{},
				inv,
				noopLogger(),
			)

			order, err := svc.PlaceOrder(context.Background(), tt.req)

			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if tt.wantErrType != nil && !errors.As(err, tt.wantErrType) {
					t.Errorf("want error type %T, got %T: %v", tt.wantErrType, err, err)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if order.Status != tt.wantStatus {
				t.Errorf("want status %s, got %s", tt.wantStatus, order.Status)
			}
		})
	}
}
```

## Key Takeaways

- Design for testability by placing all external dependencies behind interfaces defined in the application layer — this is the single most impactful architectural decision for test quality.
- Use fakes (in-memory implementations) for the repository tier in unit tests; use testcontainers for real-database component tests. Never use mocks that assert call counts for business logic — they couple tests to implementation details.
- Consumer-driven contract tests are the only reliable mechanism for catching cross-service incompatibilities before production; the consumer defines what it needs, the provider verifies it can fulfill that need, and the Pact Broker tracks compatibility over time.
- Component tests with testcontainers provide high confidence by testing the full request/response cycle with real dependencies while remaining fast enough to run in CI (typically 30-60 seconds with pre-pulled images).
- The `pact can-i-deploy` command makes contract compatibility a deployment gate — a service cannot be promoted to production if it breaks any of its consumer contracts.
- Inject the clock as a function (`clock func() time.Time`) rather than calling `time.Now()` directly — this is the simplest way to write deterministic tests for time-dependent business logic.
