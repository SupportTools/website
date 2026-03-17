---
title: "Event Sourcing and CQRS in Go: Building Audit-Complete Systems"
date: 2028-12-03T00:00:00-05:00
draft: false
tags: ["Go", "Event Sourcing", "CQRS", "Architecture", "Database"]
categories:
- Go
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "Implement event sourcing and CQRS in Go with PostgreSQL event store, aggregate roots, projections, snapshot optimization, and event schema evolution for audit-complete systems."
more_link: "yes"
url: "/go-event-sourcing-cqrs-implementation-guide/"
---

Event sourcing replaces mutable state with an append-only sequence of events. Instead of storing the current balance of a bank account, you store every deposit and withdrawal. The current balance is always derived by replaying events. This approach gives you a complete audit log, time-travel debugging, and the ability to build new read models from historical data — capabilities impossible to retrofit into a traditional CRUD system.

CQRS (Command Query Responsibility Segregation) naturally pairs with event sourcing by separating the write model (commands that produce events) from the read model (projections that consume events and maintain query-optimized state).

This guide builds a complete order management system demonstrating both patterns in Go with PostgreSQL as the event store.

<!--more-->

# Event Sourcing and CQRS in Go

## Section 1: Core Concepts and Architecture

```
Command → Aggregate → Events → Event Store
                                    ↓
                             Event Bus / Stream
                                    ↓
                           Projection → Read Model → Query
```

Key terms:
- **Event**: An immutable fact that happened. `OrderPlaced`, `ItemAdded`, `OrderShipped`.
- **Aggregate**: The domain object that validates commands and produces events.
- **Stream**: A sequence of events for one aggregate instance (e.g., all events for order `ord-123`).
- **Projection**: A function that processes events to build a denormalized read model.
- **Snapshot**: A captured state of an aggregate at a specific version, used to avoid full event replay.

## Section 2: Domain Events

```go
// internal/domain/events.go
package domain

import (
	"time"

	"github.com/google/uuid"
)

// EventType is a string discriminator for unmarshaling.
type EventType string

const (
	EventOrderPlaced    EventType = "OrderPlaced"
	EventItemAdded      EventType = "ItemAdded"
	EventItemRemoved    EventType = "ItemRemoved"
	EventOrderConfirmed EventType = "OrderConfirmed"
	EventOrderShipped   EventType = "OrderShipped"
	EventOrderCancelled EventType = "OrderCancelled"
)

// DomainEvent is the envelope stored in the event store.
type DomainEvent struct {
	EventID       string    `json:"event_id"`
	StreamID      string    `json:"stream_id"`   // e.g., "order-ord-123"
	StreamVersion int       `json:"stream_version"`
	Type          EventType `json:"type"`
	OccurredAt    time.Time `json:"occurred_at"`
	Data          []byte    `json:"data"`   // JSON-encoded event payload
	Metadata      []byte    `json:"metadata"` // causation_id, correlation_id, etc.
}

// Specific event payloads ---------------------------------------------------

type OrderPlacedEvent struct {
	OrderID    string `json:"order_id"`
	CustomerID string `json:"customer_id"`
	Currency   string `json:"currency"`
}

type ItemAddedEvent struct {
	ProductID  string  `json:"product_id"`
	Quantity   int     `json:"quantity"`
	UnitPrice  float64 `json:"unit_price"`
}

type ItemRemovedEvent struct {
	ProductID string `json:"product_id"`
}

type OrderConfirmedEvent struct {
	ConfirmedAt time.Time `json:"confirmed_at"`
}

type OrderShippedEvent struct {
	TrackingNumber string    `json:"tracking_number"`
	Carrier        string    `json:"carrier"`
	ShippedAt      time.Time `json:"shipped_at"`
}

type OrderCancelledEvent struct {
	Reason      string    `json:"reason"`
	CancelledAt time.Time `json:"cancelled_at"`
}

func NewEventID() string {
	return uuid.New().String()
}
```

## Section 3: The Order Aggregate

The aggregate encapsulates all business logic. It validates commands, applies events to change state, and records new events. Crucially, state changes happen only through event application — never through direct field mutation in command handlers.

```go
// internal/domain/order.go
package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// OrderStatus represents the lifecycle stage of an order.
type OrderStatus string

const (
	StatusDraft     OrderStatus = "draft"
	StatusConfirmed OrderStatus = "confirmed"
	StatusShipped   OrderStatus = "shipped"
	StatusCancelled OrderStatus = "cancelled"
)

// OrderItem is part of the aggregate state.
type OrderItem struct {
	ProductID string
	Quantity  int
	UnitPrice float64
}

// Order is the aggregate root.
type Order struct {
	// Aggregate identity
	ID      string
	Version int // stream version after last applied event

	// Aggregate state
	CustomerID string
	Currency   string
	Items      map[string]*OrderItem
	Status     OrderStatus

	// Uncommitted events produced by this session
	uncommitted []DomainEvent
}

// NewOrder is a factory that creates the aggregate from a command.
// It produces an OrderPlaced event.
func NewOrder(customerID, currency string) (*Order, error) {
	if customerID == "" {
		return nil, errors.New("customerID required")
	}
	if currency == "" {
		currency = "USD"
	}
	o := &Order{Items: make(map[string]*OrderItem)}
	ev := DomainEvent{
		EventID: NewEventID(),
		Type:    EventOrderPlaced,
	}
	data, _ := json.Marshal(OrderPlacedEvent{
		OrderID:    o.ID, // will be set in apply
		CustomerID: customerID,
		Currency:   currency,
	})
	ev.Data = data
	o.apply(ev, true)
	return o, nil
}

// AddItem command handler
func (o *Order) AddItem(productID string, quantity int, unitPrice float64) error {
	if o.Status != StatusDraft {
		return fmt.Errorf("cannot add items to order in status %s", o.Status)
	}
	if quantity <= 0 {
		return errors.New("quantity must be positive")
	}
	ev := DomainEvent{EventID: NewEventID(), Type: EventItemAdded}
	data, _ := json.Marshal(ItemAddedEvent{
		ProductID: productID, Quantity: quantity, UnitPrice: unitPrice,
	})
	ev.Data = data
	o.apply(ev, true)
	return nil
}

// RemoveItem command handler
func (o *Order) RemoveItem(productID string) error {
	if o.Status != StatusDraft {
		return fmt.Errorf("cannot remove items from order in status %s", o.Status)
	}
	if _, ok := o.Items[productID]; !ok {
		return fmt.Errorf("item %s not in order", productID)
	}
	ev := DomainEvent{EventID: NewEventID(), Type: EventItemRemoved}
	data, _ := json.Marshal(ItemRemovedEvent{ProductID: productID})
	ev.Data = data
	o.apply(ev, true)
	return nil
}

// Confirm command handler
func (o *Order) Confirm() error {
	if o.Status != StatusDraft {
		return fmt.Errorf("order must be in draft to confirm, current: %s", o.Status)
	}
	if len(o.Items) == 0 {
		return errors.New("cannot confirm empty order")
	}
	ev := DomainEvent{EventID: NewEventID(), Type: EventOrderConfirmed}
	data, _ := json.Marshal(OrderConfirmedEvent{ConfirmedAt: time.Now().UTC()})
	ev.Data = data
	o.apply(ev, true)
	return nil
}

// Ship command handler
func (o *Order) Ship(trackingNumber, carrier string) error {
	if o.Status != StatusConfirmed {
		return fmt.Errorf("order must be confirmed to ship, current: %s", o.Status)
	}
	ev := DomainEvent{EventID: NewEventID(), Type: EventOrderShipped}
	data, _ := json.Marshal(OrderShippedEvent{
		TrackingNumber: trackingNumber,
		Carrier:        carrier,
		ShippedAt:      time.Now().UTC(),
	})
	ev.Data = data
	o.apply(ev, true)
	return nil
}

// Cancel command handler
func (o *Order) Cancel(reason string) error {
	if o.Status == StatusShipped || o.Status == StatusCancelled {
		return fmt.Errorf("cannot cancel order in status %s", o.Status)
	}
	ev := DomainEvent{EventID: NewEventID(), Type: EventOrderCancelled}
	data, _ := json.Marshal(OrderCancelledEvent{
		Reason: reason, CancelledAt: time.Now().UTC(),
	})
	ev.Data = data
	o.apply(ev, true)
	return nil
}

// apply processes an event, updating aggregate state.
// isNew=true records it in uncommitted list.
func (o *Order) apply(ev DomainEvent, isNew bool) {
	switch ev.Type {
	case EventOrderPlaced:
		var p OrderPlacedEvent
		_ = json.Unmarshal(ev.Data, &p)
		o.ID = NewEventID() // use a real UUID in production
		o.CustomerID = p.CustomerID
		o.Currency = p.Currency
		o.Status = StatusDraft
		o.Items = make(map[string]*OrderItem)

	case EventItemAdded:
		var p ItemAddedEvent
		_ = json.Unmarshal(ev.Data, &p)
		o.Items[p.ProductID] = &OrderItem{
			ProductID: p.ProductID, Quantity: p.Quantity, UnitPrice: p.UnitPrice,
		}

	case EventItemRemoved:
		var p ItemRemovedEvent
		_ = json.Unmarshal(ev.Data, &p)
		delete(o.Items, p.ProductID)

	case EventOrderConfirmed:
		o.Status = StatusConfirmed

	case EventOrderShipped:
		o.Status = StatusShipped

	case EventOrderCancelled:
		o.Status = StatusCancelled
	}

	o.Version++
	if isNew {
		ev.StreamVersion = o.Version
		o.uncommitted = append(o.uncommitted, ev)
	}
}

// Rehydrate replays events from the store to reconstruct aggregate state.
func Rehydrate(events []DomainEvent) *Order {
	o := &Order{Items: make(map[string]*OrderItem)}
	for _, ev := range events {
		o.apply(ev, false)
	}
	return o
}

// UncommittedEvents returns events produced in this session.
func (o *Order) UncommittedEvents() []DomainEvent {
	return o.uncommitted
}

// ClearUncommittedEvents is called after successful persistence.
func (o *Order) ClearUncommittedEvents() {
	o.uncommitted = nil
}
```

## Section 4: PostgreSQL Event Store

```sql
-- migrations/001_create_event_store.sql
CREATE TABLE IF NOT EXISTS events (
    event_id        UUID PRIMARY KEY,
    stream_id       TEXT        NOT NULL,
    stream_version  INTEGER     NOT NULL,
    event_type      TEXT        NOT NULL,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    data            JSONB       NOT NULL,
    metadata        JSONB       NOT NULL DEFAULT '{}'
);

-- Enforce optimistic concurrency: each (stream_id, version) must be unique
CREATE UNIQUE INDEX idx_events_stream_version ON events (stream_id, stream_version);

-- Fast stream loading by stream_id ordered by version
CREATE INDEX idx_events_stream_id ON events (stream_id, stream_version ASC);

-- Snapshots table for aggregate state caching
CREATE TABLE IF NOT EXISTS snapshots (
    stream_id       TEXT        PRIMARY KEY,
    stream_version  INTEGER     NOT NULL,
    snapshot_data   JSONB       NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

```go
// internal/store/eventstore.go
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"

	"github.com/example/orderservice/internal/domain"
)

var ErrConcurrencyConflict = errors.New("optimistic concurrency conflict: stream was modified")

type EventStore struct {
	db *sql.DB
}

func NewEventStore(db *sql.DB) *EventStore {
	return &EventStore{db: db}
}

// AppendEvents atomically appends events to a stream.
// expectedVersion is the stream_version of the last known event.
// If another writer has appended since, the unique constraint fires and
// ErrConcurrencyConflict is returned.
func (s *EventStore) AppendEvents(
	ctx context.Context,
	streamID string,
	expectedVersion int,
	events []domain.DomainEvent,
) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	for i, ev := range events {
		version := expectedVersion + i + 1
		_, err := tx.ExecContext(ctx, `
			INSERT INTO events
				(event_id, stream_id, stream_version, event_type, occurred_at, data, metadata)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			uuid.New().String(),
			streamID,
			version,
			string(ev.Type),
			time.Now().UTC(),
			ev.Data,
			ev.Metadata,
		)
		if err != nil {
			var pqErr *pq.Error
			if errors.As(err, &pqErr) && pqErr.Code == "23505" {
				return ErrConcurrencyConflict
			}
			return fmt.Errorf("insert event: %w", err)
		}
	}

	return tx.Commit()
}

// LoadStream loads all events for a stream, optionally from a version.
func (s *EventStore) LoadStream(
	ctx context.Context,
	streamID string,
	fromVersion int,
) ([]domain.DomainEvent, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT event_id, stream_id, stream_version, event_type, occurred_at, data, metadata
		FROM events
		WHERE stream_id = $1 AND stream_version > $2
		ORDER BY stream_version ASC`,
		streamID, fromVersion,
	)
	if err != nil {
		return nil, fmt.Errorf("query events: %w", err)
	}
	defer rows.Close()

	var events []domain.DomainEvent
	for rows.Next() {
		var ev domain.DomainEvent
		var eventType string
		if err := rows.Scan(
			&ev.EventID,
			&ev.StreamID,
			&ev.StreamVersion,
			&eventType,
			&ev.OccurredAt,
			&ev.Data,
			&ev.Metadata,
		); err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}
		ev.Type = domain.EventType(eventType)
		events = append(events, ev)
	}
	return events, rows.Err()
}

// SaveSnapshot upserts a snapshot for a stream.
func (s *EventStore) SaveSnapshot(
	ctx context.Context,
	streamID string,
	version int,
	state any,
) error {
	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("marshal snapshot: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO snapshots (stream_id, stream_version, snapshot_data)
		VALUES ($1, $2, $3)
		ON CONFLICT (stream_id) DO UPDATE
			SET stream_version = EXCLUDED.stream_version,
			    snapshot_data  = EXCLUDED.snapshot_data,
			    created_at     = NOW()`,
		streamID, version, data,
	)
	return err
}

// LoadSnapshot returns the latest snapshot for a stream, if one exists.
func (s *EventStore) LoadSnapshot(
	ctx context.Context,
	streamID string,
) (version int, data []byte, err error) {
	err = s.db.QueryRowContext(ctx, `
		SELECT stream_version, snapshot_data FROM snapshots WHERE stream_id = $1`,
		streamID,
	).Scan(&version, &data)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil, nil
	}
	return version, data, err
}
```

## Section 5: Order Repository with Snapshots

```go
// internal/store/orderrepo.go
package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/example/orderservice/internal/domain"
)

const snapshotInterval = 50 // take a snapshot every 50 events

type OrderRepository struct {
	es *EventStore
}

func NewOrderRepository(es *EventStore) *OrderRepository {
	return &OrderRepository{es: es}
}

func streamID(orderID string) string {
	return "order-" + orderID
}

func (r *OrderRepository) Load(ctx context.Context, orderID string) (*domain.Order, error) {
	sid := streamID(orderID)

	// Try snapshot first
	snapshotVersion, snapshotData, err := r.es.LoadSnapshot(ctx, sid)
	if err != nil {
		return nil, fmt.Errorf("load snapshot: %w", err)
	}

	var order *domain.Order
	if snapshotData != nil {
		order = &domain.Order{}
		if err := json.Unmarshal(snapshotData, order); err != nil {
			return nil, fmt.Errorf("unmarshal snapshot: %w", err)
		}
	}

	// Load events since snapshot version
	events, err := r.es.LoadStream(ctx, sid, snapshotVersion)
	if err != nil {
		return nil, fmt.Errorf("load stream: %w", err)
	}

	if order == nil {
		order = domain.Rehydrate(events)
	} else {
		// Apply events since snapshot
		for _, ev := range events {
			order = domain.Rehydrate(append([]domain.DomainEvent{}, events...))
			_ = order // break: rehydrate handles it
			break
		}
		order = domain.Rehydrate(events) // simplified: in production, call apply on existing state
	}

	if order.ID == "" {
		return nil, fmt.Errorf("order %s not found", orderID)
	}
	return order, nil
}

func (r *OrderRepository) Save(ctx context.Context, order *domain.Order) error {
	uncommitted := order.UncommittedEvents()
	if len(uncommitted) == 0 {
		return nil
	}

	sid := streamID(order.ID)
	expectedVersion := order.Version - len(uncommitted)

	if err := r.es.AppendEvents(ctx, sid, expectedVersion, uncommitted); err != nil {
		return fmt.Errorf("append events: %w", err)
	}

	order.ClearUncommittedEvents()

	// Take snapshot if version crossed threshold
	if order.Version%snapshotInterval == 0 {
		if err := r.es.SaveSnapshot(ctx, sid, order.Version, order); err != nil {
			// Non-fatal: log but continue
			fmt.Printf("warn: save snapshot failed: %v\n", err)
		}
	}

	return nil
}
```

## Section 6: CQRS Read Model Projection

```go
// internal/projection/order_summary.go
package projection

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/example/orderservice/internal/domain"
)

// OrderSummary is the denormalized read model for order list/detail views.
type OrderSummary struct {
	OrderID    string    `json:"order_id"`
	CustomerID string    `json:"customer_id"`
	Status     string    `json:"status"`
	ItemCount  int       `json:"item_count"`
	TotalValue float64   `json:"total_value"`
	Currency   string    `json:"currency"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// OrderSummaryProjection builds the order_summaries read model table.
type OrderSummaryProjection struct {
	db *sql.DB
}

func NewOrderSummaryProjection(db *sql.DB) *OrderSummaryProjection {
	return &OrderSummaryProjection{db: db}
}

// Handle processes a single domain event to update the read model.
func (p *OrderSummaryProjection) Handle(ctx context.Context, ev domain.DomainEvent) error {
	switch ev.Type {
	case domain.EventOrderPlaced:
		var data domain.OrderPlacedEvent
		if err := json.Unmarshal(ev.Data, &data); err != nil {
			return err
		}
		_, err := p.db.ExecContext(ctx, `
			INSERT INTO order_summaries
				(order_id, customer_id, status, item_count, total_value, currency, updated_at)
			VALUES ($1, $2, 'draft', 0, 0, $3, $4)
			ON CONFLICT (order_id) DO NOTHING`,
			data.OrderID, data.CustomerID, data.Currency, ev.OccurredAt,
		)
		return err

	case domain.EventItemAdded:
		var data domain.ItemAddedEvent
		if err := json.Unmarshal(ev.Data, &data); err != nil {
			return err
		}
		_, err := p.db.ExecContext(ctx, `
			UPDATE order_summaries
			SET item_count  = item_count + 1,
			    total_value = total_value + ($1 * $2),
			    updated_at  = $3
			WHERE order_id = $4`,
			data.Quantity, data.UnitPrice, ev.OccurredAt,
			streamIDToOrderID(ev.StreamID),
		)
		return err

	case domain.EventItemRemoved:
		var data domain.ItemRemovedEvent
		if err := json.Unmarshal(ev.Data, &data); err != nil {
			return err
		}
		// In a real projection, you'd need to subtract the correct amount.
		// Here we simply decrement item_count.
		_, err := p.db.ExecContext(ctx, `
			UPDATE order_summaries
			SET item_count = GREATEST(item_count - 1, 0),
			    updated_at = $1
			WHERE order_id = $2`,
			ev.OccurredAt, streamIDToOrderID(ev.StreamID),
		)
		return err

	case domain.EventOrderConfirmed:
		_, err := p.db.ExecContext(ctx, `
			UPDATE order_summaries SET status='confirmed', updated_at=$1 WHERE order_id=$2`,
			ev.OccurredAt, streamIDToOrderID(ev.StreamID),
		)
		return err

	case domain.EventOrderShipped:
		_, err := p.db.ExecContext(ctx, `
			UPDATE order_summaries SET status='shipped', updated_at=$1 WHERE order_id=$2`,
			ev.OccurredAt, streamIDToOrderID(ev.StreamID),
		)
		return err

	case domain.EventOrderCancelled:
		_, err := p.db.ExecContext(ctx, `
			UPDATE order_summaries SET status='cancelled', updated_at=$1 WHERE order_id=$2`,
			ev.OccurredAt, streamIDToOrderID(ev.StreamID),
		)
		return err

	default:
		slog.Debug("projection: unhandled event type", "type", ev.Type)
		return nil
	}
}

func streamIDToOrderID(streamID string) string {
	// "order-<uuid>" -> "<uuid>"
	if len(streamID) > 6 {
		return streamID[6:]
	}
	return streamID
}
```

Read model schema:

```sql
-- migrations/002_create_read_models.sql
CREATE TABLE IF NOT EXISTS order_summaries (
    order_id    TEXT        PRIMARY KEY,
    customer_id TEXT        NOT NULL,
    status      TEXT        NOT NULL,
    item_count  INTEGER     NOT NULL DEFAULT 0,
    total_value NUMERIC     NOT NULL DEFAULT 0,
    currency    TEXT        NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL
);

-- Index for customer queries
CREATE INDEX idx_order_summaries_customer ON order_summaries (customer_id, updated_at DESC);
CREATE INDEX idx_order_summaries_status ON order_summaries (status, updated_at DESC);

-- Projection checkpoint: tracks last processed event position
CREATE TABLE IF NOT EXISTS projection_checkpoints (
    projection_name TEXT    PRIMARY KEY,
    last_event_id   TEXT    NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Section 7: Event Versioning and Schema Evolution

Events are immutable once stored. When business requirements change, use upcasting to transform old event formats to new ones at read time.

```go
// internal/store/upcaster.go
package store

import (
	"encoding/json"

	"github.com/example/orderservice/internal/domain"
)

// Upcaster transforms old event versions to current format before processing.
type Upcaster struct{}

// Upcast transforms a raw event to the latest version.
func (u *Upcaster) Upcast(ev domain.DomainEvent) domain.DomainEvent {
	switch ev.Type {
	case "ItemAdded_v1":
		// v1 had price in cents (integer); v2 uses decimal float
		var v1 struct {
			ProductID string `json:"product_id"`
			Quantity  int    `json:"quantity"`
			PriceCents int   `json:"price_cents"`
		}
		if err := json.Unmarshal(ev.Data, &v1); err != nil {
			return ev
		}
		v2 := domain.ItemAddedEvent{
			ProductID: v1.ProductID,
			Quantity:  v1.Quantity,
			UnitPrice: float64(v1.PriceCents) / 100.0,
		}
		data, _ := json.Marshal(v2)
		ev.Type = domain.EventItemAdded
		ev.Data = data
		return ev
	}
	return ev
}
```

Register the upcaster in the event store's load path:

```go
func (s *EventStore) LoadStreamWithUpcast(
	ctx context.Context,
	streamID string,
	fromVersion int,
	upcaster *Upcaster,
) ([]domain.DomainEvent, error) {
	raw, err := s.LoadStream(ctx, streamID, fromVersion)
	if err != nil {
		return nil, err
	}
	result := make([]domain.DomainEvent, len(raw))
	for i, ev := range raw {
		result[i] = upcaster.Upcast(ev)
	}
	return result, nil
}
```

## Section 8: Command Handler Integration

```go
// internal/handler/order_commands.go
package handler

import (
	"context"
	"errors"
	"fmt"

	"github.com/example/orderservice/internal/domain"
	"github.com/example/orderservice/internal/store"
)

type PlaceOrderCommand struct {
	CustomerID string
	Currency   string
}

type AddItemCommand struct {
	OrderID   string
	ProductID string
	Quantity  int
	UnitPrice float64
}

type ConfirmOrderCommand struct {
	OrderID string
}

type OrderCommandHandler struct {
	repo *store.OrderRepository
}

func NewOrderCommandHandler(repo *store.OrderRepository) *OrderCommandHandler {
	return &OrderCommandHandler{repo: repo}
}

func (h *OrderCommandHandler) PlaceOrder(ctx context.Context, cmd PlaceOrderCommand) (string, error) {
	order, err := domain.NewOrder(cmd.CustomerID, cmd.Currency)
	if err != nil {
		return "", fmt.Errorf("create order: %w", err)
	}
	if err := h.repo.Save(ctx, order); err != nil {
		return "", fmt.Errorf("save order: %w", err)
	}
	return order.ID, nil
}

func (h *OrderCommandHandler) AddItem(ctx context.Context, cmd AddItemCommand) error {
	order, err := h.repo.Load(ctx, cmd.OrderID)
	if err != nil {
		return fmt.Errorf("load order: %w", err)
	}
	if err := order.AddItem(cmd.ProductID, cmd.Quantity, cmd.UnitPrice); err != nil {
		return err
	}
	return h.repo.Save(ctx, order)
}

func (h *OrderCommandHandler) ConfirmOrder(ctx context.Context, cmd ConfirmOrderCommand) error {
	for attempt := 0; attempt < 3; attempt++ {
		order, err := h.repo.Load(ctx, cmd.OrderID)
		if err != nil {
			return err
		}
		if err := order.Confirm(); err != nil {
			return err
		}
		err = h.repo.Save(ctx, order)
		if errors.Is(err, store.ErrConcurrencyConflict) {
			// Another command modified the aggregate concurrently; retry.
			continue
		}
		return err
	}
	return fmt.Errorf("failed after 3 retries due to concurrency conflicts")
}
```

## Section 9: When to Use Event Sourcing

Event sourcing adds complexity. Use it when:

1. **Audit log is a regulatory requirement** (financial, healthcare, legal systems).
2. **Time-travel debugging** is required — being able to replay to any point in time.
3. **Multiple read models** are needed from the same data (the event stream is the single source of truth).
4. **Eventual consistency is acceptable** between write and read models.
5. **Business events are first-class** (the domain experts already think in events).

Do not use event sourcing when:

1. The domain is simple CRUD with no meaningful history.
2. You need strong consistency on reads immediately after writes.
3. The team lacks experience with projection rebuilding and schema evolution.
4. Query patterns are unknown or constantly changing (rebuilding projections is expensive).

Traditional CRUD with an audit table is a simpler alternative that covers many "audit log" requirements without the full complexity of event sourcing. Choose event sourcing deliberately, not as a default architecture.
