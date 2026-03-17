---
title: "Go Event Sourcing Patterns: CQRS, Event Store, and Projection Rebuilding"
date: 2028-05-03T00:00:00-05:00
draft: false
tags: ["Go", "Event Sourcing", "CQRS", "EventStore", "Architecture"]
categories: ["Go", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to implementing event sourcing and CQRS in Go covering aggregate design, event store implementation, snapshot strategies, projection rebuilding, and command/query separation with practical production patterns."
more_link: "yes"
url: "/go-event-sourcing-cqrs-patterns-guide/"
---

Event sourcing captures every state change as an immutable event rather than updating in-place records. Combined with CQRS (Command Query Responsibility Segregation), it creates systems where the full history of what happened is always available, projections can be rebuilt from scratch, and read models are optimized independently from write models. This guide builds a complete event sourcing system in Go with production-grade patterns.

<!--more-->

# Go Event Sourcing Patterns: CQRS, Event Store, and Projection Rebuilding

## Core Concepts

**Event Sourcing** replaces the traditional "save current state" approach with "append every state change as an event." The current state is derived by replaying all events. This provides:
- Complete audit trail
- Time-travel debugging (replay from any point)
- Multiple read models from the same event history
- Natural event-driven integration with other services

**CQRS** separates the write model (commands that change state) from read models (queries that return data). Commands go through aggregates and produce events. Queries read from denormalized projections optimized for specific read patterns.

**Aggregate**: A consistency boundary that handles commands, enforces invariants, and produces events. All changes to an aggregate go through its command handlers.

**Event Store**: An append-only log of events grouped by aggregate ID. The only write operation is appending; reads return a sequence of events.

**Projection**: A read model built by consuming events. Multiple projections can exist for the same event stream, each optimized for different query patterns.

## Domain Model: Order Management

We will build an order management system to demonstrate all patterns:

```go
// domain/order/events.go
package order

import (
    "time"
)

// Event types - use string constants for serialization stability
const (
    EventOrderPlaced    = "order.placed"
    EventOrderConfirmed = "order.confirmed"
    EventOrderShipped   = "order.shipped"
    EventOrderCancelled = "order.cancelled"
    EventItemAdded      = "order.item_added"
    EventItemRemoved    = "order.item_removed"
    EventPaymentApplied = "order.payment_applied"
)

// DomainEvent is the interface all events implement.
type DomainEvent interface {
    EventType() string
    AggregateID() string
    OccurredAt() time.Time
}

// BaseEvent provides common event fields.
type BaseEvent struct {
    Type        string    `json:"type"`
    AggregateId string    `json:"aggregate_id"`
    Occurred    time.Time `json:"occurred_at"`
    Version     int       `json:"version"`
}

func (e BaseEvent) EventType() string    { return e.Type }
func (e BaseEvent) AggregateID() string  { return e.AggregateId }
func (e BaseEvent) OccurredAt() time.Time { return e.Occurred }

// Concrete events
type OrderPlaced struct {
    BaseEvent
    CustomerID string  `json:"customer_id"`
    TotalAmount float64 `json:"total_amount"`
    Currency    string  `json:"currency"`
}

type OrderConfirmed struct {
    BaseEvent
    ConfirmedBy string `json:"confirmed_by"`
}

type OrderShipped struct {
    BaseEvent
    TrackingNumber string `json:"tracking_number"`
    Carrier        string `json:"carrier"`
    EstimatedDays  int    `json:"estimated_days"`
}

type OrderCancelled struct {
    BaseEvent
    Reason      string `json:"reason"`
    CancelledBy string `json:"cancelled_by"`
}

type ItemAdded struct {
    BaseEvent
    SKU      string  `json:"sku"`
    Quantity int     `json:"quantity"`
    Price    float64 `json:"price"`
}

type PaymentApplied struct {
    BaseEvent
    Amount        float64 `json:"amount"`
    PaymentMethod string  `json:"payment_method"`
    TransactionID string  `json:"transaction_id"`
}
```

## Aggregate Implementation

```go
// domain/order/aggregate.go
package order

import (
    "errors"
    "fmt"
    "time"
)

type Status string

const (
    StatusDraft     Status = "draft"
    StatusPlaced    Status = "placed"
    StatusConfirmed Status = "confirmed"
    StatusShipped   Status = "shipped"
    StatusCancelled Status = "cancelled"
)

var (
    ErrOrderAlreadyPlaced   = errors.New("order has already been placed")
    ErrOrderNotPlaced       = errors.New("order has not been placed")
    ErrCannotCancelShipped  = errors.New("cannot cancel a shipped order")
    ErrInsufficientItems    = errors.New("order must have at least one item")
    ErrInvalidVersion       = errors.New("aggregate version conflict")
)

type Item struct {
    SKU      string
    Quantity int
    Price    float64
}

// Order is the aggregate root.
type Order struct {
    id             string
    version        int        // Current persisted version
    uncommitted    []DomainEvent // Events not yet persisted
    status         Status
    customerID     string
    items          map[string]Item
    totalAmount    float64
    amountPaid     float64
    trackingNumber string
}

// NewOrder creates an empty order aggregate.
func NewOrder(id string) *Order {
    return &Order{
        id:    id,
        items: make(map[string]Item),
    }
}

// Rehydrate replays events to reconstruct state from the event store.
func Rehydrate(id string, events []DomainEvent) (*Order, error) {
    o := NewOrder(id)
    for _, event := range events {
        if err := o.apply(event, false); err != nil {
            return nil, fmt.Errorf("rehydrating event %s: %w", event.EventType(), err)
        }
    }
    o.version = len(events)
    return o, nil
}

// apply updates the aggregate state from an event.
// If isNew=true, the event is tracked as uncommitted.
func (o *Order) apply(event DomainEvent, isNew bool) error {
    switch e := event.(type) {
    case *OrderPlaced:
        o.status = StatusPlaced
        o.customerID = e.CustomerID
        o.totalAmount = e.TotalAmount

    case *OrderConfirmed:
        o.status = StatusConfirmed

    case *OrderShipped:
        o.status = StatusShipped
        o.trackingNumber = e.TrackingNumber

    case *OrderCancelled:
        o.status = StatusCancelled

    case *ItemAdded:
        existing := o.items[e.SKU]
        o.items[e.SKU] = Item{
            SKU:      e.SKU,
            Quantity: existing.Quantity + e.Quantity,
            Price:    e.Price,
        }
        o.totalAmount += float64(e.Quantity) * e.Price

    case *PaymentApplied:
        o.amountPaid += e.Amount

    default:
        return fmt.Errorf("unknown event type: %T", event)
    }

    if isNew {
        o.uncommitted = append(o.uncommitted, event)
    }
    return nil
}

// baseEvent builds a BaseEvent for a new event.
func (o *Order) baseEvent(eventType string) BaseEvent {
    return BaseEvent{
        Type:        eventType,
        AggregateId: o.id,
        Occurred:    time.Now().UTC(),
        Version:     o.version + len(o.uncommitted) + 1,
    }
}

// --- Command Handlers ---

func (o *Order) AddItem(sku string, quantity int, price float64) error {
    if o.status != StatusDraft {
        return ErrOrderAlreadyPlaced
    }

    event := &ItemAdded{
        BaseEvent: o.baseEvent(EventItemAdded),
        SKU:       sku,
        Quantity:  quantity,
        Price:     price,
    }

    return o.apply(event, true)
}

func (o *Order) Place(customerID string) error {
    if o.status != StatusDraft {
        return ErrOrderAlreadyPlaced
    }

    if len(o.items) == 0 {
        return ErrInsufficientItems
    }

    event := &OrderPlaced{
        BaseEvent:   o.baseEvent(EventOrderPlaced),
        CustomerID:  customerID,
        TotalAmount: o.totalAmount,
        Currency:    "USD",
    }

    return o.apply(event, true)
}

func (o *Order) Confirm(confirmedBy string) error {
    if o.status != StatusPlaced {
        return ErrOrderNotPlaced
    }

    event := &OrderConfirmed{
        BaseEvent:   o.baseEvent(EventOrderConfirmed),
        ConfirmedBy: confirmedBy,
    }

    return o.apply(event, true)
}

func (o *Order) Ship(trackingNumber, carrier string, estimatedDays int) error {
    if o.status != StatusConfirmed {
        return fmt.Errorf("cannot ship an order with status %s", o.status)
    }

    event := &OrderShipped{
        BaseEvent:      o.baseEvent(EventOrderShipped),
        TrackingNumber: trackingNumber,
        Carrier:        carrier,
        EstimatedDays:  estimatedDays,
    }

    return o.apply(event, true)
}

func (o *Order) Cancel(reason, cancelledBy string) error {
    if o.status == StatusShipped {
        return ErrCannotCancelShipped
    }

    if o.status == StatusCancelled {
        return nil // Idempotent
    }

    event := &OrderCancelled{
        BaseEvent:   o.baseEvent(EventOrderCancelled),
        Reason:      reason,
        CancelledBy: cancelledBy,
    }

    return o.apply(event, true)
}

func (o *Order) ApplyPayment(amount float64, method, transactionID string) error {
    event := &PaymentApplied{
        BaseEvent:     o.baseEvent(EventPaymentApplied),
        Amount:        amount,
        PaymentMethod: method,
        TransactionID: transactionID,
    }

    return o.apply(event, true)
}

// --- State Accessors ---

func (o *Order) ID() string            { return o.id }
func (o *Order) Version() int          { return o.version }
func (o *Order) Status() Status        { return o.status }
func (o *Order) CustomerID() string    { return o.customerID }
func (o *Order) TotalAmount() float64  { return o.totalAmount }
func (o *Order) AmountPaid() float64   { return o.amountPaid }
func (o *Order) TrackingNumber() string { return o.trackingNumber }

func (o *Order) UncommittedEvents() []DomainEvent { return o.uncommitted }

// MarkAsCommitted clears uncommitted events after successful persistence.
func (o *Order) MarkAsCommitted() {
    o.version += len(o.uncommitted)
    o.uncommitted = nil
}
```

## Event Store Implementation

```go
// eventstore/store.go
package eventstore

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

var ErrOptimisticConcurrency = errors.New("optimistic concurrency conflict")
var ErrStreamNotFound = errors.New("event stream not found")

type StoredEvent struct {
    StreamID      string          `json:"stream_id"`
    StreamVersion int             `json:"stream_version"`
    EventType     string          `json:"event_type"`
    EventData     json.RawMessage `json:"event_data"`
    Metadata      json.RawMessage `json:"metadata"`
    OccurredAt    time.Time       `json:"occurred_at"`
    GlobalSeq     int64           `json:"global_seq"`
}

type AppendRequest struct {
    StreamID        string
    ExpectedVersion int // -1 for "stream should not exist"
    Events          []EventToStore
}

type EventToStore struct {
    EventType  string
    EventData  interface{}
    Metadata   map[string]string
    OccurredAt time.Time
}

type PostgresEventStore struct {
    pool *pgxpool.Pool
}

func NewPostgresEventStore(pool *pgxpool.Pool) *PostgresEventStore {
    return &PostgresEventStore{pool: pool}
}

// Schema creation
const createSchema = `
CREATE TABLE IF NOT EXISTS event_store (
    global_seq     BIGSERIAL PRIMARY KEY,
    stream_id      VARCHAR(255) NOT NULL,
    stream_version INTEGER NOT NULL,
    event_type     VARCHAR(255) NOT NULL,
    event_data     JSONB NOT NULL,
    metadata       JSONB NOT NULL DEFAULT '{}',
    occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (stream_id, stream_version)
);

CREATE INDEX IF NOT EXISTS idx_event_store_stream_id
    ON event_store (stream_id, stream_version);
CREATE INDEX IF NOT EXISTS idx_event_store_event_type
    ON event_store (event_type);
CREATE INDEX IF NOT EXISTS idx_event_store_global_seq
    ON event_store (global_seq);

-- Snapshots table
CREATE TABLE IF NOT EXISTS snapshots (
    stream_id        VARCHAR(255) PRIMARY KEY,
    stream_version   INTEGER NOT NULL,
    aggregate_type   VARCHAR(255) NOT NULL,
    snapshot_data    JSONB NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`

// Append adds events to a stream with optimistic concurrency control.
func (s *PostgresEventStore) Append(ctx context.Context, req AppendRequest) error {
    tx, err := s.pool.Begin(ctx)
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }
    defer tx.Rollback(ctx)

    // Check current stream version
    var currentVersion int
    err = tx.QueryRow(ctx,
        `SELECT COALESCE(MAX(stream_version), -1)
         FROM event_store
         WHERE stream_id = $1`,
        req.StreamID,
    ).Scan(&currentVersion)
    if err != nil {
        return fmt.Errorf("checking stream version: %w", err)
    }

    if req.ExpectedVersion != currentVersion {
        return fmt.Errorf("%w: expected version %d but got %d",
            ErrOptimisticConcurrency, req.ExpectedVersion, currentVersion)
    }

    // Insert events
    nextVersion := currentVersion + 1

    for i, event := range req.Events {
        eventData, err := json.Marshal(event.EventData)
        if err != nil {
            return fmt.Errorf("marshaling event %s: %w", event.EventType, err)
        }

        metadata, err := json.Marshal(event.Metadata)
        if err != nil {
            return fmt.Errorf("marshaling metadata: %w", err)
        }

        occurredAt := event.OccurredAt
        if occurredAt.IsZero() {
            occurredAt = time.Now().UTC()
        }

        _, err = tx.Exec(ctx,
            `INSERT INTO event_store
             (stream_id, stream_version, event_type, event_data, metadata, occurred_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            req.StreamID,
            nextVersion+i,
            event.EventType,
            eventData,
            metadata,
            occurredAt,
        )
        if err != nil {
            var pgErr *pgx.PgError
            if errors.As(err, &pgErr) && pgErr.Code == "23505" {
                return fmt.Errorf("%w: duplicate event version", ErrOptimisticConcurrency)
            }
            return fmt.Errorf("inserting event: %w", err)
        }
    }

    return tx.Commit(ctx)
}

// Load retrieves all events for a stream.
func (s *PostgresEventStore) Load(ctx context.Context, streamID string) ([]StoredEvent, error) {
    return s.LoadFrom(ctx, streamID, 0)
}

// LoadFrom retrieves events starting from a given version.
func (s *PostgresEventStore) LoadFrom(ctx context.Context, streamID string, fromVersion int) ([]StoredEvent, error) {
    rows, err := s.pool.Query(ctx,
        `SELECT stream_id, stream_version, event_type, event_data, metadata, occurred_at, global_seq
         FROM event_store
         WHERE stream_id = $1 AND stream_version >= $2
         ORDER BY stream_version ASC`,
        streamID, fromVersion,
    )
    if err != nil {
        return nil, fmt.Errorf("loading events for stream %s: %w", streamID, err)
    }
    defer rows.Close()

    var events []StoredEvent
    for rows.Next() {
        var e StoredEvent
        if err := rows.Scan(
            &e.StreamID, &e.StreamVersion, &e.EventType,
            &e.EventData, &e.Metadata, &e.OccurredAt, &e.GlobalSeq,
        ); err != nil {
            return nil, fmt.Errorf("scanning event: %w", err)
        }
        events = append(events, e)
    }

    return events, rows.Err()
}

// Subscribe returns a channel that receives new events as they are appended.
func (s *PostgresEventStore) Subscribe(
    ctx context.Context,
    fromGlobalSeq int64,
    eventTypes []string,
) (<-chan StoredEvent, error) {
    ch := make(chan StoredEvent, 100)

    go func() {
        defer close(ch)

        conn, err := s.pool.Acquire(ctx)
        if err != nil {
            return
        }
        defer conn.Release()

        // Use PostgreSQL LISTEN/NOTIFY for real-time events
        _, err = conn.Exec(ctx, "LISTEN event_appended")
        if err != nil {
            return
        }

        lastSeq := fromGlobalSeq

        for {
            // Poll for new events
            rows, err := s.pool.Query(ctx,
                `SELECT stream_id, stream_version, event_type, event_data, metadata, occurred_at, global_seq
                 FROM event_store
                 WHERE global_seq > $1
                 AND ($2::text[] IS NULL OR event_type = ANY($2))
                 ORDER BY global_seq ASC
                 LIMIT 100`,
                lastSeq, eventTypes,
            )
            if err != nil {
                return
            }

            var fetched int
            for rows.Next() {
                var e StoredEvent
                if err := rows.Scan(
                    &e.StreamID, &e.StreamVersion, &e.EventType,
                    &e.EventData, &e.Metadata, &e.OccurredAt, &e.GlobalSeq,
                ); err != nil {
                    rows.Close()
                    return
                }

                select {
                case ch <- e:
                    lastSeq = e.GlobalSeq
                    fetched++
                case <-ctx.Done():
                    rows.Close()
                    return
                }
            }
            rows.Close()

            if fetched == 0 {
                // Wait for notification or poll interval
                notification, err := conn.Conn().WaitForNotification(ctx)
                if err != nil {
                    return
                }
                _ = notification
            }
        }
    }()

    return ch, nil
}
```

## Snapshot Support

For aggregates with long event histories, snapshots reduce replay time:

```go
// eventstore/snapshot.go
package eventstore

import (
    "context"
    "encoding/json"
    "fmt"
    "time"
)

type Snapshot struct {
    StreamID      string          `json:"stream_id"`
    StreamVersion int             `json:"stream_version"`
    AggregateType string          `json:"aggregate_type"`
    Data          json.RawMessage `json:"data"`
    CreatedAt     time.Time       `json:"created_at"`
}

func (s *PostgresEventStore) SaveSnapshot(ctx context.Context, snap Snapshot) error {
    _, err := s.pool.Exec(ctx,
        `INSERT INTO snapshots (stream_id, stream_version, aggregate_type, snapshot_data, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (stream_id)
         DO UPDATE SET
           stream_version = EXCLUDED.stream_version,
           snapshot_data  = EXCLUDED.snapshot_data,
           created_at     = EXCLUDED.created_at`,
        snap.StreamID, snap.StreamVersion, snap.AggregateType,
        snap.Data, snap.CreatedAt,
    )
    return err
}

func (s *PostgresEventStore) LoadSnapshot(ctx context.Context, streamID string) (*Snapshot, error) {
    var snap Snapshot
    err := s.pool.QueryRow(ctx,
        `SELECT stream_id, stream_version, aggregate_type, snapshot_data, created_at
         FROM snapshots WHERE stream_id = $1`,
        streamID,
    ).Scan(&snap.StreamID, &snap.StreamVersion, &snap.AggregateType,
        &snap.Data, &snap.CreatedAt)

    if err != nil {
        if errors.Is(err, pgx.ErrNoRows) {
            return nil, nil // No snapshot found
        }
        return nil, fmt.Errorf("loading snapshot for %s: %w", streamID, err)
    }

    return &snap, nil
}
```

## Order Repository with Snapshots

```go
// domain/order/repository.go
package order

import (
    "context"
    "encoding/json"
    "fmt"

    "myapp/eventstore"
)

const SnapshotThreshold = 50 // Take snapshot every 50 events

type EventDeserializer func(eventType string, data []byte) (DomainEvent, error)

type Repository struct {
    store       *eventstore.PostgresEventStore
    deserialize EventDeserializer
}

func NewRepository(store *eventstore.PostgresEventStore) *Repository {
    return &Repository{
        store:       store,
        deserialize: deserializeOrderEvent,
    }
}

func (r *Repository) Load(ctx context.Context, orderID string) (*Order, error) {
    // Try snapshot first
    snap, err := r.store.LoadSnapshot(ctx, "order-"+orderID)
    if err != nil {
        return nil, fmt.Errorf("loading snapshot: %w", err)
    }

    order := NewOrder(orderID)
    fromVersion := 0

    if snap != nil {
        // Restore from snapshot
        var state snapshotState
        if err := json.Unmarshal(snap.Data, &state); err != nil {
            return nil, fmt.Errorf("deserializing snapshot: %w", err)
        }
        restoreFromSnapshot(order, &state)
        order.version = snap.StreamVersion
        fromVersion = snap.StreamVersion
    }

    // Load events after the snapshot
    stored, err := r.store.LoadFrom(ctx, "order-"+orderID, fromVersion)
    if err != nil {
        return nil, fmt.Errorf("loading events: %w", err)
    }

    for _, se := range stored {
        event, err := r.deserialize(se.EventType, se.EventData)
        if err != nil {
            return nil, fmt.Errorf("deserializing event %s: %w", se.EventType, err)
        }
        if err := order.apply(event, false); err != nil {
            return nil, fmt.Errorf("applying event: %w", err)
        }
    }

    order.version = fromVersion + len(stored)
    return order, nil
}

func (r *Repository) Save(ctx context.Context, order *Order) error {
    uncommitted := order.UncommittedEvents()
    if len(uncommitted) == 0 {
        return nil
    }

    events := make([]eventstore.EventToStore, 0, len(uncommitted))
    for _, event := range uncommitted {
        data, err := json.Marshal(event)
        if err != nil {
            return fmt.Errorf("marshaling event: %w", err)
        }

        events = append(events, eventstore.EventToStore{
            EventType:  event.EventType(),
            EventData:  json.RawMessage(data),
            OccurredAt: event.OccurredAt(),
        })
    }

    err := r.store.Append(ctx, eventstore.AppendRequest{
        StreamID:        "order-" + order.ID(),
        ExpectedVersion: order.Version() - 1, // -1 if new aggregate
        Events:          events,
    })
    if err != nil {
        return err
    }

    order.MarkAsCommitted()

    // Take snapshot if threshold reached
    if order.Version() > 0 && order.Version()%SnapshotThreshold == 0 {
        if snapErr := r.saveSnapshot(ctx, order); snapErr != nil {
            // Log but don't fail - snapshot is an optimization
            fmt.Printf("Warning: snapshot failed: %v\n", snapErr)
        }
    }

    return nil
}

type snapshotState struct {
    Status         string             `json:"status"`
    CustomerID     string             `json:"customer_id"`
    Items          map[string]Item    `json:"items"`
    TotalAmount    float64            `json:"total_amount"`
    AmountPaid     float64            `json:"amount_paid"`
    TrackingNumber string             `json:"tracking_number"`
}

func (r *Repository) saveSnapshot(ctx context.Context, order *Order) error {
    state := snapshotState{
        Status:         string(order.Status()),
        CustomerID:     order.CustomerID(),
        TotalAmount:    order.TotalAmount(),
        AmountPaid:     order.AmountPaid(),
        TrackingNumber: order.TrackingNumber(),
    }

    data, err := json.Marshal(state)
    if err != nil {
        return err
    }

    return r.store.SaveSnapshot(ctx, eventstore.Snapshot{
        StreamID:      "order-" + order.ID(),
        StreamVersion: order.Version(),
        AggregateType: "Order",
        Data:          data,
    })
}

func restoreFromSnapshot(order *Order, state *snapshotState) {
    order.status = Status(state.Status)
    order.customerID = state.CustomerID
    order.items = state.Items
    if order.items == nil {
        order.items = make(map[string]Item)
    }
    order.totalAmount = state.TotalAmount
    order.amountPaid = state.AmountPaid
    order.trackingNumber = state.TrackingNumber
}
```

## Projections

```go
// projections/order_summary.go
package projections

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "myapp/domain/order"
    "myapp/eventstore"
)

type OrderSummaryProjection struct {
    pool *pgxpool.Pool
}

func NewOrderSummaryProjection(pool *pgxpool.Pool) *OrderSummaryProjection {
    return &OrderSummaryProjection{pool: pool}
}

// Schema for the read model
const orderSummarySchema = `
CREATE TABLE IF NOT EXISTS order_summaries (
    id              VARCHAR(255) PRIMARY KEY,
    customer_id     VARCHAR(255) NOT NULL,
    status          VARCHAR(50) NOT NULL,
    total_amount    DECIMAL(15,2) NOT NULL,
    amount_paid     DECIMAL(15,2) NOT NULL DEFAULT 0,
    tracking_number VARCHAR(255),
    placed_at       TIMESTAMPTZ,
    confirmed_at    TIMESTAMPTZ,
    shipped_at      TIMESTAMPTZ,
    cancelled_at    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_summaries_customer
    ON order_summaries (customer_id);
CREATE INDEX IF NOT EXISTS idx_order_summaries_status
    ON order_summaries (status);
`

// Handle processes an event and updates the projection.
func (p *OrderSummaryProjection) Handle(ctx context.Context, stored eventstore.StoredEvent) error {
    switch stored.EventType {

    case order.EventOrderPlaced:
        var e order.OrderPlaced
        if err := json.Unmarshal(stored.EventData, &e); err != nil {
            return fmt.Errorf("deserializing OrderPlaced: %w", err)
        }
        _, err := p.pool.Exec(ctx,
            `INSERT INTO order_summaries
             (id, customer_id, status, total_amount, placed_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (id) DO UPDATE SET
               status = EXCLUDED.status,
               total_amount = EXCLUDED.total_amount,
               placed_at = EXCLUDED.placed_at,
               updated_at = NOW()`,
            e.AggregateID(), e.CustomerID, "placed", e.TotalAmount, e.OccurredAt(),
        )
        return err

    case order.EventOrderConfirmed:
        _, err := p.pool.Exec(ctx,
            `UPDATE order_summaries
             SET status = 'confirmed', confirmed_at = $1, updated_at = NOW()
             WHERE id = $2`,
            stored.OccurredAt, extracted(stored.StreamID),
        )
        return err

    case order.EventOrderShipped:
        var e order.OrderShipped
        if err := json.Unmarshal(stored.EventData, &e); err != nil {
            return err
        }
        _, err := p.pool.Exec(ctx,
            `UPDATE order_summaries
             SET status = 'shipped', tracking_number = $1,
                 shipped_at = $2, updated_at = NOW()
             WHERE id = $3`,
            e.TrackingNumber, stored.OccurredAt, e.AggregateID(),
        )
        return err

    case order.EventOrderCancelled:
        _, err := p.pool.Exec(ctx,
            `UPDATE order_summaries
             SET status = 'cancelled', cancelled_at = $1, updated_at = NOW()
             WHERE id = $2`,
            stored.OccurredAt, extracted(stored.StreamID),
        )
        return err

    case order.EventPaymentApplied:
        var e order.PaymentApplied
        if err := json.Unmarshal(stored.EventData, &e); err != nil {
            return err
        }
        _, err := p.pool.Exec(ctx,
            `UPDATE order_summaries
             SET amount_paid = amount_paid + $1, updated_at = NOW()
             WHERE id = $2`,
            e.Amount, e.AggregateID(),
        )
        return err
    }

    return nil // Ignore unknown event types
}

func extracted(streamID string) string {
    // Extract aggregate ID from "order-<id>"
    if len(streamID) > 6 {
        return streamID[6:]
    }
    return streamID
}
```

## Projection Rebuilding

When a projection's schema changes or bugs are fixed, rebuild from scratch:

```go
// projections/rebuilder.go
package projections

import (
    "context"
    "fmt"
    "log"
    "time"

    "myapp/eventstore"
)

type Projection interface {
    Handle(ctx context.Context, event eventstore.StoredEvent) error
    Schema() string // DDL for the projection's table
    TableName() string
}

type Rebuilder struct {
    store       *eventstore.PostgresEventStore
    projections []Projection
    pool        *pgxpool.Pool
}

func NewRebuilder(
    store *eventstore.PostgresEventStore,
    pool *pgxpool.Pool,
    projections ...Projection,
) *Rebuilder {
    return &Rebuilder{
        store:       store,
        projections: projections,
        pool:        pool,
    }
}

// RebuildAll truncates projection tables and replays all events.
func (r *Rebuilder) RebuildAll(ctx context.Context) error {
    log.Println("Starting full projection rebuild...")
    start := time.Now()

    // Truncate all projection tables
    for _, proj := range r.projections {
        log.Printf("Truncating %s...", proj.TableName())
        _, err := r.pool.Exec(ctx, fmt.Sprintf("TRUNCATE TABLE %s", proj.TableName()))
        if err != nil {
            return fmt.Errorf("truncating %s: %w", proj.TableName(), err)
        }
    }

    // Stream all events and replay
    var count int64
    var lastSeq int64

    for {
        // Fetch events in batches
        rows, err := r.pool.Query(ctx,
            `SELECT stream_id, stream_version, event_type, event_data, metadata, occurred_at, global_seq
             FROM event_store
             WHERE global_seq > $1
             ORDER BY global_seq ASC
             LIMIT 1000`,
            lastSeq,
        )
        if err != nil {
            return fmt.Errorf("fetching events: %w", err)
        }

        var batch []eventstore.StoredEvent
        for rows.Next() {
            var e eventstore.StoredEvent
            if err := rows.Scan(
                &e.StreamID, &e.StreamVersion, &e.EventType,
                &e.EventData, &e.Metadata, &e.OccurredAt, &e.GlobalSeq,
            ); err != nil {
                rows.Close()
                return fmt.Errorf("scanning event: %w", err)
            }
            batch = append(batch, e)
        }
        rows.Close()

        if len(batch) == 0 {
            break
        }

        // Apply to all projections
        for _, event := range batch {
            for _, proj := range r.projections {
                if err := proj.Handle(ctx, event); err != nil {
                    log.Printf("Warning: projection %s failed on event %d: %v",
                        proj.TableName(), event.GlobalSeq, err)
                    // Continue with other projections and events
                }
            }
            lastSeq = event.GlobalSeq
            count++
        }

        if count%10000 == 0 {
            log.Printf("Rebuilt %d events (seq %d)...", count, lastSeq)
        }
    }

    log.Printf("Rebuild complete: %d events in %s", count, time.Since(start))
    return nil
}

// RebuildFromCheckpoint rebuilds a projection from where it left off.
func (r *Rebuilder) RebuildFromCheckpoint(
    ctx context.Context,
    proj Projection,
    fromSeq int64,
) error {
    // This is used for live catch-up after a projection falls behind
    rows, err := r.pool.Query(ctx,
        `SELECT stream_id, stream_version, event_type, event_data, metadata, occurred_at, global_seq
         FROM event_store
         WHERE global_seq > $1
         ORDER BY global_seq ASC`,
        fromSeq,
    )
    if err != nil {
        return err
    }
    defer rows.Close()

    for rows.Next() {
        var e eventstore.StoredEvent
        if err := rows.Scan(
            &e.StreamID, &e.StreamVersion, &e.EventType,
            &e.EventData, &e.Metadata, &e.OccurredAt, &e.GlobalSeq,
        ); err != nil {
            return err
        }

        if err := proj.Handle(ctx, e); err != nil {
            return fmt.Errorf("applying event %d to projection: %w", e.GlobalSeq, err)
        }
    }

    return rows.Err()
}
```

## Command Handler and Query Side

```go
// application/order_command_handler.go
package application

import (
    "context"
    "fmt"

    "myapp/domain/order"
)

type PlaceOrderCommand struct {
    OrderID    string
    CustomerID string
    Items      []OrderItem
}

type OrderItem struct {
    SKU      string
    Quantity int
    Price    float64
}

type OrderCommandHandler struct {
    repo *order.Repository
}

func NewOrderCommandHandler(repo *order.Repository) *OrderCommandHandler {
    return &OrderCommandHandler{repo: repo}
}

func (h *OrderCommandHandler) PlaceOrder(ctx context.Context, cmd PlaceOrderCommand) error {
    o := order.NewOrder(cmd.OrderID)

    for _, item := range cmd.Items {
        if err := o.AddItem(item.SKU, item.Quantity, item.Price); err != nil {
            return fmt.Errorf("adding item %s: %w", item.SKU, err)
        }
    }

    if err := o.Place(cmd.CustomerID); err != nil {
        return fmt.Errorf("placing order: %w", err)
    }

    return h.repo.Save(ctx, o)
}

func (h *OrderCommandHandler) ConfirmOrder(ctx context.Context, orderID, confirmedBy string) error {
    o, err := h.repo.Load(ctx, orderID)
    if err != nil {
        return fmt.Errorf("loading order %s: %w", orderID, err)
    }

    if err := o.Confirm(confirmedBy); err != nil {
        return err
    }

    return h.repo.Save(ctx, o)
}

// application/order_query.go
type OrderSummary struct {
    ID             string
    CustomerID     string
    Status         string
    TotalAmount    float64
    AmountPaid     float64
    TrackingNumber string
}

type OrderQueryHandler struct {
    pool *pgxpool.Pool
}

func (q *OrderQueryHandler) GetOrderSummary(ctx context.Context, orderID string) (*OrderSummary, error) {
    var s OrderSummary
    err := q.pool.QueryRow(ctx,
        `SELECT id, customer_id, status, total_amount, amount_paid, COALESCE(tracking_number, '')
         FROM order_summaries WHERE id = $1`,
        orderID,
    ).Scan(&s.ID, &s.CustomerID, &s.Status, &s.TotalAmount, &s.AmountPaid, &s.TrackingNumber)

    if err != nil {
        return nil, fmt.Errorf("querying order %s: %w", orderID, err)
    }

    return &s, nil
}

func (q *OrderQueryHandler) GetCustomerOrders(ctx context.Context, customerID string) ([]OrderSummary, error) {
    rows, err := q.pool.Query(ctx,
        `SELECT id, customer_id, status, total_amount, amount_paid
         FROM order_summaries
         WHERE customer_id = $1
         ORDER BY placed_at DESC`,
        customerID,
    )
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var orders []OrderSummary
    for rows.Next() {
        var s OrderSummary
        if err := rows.Scan(&s.ID, &s.CustomerID, &s.Status, &s.TotalAmount, &s.AmountPaid); err != nil {
            return nil, err
        }
        orders = append(orders, s)
    }

    return orders, rows.Err()
}
```

## Testing Event-Sourced Aggregates

```go
// domain/order/aggregate_test.go
package order_test

import (
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "myapp/domain/order"
)

func TestOrderPlacement(t *testing.T) {
    t.Run("successfully places order with items", func(t *testing.T) {
        o := order.NewOrder("order-001")

        require.NoError(t, o.AddItem("SKU-A", 2, 29.99))
        require.NoError(t, o.AddItem("SKU-B", 1, 99.99))
        require.NoError(t, o.Place("customer-123"))

        assert.Equal(t, order.StatusPlaced, o.Status())
        assert.Equal(t, "customer-123", o.CustomerID())
        assert.InDelta(t, 159.97, o.TotalAmount(), 0.01)

        events := o.UncommittedEvents()
        assert.Len(t, events, 3) // 2 ItemAdded + 1 OrderPlaced
        assert.Equal(t, order.EventOrderPlaced, events[2].EventType())
    })

    t.Run("rejects placement of empty order", func(t *testing.T) {
        o := order.NewOrder("order-002")
        err := o.Place("customer-456")
        assert.ErrorIs(t, err, order.ErrInsufficientItems)
        assert.Empty(t, o.UncommittedEvents())
    })

    t.Run("rehydrates correctly from events", func(t *testing.T) {
        original := order.NewOrder("order-003")
        require.NoError(t, original.AddItem("SKU-C", 3, 19.99))
        require.NoError(t, original.Place("customer-789"))
        require.NoError(t, original.Confirm("admin@company.com"))

        events := original.UncommittedEvents()

        // Rehydrate a new aggregate from the events
        rehydrated, err := order.Rehydrate("order-003", events)
        require.NoError(t, err)

        assert.Equal(t, original.Status(), rehydrated.Status())
        assert.Equal(t, original.CustomerID(), rehydrated.CustomerID())
        assert.Equal(t, original.TotalAmount(), rehydrated.TotalAmount())
        assert.Equal(t, len(events), rehydrated.Version())
        assert.Empty(t, rehydrated.UncommittedEvents())
    })
}
```

## Summary

Event sourcing with CQRS in Go requires discipline in a few areas:

- **Aggregates are pure domain logic**: no I/O, no side effects. All state changes happen through `apply()` with events.
- **Optimistic concurrency** via expected version prevents lost updates without distributed locks.
- **Snapshots** are an optimization, not correctness-critical. Build the system correctly without them first.
- **Projections** must be idempotent (upserts) since they may be rebuilt or events may be replayed multiple times.
- **Rebuild capability** is a first-class feature, not an emergency operation. Design projections to be rebuildable.
- **Event versioning**: use explicit event type strings rather than struct types for stable serialization across deployments.

The power of event sourcing shows up at scale: audit trails, time-travel debugging, multiple read models for different access patterns, and event-driven integration with other services all become natural consequences of the architecture rather than special-case additions.
