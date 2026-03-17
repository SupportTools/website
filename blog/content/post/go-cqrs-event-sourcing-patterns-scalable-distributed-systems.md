---
title: "Go: Implementing CQRS and Event Sourcing Patterns for Scalable Distributed Systems"
date: 2031-06-25T00:00:00-05:00
draft: false
tags: ["Go", "CQRS", "Event Sourcing", "Distributed Systems", "Architecture", "Microservices", "DDD"]
categories:
- Go
- Architecture
- Distributed Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to CQRS and event sourcing in Go: aggregate design, event store implementation, projections, sagas for distributed transactions, and operational concerns including snapshotting and replay."
more_link: "yes"
url: "/go-cqrs-event-sourcing-patterns-scalable-distributed-systems/"
---

CQRS (Command Query Responsibility Segregation) and Event Sourcing are two complementary patterns that address different scaling and consistency challenges in distributed systems. CQRS separates the write path (commands) from the read path (queries), enabling each to be optimized independently. Event Sourcing replaces point-in-time state storage with an immutable log of state transitions, providing complete audit history, time-travel debugging, and the ability to rebuild any read model from scratch.

Together they solve problems that traditional CRUD architectures struggle with: complex business rules that require transaction consistency, multiple read models serving different use cases with different performance profiles, and the need to understand how system state evolved over time. This guide implements both patterns in Go with PostgreSQL as the event store.

<!--more-->

# Go: Implementing CQRS and Event Sourcing Patterns for Scalable Distributed Systems

## Core Concepts

Before implementation:

- **Aggregate**: A cluster of domain objects that maintain consistency boundaries. All changes go through the aggregate root (e.g., `Order`, `BankAccount`).
- **Command**: An intent to change state (`PlaceOrder`, `CancelOrder`). Can be rejected.
- **Event**: A fact that has occurred (`OrderPlaced`, `OrderCancelled`). Immutable, always accepted.
- **Event Store**: An append-only log of domain events, indexed by aggregate ID and version.
- **Projection**: A read model built by replaying events (e.g., a summary table, a search index).
- **Saga**: A long-running process coordinator that manages distributed transactions across aggregates.

## Project Structure

```
internal/
├── domain/
│   ├── order/
│   │   ├── aggregate.go    # Order aggregate
│   │   ├── commands.go     # Command types
│   │   ├── events.go       # Event types
│   │   └── handler.go      # Command handler
│   └── inventory/
│       ├── aggregate.go
│       ├── commands.go
│       └── events.go
├── store/
│   ├── eventstore.go       # Event store interface
│   ├── postgres/
│   │   └── eventstore.go   # PostgreSQL implementation
│   └── inmemory/
│       └── eventstore.go   # In-memory for testing
├── projection/
│   ├── runner.go           # Projection rebuild engine
│   ├── order_summary.go    # Order list projection
│   └── order_details.go    # Order detail projection
├── saga/
│   └── order_fulfillment.go # Order fulfillment saga
└── api/
    ├── command_handler.go   # HTTP command endpoint
    └── query_handler.go     # HTTP query endpoint
```

## Event and Command Definitions

```go
// internal/domain/order/events.go
package order

import (
	"time"
)

const (
	EventTypeOrderPlaced    = "order.placed"
	EventTypeOrderConfirmed = "order.confirmed"
	EventTypeOrderCancelled = "order.cancelled"
	EventTypeOrderShipped   = "order.shipped"
	EventTypeOrderDelivered = "order.delivered"
	EventTypeItemAdded      = "order.item_added"
	EventTypeItemRemoved    = "order.item_removed"
)

// OrderPlaced is emitted when a new order is created.
type OrderPlaced struct {
	OrderID    string    `json:"order_id"`
	CustomerID string    `json:"customer_id"`
	OccurredAt time.Time `json:"occurred_at"`
}

type OrderConfirmed struct {
	OrderID    string    `json:"order_id"`
	ConfirmedBy string   `json:"confirmed_by"`
	OccurredAt time.Time `json:"occurred_at"`
}

type OrderCancelled struct {
	OrderID    string    `json:"order_id"`
	Reason     string    `json:"reason"`
	CancelledBy string   `json:"cancelled_by"`
	OccurredAt time.Time `json:"occurred_at"`
}

type OrderShipped struct {
	OrderID        string    `json:"order_id"`
	TrackingNumber string    `json:"tracking_number"`
	Carrier        string    `json:"carrier"`
	OccurredAt     time.Time `json:"occurred_at"`
}

type ItemAdded struct {
	OrderID   string    `json:"order_id"`
	ProductID string    `json:"product_id"`
	Quantity  int       `json:"quantity"`
	UnitPrice float64   `json:"unit_price"`
	OccurredAt time.Time `json:"occurred_at"`
}

// internal/domain/order/commands.go
package order

type PlaceOrder struct {
	OrderID    string
	CustomerID string
}

type ConfirmOrder struct {
	OrderID     string
	ConfirmedBy string
}

type CancelOrder struct {
	OrderID     string
	Reason      string
	CancelledBy string
}

type AddItem struct {
	OrderID   string
	ProductID string
	Quantity  int
	UnitPrice float64
}
```

## Event Store Interface and Schema

```go
// internal/store/eventstore.go
package store

import (
	"context"
	"time"
)

// StoredEvent is the envelope around a domain event.
type StoredEvent struct {
	ID            int64
	AggregateID   string
	AggregateType string
	EventType     string
	Version       int64
	Data          []byte // JSON-serialized event payload
	Metadata      []byte // JSON: correlation ID, causation ID, user ID
	OccurredAt    time.Time
}

// EventStore is the interface for reading and writing events.
type EventStore interface {
	// AppendEvents atomically appends events to an aggregate stream.
	// expectedVersion: the version the caller expects the aggregate to be at.
	// Returns ErrVersionConflict if another writer has modified the aggregate.
	AppendEvents(ctx context.Context, events []StoredEvent, expectedVersion int64) error

	// LoadEvents returns all events for an aggregate, optionally from a version.
	LoadEvents(ctx context.Context, aggregateID string, fromVersion int64) ([]StoredEvent, error)

	// Subscribe returns a channel of events starting from globalPosition.
	// Used by projections and sagas.
	Subscribe(ctx context.Context, globalPosition int64) (<-chan StoredEvent, error)

	// GetPosition returns the current highest global event position.
	GetPosition(ctx context.Context) (int64, error)
}

// ErrVersionConflict is returned when optimistic concurrency control fails.
type ErrVersionConflict struct {
	AggregateID     string
	ExpectedVersion int64
	ActualVersion   int64
}

func (e *ErrVersionConflict) Error() string {
	return fmt.Sprintf("version conflict for %s: expected %d, got %d",
		e.AggregateID, e.ExpectedVersion, e.ActualVersion)
}
```

### PostgreSQL Event Store Schema

```sql
-- migrations/001_create_events_table.sql

CREATE TABLE IF NOT EXISTS events (
    id              BIGSERIAL PRIMARY KEY,
    aggregate_id    VARCHAR(255)    NOT NULL,
    aggregate_type  VARCHAR(255)    NOT NULL,
    event_type      VARCHAR(255)    NOT NULL,
    version         BIGINT          NOT NULL,
    data            JSONB           NOT NULL,
    metadata        JSONB           NOT NULL DEFAULT '{}',
    occurred_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    -- Optimistic concurrency: each version must be unique per aggregate
    CONSTRAINT uq_aggregate_version UNIQUE (aggregate_id, version)
);

-- Index for loading a single aggregate's events
CREATE INDEX idx_events_aggregate
    ON events (aggregate_id, version);

-- Index for global event subscription (projections, sagas)
CREATE INDEX idx_events_global
    ON events (id);

-- Index for querying by type (admin queries, debugging)
CREATE INDEX idx_events_type
    ON events (aggregate_type, event_type, occurred_at);

-- Snapshots table for performance optimization
CREATE TABLE IF NOT EXISTS snapshots (
    aggregate_id    VARCHAR(255)    NOT NULL,
    aggregate_type  VARCHAR(255)    NOT NULL,
    version         BIGINT          NOT NULL,
    state           JSONB           NOT NULL,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    PRIMARY KEY (aggregate_id)
);
```

### PostgreSQL Event Store Implementation

```go
// internal/store/postgres/eventstore.go
package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/your-org/service/internal/store"
)

type PostgresEventStore struct {
	pool *pgxpool.Pool
}

func NewPostgresEventStore(pool *pgxpool.Pool) *PostgresEventStore {
	return &PostgresEventStore{pool: pool}
}

func (s *PostgresEventStore) AppendEvents(
	ctx context.Context,
	events []store.StoredEvent,
	expectedVersion int64,
) error {
	if len(events) == 0 {
		return nil
	}

	return pgx.BeginTxFunc(ctx, s.pool, pgx.TxOptions{
		IsoLevel: pgx.Serializable,
	}, func(tx pgx.Tx) error {
		// Check current version (optimistic concurrency)
		var currentVersion int64
		err := tx.QueryRow(ctx,
			`SELECT COALESCE(MAX(version), -1)
			 FROM events WHERE aggregate_id = $1`,
			events[0].AggregateID,
		).Scan(&currentVersion)
		if err != nil {
			return fmt.Errorf("checking version: %w", err)
		}

		if currentVersion != expectedVersion {
			return &store.ErrVersionConflict{
				AggregateID:     events[0].AggregateID,
				ExpectedVersion: expectedVersion,
				ActualVersion:   currentVersion,
			}
		}

		// Insert events
		batch := &pgx.Batch{}
		for _, evt := range events {
			batch.Queue(
				`INSERT INTO events
				 (aggregate_id, aggregate_type, event_type, version, data, metadata, occurred_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
				evt.AggregateID,
				evt.AggregateType,
				evt.EventType,
				evt.Version,
				evt.Data,
				evt.Metadata,
				evt.OccurredAt,
			)
		}

		br := tx.SendBatch(ctx, batch)
		defer br.Close()

		for range events {
			if _, err := br.Exec(); err != nil {
				return fmt.Errorf("inserting event: %w", err)
			}
		}
		return br.Close()
	})
}

func (s *PostgresEventStore) LoadEvents(
	ctx context.Context,
	aggregateID string,
	fromVersion int64,
) ([]store.StoredEvent, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, aggregate_id, aggregate_type, event_type, version,
		        data, metadata, occurred_at
		 FROM events
		 WHERE aggregate_id = $1 AND version >= $2
		 ORDER BY version ASC`,
		aggregateID, fromVersion,
	)
	if err != nil {
		return nil, fmt.Errorf("querying events: %w", err)
	}
	defer rows.Close()

	var events []store.StoredEvent
	for rows.Next() {
		var evt store.StoredEvent
		if err := rows.Scan(
			&evt.ID, &evt.AggregateID, &evt.AggregateType,
			&evt.EventType, &evt.Version, &evt.Data,
			&evt.Metadata, &evt.OccurredAt,
		); err != nil {
			return nil, fmt.Errorf("scanning event: %w", err)
		}
		events = append(events, evt)
	}
	return events, rows.Err()
}
```

## Order Aggregate

```go
// internal/domain/order/aggregate.go
package order

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/your-org/service/internal/store"
)

type Status string

const (
	StatusDraft     Status = "draft"
	StatusPlaced    Status = "placed"
	StatusConfirmed Status = "confirmed"
	StatusCancelled Status = "cancelled"
	StatusShipped   Status = "shipped"
	StatusDelivered Status = "delivered"
)

type OrderItem struct {
	ProductID string
	Quantity  int
	UnitPrice float64
}

// Order is the aggregate root.
type Order struct {
	ID         string
	CustomerID string
	Status     Status
	Items      []OrderItem
	Version    int64  // Current event version

	// Uncommitted events generated by commands
	uncommitted []store.StoredEvent
}

// NewOrder creates a new order from the PlaceOrder command.
func NewOrder(cmd PlaceOrder) (*Order, error) {
	if cmd.OrderID == "" {
		return nil, errors.New("order ID is required")
	}
	if cmd.CustomerID == "" {
		return nil, errors.New("customer ID is required")
	}

	o := &Order{}
	o.apply(store.StoredEvent{
		AggregateID:   cmd.OrderID,
		AggregateType: "Order",
		EventType:     EventTypeOrderPlaced,
		Version:       0,
		OccurredAt:    time.Now().UTC(),
	}, OrderPlaced{
		OrderID:    cmd.OrderID,
		CustomerID: cmd.CustomerID,
		OccurredAt: time.Now().UTC(),
	})

	return o, nil
}

// Reconstruct rebuilds an Order from a slice of stored events.
func Reconstruct(events []store.StoredEvent) (*Order, error) {
	o := &Order{}
	for _, evt := range events {
		if err := o.applyStored(evt); err != nil {
			return nil, fmt.Errorf("applying event %s at version %d: %w",
				evt.EventType, evt.Version, err)
		}
	}
	return o, nil
}

// Confirm transitions the order to confirmed state.
func (o *Order) Confirm(cmd ConfirmOrder) error {
	if o.Status != StatusPlaced {
		return fmt.Errorf("cannot confirm order in status %s", o.Status)
	}
	if len(o.Items) == 0 {
		return errors.New("cannot confirm order with no items")
	}

	o.apply(store.StoredEvent{
		AggregateID:   o.ID,
		AggregateType: "Order",
		EventType:     EventTypeOrderConfirmed,
		Version:       o.Version + 1,
		OccurredAt:    time.Now().UTC(),
	}, OrderConfirmed{
		OrderID:     o.ID,
		ConfirmedBy: cmd.ConfirmedBy,
		OccurredAt:  time.Now().UTC(),
	})
	return nil
}

// Cancel transitions the order to cancelled state.
func (o *Order) Cancel(cmd CancelOrder) error {
	if o.Status == StatusCancelled || o.Status == StatusShipped || o.Status == StatusDelivered {
		return fmt.Errorf("cannot cancel order in status %s", o.Status)
	}

	o.apply(store.StoredEvent{
		AggregateID:   o.ID,
		AggregateType: "Order",
		EventType:     EventTypeOrderCancelled,
		Version:       o.Version + 1,
		OccurredAt:    time.Now().UTC(),
	}, OrderCancelled{
		OrderID:     o.ID,
		Reason:      cmd.Reason,
		CancelledBy: cmd.CancelledBy,
		OccurredAt:  time.Now().UTC(),
	})
	return nil
}

// UncommittedEvents returns events generated since last save.
func (o *Order) UncommittedEvents() []store.StoredEvent {
	return o.uncommitted
}

// ClearUncommitted marks events as saved.
func (o *Order) ClearUncommitted() {
	o.uncommitted = nil
}

// apply generates a new event and updates aggregate state.
func (o *Order) apply(evt store.StoredEvent, payload interface{}) {
	data, _ := json.Marshal(payload)
	evt.Data = data
	o.uncommitted = append(o.uncommitted, evt)
	_ = o.applyStored(evt)
}

// applyStored updates state from a stored event (used during reconstruction).
func (o *Order) applyStored(evt store.StoredEvent) error {
	switch evt.EventType {
	case EventTypeOrderPlaced:
		var e OrderPlaced
		if err := json.Unmarshal(evt.Data, &e); err != nil {
			return err
		}
		o.ID = e.OrderID
		o.CustomerID = e.CustomerID
		o.Status = StatusPlaced

	case EventTypeOrderConfirmed:
		o.Status = StatusConfirmed

	case EventTypeOrderCancelled:
		o.Status = StatusCancelled

	case EventTypeOrderShipped:
		o.Status = StatusShipped

	case EventTypeItemAdded:
		var e ItemAdded
		if err := json.Unmarshal(evt.Data, &e); err != nil {
			return err
		}
		o.Items = append(o.Items, OrderItem{
			ProductID: e.ProductID,
			Quantity:  e.Quantity,
			UnitPrice: e.UnitPrice,
		})

	default:
		// Unknown event types are silently ignored (forward compatibility)
	}

	o.Version = evt.Version
	return nil
}
```

## Command Handler

```go
// internal/domain/order/handler.go
package order

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/your-org/service/internal/store"
)

type CommandHandler struct {
	events store.EventStore
}

func NewCommandHandler(events store.EventStore) *CommandHandler {
	return &CommandHandler{events: events}
}

func (h *CommandHandler) HandlePlaceOrder(ctx context.Context, cmd PlaceOrder) error {
	order, err := NewOrder(cmd)
	if err != nil {
		return fmt.Errorf("creating order: %w", err)
	}

	if err := h.save(ctx, order, -1); err != nil {
		return fmt.Errorf("saving order: %w", err)
	}
	return nil
}

func (h *CommandHandler) HandleConfirmOrder(ctx context.Context, cmd ConfirmOrder) error {
	return h.executeCommand(ctx, cmd.OrderID, func(order *Order) error {
		return order.Confirm(cmd)
	})
}

func (h *CommandHandler) HandleCancelOrder(ctx context.Context, cmd CancelOrder) error {
	return h.executeCommand(ctx, cmd.OrderID, func(order *Order) error {
		return order.Cancel(cmd)
	})
}

// executeCommand loads, modifies, and saves an aggregate with retry on conflict.
func (h *CommandHandler) executeCommand(
	ctx context.Context,
	aggregateID string,
	fn func(*Order) error,
) error {
	const maxRetries = 3
	var lastErr error

	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			// Brief pause before retry
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt*10) * time.Millisecond):
			}
		}

		// Load aggregate
		events, err := h.events.LoadEvents(ctx, aggregateID, 0)
		if err != nil {
			return fmt.Errorf("loading order %s: %w", aggregateID, err)
		}
		if len(events) == 0 {
			return fmt.Errorf("order %s not found", aggregateID)
		}

		order, err := Reconstruct(events)
		if err != nil {
			return fmt.Errorf("reconstructing order: %w", err)
		}

		// Apply command
		if err := fn(order); err != nil {
			return err // Domain errors are not retried
		}

		// Save
		if err := h.save(ctx, order, order.Version); err != nil {
			var conflictErr *store.ErrVersionConflict
			if errors.As(err, &conflictErr) {
				lastErr = err
				continue // Retry on optimistic concurrency conflict
			}
			return err
		}
		return nil
	}

	return fmt.Errorf("max retries exceeded: %w", lastErr)
}

func (h *CommandHandler) save(ctx context.Context, order *Order, expectedVersion int64) error {
	events := order.UncommittedEvents()
	if len(events) == 0 {
		return nil
	}

	if err := h.events.AppendEvents(ctx, events, expectedVersion); err != nil {
		return err
	}

	order.ClearUncommitted()
	return nil
}
```

## Projections

Projections build read models by consuming the event stream:

```go
// internal/projection/order_summary.go
package projection

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/your-org/service/internal/domain/order"
	"github.com/your-org/service/internal/store"
)

// OrderSummaryProjection maintains a denormalized orders table for list queries.
type OrderSummaryProjection struct {
	db     *sql.DB
	events store.EventStore
	logger *slog.Logger
}

// Run starts the projection, consuming events from lastPosition.
func (p *OrderSummaryProjection) Run(ctx context.Context, lastPosition int64) error {
	eventCh, err := p.events.Subscribe(ctx, lastPosition)
	if err != nil {
		return fmt.Errorf("subscribing: %w", err)
	}

	for {
		select {
		case <-ctx.Done():
			return nil

		case evt, ok := <-eventCh:
			if !ok {
				return nil
			}

			if err := p.handleEvent(ctx, evt); err != nil {
				p.logger.Error("projection error",
					"event_type", evt.EventType,
					"aggregate_id", evt.AggregateID,
					"error", err,
				)
				// For idempotent projections, log and continue
				// For critical projections, return err to trigger restart
			}

			// Checkpoint: save last processed position
			if err := p.saveCheckpoint(ctx, evt.ID); err != nil {
				return fmt.Errorf("saving checkpoint: %w", err)
			}
		}
	}
}

func (p *OrderSummaryProjection) handleEvent(ctx context.Context, evt store.StoredEvent) error {
	switch evt.EventType {
	case order.EventTypeOrderPlaced:
		var e order.OrderPlaced
		if err := json.Unmarshal(evt.Data, &e); err != nil {
			return err
		}
		_, err := p.db.ExecContext(ctx,
			`INSERT INTO order_summaries
			 (order_id, customer_id, status, item_count, total_usd, placed_at)
			 VALUES ($1, $2, 'placed', 0, 0, $3)
			 ON CONFLICT (order_id) DO NOTHING`,
			e.OrderID, e.CustomerID, e.OccurredAt,
		)
		return err

	case order.EventTypeOrderConfirmed:
		_, err := p.db.ExecContext(ctx,
			`UPDATE order_summaries SET status = 'confirmed' WHERE order_id = $1`,
			evt.AggregateID,
		)
		return err

	case order.EventTypeOrderCancelled:
		_, err := p.db.ExecContext(ctx,
			`UPDATE order_summaries SET status = 'cancelled' WHERE order_id = $1`,
			evt.AggregateID,
		)
		return err

	case order.EventTypeItemAdded:
		var e order.ItemAdded
		if err := json.Unmarshal(evt.Data, &e); err != nil {
			return err
		}
		_, err := p.db.ExecContext(ctx,
			`UPDATE order_summaries
			 SET item_count = item_count + $2,
			     total_usd = total_usd + ($3 * $4)
			 WHERE order_id = $1`,
			e.OrderID, e.Quantity, e.UnitPrice, e.Quantity,
		)
		return err
	}

	return nil // Unknown events are silently ignored
}

func (p *OrderSummaryProjection) saveCheckpoint(ctx context.Context, position int64) error {
	_, err := p.db.ExecContext(ctx,
		`INSERT INTO projection_checkpoints (projection_name, position)
		 VALUES ('order_summary', $1)
		 ON CONFLICT (projection_name) DO UPDATE SET position = $1`,
		position,
	)
	return err
}
```

## Snapshotting

For aggregates with many events, load performance degrades. Snapshots cache aggregate state:

```go
// internal/domain/order/repository.go
package order

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/your-org/service/internal/store"
)

const snapshotEvery = 50 // Take snapshot every 50 events

type OrderState struct {
	ID         string      `json:"id"`
	CustomerID string      `json:"customer_id"`
	Status     Status      `json:"status"`
	Items      []OrderItem `json:"items"`
	Version    int64       `json:"version"`
}

type Repository struct {
	events    store.EventStore
	snapshots store.SnapshotStore
}

func (r *Repository) Load(ctx context.Context, orderID string) (*Order, error) {
	// Try to load from snapshot first
	snapshot, err := r.snapshots.LoadSnapshot(ctx, orderID)
	if err != nil {
		return nil, fmt.Errorf("loading snapshot: %w", err)
	}

	fromVersion := int64(0)
	var order *Order

	if snapshot != nil {
		// Restore from snapshot
		var state OrderState
		if err := json.Unmarshal(snapshot.State, &state); err != nil {
			return nil, fmt.Errorf("unmarshaling snapshot: %w", err)
		}
		order = &Order{
			ID:         state.ID,
			CustomerID: state.CustomerID,
			Status:     state.Status,
			Items:      state.Items,
			Version:    state.Version,
		}
		fromVersion = snapshot.Version + 1
	}

	// Load events since snapshot
	events, err := r.events.LoadEvents(ctx, orderID, fromVersion)
	if err != nil {
		return nil, fmt.Errorf("loading events: %w", err)
	}

	if order == nil {
		if len(events) == 0 {
			return nil, fmt.Errorf("order %s not found", orderID)
		}
		order = &Order{}
	}

	for _, evt := range events {
		if err := order.applyStored(evt); err != nil {
			return nil, fmt.Errorf("applying event: %w", err)
		}
	}

	return order, nil
}

func (r *Repository) Save(ctx context.Context, order *Order, expectedVersion int64) error {
	if err := r.events.AppendEvents(ctx, order.UncommittedEvents(), expectedVersion); err != nil {
		return err
	}

	order.ClearUncommitted()

	// Take snapshot if threshold reached
	if order.Version > 0 && order.Version%snapshotEvery == 0 {
		state, _ := json.Marshal(OrderState{
			ID:         order.ID,
			CustomerID: order.CustomerID,
			Status:     order.Status,
			Items:      order.Items,
			Version:    order.Version,
		})
		_ = r.snapshots.SaveSnapshot(ctx, store.Snapshot{
			AggregateID: order.ID,
			Version:     order.Version,
			State:       state,
		})
	}

	return nil
}
```

## Saga: Order Fulfillment Distributed Transaction

A saga coordinates actions across multiple aggregates/services with compensating transactions:

```go
// internal/saga/order_fulfillment.go
package saga

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/your-org/service/internal/domain/order"
	"github.com/your-org/service/internal/store"
)

// OrderFulfillmentSaga orchestrates: confirm payment -> reserve inventory -> ship order.
// If any step fails, compensating transactions are executed in reverse.
type OrderFulfillmentSaga struct {
	events    store.EventStore
	payments  PaymentService
	inventory InventoryService
	shipping  ShippingService
	logger    *slog.Logger
}

type SagaState struct {
	OrderID          string       `json:"order_id"`
	Step             string       `json:"step"`
	PaymentID        string       `json:"payment_id,omitempty"`
	ReservationID    string       `json:"reservation_id,omitempty"`
	CompensateDone   bool         `json:"compensate_done"`
}

func (s *OrderFulfillmentSaga) Handle(ctx context.Context, evt store.StoredEvent) error {
	if evt.EventType != order.EventTypeOrderConfirmed {
		return nil // Only handle confirmed orders
	}

	var confirmed order.OrderConfirmed
	if err := json.Unmarshal(evt.Data, &confirmed); err != nil {
		return fmt.Errorf("unmarshaling event: %w", err)
	}

	state := &SagaState{
		OrderID: confirmed.OrderID,
		Step:    "start",
	}

	// Step 1: Process payment
	state.Step = "payment"
	paymentID, err := s.payments.ChargeCustomer(ctx, confirmed.OrderID)
	if err != nil {
		s.logger.Error("payment failed", "order_id", confirmed.OrderID, "error", err)
		return s.compensate(ctx, state)
	}
	state.PaymentID = paymentID

	// Step 2: Reserve inventory
	state.Step = "inventory"
	reservationID, err := s.inventory.Reserve(ctx, confirmed.OrderID)
	if err != nil {
		s.logger.Error("inventory reservation failed",
			"order_id", confirmed.OrderID, "error", err)
		return s.compensate(ctx, state)
	}
	state.ReservationID = reservationID

	// Step 3: Create shipment
	state.Step = "shipping"
	if err := s.shipping.CreateShipment(ctx, confirmed.OrderID, reservationID); err != nil {
		s.logger.Error("shipment creation failed",
			"order_id", confirmed.OrderID, "error", err)
		return s.compensate(ctx, state)
	}

	return nil
}

// compensate executes compensating transactions in reverse order.
func (s *OrderFulfillmentSaga) compensate(ctx context.Context, state *SagaState) error {
	s.logger.Warn("starting saga compensation",
		"order_id", state.OrderID,
		"failed_step", state.Step,
	)

	switch state.Step {
	case "shipping", "inventory":
		if state.ReservationID != "" {
			if err := s.inventory.ReleaseReservation(ctx, state.ReservationID); err != nil {
				s.logger.Error("compensation failed: release reservation",
					"error", err)
			}
		}
		fallthrough

	case "payment":
		if state.PaymentID != "" {
			if err := s.payments.Refund(ctx, state.PaymentID); err != nil {
				s.logger.Error("compensation failed: refund payment",
					"error", err)
			}
		}
	}

	// Emit cancellation command
	return s.cancelOrder(ctx, state.OrderID,
		fmt.Sprintf("fulfillment failed at %s step", state.Step))
}

func (s *OrderFulfillmentSaga) cancelOrder(ctx context.Context, orderID, reason string) error {
	// This would dispatch a CancelOrder command through the command handler
	s.logger.Info("cancelling order due to fulfillment failure",
		"order_id", orderID,
		"reason", reason,
	)
	return nil
}
```

## Projection Rebuilding

The ability to rebuild projections from scratch is one of event sourcing's core advantages:

```go
// internal/projection/runner.go
package projection

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/your-org/service/internal/store"
)

// Projector handles a single event.
type Projector interface {
	Handle(ctx context.Context, evt store.StoredEvent) error
	Name() string
}

// Runner replays all events through a projector, then subscribes to new events.
func Rebuild(
	ctx context.Context,
	events store.EventStore,
	projector Projector,
	logger *slog.Logger,
) error {
	logger.Info("starting projection rebuild", "projection", projector.Name())
	start := time.Now()
	var processed int64

	// Replay all historical events
	position := int64(0)
	const batchSize = 1000

	for {
		// Load batch of events from current position
		batch, err := loadEventsBatch(ctx, events, position, batchSize)
		if err != nil {
			return fmt.Errorf("loading batch at position %d: %w", position, err)
		}

		for _, evt := range batch {
			if err := projector.Handle(ctx, evt); err != nil {
				return fmt.Errorf("handling event %d: %w", evt.ID, err)
			}
			position = evt.ID
			processed++

			if processed%10000 == 0 {
				logger.Info("rebuild progress",
					"projection", projector.Name(),
					"processed", processed,
					"position", position,
					"elapsed", time.Since(start),
				)
			}
		}

		if len(batch) < batchSize {
			break // Reached end of historical events
		}
	}

	logger.Info("rebuild complete",
		"projection", projector.Name(),
		"processed", processed,
		"duration", time.Since(start),
	)

	return nil
}
```

## HTTP Layer (CQRS API)

```go
// internal/api/server.go
package api

import (
	"encoding/json"
	"net/http"

	"github.com/your-org/service/internal/domain/order"
)

type Server struct {
	commands *order.CommandHandler
	queries  *QueryService
}

// Command endpoint — write side
func (s *Server) handlePlaceOrder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		OrderID    string `json:"order_id"`
		CustomerID string `json:"customer_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	if err := s.commands.HandlePlaceOrder(r.Context(), order.PlaceOrder{
		OrderID:    req.OrderID,
		CustomerID: req.CustomerID,
	}); err != nil {
		// Map domain errors to HTTP status codes
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Location", "/orders/"+req.OrderID)
	w.WriteHeader(http.StatusAccepted)
}

// Query endpoint — read side (hits projection tables)
func (s *Server) handleGetOrder(w http.ResponseWriter, r *http.Request) {
	orderID := r.PathValue("id")

	summary, err := s.queries.GetOrderSummary(r.Context(), orderID)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(summary)
}
```

## Testing Patterns

```go
// internal/domain/order/aggregate_test.go
package order_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/your-org/service/internal/domain/order"
)

func TestOrder_PlaceAndConfirm(t *testing.T) {
	// Given: a new order is placed
	o, err := order.NewOrder(order.PlaceOrder{
		OrderID:    "ord-001",
		CustomerID: "cust-001",
	})
	require.NoError(t, err)

	// Then: it is in placed status
	assert.Equal(t, order.StatusPlaced, o.Status)
	assert.Len(t, o.UncommittedEvents(), 1)
	assert.Equal(t, order.EventTypeOrderPlaced, o.UncommittedEvents()[0].EventType)

	// When: items are added and order is confirmed
	err = o.Confirm(order.ConfirmOrder{
		OrderID:     "ord-001",
		ConfirmedBy: "system",
	})
	// Then: fails because no items
	assert.Error(t, err)

	// Add an item first
	o.AddItem(order.AddItem{
		OrderID:   "ord-001",
		ProductID: "prod-001",
		Quantity:  2,
		UnitPrice: 29.99,
	})

	err = o.Confirm(order.ConfirmOrder{
		OrderID:     "ord-001",
		ConfirmedBy: "system",
	})
	require.NoError(t, err)
	assert.Equal(t, order.StatusConfirmed, o.Status)
}

func TestOrder_ReconstructFromEvents(t *testing.T) {
	// Place an order
	o, _ := order.NewOrder(order.PlaceOrder{OrderID: "ord-001", CustomerID: "cust-001"})
	events := o.UncommittedEvents()

	// Reconstruct from events
	reconstructed, err := order.Reconstruct(events)
	require.NoError(t, err)

	assert.Equal(t, o.ID, reconstructed.ID)
	assert.Equal(t, o.CustomerID, reconstructed.CustomerID)
	assert.Equal(t, o.Status, reconstructed.Status)
}
```

CQRS and Event Sourcing add complexity that is not always warranted. They shine when: business rules are complex enough to require explicit state machine validation, audit history is a first-class requirement, multiple read models serve different access patterns, or replay-based debugging is needed. For simple CRUD applications, the overhead is not justified. When the patterns do fit, Go's type system, goroutines for projection runners, and pgx for PostgreSQL make for an ergonomic and performant implementation.
