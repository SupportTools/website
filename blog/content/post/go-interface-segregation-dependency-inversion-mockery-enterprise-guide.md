---
title: "Go Interface Segregation in Large Codebases: Dependency Inversion, Mock Generation with mockery, and testify Expectations"
date: 2031-12-06T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Testing", "Interfaces", "mockery", "testify", "Software Design", "SOLID"]
categories: ["Go", "Software Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to applying interface segregation and dependency inversion in large Go codebases, with production patterns for mock generation using mockery, testify suite organization, and avoiding common interface anti-patterns."
more_link: "yes"
url: "/go-interface-segregation-dependency-inversion-mockery-enterprise-guide/"
---

In large Go codebases, interfaces are the primary mechanism for decoupling components, enabling parallel development, and making code testable without a running database or external service. Done wrong, you end up with interfaces that mirror struct method sets one-to-one — creating coupling under a different name. Done right, small consumer-defined interfaces combined with dependency inversion lead to code that is composable, independently testable, and resilient to upstream API changes.

<!--more-->

# Go Interface Segregation: Enterprise Patterns

## The Interface Segregation Principle in Go

The Interface Segregation Principle (ISP) states that no client should be forced to depend on methods it does not use. In Go, this maps directly to the language's structural typing: define the smallest interface that satisfies your consumer's requirements, not the largest interface that an implementation happens to provide.

### Anti-Pattern: Producer-Defined Monolith Interface

```go
// BAD: the implementation defines this interface, not the consumer
// Everything that needs a UserStore must depend on ALL these methods
package store

type UserStore interface {
    CreateUser(ctx context.Context, u User) (User, error)
    GetUser(ctx context.Context, id string) (User, error)
    UpdateUser(ctx context.Context, id string, patch UserPatch) (User, error)
    DeleteUser(ctx context.Context, id string) error
    ListUsers(ctx context.Context, filter UserFilter) ([]User, error)
    CountUsers(ctx context.Context, filter UserFilter) (int64, error)
    SearchUsers(ctx context.Context, query string) ([]User, error)
    GetUserByEmail(ctx context.Context, email string) (User, error)
    GetUsersByOrg(ctx context.Context, orgID string) ([]User, error)
    UpdateUserPassword(ctx context.Context, id string, hash string) error
    CreateSession(ctx context.Context, s Session) (Session, error)
    GetSession(ctx context.Context, token string) (Session, error)
    DeleteSession(ctx context.Context, token string) error
    ListSessions(ctx context.Context, userID string) ([]Session, error)
}
```

A handler that only reads users must now mock 14 methods to test a function that calls `GetUser` once. When the store adds `ArchiveUser`, every mock in the codebase must be regenerated. This is the anti-pattern.

### Pattern: Consumer-Defined Narrow Interfaces

```go
// GOOD: each consumer defines exactly what it needs

// cmd/api/handler/profile.go
package handler

// ProfileReader is all the profile handler needs.
// Defined in the consumer package, not the store package.
type ProfileReader interface {
    GetUser(ctx context.Context, id string) (store.User, error)
}

type ProfileHandler struct {
    users ProfileReader
    log   *slog.Logger
}

func NewProfileHandler(users ProfileReader, log *slog.Logger) *ProfileHandler {
    return &ProfileHandler{users: users, log: log}
}

func (h *ProfileHandler) GetProfile(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id")
    user, err := h.users.GetUser(r.Context(), id)
    if err != nil {
        h.log.ErrorContext(r.Context(), "fetch user", "id", id, "err", err)
        http.Error(w, "not found", http.StatusNotFound)
        return
    }
    json.NewEncoder(w).Encode(user)
}
```

```go
// cmd/api/handler/admin.go
package handler

// AdminUserManager is what the admin handler needs
type AdminUserManager interface {
    ListUsers(ctx context.Context, filter store.UserFilter) ([]store.User, error)
    DeleteUser(ctx context.Context, id string) error
    UpdateUser(ctx context.Context, id string, patch store.UserPatch) (store.User, error)
}
```

Now `*store.PostgresUserStore` satisfies both interfaces implicitly, without being imported by either handler package. You can test each handler by mocking only the methods it actually calls.

## Dependency Inversion in Service Layers

### Structuring the Dependency Graph

```
cmd/api/main.go
    |
    +-- wire up concrete types
    |
    v
internal/handler/     (depends on interfaces)
    ^
    |
internal/service/     (depends on interfaces, implements business logic)
    ^
    |
internal/store/       (concrete implementations; no interface deps on upper layers)
```

The rule: **higher layers define interfaces; lower layers implement them.** The `store` package never imports `handler` or `service`.

### Service Layer Example

```go
// internal/service/payment/service.go
package payment

import (
    "context"
    "time"
)

// These interfaces are defined HERE, consumed by this service.
// The implementations live in store/, gateway/, etc.

type OrderReader interface {
    GetOrder(ctx context.Context, id string) (Order, error)
}

type OrderWriter interface {
    UpdateOrderStatus(ctx context.Context, id string, status OrderStatus) error
}

type PaymentGateway interface {
    Charge(ctx context.Context, req ChargeRequest) (ChargeResponse, error)
    Refund(ctx context.Context, chargeID string, amount int64) error
}

type AuditLogger interface {
    LogPaymentEvent(ctx context.Context, event PaymentEvent) error
}

// Service composes the interfaces it needs
type Service struct {
    orders  interface {
        OrderReader
        OrderWriter
    }
    gateway PaymentGateway
    audit   AuditLogger
    clock   func() time.Time
}

func NewService(
    orders interface {
        OrderReader
        OrderWriter
    },
    gateway PaymentGateway,
    audit AuditLogger,
) *Service {
    return &Service{
        orders:  orders,
        gateway: gateway,
        audit:   audit,
        clock:   time.Now,
    }
}

func (s *Service) ProcessPayment(ctx context.Context, orderID string, card CardDetails) error {
    order, err := s.orders.GetOrder(ctx, orderID)
    if err != nil {
        return fmt.Errorf("get order %s: %w", orderID, err)
    }
    if order.Status != OrderStatusPending {
        return fmt.Errorf("order %s is not pending (status=%s)", orderID, order.Status)
    }

    charge, err := s.gateway.Charge(ctx, ChargeRequest{
        Amount:   order.TotalCents,
        Currency: order.Currency,
        Card:     card,
    })
    if err != nil {
        _ = s.audit.LogPaymentEvent(ctx, PaymentEvent{
            OrderID:   orderID,
            Type:      EventTypeChargeFailed,
            Timestamp: s.clock(),
            Error:     err.Error(),
        })
        return fmt.Errorf("charge card: %w", err)
    }

    if err := s.orders.UpdateOrderStatus(ctx, orderID, OrderStatusPaid); err != nil {
        // Attempt refund to avoid charging without completing the order
        _ = s.gateway.Refund(ctx, charge.ID, order.TotalCents)
        return fmt.Errorf("update order status: %w", err)
    }

    return s.audit.LogPaymentEvent(ctx, PaymentEvent{
        OrderID:   orderID,
        Type:      EventTypeChargeSucceeded,
        ChargeID:  charge.ID,
        Timestamp: s.clock(),
    })
}
```

## Mock Generation with mockery v2

### Installation and Configuration

```bash
go install github.com/vektra/mockery/v2@latest

# Verify installation
mockery --version
```

Create `.mockery.yaml` at the project root to configure generation:

```yaml
# .mockery.yaml
with-expecter: true          # generate typed .EXPECT() methods
mockname: "Mock{{.InterfaceName}}"
filename: "mock_{{.InterfaceName | snakecase}}.go"
dir: "{{.InterfaceDir}}/mocks"
outpkg: "mocks"
log-level: warn
disable-version-string: true
packages:
  github.com/example/paymentservice/internal/service/payment:
    interfaces:
      OrderReader:
      OrderWriter:
      PaymentGateway:
      AuditLogger:
  github.com/example/paymentservice/internal/handler:
    interfaces:
      ProfileReader:
      AdminUserManager:
```

Generate mocks:

```bash
mockery
```

This creates files like:

```
internal/service/payment/mocks/mock_order_reader.go
internal/service/payment/mocks/mock_payment_gateway.go
internal/handler/mocks/mock_profile_reader.go
```

### Generated Mock Structure

The generated mock with `with-expecter: true` looks like:

```go
// Code generated by mockery v2.x.x. DO NOT EDIT.
package mocks

import (
    "context"

    mock "github.com/stretchr/testify/mock"

    payment "github.com/example/paymentservice/internal/service/payment"
)

type MockPaymentGateway struct {
    mock.Mock
}

type MockPaymentGateway_Expecter struct {
    mock *mock.Mock
}

func (_m *MockPaymentGateway) EXPECT() *MockPaymentGateway_Expecter {
    return &MockPaymentGateway_Expecter{mock: &_m.Mock}
}

func (_m *MockPaymentGateway) Charge(ctx context.Context, req payment.ChargeRequest) (payment.ChargeResponse, error) {
    _va := []interface{}{ctx, req}
    ret := _m.Called(_va...)
    var r0 payment.ChargeResponse
    if rf, ok := ret.Get(0).(func(context.Context, payment.ChargeRequest) payment.ChargeResponse); ok {
        r0 = rf(ctx, req)
    } else {
        r0 = ret.Get(0).(payment.ChargeResponse)
    }
    var r1 error
    if rf, ok := ret.Get(1).(func(context.Context, payment.ChargeRequest) error); ok {
        r1 = rf(ctx, req)
    } else {
        r1 = ret.Error(1)
    }
    return r0, r1
}

// Typed expecter — no string method names
func (_e *MockPaymentGateway_Expecter) Charge(ctx interface{}, req interface{}) *MockPaymentGateway_Charge_Call {
    return &MockPaymentGateway_Charge_Call{Call: _e.mock.On("Charge", ctx, req)}
}

type MockPaymentGateway_Charge_Call struct {
    *mock.Call
}

func (_c *MockPaymentGateway_Charge_Call) Return(_a0 payment.ChargeResponse, _a1 error) *MockPaymentGateway_Charge_Call {
    _c.Call.Return(_a0, _a1)
    return _c
}

func (_c *MockPaymentGateway_Charge_Call) RunAndReturn(run func(context.Context, payment.ChargeRequest) (payment.ChargeResponse, error)) *MockPaymentGateway_Charge_Call {
    _c.Call.Return(run)
    return _c
}
```

## Writing Tests with testify Expectations

### Basic Test Pattern

```go
// internal/service/payment/service_test.go
package payment_test

import (
    "context"
    "errors"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
    "github.com/stretchr/testify/require"

    "github.com/example/paymentservice/internal/service/payment"
    "github.com/example/paymentservice/internal/service/payment/mocks"
)

func TestService_ProcessPayment_Success(t *testing.T) {
    // Arrange
    ctx := context.Background()
    orderID := "order-123"
    fixedTime := time.Date(2031, 12, 6, 10, 0, 0, 0, time.UTC)

    mockOrders := mocks.NewMockOrderReadWriter(t)
    mockGateway := mocks.NewMockPaymentGateway(t)
    mockAudit := mocks.NewMockAuditLogger(t)

    // Use typed EXPECT() — compile-time method name verification
    mockOrders.EXPECT().
        GetOrder(ctx, orderID).
        Return(payment.Order{
            ID:         orderID,
            Status:     payment.OrderStatusPending,
            TotalCents: 4999,
            Currency:   "USD",
        }, nil).
        Once()

    mockGateway.EXPECT().
        Charge(ctx, payment.ChargeRequest{
            Amount:   4999,
            Currency: "USD",
            Card:     testCard(),
        }).
        Return(payment.ChargeResponse{ID: "ch_abc123"}, nil).
        Once()

    mockOrders.EXPECT().
        UpdateOrderStatus(ctx, orderID, payment.OrderStatusPaid).
        Return(nil).
        Once()

    mockAudit.EXPECT().
        LogPaymentEvent(ctx, mock.MatchedBy(func(e payment.PaymentEvent) bool {
            return e.OrderID == orderID &&
                e.Type == payment.EventTypeChargeSucceeded &&
                e.ChargeID == "ch_abc123" &&
                e.Timestamp.Equal(fixedTime)
        })).
        Return(nil).
        Once()

    svc := payment.NewService(mockOrders, mockGateway, mockAudit)
    // Inject fixed clock for deterministic timestamp assertions
    svc.SetClock(func() time.Time { return fixedTime })

    // Act
    err := svc.ProcessPayment(ctx, orderID, testCard())

    // Assert
    require.NoError(t, err)
    // testify/mock asserts all expectations were met in t.Cleanup via NewMock(t)
}
```

### Testing the Refund Compensation Path

```go
func TestService_ProcessPayment_UpdateStatusFails_RefundsCharge(t *testing.T) {
    ctx := context.Background()
    orderID := "order-456"
    chargeID := "ch_xyz789"

    mockOrders := mocks.NewMockOrderReadWriter(t)
    mockGateway := mocks.NewMockPaymentGateway(t)
    mockAudit := mocks.NewMockAuditLogger(t)

    mockOrders.EXPECT().
        GetOrder(ctx, orderID).
        Return(payment.Order{
            ID: orderID, Status: payment.OrderStatusPending,
            TotalCents: 2000, Currency: "USD",
        }, nil)

    mockGateway.EXPECT().
        Charge(mock.Anything, mock.Anything).
        Return(payment.ChargeResponse{ID: chargeID}, nil)

    // UpdateOrderStatus fails — should trigger refund
    dbErr := errors.New("connection reset")
    mockOrders.EXPECT().
        UpdateOrderStatus(ctx, orderID, payment.OrderStatusPaid).
        Return(dbErr)

    // Refund must be called with the charge ID and the order amount
    mockGateway.EXPECT().
        Refund(ctx, chargeID, int64(2000)).
        Return(nil).
        Once()

    // Audit is NOT expected to be called (charge failed from business perspective)

    svc := payment.NewService(mockOrders, mockGateway, mockAudit)
    err := svc.ProcessPayment(ctx, orderID, testCard())

    require.Error(t, err)
    assert.ErrorContains(t, err, "update order status")
    assert.ErrorContains(t, err, "connection reset")
}
```

### Table-Driven Tests with Typed Mocks

```go
func TestService_ProcessPayment_InvalidStates(t *testing.T) {
    tests := []struct {
        name          string
        orderStatus   payment.OrderStatus
        expectCharge  bool
        expectedError string
    }{
        {
            name:          "already paid",
            orderStatus:   payment.OrderStatusPaid,
            expectCharge:  false,
            expectedError: "not pending",
        },
        {
            name:          "cancelled order",
            orderStatus:   payment.OrderStatusCancelled,
            expectCharge:  false,
            expectedError: "not pending",
        },
        {
            name:          "refunded order",
            orderStatus:   payment.OrderStatusRefunded,
            expectCharge:  false,
            expectedError: "not pending",
        },
    }

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            ctx := context.Background()
            orderID := "order-789"

            mockOrders := mocks.NewMockOrderReadWriter(t)
            mockGateway := mocks.NewMockPaymentGateway(t)
            mockAudit := mocks.NewMockAuditLogger(t)

            mockOrders.EXPECT().
                GetOrder(ctx, orderID).
                Return(payment.Order{
                    ID:     orderID,
                    Status: tc.orderStatus,
                }, nil)

            // mockGateway.EXPECT().Charge is NOT set — if called, test fails
            // This verifies the guard logic without explicit "never called" assertions

            svc := payment.NewService(mockOrders, mockGateway, mockAudit)
            err := svc.ProcessPayment(ctx, orderID, testCard())

            require.Error(t, err)
            assert.ErrorContains(t, err, tc.expectedError)
        })
    }
}
```

### Using mock.MatchedBy for Complex Argument Matching

```go
// Verify a struct argument satisfies a predicate without specifying all fields
mockGateway.EXPECT().
    Charge(
        mock.Anything, // context — don't care about value
        mock.MatchedBy(func(req payment.ChargeRequest) bool {
            return req.Amount > 0 &&
                req.Currency == "USD" &&
                req.Card.Number != "" &&
                req.Card.CVV != ""
        }),
    ).
    Return(payment.ChargeResponse{ID: "ch_test"}, nil)
```

### Using mock.AnythingOfType

```go
// When you need to verify type but not value
mockAudit.EXPECT().
    LogPaymentEvent(
        mock.AnythingOfType("*context.valueCtx"),
        mock.AnythingOfType("payment.PaymentEvent"),
    ).
    Return(nil)
```

### Capturing Arguments for Post-Call Assertion

```go
// Capture what was actually passed for detailed assertions
var capturedEvent payment.PaymentEvent

mockAudit.EXPECT().
    LogPaymentEvent(mock.Anything, mock.Anything).
    Run(func(ctx context.Context, event payment.PaymentEvent) {
        capturedEvent = event
    }).
    Return(nil)

// ... run the code under test ...

assert.Equal(t, orderID, capturedEvent.OrderID)
assert.Equal(t, payment.EventTypeChargeSucceeded, capturedEvent.Type)
assert.WithinDuration(t, time.Now(), capturedEvent.Timestamp, 2*time.Second)
```

## Test Suite Organization with testify/suite

For complex service tests with shared setup:

```go
// internal/service/payment/service_suite_test.go
package payment_test

import (
    "context"
    "testing"
    "time"

    "github.com/stretchr/testify/suite"

    "github.com/example/paymentservice/internal/service/payment"
    "github.com/example/paymentservice/internal/service/payment/mocks"
)

type PaymentServiceSuite struct {
    suite.Suite

    ctx         context.Context
    fixedTime   time.Time
    mockOrders  *mocks.MockOrderReadWriter
    mockGateway *mocks.MockPaymentGateway
    mockAudit   *mocks.MockAuditLogger
    svc         *payment.Service
}

func (s *PaymentServiceSuite) SetupTest() {
    s.ctx = context.Background()
    s.fixedTime = time.Date(2031, 12, 6, 12, 0, 0, 0, time.UTC)

    // NewMock(s.T()) registers automatic expectation assertion in t.Cleanup
    s.mockOrders = mocks.NewMockOrderReadWriter(s.T())
    s.mockGateway = mocks.NewMockPaymentGateway(s.T())
    s.mockAudit = mocks.NewMockAuditLogger(s.T())

    s.svc = payment.NewService(s.mockOrders, s.mockGateway, s.mockAudit)
    s.svc.SetClock(func() time.Time { return s.fixedTime })
}

func (s *PaymentServiceSuite) TestProcessPayment_Success() {
    order := s.pendingOrder("order-001", 5000)

    s.mockOrders.EXPECT().GetOrder(s.ctx, order.ID).Return(order, nil)
    s.mockGateway.EXPECT().Charge(s.ctx, mock.Anything).
        Return(payment.ChargeResponse{ID: "ch_001"}, nil)
    s.mockOrders.EXPECT().UpdateOrderStatus(s.ctx, order.ID, payment.OrderStatusPaid).
        Return(nil)
    s.mockAudit.EXPECT().LogPaymentEvent(s.ctx, mock.Anything).Return(nil)

    err := s.svc.ProcessPayment(s.ctx, order.ID, testCard())
    s.NoError(err)
}

func (s *PaymentServiceSuite) TestProcessPayment_GatewayTimeout() {
    order := s.pendingOrder("order-002", 1000)

    s.mockOrders.EXPECT().GetOrder(s.ctx, order.ID).Return(order, nil)
    s.mockGateway.EXPECT().Charge(s.ctx, mock.Anything).
        Return(payment.ChargeResponse{}, payment.ErrGatewayTimeout)
    s.mockAudit.EXPECT().LogPaymentEvent(s.ctx, mock.MatchedBy(func(e payment.PaymentEvent) bool {
        return e.Type == payment.EventTypeChargeFailed
    })).Return(nil)

    err := s.svc.ProcessPayment(s.ctx, order.ID, testCard())
    s.ErrorIs(err, payment.ErrGatewayTimeout)
}

// Helper to reduce test boilerplate
func (s *PaymentServiceSuite) pendingOrder(id string, cents int64) payment.Order {
    return payment.Order{
        ID:         id,
        Status:     payment.OrderStatusPending,
        TotalCents: cents,
        Currency:   "USD",
    }
}

func TestPaymentServiceSuite(t *testing.T) {
    suite.Run(t, new(PaymentServiceSuite))
}
```

## Interface Composition Patterns

### Embedding Interfaces for Focused Mocking

```go
// Define atomic interfaces
type Reader interface {
    Get(ctx context.Context, id string) (Record, error)
    List(ctx context.Context, filter Filter) ([]Record, error)
}

type Writer interface {
    Create(ctx context.Context, r Record) (Record, error)
    Update(ctx context.Context, id string, patch Patch) (Record, error)
    Delete(ctx context.Context, id string) error
}

// Compose for services that need both
type ReadWriter interface {
    Reader
    Writer
}

// A backup service only needs reading
type BackupService struct {
    store Reader
}

// An import service only needs writing
type ImportService struct {
    store Writer
}

// The admin API needs both
type AdminService struct {
    store ReadWriter
}
```

### The Functional Options Pattern for Test Injection

```go
// service.go
type Service struct {
    db      DBQuerier
    cache   CacheStore
    metrics MetricsRecorder
    clock   func() time.Time
    logger  *slog.Logger
}

type Option func(*Service)

func WithClock(fn func() time.Time) Option {
    return func(s *Service) { s.clock = fn }
}

func WithLogger(l *slog.Logger) Option {
    return func(s *Service) { s.logger = l }
}

func NewService(db DBQuerier, cache CacheStore, metrics MetricsRecorder, opts ...Option) *Service {
    s := &Service{
        db:      db,
        cache:   cache,
        metrics: metrics,
        clock:   time.Now,
        logger:  slog.Default(),
    }
    for _, opt := range opts {
        opt(s)
    }
    return s
}
```

```go
// service_test.go
func TestService_WithFixedClock(t *testing.T) {
    fixedNow := time.Date(2031, 12, 6, 0, 0, 0, 0, time.UTC)
    svc := NewService(
        mocks.NewMockDBQuerier(t),
        mocks.NewMockCacheStore(t),
        mocks.NewMockMetricsRecorder(t),
        WithClock(func() time.Time { return fixedNow }),
        WithLogger(slog.New(slog.NewTextHandler(io.Discard, nil))),
    )
    // ...
}
```

## Avoiding Common Interface Pitfalls

### Pitfall 1: Interface Pollution from Embedding `context.Context`

Never embed `context.Context` in a struct or interface. Pass it as a parameter:

```go
// WRONG
type RequestContext interface {
    context.Context
    UserID() string
    OrgID() string
}

// RIGHT
type AuthClaims struct {
    UserID string
    OrgID  string
}

func GetUser(ctx context.Context, claims AuthClaims, id string) (User, error)
```

### Pitfall 2: Returning Concrete Types from Interface Methods

```go
// WRONG — forces the caller to import the concrete type
type UserService interface {
    GetUser(ctx context.Context, id string) (*postgres.UserRow, error)
}

// RIGHT — domain type defined in the service package
type UserService interface {
    GetUser(ctx context.Context, id string) (User, error)
}
```

### Pitfall 3: Accepting Interfaces for Primitive Values

```go
// WRONG — unnecessary interface
type IDProvider interface {
    GetID() string
}

// RIGHT — just accept the string
func DeleteUser(ctx context.Context, id string) error
```

### Pitfall 4: Mocking What You Do Not Own

Do not write mocks for types from third-party packages. Wrap them behind your own interface:

```go
// WRONG: mocking *sql.DB or *redis.Client directly
// RIGHT: wrap behind a narrow interface

// internal/store/db.go
type DBQuerier interface {
    QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error)
    ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error)
    QueryRowContext(ctx context.Context, query string, args ...interface{}) *sql.Row
}

// In tests, mock DBQuerier — not *sql.DB
```

## Running and Maintaining Mocks in CI

### Makefile Targets

```makefile
.PHONY: mocks
mocks:
	mockery
	@echo "Mocks regenerated"

.PHONY: mocks-check
mocks-check:
	@git diff --quiet internal/*/mocks/ || \
	  (echo "ERROR: Mocks are out of date. Run 'make mocks' and commit." && exit 1)
```

### GitHub Actions CI Check

```yaml
name: Check Generated Mocks

on:
  pull_request:
    paths:
      - "internal/**/*.go"
      - ".mockery.yaml"

jobs:
  check-mocks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"

      - name: Install mockery
        run: go install github.com/vektra/mockery/v2@latest

      - name: Regenerate mocks
        run: mockery

      - name: Check for changes
        run: |
          if ! git diff --quiet; then
            echo "Generated mocks are out of date:"
            git diff --stat
            echo ""
            echo "Run 'make mocks' and commit the regenerated files."
            exit 1
          fi
```

## Summary

Go's structural typing enables consumer-defined interfaces that decouple packages without coordination overhead. The key discipline is: interfaces belong in the package that uses them, not the package that implements them. mockery v2 with `with-expecter: true` generates typed `.EXPECT()` chains that catch method renames at compile time rather than test runtime. testify suites centralize mock setup, and table-driven tests with `mock.MatchedBy` assertions validate business logic without coupling tests to irrelevant implementation details. Keep interfaces to one or two methods unless you have a genuine reason to group behaviors, and always verify that every method on a mock interface is actually called — or explicitly confirm it should not be called — so that tests remain honest about the behavior they cover.
