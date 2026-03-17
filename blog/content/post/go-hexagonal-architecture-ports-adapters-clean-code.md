---
title: "Go Hexagonal Architecture: Ports, Adapters, and Clean Code"
date: 2029-07-21T00:00:00-05:00
draft: false
tags: ["Go", "Hexagonal Architecture", "Clean Architecture", "Ports and Adapters", "DDD", "Testing"]
categories: ["Go", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go hexagonal architecture covering domain layer isolation, port interfaces, primary and secondary adapters, dependency direction rules, and testing without infrastructure dependencies."
more_link: "yes"
url: "/go-hexagonal-architecture-ports-adapters-clean-code/"
---

As Go services grow, the instinct to reach for database packages, HTTP clients, and queue SDKs directly from business logic becomes a maintenance liability. Business rules get tangled with infrastructure concerns, tests require real databases, and changing a storage backend means touching every layer. Hexagonal architecture — also called Ports and Adapters — solves this by putting the domain at the center, defining interfaces (ports) at its boundary, and pushing all infrastructure into interchangeable adapters. This guide builds a production-grade Go application using hexagonal architecture from scratch.

<!--more-->

# Go Hexagonal Architecture: Ports, Adapters, and Clean Code

## Section 1: Core Concepts

Hexagonal architecture organizes code into three zones:

```
                    ┌─────────────────────┐
  HTTP/gRPC  ──────>│                     │<────── CLI
  Web UI     ──────>│   Primary Adapters   │
  Kafka      ──────>│  (driving the app)  │
                    └──────────┬──────────┘
                               │ Primary Ports
                               │ (interfaces defined by domain)
                    ┌──────────▼──────────┐
                    │                     │
                    │   Domain / Core      │
                    │   (pure business    │
                    │    logic)           │
                    │                     │
                    └──────────┬──────────┘
                               │ Secondary Ports
                               │ (interfaces defined by domain)
                    ┌──────────▼──────────┐
  PostgreSQL ──────>│  Secondary Adapters  │
  Redis      ──────>│  (driven by app)    │
  S3         ──────>│                     │
  SMTP       ──────>│                     │
                    └─────────────────────┘
```

**Dependency Rule**: dependencies point inward. The domain knows nothing about adapters. Adapters implement domain-defined interfaces.

**Primary Ports**: interfaces that primary adapters call into the domain (e.g., `OrderService`)
**Secondary Ports**: interfaces the domain calls that adapters implement (e.g., `OrderRepository`, `PaymentGateway`)

## Section 2: Project Structure

```
myapp/
├── domain/                     # Pure business logic — no imports from adapters
│   ├── order/
│   │   ├── order.go            # Domain entity
│   │   ├── service.go          # Domain service (primary port implementation)
│   │   ├── repository.go       # Secondary port (interface)
│   │   ├── events.go           # Domain events
│   │   └── service_test.go     # Tests with mock adapters
│   └── product/
│       ├── product.go
│       ├── service.go
│       └── repository.go
├── adapters/
│   ├── primary/
│   │   ├── httpapi/            # HTTP adapter (drives domain)
│   │   │   ├── handler.go
│   │   │   ├── routes.go
│   │   │   └── handler_test.go
│   │   └── grpc/               # gRPC adapter
│   │       ├── server.go
│   │       └── generated/
│   └── secondary/
│       ├── postgres/           # PostgreSQL adapter (driven by domain)
│       │   ├── order_repo.go
│       │   └── order_repo_test.go
│       ├── redis/
│       │   └── cache.go
│       ├── stripe/             # Payment gateway adapter
│       │   └── gateway.go
│       └── kafka/              # Event publisher adapter
│           └── publisher.go
├── app/                        # Application wiring (dependency injection)
│   ├── app.go
│   └── config.go
└── cmd/
    └── server/
        └── main.go
```

## Section 3: Domain Layer

```go
// domain/order/order.go
package order

import (
	"errors"
	"fmt"
	"time"
)

// OrderID is the domain identifier for an order
type OrderID string

// OrderStatus represents the lifecycle state of an order
type OrderStatus string

const (
	OrderStatusDraft     OrderStatus = "DRAFT"
	OrderStatusSubmitted OrderStatus = "SUBMITTED"
	OrderStatusPaid      OrderStatus = "PAID"
	OrderStatusShipped   OrderStatus = "SHIPPED"
	OrderStatusCancelled OrderStatus = "CANCELLED"
)

// Domain errors — defined in domain, not infrastructure
var (
	ErrOrderNotFound      = errors.New("order not found")
	ErrOrderAlreadyExists = errors.New("order already exists")
	ErrInvalidTransition  = errors.New("invalid order status transition")
	ErrEmptyOrder         = errors.New("order must have at least one line item")
	ErrInsufficientStock  = errors.New("insufficient stock for requested quantity")
)

// Money is a value object for monetary amounts
type Money struct {
	Amount   int64  // stored as cents to avoid float precision issues
	Currency string // ISO 4217 currency code
}

func NewMoney(amount int64, currency string) (Money, error) {
	if amount < 0 {
		return Money{}, fmt.Errorf("money amount cannot be negative: %d", amount)
	}
	if len(currency) != 3 {
		return Money{}, fmt.Errorf("invalid currency code: %s", currency)
	}
	return Money{Amount: amount, Currency: currency}, nil
}

func (m Money) Add(other Money) (Money, error) {
	if m.Currency != other.Currency {
		return Money{}, fmt.Errorf("cannot add %s and %s", m.Currency, other.Currency)
	}
	return Money{Amount: m.Amount + other.Amount, Currency: m.Currency}, nil
}

// LineItem is a value object representing a product in an order
type LineItem struct {
	ProductID   string
	ProductName string
	Quantity    int
	UnitPrice   Money
}

func (li LineItem) Total() Money {
	return Money{Amount: li.UnitPrice.Amount * int64(li.Quantity), Currency: li.UnitPrice.Currency}
}

// Order is the root aggregate of the order domain
type Order struct {
	id          OrderID
	customerID  string
	status      OrderStatus
	items       []LineItem
	total       Money
	createdAt   time.Time
	updatedAt   time.Time
	events      []DomainEvent
}

// NewOrder creates a new draft order — the only way to create an Order
func NewOrder(id OrderID, customerID string) (*Order, error) {
	if id == "" {
		return nil, fmt.Errorf("order ID cannot be empty")
	}
	if customerID == "" {
		return nil, fmt.Errorf("customer ID cannot be empty")
	}
	now := time.Now().UTC()
	o := &Order{
		id:         id,
		customerID: customerID,
		status:     OrderStatusDraft,
		items:      make([]LineItem, 0),
		total:      Money{Amount: 0, Currency: "USD"},
		createdAt:  now,
		updatedAt:  now,
	}
	o.raise(OrderCreatedEvent{OrderID: id, CustomerID: customerID, CreatedAt: now})
	return o, nil
}

// Reconstitute creates an Order from persisted state (no events raised)
func Reconstitute(id OrderID, customerID string, status OrderStatus, items []LineItem, createdAt, updatedAt time.Time) *Order {
	o := &Order{
		id:         id,
		customerID: customerID,
		status:     status,
		items:      items,
		createdAt:  createdAt,
		updatedAt:  updatedAt,
	}
	o.recalculateTotal()
	return o
}

// AddItem adds a line item to a draft order
func (o *Order) AddItem(item LineItem) error {
	if o.status != OrderStatusDraft {
		return fmt.Errorf("cannot add items to order in status %s: %w", o.status, ErrInvalidTransition)
	}
	if item.Quantity <= 0 {
		return fmt.Errorf("item quantity must be positive: %d", item.Quantity)
	}

	// Check if product already in order — update quantity
	for i, existing := range o.items {
		if existing.ProductID == item.ProductID {
			o.items[i].Quantity += item.Quantity
			o.recalculateTotal()
			return nil
		}
	}

	o.items = append(o.items, item)
	o.recalculateTotal()
	o.updatedAt = time.Now().UTC()
	return nil
}

// Submit transitions the order from Draft to Submitted
func (o *Order) Submit() error {
	if o.status != OrderStatusDraft {
		return fmt.Errorf("can only submit draft orders, current status: %s: %w", o.status, ErrInvalidTransition)
	}
	if len(o.items) == 0 {
		return ErrEmptyOrder
	}
	o.status = OrderStatusSubmitted
	o.updatedAt = time.Now().UTC()
	o.raise(OrderSubmittedEvent{OrderID: o.id, Total: o.total, SubmittedAt: o.updatedAt})
	return nil
}

// MarkPaid transitions the order from Submitted to Paid
func (o *Order) MarkPaid(transactionID string) error {
	if o.status != OrderStatusSubmitted {
		return fmt.Errorf("can only pay submitted orders, current status: %s: %w", o.status, ErrInvalidTransition)
	}
	o.status = OrderStatusPaid
	o.updatedAt = time.Now().UTC()
	o.raise(OrderPaidEvent{OrderID: o.id, TransactionID: transactionID, PaidAt: o.updatedAt})
	return nil
}

// Cancel cancels an order that is not yet shipped
func (o *Order) Cancel(reason string) error {
	switch o.status {
	case OrderStatusShipped, OrderStatusCancelled:
		return fmt.Errorf("cannot cancel order in status %s: %w", o.status, ErrInvalidTransition)
	}
	o.status = OrderStatusCancelled
	o.updatedAt = time.Now().UTC()
	o.raise(OrderCancelledEvent{OrderID: o.id, Reason: reason, CancelledAt: o.updatedAt})
	return nil
}

func (o *Order) ID() OrderID          { return o.id }
func (o *Order) CustomerID() string   { return o.customerID }
func (o *Order) Status() OrderStatus  { return o.status }
func (o *Order) Items() []LineItem    { return append([]LineItem(nil), o.items...) }
func (o *Order) Total() Money         { return o.total }
func (o *Order) CreatedAt() time.Time { return o.createdAt }

func (o *Order) Events() []DomainEvent {
	return append([]DomainEvent(nil), o.events...)
}

func (o *Order) ClearEvents() {
	o.events = o.events[:0]
}

func (o *Order) raise(event DomainEvent) {
	o.events = append(o.events, event)
}

func (o *Order) recalculateTotal() {
	total := Money{Amount: 0, Currency: "USD"}
	for _, item := range o.items {
		t := item.Total()
		total.Amount += t.Amount
	}
	o.total = total
}
```

### Domain Events

```go
// domain/order/events.go
package order

import "time"

// DomainEvent is the marker interface for all order domain events
type DomainEvent interface {
	EventName() string
	AggregateID() OrderID
}

type OrderCreatedEvent struct {
	OrderID    OrderID
	CustomerID string
	CreatedAt  time.Time
}

func (e OrderCreatedEvent) EventName() string    { return "order.created" }
func (e OrderCreatedEvent) AggregateID() OrderID { return e.OrderID }

type OrderSubmittedEvent struct {
	OrderID     OrderID
	Total       Money
	SubmittedAt time.Time
}

func (e OrderSubmittedEvent) EventName() string    { return "order.submitted" }
func (e OrderSubmittedEvent) AggregateID() OrderID { return e.OrderID }

type OrderPaidEvent struct {
	OrderID       OrderID
	TransactionID string
	PaidAt        time.Time
}

func (e OrderPaidEvent) EventName() string    { return "order.paid" }
func (e OrderPaidEvent) AggregateID() OrderID { return e.OrderID }

type OrderCancelledEvent struct {
	OrderID     OrderID
	Reason      string
	CancelledAt time.Time
}

func (e OrderCancelledEvent) EventName() string    { return "order.cancelled" }
func (e OrderCancelledEvent) AggregateID() OrderID { return e.OrderID }
```

### Secondary Ports (Repository Interface)

```go
// domain/order/repository.go
package order

import "context"

// Repository is the secondary port for order persistence.
// This interface is defined IN THE DOMAIN — not in any adapter package.
// Concrete implementations live in adapters/secondary/*.
type Repository interface {
	// Save persists a new order — returns ErrOrderAlreadyExists if ID taken
	Save(ctx context.Context, order *Order) error

	// Update updates an existing order — returns ErrOrderNotFound if missing
	Update(ctx context.Context, order *Order) error

	// FindByID retrieves an order by ID — returns ErrOrderNotFound if missing
	FindByID(ctx context.Context, id OrderID) (*Order, error)

	// FindByCustomer returns all orders for a customer, sorted by createdAt desc
	FindByCustomer(ctx context.Context, customerID string, limit, offset int) ([]*Order, error)

	// FindByStatus returns orders with the given status
	FindByStatus(ctx context.Context, status OrderStatus, limit, offset int) ([]*Order, error)
}

// EventPublisher is the secondary port for domain event publishing
type EventPublisher interface {
	Publish(ctx context.Context, events []DomainEvent) error
}

// PaymentGateway is the secondary port for payment processing
type PaymentGateway interface {
	Charge(ctx context.Context, req ChargeRequest) (ChargeResult, error)
	Refund(ctx context.Context, transactionID string, amount Money) error
}

type ChargeRequest struct {
	OrderID         OrderID
	Amount          Money
	PaymentMethodID string
	IdempotencyKey  string
}

type ChargeResult struct {
	TransactionID string
	Status        string
}
```

### Domain Service (Primary Port Implementation)

```go
// domain/order/service.go
package order

import (
	"context"
	"fmt"
	"log/slog"
)

// Service implements the primary port — the application's entry point for order operations.
// It depends only on secondary port interfaces, never on concrete adapters.
type Service struct {
	repo      Repository
	payment   PaymentGateway
	publisher EventPublisher
	logger    *slog.Logger
}

// NewService creates the order service with all required ports
func NewService(
	repo Repository,
	payment PaymentGateway,
	publisher EventPublisher,
	logger *slog.Logger,
) *Service {
	return &Service{
		repo:      repo,
		payment:   payment,
		publisher: publisher,
		logger:    logger,
	}
}

// CreateOrder creates a new draft order
func (s *Service) CreateOrder(ctx context.Context, cmd CreateOrderCommand) (*Order, error) {
	order, err := NewOrder(OrderID(cmd.OrderID), cmd.CustomerID)
	if err != nil {
		return nil, fmt.Errorf("new order: %w", err)
	}

	for _, item := range cmd.Items {
		li := LineItem{
			ProductID:   item.ProductID,
			ProductName: item.ProductName,
			Quantity:    item.Quantity,
			UnitPrice:   Money{Amount: item.UnitPriceCents, Currency: "USD"},
		}
		if err := order.AddItem(li); err != nil {
			return nil, fmt.Errorf("add item %s: %w", item.ProductID, err)
		}
	}

	if err := s.repo.Save(ctx, order); err != nil {
		return nil, fmt.Errorf("save order: %w", err)
	}

	if err := s.publishEvents(ctx, order); err != nil {
		s.logger.Error("failed to publish order events",
			"order_id", order.ID(),
			"error", err,
		)
		// Non-fatal: order is saved; events can be retried via outbox
	}

	return order, nil
}

// SubmitOrder transitions an order from draft to submitted
func (s *Service) SubmitOrder(ctx context.Context, id OrderID) (*Order, error) {
	order, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("find order: %w", err)
	}

	if err := order.Submit(); err != nil {
		return nil, fmt.Errorf("submit order: %w", err)
	}

	if err := s.repo.Update(ctx, order); err != nil {
		return nil, fmt.Errorf("update order: %w", err)
	}

	if err := s.publishEvents(ctx, order); err != nil {
		s.logger.Error("failed to publish submit events", "order_id", id, "error", err)
	}

	return order, nil
}

// PayOrder charges the customer and transitions order to Paid
func (s *Service) PayOrder(ctx context.Context, cmd PayOrderCommand) (*Order, error) {
	order, err := s.repo.FindByID(ctx, cmd.OrderID)
	if err != nil {
		return nil, fmt.Errorf("find order: %w", err)
	}

	chargeResult, err := s.payment.Charge(ctx, ChargeRequest{
		OrderID:         cmd.OrderID,
		Amount:          order.Total(),
		PaymentMethodID: cmd.PaymentMethodID,
		IdempotencyKey:  fmt.Sprintf("order-pay-%s", cmd.OrderID),
	})
	if err != nil {
		return nil, fmt.Errorf("charge payment: %w", err)
	}

	if err := order.MarkPaid(chargeResult.TransactionID); err != nil {
		// Payment succeeded but state transition failed — record payment result
		s.logger.Error("payment charged but order state transition failed",
			"order_id", cmd.OrderID,
			"transaction_id", chargeResult.TransactionID,
			"error", err,
		)
		return nil, fmt.Errorf("mark paid: %w", err)
	}

	if err := s.repo.Update(ctx, order); err != nil {
		return nil, fmt.Errorf("update order after payment: %w", err)
	}

	if err := s.publishEvents(ctx, order); err != nil {
		s.logger.Error("failed to publish payment events", "order_id", cmd.OrderID, "error", err)
	}

	return order, nil
}

func (s *Service) GetOrder(ctx context.Context, id OrderID) (*Order, error) {
	return s.repo.FindByID(ctx, id)
}

func (s *Service) publishEvents(ctx context.Context, order *Order) error {
	events := order.Events()
	if len(events) == 0 {
		return nil
	}
	if err := s.publisher.Publish(ctx, events); err != nil {
		return err
	}
	order.ClearEvents()
	return nil
}

// Command types — defined in domain, used by primary adapters
type CreateOrderCommand struct {
	OrderID    string
	CustomerID string
	Items      []OrderItemInput
}

type OrderItemInput struct {
	ProductID      string
	ProductName    string
	Quantity       int
	UnitPriceCents int64
}

type PayOrderCommand struct {
	OrderID         OrderID
	PaymentMethodID string
}
```

## Section 4: Secondary Adapters

### PostgreSQL Adapter

```go
// adapters/secondary/postgres/order_repo.go
package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/example/myapp/domain/order"
	_ "github.com/jackc/pgx/v5/stdlib"
)

// OrderRow is the database representation of an order
type OrderRow struct {
	ID         string
	CustomerID string
	Status     string
	ItemsJSON  []byte
	TotalCents int64
	Currency   string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// OrderRepository implements domain/order.Repository using PostgreSQL.
// This adapter is OUTSIDE the domain — it knows about both domain types and SQL.
type OrderRepository struct {
	db *sql.DB
}

func NewOrderRepository(db *sql.DB) *OrderRepository {
	return &OrderRepository{db: db}
}

// Save inserts a new order
func (r *OrderRepository) Save(ctx context.Context, o *order.Order) error {
	itemsJSON, err := json.Marshal(lineItemsToRows(o.Items()))
	if err != nil {
		return fmt.Errorf("marshal items: %w", err)
	}

	_, err = r.db.ExecContext(ctx, `
		INSERT INTO orders (id, customer_id, status, items, total_cents, currency, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`,
		string(o.ID()),
		o.CustomerID(),
		string(o.Status()),
		itemsJSON,
		o.Total().Amount,
		o.Total().Currency,
		o.CreatedAt(),
		o.CreatedAt(),
	)

	if err != nil {
		if isUniqueViolation(err) {
			return order.ErrOrderAlreadyExists
		}
		return fmt.Errorf("insert order: %w", err)
	}
	return nil
}

// FindByID retrieves an order by its ID
func (r *OrderRepository) FindByID(ctx context.Context, id order.OrderID) (*order.Order, error) {
	var row OrderRow
	err := r.db.QueryRowContext(ctx, `
		SELECT id, customer_id, status, items, total_cents, currency, created_at, updated_at
		FROM orders WHERE id = $1
	`, string(id)).Scan(
		&row.ID, &row.CustomerID, &row.Status, &row.ItemsJSON,
		&row.TotalCents, &row.Currency, &row.CreatedAt, &row.UpdatedAt,
	)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, order.ErrOrderNotFound
		}
		return nil, fmt.Errorf("query order: %w", err)
	}

	return rowToOrder(row)
}

// Update persists changes to an existing order
func (r *OrderRepository) Update(ctx context.Context, o *order.Order) error {
	itemsJSON, err := json.Marshal(lineItemsToRows(o.Items()))
	if err != nil {
		return fmt.Errorf("marshal items: %w", err)
	}

	result, err := r.db.ExecContext(ctx, `
		UPDATE orders
		SET status = $1, items = $2, total_cents = $3, updated_at = $4
		WHERE id = $5
	`,
		string(o.Status()),
		itemsJSON,
		o.Total().Amount,
		time.Now().UTC(),
		string(o.ID()),
	)
	if err != nil {
		return fmt.Errorf("update order: %w", err)
	}
	rowsAffected, _ := result.RowsAffected()
	if rowsAffected == 0 {
		return order.ErrOrderNotFound
	}
	return nil
}

func (r *OrderRepository) FindByCustomer(ctx context.Context, customerID string, limit, offset int) ([]*order.Order, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, customer_id, status, items, total_cents, currency, created_at, updated_at
		FROM orders
		WHERE customer_id = $1
		ORDER BY created_at DESC
		LIMIT $2 OFFSET $3
	`, customerID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("query orders by customer: %w", err)
	}
	defer rows.Close()
	return r.scanRows(rows)
}

func (r *OrderRepository) FindByStatus(ctx context.Context, status order.OrderStatus, limit, offset int) ([]*order.Order, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, customer_id, status, items, total_cents, currency, created_at, updated_at
		FROM orders
		WHERE status = $1
		ORDER BY created_at DESC
		LIMIT $2 OFFSET $3
	`, string(status), limit, offset)
	if err != nil {
		return nil, fmt.Errorf("query orders by status: %w", err)
	}
	defer rows.Close()
	return r.scanRows(rows)
}

func (r *OrderRepository) scanRows(rows *sql.Rows) ([]*order.Order, error) {
	var result []*order.Order
	for rows.Next() {
		var row OrderRow
		if err := rows.Scan(
			&row.ID, &row.CustomerID, &row.Status, &row.ItemsJSON,
			&row.TotalCents, &row.Currency, &row.CreatedAt, &row.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan order row: %w", err)
		}
		o, err := rowToOrder(row)
		if err != nil {
			return nil, err
		}
		result = append(result, o)
	}
	return result, rows.Err()
}

// rowToOrder converts a database row to a domain Order using Reconstitute
// (not NewOrder — Reconstitute does not raise events)
func rowToOrder(row OrderRow) (*order.Order, error) {
	var itemRows []lineItemRow
	if err := json.Unmarshal(row.ItemsJSON, &itemRows); err != nil {
		return nil, fmt.Errorf("unmarshal items: %w", err)
	}

	items := make([]order.LineItem, len(itemRows))
	for i, ir := range itemRows {
		items[i] = order.LineItem{
			ProductID:   ir.ProductID,
			ProductName: ir.ProductName,
			Quantity:    ir.Quantity,
			UnitPrice:   order.Money{Amount: ir.UnitPriceCents, Currency: "USD"},
		}
	}

	return order.Reconstitute(
		order.OrderID(row.ID),
		row.CustomerID,
		order.OrderStatus(row.Status),
		items,
		row.CreatedAt,
		row.UpdatedAt,
	), nil
}

type lineItemRow struct {
	ProductID      string `json:"product_id"`
	ProductName    string `json:"product_name"`
	Quantity       int    `json:"quantity"`
	UnitPriceCents int64  `json:"unit_price_cents"`
}

func lineItemsToRows(items []order.LineItem) []lineItemRow {
	rows := make([]lineItemRow, len(items))
	for i, item := range items {
		rows[i] = lineItemRow{
			ProductID:      item.ProductID,
			ProductName:    item.ProductName,
			Quantity:       item.Quantity,
			UnitPriceCents: item.UnitPrice.Amount,
		}
	}
	return rows
}

func isUniqueViolation(err error) bool {
	// Check for PostgreSQL unique violation error code 23505
	type pgError interface {
		Code() string
	}
	if pge, ok := err.(pgError); ok {
		return pge.Code() == "23505"
	}
	return false
}
```

## Section 5: Primary Adapters

### HTTP Adapter

```go
// adapters/primary/httpapi/handler.go
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/example/myapp/domain/order"
)

// OrderHandler is the HTTP adapter that drives the order domain service
type OrderHandler struct {
	service *order.Service
}

func NewOrderHandler(service *order.Service) *OrderHandler {
	return &OrderHandler{service: service}
}

// CreateOrderRequest is the HTTP input model
type CreateOrderRequest struct {
	CustomerID string           `json:"customer_id"`
	Items      []OrderItemInput `json:"items"`
}

type OrderItemInput struct {
	ProductID      string `json:"product_id"`
	ProductName    string `json:"product_name"`
	Quantity       int    `json:"quantity"`
	UnitPriceCents int64  `json:"unit_price_cents"`
}

// CreateOrderResponse is the HTTP output model
type CreateOrderResponse struct {
	OrderID    string `json:"order_id"`
	CustomerID string `json:"customer_id"`
	Status     string `json:"status"`
	TotalCents int64  `json:"total_cents"`
	Currency   string `json:"currency"`
}

func (h *OrderHandler) CreateOrder(w http.ResponseWriter, r *http.Request) {
	var req CreateOrderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.CustomerID == "" {
		writeError(w, http.StatusBadRequest, "customer_id is required")
		return
	}

	// Translate HTTP input to domain command
	items := make([]order.OrderItemInput, len(req.Items))
	for i, item := range req.Items {
		items[i] = order.OrderItemInput{
			ProductID:      item.ProductID,
			ProductName:    item.ProductName,
			Quantity:       item.Quantity,
			UnitPriceCents: item.UnitPriceCents,
		}
	}

	cmd := order.CreateOrderCommand{
		OrderID:    generateOrderID(),
		CustomerID: req.CustomerID,
		Items:      items,
	}

	o, err := h.service.CreateOrder(r.Context(), cmd)
	if err != nil {
		h.handleDomainError(w, err)
		return
	}

	// Translate domain result to HTTP response
	resp := CreateOrderResponse{
		OrderID:    string(o.ID()),
		CustomerID: o.CustomerID(),
		Status:     string(o.Status()),
		TotalCents: o.Total().Amount,
		Currency:   o.Total().Currency,
	}

	writeJSON(w, http.StatusCreated, resp)
}

func (h *OrderHandler) GetOrder(w http.ResponseWriter, r *http.Request) {
	orderID := order.OrderID(r.PathValue("id"))

	o, err := h.service.GetOrder(r.Context(), orderID)
	if err != nil {
		h.handleDomainError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, orderToResponse(o))
}

func (h *OrderHandler) SubmitOrder(w http.ResponseWriter, r *http.Request) {
	orderID := order.OrderID(r.PathValue("id"))

	o, err := h.service.SubmitOrder(r.Context(), orderID)
	if err != nil {
		h.handleDomainError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, orderToResponse(o))
}

// handleDomainError maps domain errors to HTTP status codes.
// The adapter translates — it does NOT expose domain internals to clients.
func (h *OrderHandler) handleDomainError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, order.ErrOrderNotFound):
		writeError(w, http.StatusNotFound, "order not found")
	case errors.Is(err, order.ErrOrderAlreadyExists):
		writeError(w, http.StatusConflict, "order already exists")
	case errors.Is(err, order.ErrInvalidTransition):
		writeError(w, http.StatusUnprocessableEntity, err.Error())
	case errors.Is(err, order.ErrEmptyOrder):
		writeError(w, http.StatusBadRequest, "order must contain at least one item")
	default:
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}
```

## Section 6: Testing Without Infrastructure

The core benefit of hexagonal architecture is that domain tests use no real databases, message queues, or external services.

```go
// domain/order/service_test.go
package order_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/example/myapp/domain/order"
)

// === Mock Adapters (implement secondary ports) ===

type MockRepository struct {
	mu     sync.RWMutex
	orders map[order.OrderID]*order.Order
	err    error // injected error for testing
}

func NewMockRepository() *MockRepository {
	return &MockRepository{orders: make(map[order.OrderID]*order.Order)}
}

func (r *MockRepository) Save(_ context.Context, o *order.Order) error {
	if r.err != nil { return r.err }
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.orders[o.ID()]; exists {
		return order.ErrOrderAlreadyExists
	}
	r.orders[o.ID()] = o
	return nil
}

func (r *MockRepository) Update(_ context.Context, o *order.Order) error {
	if r.err != nil { return r.err }
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.orders[o.ID()]; !exists {
		return order.ErrOrderNotFound
	}
	r.orders[o.ID()] = o
	return nil
}

func (r *MockRepository) FindByID(_ context.Context, id order.OrderID) (*order.Order, error) {
	if r.err != nil { return nil, r.err }
	r.mu.RLock()
	defer r.mu.RUnlock()
	o, ok := r.orders[id]
	if !ok { return nil, order.ErrOrderNotFound }
	return o, nil
}

func (r *MockRepository) FindByCustomer(_ context.Context, _ string, _, _ int) ([]*order.Order, error) {
	return nil, nil
}

func (r *MockRepository) FindByStatus(_ context.Context, _ order.OrderStatus, _, _ int) ([]*order.Order, error) {
	return nil, nil
}

type MockPaymentGateway struct {
	chargeResult order.ChargeResult
	chargeErr    error
}

func (m *MockPaymentGateway) Charge(_ context.Context, _ order.ChargeRequest) (order.ChargeResult, error) {
	return m.chargeResult, m.chargeErr
}

func (m *MockPaymentGateway) Refund(_ context.Context, _ string, _ order.Money) error {
	return nil
}

type MockEventPublisher struct {
	published []order.DomainEvent
}

func (m *MockEventPublisher) Publish(_ context.Context, events []order.DomainEvent) error {
	m.published = append(m.published, events...)
	return nil
}

// === Tests ===

func newTestService(repo order.Repository) *order.Service {
	return order.NewService(
		repo,
		&MockPaymentGateway{chargeResult: order.ChargeResult{TransactionID: "txn-123", Status: "succeeded"}},
		&MockEventPublisher{},
		slog.Default(),
	)
}

func TestCreateOrderSuccess(t *testing.T) {
	repo := NewMockRepository()
	svc := newTestService(repo)

	cmd := order.CreateOrderCommand{
		OrderID:    "order-001",
		CustomerID: "cust-001",
		Items: []order.OrderItemInput{
			{ProductID: "prod-1", ProductName: "Widget", Quantity: 2, UnitPriceCents: 1000},
		},
	}

	o, err := svc.CreateOrder(context.Background(), cmd)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if o.Status() != order.OrderStatusDraft {
		t.Errorf("expected DRAFT, got %s", o.Status())
	}
	if o.Total().Amount != 2000 {
		t.Errorf("expected total 2000 cents, got %d", o.Total().Amount)
	}
	if len(o.Items()) != 1 {
		t.Errorf("expected 1 item, got %d", len(o.Items()))
	}
}

func TestSubmitEmptyOrderFails(t *testing.T) {
	repo := NewMockRepository()
	svc := newTestService(repo)

	// Create order with no items
	o, _ := order.NewOrder("order-002", "cust-002")
	_ = repo.Save(context.Background(), o)

	_, err := svc.SubmitOrder(context.Background(), "order-002")
	if !errors.Is(err, order.ErrEmptyOrder) {
		t.Errorf("expected ErrEmptyOrder, got: %v", err)
	}
}

func TestPayOrderSuccess(t *testing.T) {
	repo := NewMockRepository()
	publisher := &MockEventPublisher{}
	payment := &MockPaymentGateway{
		chargeResult: order.ChargeResult{TransactionID: "txn-456", Status: "succeeded"},
	}
	svc := order.NewService(repo, payment, publisher, slog.Default())

	// Create and submit order first
	cmd := order.CreateOrderCommand{
		OrderID: "order-003", CustomerID: "cust-003",
		Items: []order.OrderItemInput{{ProductID: "p1", ProductName: "Gizmo", Quantity: 1, UnitPriceCents: 5000}},
	}
	_, _ = svc.CreateOrder(context.Background(), cmd)
	_, _ = svc.SubmitOrder(context.Background(), "order-003")

	o, err := svc.PayOrder(context.Background(), order.PayOrderCommand{
		OrderID: "order-003", PaymentMethodID: "pm_test_123",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if o.Status() != order.OrderStatusPaid {
		t.Errorf("expected PAID, got %s", o.Status())
	}

	// Verify domain event was published
	paidEvents := 0
	for _, evt := range publisher.published {
		if evt.EventName() == "order.paid" {
			paidEvents++
		}
	}
	if paidEvents != 1 {
		t.Errorf("expected 1 order.paid event, got %d", paidEvents)
	}
}
```

## Section 7: Application Wiring

```go
// app/app.go
package app

import (
	"database/sql"
	"log/slog"

	"github.com/example/myapp/adapters/primary/httpapi"
	"github.com/example/myapp/adapters/secondary/kafka"
	"github.com/example/myapp/adapters/secondary/postgres"
	"github.com/example/myapp/adapters/secondary/stripe"
	"github.com/example/myapp/domain/order"
)

// App is the composition root — the only place that knows about all layers
type App struct {
	OrderHandler *httpapi.OrderHandler
	Config       Config
}

// New wires all adapters to domain services
func New(cfg Config, db *sql.DB, logger *slog.Logger) *App {
	// Secondary adapters
	orderRepo := postgres.NewOrderRepository(db)
	paymentGateway := stripe.NewGateway(cfg.Stripe.SecretKey, cfg.Stripe.WebhookSecret)
	eventPublisher := kafka.NewPublisher(cfg.Kafka.Brokers, cfg.Kafka.Topic)

	// Domain service (primary port implementation)
	orderService := order.NewService(orderRepo, paymentGateway, eventPublisher, logger)

	// Primary adapters
	orderHandler := httpapi.NewOrderHandler(orderService)

	return &App{
		OrderHandler: orderHandler,
		Config:       cfg,
	}
}
```

## Section 8: Dependency Direction Enforcement

```go
// tools/check-deps/main.go
// Run: go run tools/check-deps/main.go
// Ensures no domain package imports from adapters/

package main

import (
	"fmt"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	violations := 0
	err := filepath.Walk("domain", func(path string, info os.FileInfo, err error) error {
		if err != nil || !strings.HasSuffix(path, ".go") {
			return err
		}

		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}

		for _, imp := range f.Imports {
			importPath := strings.Trim(imp.Path.Value, `"`)
			if strings.Contains(importPath, "adapters/") ||
				strings.Contains(importPath, "database/sql") ||
				strings.Contains(importPath, "net/http") {
				fmt.Printf("VIOLATION: %s imports %s\n", path, importPath)
				violations++
			}
		}
		return nil
	})

	if err != nil {
		fmt.Fprintf(os.Stderr, "walk error: %v\n", err)
		os.Exit(1)
	}

	if violations > 0 {
		fmt.Printf("\n%d dependency violation(s) found\n", violations)
		os.Exit(1)
	}
	fmt.Println("Dependency check passed")
}
```

## Section 9: Integration Testing Adapters

```go
// adapters/secondary/postgres/order_repo_test.go
// +build integration

package postgres_test

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/example/myapp/adapters/secondary/postgres"
	"github.com/example/myapp/domain/order"
)

func TestOrderRepository_SaveAndFind(t *testing.T) {
	db := setupTestDB(t) // uses testcontainers or a test DB
	defer db.Close()

	repo := postgres.NewOrderRepository(db)

	// Create and save an order
	o, err := order.NewOrder("test-order-1", "cust-abc")
	if err != nil {
		t.Fatal(err)
	}
	_ = o.AddItem(order.LineItem{
		ProductID:   "prod-1",
		ProductName: "Widget",
		Quantity:    3,
		UnitPrice:   order.Money{Amount: 500, Currency: "USD"},
	})

	if err := repo.Save(context.Background(), o); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// Retrieve and verify
	found, err := repo.FindByID(context.Background(), "test-order-1")
	if err != nil {
		t.Fatalf("FindByID failed: %v", err)
	}

	if found.ID() != o.ID() {
		t.Errorf("ID mismatch: want %s, got %s", o.ID(), found.ID())
	}
	if found.Total().Amount != 1500 {
		t.Errorf("Total mismatch: want 1500, got %d", found.Total().Amount)
	}
}
```

## Section 10: Architectural Rules Summary

```
Hexagonal Architecture Rules for Go:

Domain Package (domain/...):
  DO:
    - Define entities, value objects, aggregates
    - Define domain events
    - Define secondary port interfaces (Repository, Gateway, etc.)
    - Implement primary port (Service) using only port interfaces
    - Use standard library only (context, errors, time, fmt)
  DON'T:
    - Import from adapters/
    - Import database/sql, net/http, cloud SDKs
    - Reference framework types (gin.Context, echo.Context)

Secondary Adapters (adapters/secondary/...):
  DO:
    - Import domain package
    - Implement domain-defined interfaces
    - Use infrastructure packages (database/sql, redis, aws-sdk)
    - Map between domain types and persistence models
    - Map domain errors (ErrNotFound -> sql.ErrNoRows)
  DON'T:
    - Contain business logic
    - Import primary adapters

Primary Adapters (adapters/primary/...):
  DO:
    - Import domain package
    - Call domain service (primary port)
    - Translate input/output (HTTP JSON -> domain commands)
    - Map domain errors to HTTP/gRPC status codes
  DON'T:
    - Contain business logic
    - Import secondary adapters
    - Bypass the domain service

App Package (app/):
  DO:
    - Import all packages
    - Wire adapters to domain
    - This is the only package that imports everything
  DON'T:
    - Contain business logic
    - Duplicate adapter logic
```
