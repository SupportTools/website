---
title: "Go Event Sourcing with CQRS: Event Store Implementation, Projections, Replay, and Eventual Consistency Patterns"
date: 2031-10-20T00:00:00-05:00
draft: false
tags: ["Go", "Event Sourcing", "CQRS", "Architecture", "Distributed Systems", "PostgreSQL"]
categories:
- Go
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-ready guide to implementing event sourcing with CQRS in Go, covering event store design, aggregate reconstruction, projection building, event replay, and eventual consistency handling for enterprise systems."
more_link: "yes"
url: "/go-event-sourcing-cqrs-event-store-projections-replay-eventual-consistency/"
---

Event sourcing stores the sequence of state changes (events) rather than the current state. Combined with CQRS (Command Query Responsibility Segregation), it produces an audit log that is also the source of truth, enabling time travel queries, replay-based projections, and horizontal read scaling. This guide implements a complete event sourcing system in Go with PostgreSQL as the event store.

<!--more-->

# Go Event Sourcing with CQRS

## Section 1: Core Concepts and Data Model

### Event Store Schema

```sql
-- PostgreSQL event store schema
CREATE TABLE events (
    id          BIGSERIAL    PRIMARY KEY,
    stream_id   UUID         NOT NULL,     -- aggregate ID
    stream_type TEXT         NOT NULL,     -- aggregate type (e.g., "Order")
    version     BIGINT       NOT NULL,     -- monotonic version within stream
    event_type  TEXT         NOT NULL,     -- discriminator (e.g., "OrderPlaced")
    data        JSONB        NOT NULL,     -- event payload
    metadata    JSONB        NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Unique constraint prevents optimistic concurrency conflicts
CREATE UNIQUE INDEX idx_events_stream_version
    ON events (stream_id, version);

-- Index for stream reads
CREATE INDEX idx_events_stream_id
    ON events (stream_id, version ASC);

-- Index for global ordering (projection catch-up)
CREATE INDEX idx_events_created_at
    ON events (created_at, id ASC);

-- Snapshots table for performance
CREATE TABLE snapshots (
    stream_id   UUID         PRIMARY KEY,
    stream_type TEXT         NOT NULL,
    version     BIGINT       NOT NULL,
    state       JSONB        NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Projection checkpoints
CREATE TABLE projection_checkpoints (
    projection_name TEXT        PRIMARY KEY,
    last_event_id   BIGINT      NOT NULL DEFAULT 0,
    last_event_at   TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Core Types

```go
// eventsource/types.go
package eventsource

import (
    "context"
    "encoding/json"
    "time"

    "github.com/google/uuid"
)

// Event is the fundamental unit of state change.
type Event struct {
    ID         int64
    StreamID   uuid.UUID
    StreamType string
    Version    int64
    EventType  string
    Data       json.RawMessage
    Metadata   Metadata
    CreatedAt  time.Time
}

// Metadata carries cross-cutting concerns without polluting event payloads.
type Metadata struct {
    CorrelationID string    `json:"correlation_id,omitempty"`
    CausationID   string    `json:"causation_id,omitempty"`
    UserID        string    `json:"user_id,omitempty"`
    IPAddress     string    `json:"ip_address,omitempty"`
    Timestamp     time.Time `json:"timestamp"`
}

// EventData is implemented by all domain event structs.
type EventData interface {
    EventType() string
}

// AppendRequest packages a new event for writing.
type AppendRequest struct {
    StreamID        uuid.UUID
    StreamType      string
    ExpectedVersion int64       // -1 means stream must not exist; 0 means any
    Events          []EventData
    Metadata        Metadata
}

// ReadRequest specifies how to read from a stream.
type ReadRequest struct {
    StreamID     uuid.UUID
    FromVersion  int64   // 0 = from beginning
    MaxCount     int     // 0 = unlimited
}

// EventStore is the primary write-side storage interface.
type EventStore interface {
    Append(ctx context.Context, req AppendRequest) (int64, error)
    ReadStream(ctx context.Context, req ReadRequest) ([]Event, error)
    ReadAllFrom(ctx context.Context, fromEventID int64, maxCount int) ([]Event, error)
    Subscribe(ctx context.Context, fromEventID int64) (<-chan Event, error)
}

// ErrConcurrencyConflict is returned when the expected version does not match.
type ErrConcurrencyConflict struct {
    StreamID        uuid.UUID
    ExpectedVersion int64
    ActualVersion   int64
}

func (e ErrConcurrencyConflict) Error() string {
    return fmt.Sprintf("concurrency conflict on stream %s: expected version %d, got %d",
        e.StreamID, e.ExpectedVersion, e.ActualVersion)
}
```

## Section 2: PostgreSQL Event Store Implementation

```go
// eventsource/postgres/store.go
package postgres

import (
    "context"
    "database/sql"
    "encoding/json"
    "errors"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/example/eventsource"
)

type PostgresStore struct {
    pool *pgxpool.Pool
}

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore {
    return &PostgresStore{pool: pool}
}

func (s *PostgresStore) Append(ctx context.Context, req eventsource.AppendRequest) (int64, error) {
    tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
    if err != nil {
        return 0, fmt.Errorf("begin transaction: %w", err)
    }
    defer tx.Rollback(ctx)

    // Read current version
    var currentVersion int64
    err = tx.QueryRow(ctx,
        `SELECT COALESCE(MAX(version), -1) FROM events WHERE stream_id = $1`,
        req.StreamID,
    ).Scan(&currentVersion)
    if err != nil {
        return 0, fmt.Errorf("read current version: %w", err)
    }

    // Optimistic concurrency check
    if req.ExpectedVersion >= 0 && currentVersion != req.ExpectedVersion-1 {
        return 0, eventsource.ErrConcurrencyConflict{
            StreamID:        req.StreamID,
            ExpectedVersion: req.ExpectedVersion,
            ActualVersion:   currentVersion + 1,
        }
    }

    metaJSON, err := json.Marshal(req.Metadata)
    if err != nil {
        return 0, fmt.Errorf("marshal metadata: %w", err)
    }

    var lastInsertedID int64
    for i, eventData := range req.Events {
        dataJSON, err := json.Marshal(eventData)
        if err != nil {
            return 0, fmt.Errorf("marshal event %d: %w", i, err)
        }

        nextVersion := currentVersion + int64(i) + 1

        err = tx.QueryRow(ctx,
            `INSERT INTO events (stream_id, stream_type, version, event_type, data, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            req.StreamID,
            req.StreamType,
            nextVersion,
            eventData.EventType(),
            dataJSON,
            metaJSON,
        ).Scan(&lastInsertedID)
        if err != nil {
            return 0, fmt.Errorf("insert event: %w", err)
        }
    }

    if err := tx.Commit(ctx); err != nil {
        return 0, fmt.Errorf("commit transaction: %w", err)
    }

    return lastInsertedID, nil
}

func (s *PostgresStore) ReadStream(ctx context.Context, req eventsource.ReadRequest) ([]eventsource.Event, error) {
    query := `
        SELECT id, stream_id, stream_type, version, event_type, data, metadata, created_at
        FROM events
        WHERE stream_id = $1 AND version >= $2
        ORDER BY version ASC`

    args := []interface{}{req.StreamID, req.FromVersion}
    if req.MaxCount > 0 {
        query += " LIMIT $3"
        args = append(args, req.MaxCount)
    }

    rows, err := s.pool.Query(ctx, query, args...)
    if err != nil {
        return nil, fmt.Errorf("query events: %w", err)
    }
    defer rows.Close()

    return s.scanEvents(rows)
}

func (s *PostgresStore) ReadAllFrom(ctx context.Context, fromEventID int64, maxCount int) ([]eventsource.Event, error) {
    query := `
        SELECT id, stream_id, stream_type, version, event_type, data, metadata, created_at
        FROM events
        WHERE id > $1
        ORDER BY id ASC
        LIMIT $2`

    limit := 1000
    if maxCount > 0 {
        limit = maxCount
    }

    rows, err := s.pool.Query(ctx, query, fromEventID, limit)
    if err != nil {
        return nil, fmt.Errorf("query events: %w", err)
    }
    defer rows.Close()

    return s.scanEvents(rows)
}

func (s *PostgresStore) scanEvents(rows pgx.Rows) ([]eventsource.Event, error) {
    var events []eventsource.Event
    for rows.Next() {
        var e eventsource.Event
        var metaJSON []byte
        err := rows.Scan(
            &e.ID, &e.StreamID, &e.StreamType, &e.Version,
            &e.EventType, &e.Data, &metaJSON, &e.CreatedAt,
        )
        if err != nil {
            return nil, fmt.Errorf("scan event: %w", err)
        }
        if err := json.Unmarshal(metaJSON, &e.Metadata); err != nil {
            return nil, fmt.Errorf("unmarshal metadata: %w", err)
        }
        events = append(events, e)
    }
    return events, rows.Err()
}

// Subscribe uses PostgreSQL LISTEN/NOTIFY for real-time event delivery.
func (s *PostgresStore) Subscribe(ctx context.Context, fromEventID int64) (<-chan eventsource.Event, error) {
    ch := make(chan eventsource.Event, 256)

    go func() {
        defer close(ch)

        conn, err := s.pool.Acquire(ctx)
        if err != nil {
            return
        }
        defer conn.Release()

        _, err = conn.Exec(ctx, "LISTEN new_events")
        if err != nil {
            return
        }

        lastID := fromEventID

        // Catch up with any events missed before LISTEN
        s.catchUp(ctx, ch, &lastID)

        for {
            notification, err := conn.Conn().WaitForNotification(ctx)
            if err != nil {
                if ctx.Err() != nil {
                    return
                }
                time.Sleep(time.Second)
                continue
            }
            _ = notification
            s.catchUp(ctx, ch, &lastID)
        }
    }()

    return ch, nil
}

func (s *PostgresStore) catchUp(ctx context.Context, ch chan<- eventsource.Event, lastID *int64) {
    for {
        events, err := s.ReadAllFrom(ctx, *lastID, 100)
        if err != nil || len(events) == 0 {
            return
        }
        for _, e := range events {
            select {
            case ch <- e:
                *lastID = e.ID
            case <-ctx.Done():
                return
            }
        }
        if len(events) < 100 {
            return
        }
    }
}
```

## Section 3: Aggregate Implementation

```go
// domain/order/aggregate.go
package order

import (
    "encoding/json"
    "errors"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/example/eventsource"
)

// --- Domain Events ---

type OrderPlaced struct {
    OrderID    uuid.UUID         `json:"order_id"`
    CustomerID uuid.UUID         `json:"customer_id"`
    Items      []OrderItem       `json:"items"`
    TotalCents int64             `json:"total_cents"`
    PlacedAt   time.Time         `json:"placed_at"`
}
func (e OrderPlaced) EventType() string { return "OrderPlaced" }

type OrderItem struct {
    ProductID  uuid.UUID `json:"product_id"`
    Quantity   int       `json:"quantity"`
    PriceCents int64     `json:"price_cents"`
}

type OrderConfirmed struct {
    OrderID     uuid.UUID `json:"order_id"`
    ConfirmedAt time.Time `json:"confirmed_at"`
}
func (e OrderConfirmed) EventType() string { return "OrderConfirmed" }

type OrderShipped struct {
    OrderID        uuid.UUID `json:"order_id"`
    TrackingNumber string    `json:"tracking_number"`
    Carrier        string    `json:"carrier"`
    ShippedAt      time.Time `json:"shipped_at"`
}
func (e OrderShipped) EventType() string { return "OrderShipped" }

type OrderCancelled struct {
    OrderID     uuid.UUID `json:"order_id"`
    Reason      string    `json:"reason"`
    CancelledAt time.Time `json:"cancelled_at"`
}
func (e OrderCancelled) EventType() string { return "OrderCancelled" }

// --- Aggregate State ---

type OrderStatus int

const (
    StatusPending OrderStatus = iota
    StatusConfirmed
    StatusShipped
    StatusCancelled
)

func (s OrderStatus) String() string {
    return [...]string{"Pending", "Confirmed", "Shipped", "Cancelled"}[s]
}

type Order struct {
    id             uuid.UUID
    version        int64
    status         OrderStatus
    customerID     uuid.UUID
    items          []OrderItem
    totalCents     int64
    trackingNumber string

    uncommitted []eventsource.EventData
}

func NewOrder() *Order { return &Order{} }

// --- Command methods ---

func (o *Order) PlaceOrder(customerID uuid.UUID, items []OrderItem) error {
    if o.version > 0 {
        return errors.New("order already exists")
    }
    if len(items) == 0 {
        return errors.New("order must have at least one item")
    }

    var total int64
    for _, item := range items {
        if item.Quantity <= 0 {
            return fmt.Errorf("item quantity must be positive: %v", item.ProductID)
        }
        total += int64(item.Quantity) * item.PriceCents
    }

    o.apply(OrderPlaced{
        OrderID:    o.id,
        CustomerID: customerID,
        Items:      items,
        TotalCents: total,
        PlacedAt:   time.Now().UTC(),
    })
    return nil
}

func (o *Order) Confirm() error {
    if o.status != StatusPending {
        return fmt.Errorf("cannot confirm order in status %s", o.status)
    }
    o.apply(OrderConfirmed{
        OrderID:     o.id,
        ConfirmedAt: time.Now().UTC(),
    })
    return nil
}

func (o *Order) Ship(trackingNumber, carrier string) error {
    if o.status != StatusConfirmed {
        return fmt.Errorf("cannot ship order in status %s", o.status)
    }
    if trackingNumber == "" {
        return errors.New("tracking number required")
    }
    o.apply(OrderShipped{
        OrderID:        o.id,
        TrackingNumber: trackingNumber,
        Carrier:        carrier,
        ShippedAt:      time.Now().UTC(),
    })
    return nil
}

func (o *Order) Cancel(reason string) error {
    if o.status == StatusShipped || o.status == StatusCancelled {
        return fmt.Errorf("cannot cancel order in status %s", o.status)
    }
    o.apply(OrderCancelled{
        OrderID:     o.id,
        Reason:      reason,
        CancelledAt: time.Now().UTC(),
    })
    return nil
}

// --- State reconstruction ---

func (o *Order) apply(event eventsource.EventData) {
    o.mutate(event)
    o.uncommitted = append(o.uncommitted, event)
    o.version++
}

func (o *Order) mutate(event eventsource.EventData) {
    switch e := event.(type) {
    case OrderPlaced:
        o.id = e.OrderID
        o.customerID = e.CustomerID
        o.items = e.Items
        o.totalCents = e.TotalCents
        o.status = StatusPending
    case OrderConfirmed:
        o.status = StatusConfirmed
    case OrderShipped:
        o.status = StatusShipped
        o.trackingNumber = e.TrackingNumber
    case OrderCancelled:
        o.status = StatusCancelled
    }
}

// Reconstruct rebuilds aggregate state from a slice of stored events.
func (o *Order) Reconstruct(events []eventsource.Event) error {
    for _, e := range events {
        eventData, err := deserializeOrderEvent(e)
        if err != nil {
            return fmt.Errorf("deserialize event %d: %w", e.ID, err)
        }
        o.mutate(eventData)
        o.version = e.Version + 1
    }
    return nil
}

func deserializeOrderEvent(e eventsource.Event) (eventsource.EventData, error) {
    switch e.EventType {
    case "OrderPlaced":
        var ev OrderPlaced
        return ev, json.Unmarshal(e.Data, &ev)
    case "OrderConfirmed":
        var ev OrderConfirmed
        return ev, json.Unmarshal(e.Data, &ev)
    case "OrderShipped":
        var ev OrderShipped
        return ev, json.Unmarshal(e.Data, &ev)
    case "OrderCancelled":
        var ev OrderCancelled
        return ev, json.Unmarshal(e.Data, &ev)
    default:
        return nil, fmt.Errorf("unknown event type: %s", e.EventType)
    }
}

// Uncommitted returns events not yet persisted.
func (o *Order) Uncommitted() []eventsource.EventData { return o.uncommitted }
func (o *Order) ClearUncommitted()                    { o.uncommitted = nil }
func (o *Order) ID() uuid.UUID                        { return o.id }
func (o *Order) Version() int64                       { return o.version }
func (o *Order) Status() OrderStatus                  { return o.status }
```

## Section 4: Repository Pattern

```go
// domain/order/repository.go
package order

import (
    "context"
    "fmt"

    "github.com/google/uuid"
    "github.com/example/eventsource"
)

const streamType = "Order"
const snapshotThreshold = 50 // Create snapshot every 50 events

type Repository struct {
    store eventsource.EventStore
    snaps SnapshotStore
}

type SnapshotStore interface {
    Save(ctx context.Context, streamID uuid.UUID, version int64, state interface{}) error
    Load(ctx context.Context, streamID uuid.UUID) (version int64, state []byte, err error)
}

func NewRepository(store eventsource.EventStore, snaps SnapshotStore) *Repository {
    return &Repository{store: store, snaps: snaps}
}

func (r *Repository) Load(ctx context.Context, id uuid.UUID) (*Order, error) {
    order := NewOrder()
    order.id = id

    // Try snapshot first
    snapVersion, snapData, snapErr := r.snaps.Load(ctx, id)
    fromVersion := int64(0)

    if snapErr == nil && snapData != nil {
        if err := json.Unmarshal(snapData, order); err != nil {
            return nil, fmt.Errorf("unmarshal snapshot: %w", err)
        }
        fromVersion = snapVersion + 1
    }

    events, err := r.store.ReadStream(ctx, eventsource.ReadRequest{
        StreamID:    id,
        FromVersion: fromVersion,
    })
    if err != nil {
        return nil, fmt.Errorf("read stream: %w", err)
    }

    if len(events) == 0 && snapErr != nil {
        return nil, fmt.Errorf("order %s not found", id)
    }

    if err := order.Reconstruct(events); err != nil {
        return nil, fmt.Errorf("reconstruct aggregate: %w", err)
    }

    return order, nil
}

func (r *Repository) Save(ctx context.Context, order *Order, meta eventsource.Metadata) error {
    uncommitted := order.Uncommitted()
    if len(uncommitted) == 0 {
        return nil
    }

    expectedVersion := order.Version() - int64(len(uncommitted))

    _, err := r.store.Append(ctx, eventsource.AppendRequest{
        StreamID:        order.ID(),
        StreamType:      streamType,
        ExpectedVersion: expectedVersion,
        Events:          uncommitted,
        Metadata:        meta,
    })
    if err != nil {
        return fmt.Errorf("append events: %w", err)
    }

    order.ClearUncommitted()

    // Take snapshot if threshold crossed
    if order.Version() % snapshotThreshold == 0 {
        snapData, err := json.Marshal(order)
        if err == nil {
            _ = r.snaps.Save(ctx, order.ID(), order.Version()-1, snapData)
        }
    }

    return nil
}
```

## Section 5: Projections and Read Models

```go
// projections/order_summary.go
package projections

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"

    "github.com/google/uuid"
    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/example/eventsource"
    "github.com/example/domain/order"
)

// OrderSummary is the read model maintained by this projection.
type OrderSummary struct {
    OrderID        uuid.UUID   `json:"order_id"`
    CustomerID     uuid.UUID   `json:"customer_id"`
    Status         string      `json:"status"`
    TotalCents     int64       `json:"total_cents"`
    ItemCount      int         `json:"item_count"`
    TrackingNumber string      `json:"tracking_number,omitempty"`
    CreatedAt      string      `json:"created_at"`
    UpdatedAt      string      `json:"updated_at"`
}

// OrderSummaryProjection builds and maintains the order_summaries read model.
type OrderSummaryProjection struct {
    pool *pgxpool.Pool
    name string
}

func NewOrderSummaryProjection(pool *pgxpool.Pool) *OrderSummaryProjection {
    return &OrderSummaryProjection{pool: pool, name: "order_summary"}
}

func (p *OrderSummaryProjection) Name() string { return p.name }

func (p *OrderSummaryProjection) HandleEvent(ctx context.Context, e eventsource.Event) error {
    switch e.EventType {
    case "OrderPlaced":
        return p.handleOrderPlaced(ctx, e)
    case "OrderConfirmed":
        return p.handleOrderConfirmed(ctx, e)
    case "OrderShipped":
        return p.handleOrderShipped(ctx, e)
    case "OrderCancelled":
        return p.handleOrderCancelled(ctx, e)
    }
    return nil
}

func (p *OrderSummaryProjection) handleOrderPlaced(ctx context.Context, e eventsource.Event) error {
    var ev order.OrderPlaced
    if err := json.Unmarshal(e.Data, &ev); err != nil {
        return fmt.Errorf("unmarshal OrderPlaced: %w", err)
    }

    _, err := p.pool.Exec(ctx,
        `INSERT INTO order_summaries (order_id, customer_id, status, total_cents, item_count, created_at, updated_at)
         VALUES ($1, $2, 'Pending', $3, $4, $5, $5)
         ON CONFLICT (order_id) DO NOTHING`,
        ev.OrderID, ev.CustomerID, ev.TotalCents, len(ev.Items), ev.PlacedAt,
    )
    return err
}

func (p *OrderSummaryProjection) handleOrderConfirmed(ctx context.Context, e eventsource.Event) error {
    var ev order.OrderConfirmed
    if err := json.Unmarshal(e.Data, &ev); err != nil {
        return err
    }
    _, err := p.pool.Exec(ctx,
        `UPDATE order_summaries SET status = 'Confirmed', updated_at = $2 WHERE order_id = $1`,
        ev.OrderID, ev.ConfirmedAt,
    )
    return err
}

func (p *OrderSummaryProjection) handleOrderShipped(ctx context.Context, e eventsource.Event) error {
    var ev order.OrderShipped
    if err := json.Unmarshal(e.Data, &ev); err != nil {
        return err
    }
    _, err := p.pool.Exec(ctx,
        `UPDATE order_summaries SET status = 'Shipped', tracking_number = $2, updated_at = $3 WHERE order_id = $1`,
        ev.OrderID, ev.TrackingNumber, ev.ShippedAt,
    )
    return err
}

func (p *OrderSummaryProjection) handleOrderCancelled(ctx context.Context, e eventsource.Event) error {
    var ev order.OrderCancelled
    if err := json.Unmarshal(e.Data, &ev); err != nil {
        return err
    }
    _, err := p.pool.Exec(ctx,
        `UPDATE order_summaries SET status = 'Cancelled', updated_at = $2 WHERE order_id = $1`,
        ev.OrderID, ev.CancelledAt,
    )
    return err
}
```

## Section 6: Projection Runner with Checkpointing

```go
// projections/runner.go
package projections

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/example/eventsource"
)

type Projection interface {
    Name() string
    HandleEvent(ctx context.Context, e eventsource.Event) error
}

// Runner drives projections using event store subscriptions.
type Runner struct {
    store      eventsource.EventStore
    pool       *pgxpool.Pool
    projection Projection
    logger     *slog.Logger
}

func NewRunner(store eventsource.EventStore, pool *pgxpool.Pool, proj Projection, logger *slog.Logger) *Runner {
    return &Runner{store: store, pool: pool, projection: proj, logger: logger}
}

func (r *Runner) Run(ctx context.Context) error {
    // Load checkpoint
    lastEventID, err := r.loadCheckpoint(ctx)
    if err != nil {
        return fmt.Errorf("load checkpoint: %w", err)
    }

    r.logger.Info("starting projection",
        "name", r.projection.Name(),
        "lastEventID", lastEventID,
    )

    ch, err := r.store.Subscribe(ctx, lastEventID)
    if err != nil {
        return fmt.Errorf("subscribe to event store: %w", err)
    }

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()

        case event, ok := <-ch:
            if !ok {
                return fmt.Errorf("event channel closed")
            }

            if err := r.handleWithRetry(ctx, event); err != nil {
                r.logger.Error("failed to handle event",
                    "eventID", event.ID,
                    "eventType", event.EventType,
                    "error", err,
                )
                return err
            }

            if err := r.saveCheckpoint(ctx, event.ID, event.CreatedAt); err != nil {
                r.logger.Warn("failed to save checkpoint", "error", err)
            }
        }
    }
}

func (r *Runner) handleWithRetry(ctx context.Context, event eventsource.Event) error {
    const maxRetries = 3
    var err error
    for attempt := 1; attempt <= maxRetries; attempt++ {
        err = r.projection.HandleEvent(ctx, event)
        if err == nil {
            return nil
        }
        r.logger.Warn("projection handler error, retrying",
            "attempt", attempt,
            "eventID", event.ID,
            "error", err,
        )
        time.Sleep(time.Duration(attempt*attempt) * 100 * time.Millisecond)
    }
    return fmt.Errorf("projection %s failed after %d retries: %w",
        r.projection.Name(), maxRetries, err)
}

func (r *Runner) loadCheckpoint(ctx context.Context) (int64, error) {
    var lastID int64
    err := r.pool.QueryRow(ctx,
        `SELECT last_event_id FROM projection_checkpoints WHERE projection_name = $1`,
        r.projection.Name(),
    ).Scan(&lastID)
    if err != nil {
        // No checkpoint yet; start from beginning
        return 0, nil
    }
    return lastID, nil
}

func (r *Runner) saveCheckpoint(ctx context.Context, eventID int64, eventAt time.Time) error {
    _, err := r.pool.Exec(ctx,
        `INSERT INTO projection_checkpoints (projection_name, last_event_id, last_event_at, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (projection_name) DO UPDATE
           SET last_event_id = EXCLUDED.last_event_id,
               last_event_at = EXCLUDED.last_event_at,
               updated_at    = NOW()`,
        r.projection.Name(), eventID, eventAt,
    )
    return err
}
```

## Section 7: Event Replay

```go
// eventsource/replay.go
package eventsource

import (
    "context"
    "fmt"
    "log/slog"
    "time"
)

type ReplayConfig struct {
    BatchSize    int
    StreamTypes  []string  // empty = all types
    FromEventID  int64
    ToEventID    int64     // 0 = replay all
}

// Replay re-processes all events through a projection from scratch.
func Replay(
    ctx context.Context,
    store EventStore,
    proj interface {
        HandleEvent(context.Context, Event) error
        Name() string
    },
    cfg ReplayConfig,
    logger *slog.Logger,
) error {
    batchSize := cfg.BatchSize
    if batchSize <= 0 {
        batchSize = 500
    }

    logger.Info("starting replay",
        "projection", proj.Name(),
        "fromEventID", cfg.FromEventID,
        "batchSize", batchSize,
    )

    var (
        lastID    = cfg.FromEventID
        processed int64
        start     = time.Now()
    )

    for {
        events, err := store.ReadAllFrom(ctx, lastID, batchSize)
        if err != nil {
            return fmt.Errorf("read events from %d: %w", lastID, err)
        }

        if len(events) == 0 {
            break
        }

        for _, e := range events {
            if cfg.ToEventID > 0 && e.ID > cfg.ToEventID {
                goto done
            }

            if len(cfg.StreamTypes) > 0 && !contains(cfg.StreamTypes, e.StreamType) {
                continue
            }

            if err := proj.HandleEvent(ctx, e); err != nil {
                return fmt.Errorf("handle event %d (%s): %w", e.ID, e.EventType, err)
            }
            processed++
        }

        lastID = events[len(events)-1].ID

        if processed%10000 == 0 {
            elapsed := time.Since(start)
            rate := float64(processed) / elapsed.Seconds()
            logger.Info("replay progress",
                "processed", processed,
                "lastEventID", lastID,
                "rate_per_sec", fmt.Sprintf("%.0f", rate),
            )
        }

        if len(events) < batchSize {
            break
        }
    }

done:
    logger.Info("replay complete",
        "projection", proj.Name(),
        "processed", processed,
        "duration", time.Since(start).String(),
    )
    return nil
}

func contains(slice []string, s string) bool {
    for _, v := range slice {
        if v == s {
            return true
        }
    }
    return false
}
```

## Section 8: Eventual Consistency Handling

### Command Handler with Idempotency

```go
// commands/place_order.go
package commands

import (
    "context"
    "fmt"

    "github.com/google/uuid"
    "github.com/example/domain/order"
    "github.com/example/eventsource"
)

type PlaceOrderCommand struct {
    CommandID  uuid.UUID
    CustomerID uuid.UUID
    Items      []order.OrderItem
}

type PlaceOrderHandler struct {
    repo    *order.Repository
    deduper Deduplicator
}

// Deduplicator prevents double-processing of commands.
type Deduplicator interface {
    IsDuplicate(ctx context.Context, commandID uuid.UUID) (bool, error)
    MarkProcessed(ctx context.Context, commandID uuid.UUID) error
}

func NewPlaceOrderHandler(repo *order.Repository, deduper Deduplicator) *PlaceOrderHandler {
    return &PlaceOrderHandler{repo: repo, deduper: deduper}
}

func (h *PlaceOrderHandler) Handle(ctx context.Context, cmd PlaceOrderCommand, meta eventsource.Metadata) (uuid.UUID, error) {
    // Idempotency: check if this command was already processed
    isDup, err := h.deduper.IsDuplicate(ctx, cmd.CommandID)
    if err != nil {
        return uuid.Nil, fmt.Errorf("check dedup: %w", err)
    }
    if isDup {
        return uuid.Nil, nil // Already processed — idempotent response
    }

    orderID := uuid.New()
    o := order.NewOrder()
    o.id = orderID

    if err := o.PlaceOrder(cmd.CustomerID, cmd.Items); err != nil {
        return uuid.Nil, fmt.Errorf("place order: %w", err)
    }

    if err := h.repo.Save(ctx, o, meta); err != nil {
        // Retry on concurrency conflict
        if errors.As(err, &eventsource.ErrConcurrencyConflict{}) {
            return uuid.Nil, fmt.Errorf("concurrency conflict, retry: %w", err)
        }
        return uuid.Nil, fmt.Errorf("save order: %w", err)
    }

    if err := h.deduper.MarkProcessed(ctx, cmd.CommandID); err != nil {
        // Non-fatal — worst case we process again (idempotent)
        slog.Warn("failed to mark command as processed", "commandID", cmd.CommandID, "error", err)
    }

    return orderID, nil
}
```

### Query Side with Stale-Read Tolerance

```go
// queries/order_query.go
package queries

import (
    "context"
    "fmt"

    "github.com/google/uuid"
    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/example/projections"
)

type OrderQueryService struct {
    readPool *pgxpool.Pool
}

func NewOrderQueryService(readPool *pgxpool.Pool) *OrderQueryService {
    return &OrderQueryService{readPool: readPool}
}

func (s *OrderQueryService) GetOrderSummary(ctx context.Context, orderID uuid.UUID) (*projections.OrderSummary, error) {
    var summary projections.OrderSummary
    err := s.readPool.QueryRow(ctx,
        `SELECT order_id, customer_id, status, total_cents, item_count,
                COALESCE(tracking_number, ''), created_at, updated_at
         FROM order_summaries
         WHERE order_id = $1`,
        orderID,
    ).Scan(
        &summary.OrderID, &summary.CustomerID, &summary.Status,
        &summary.TotalCents, &summary.ItemCount, &summary.TrackingNumber,
        &summary.CreatedAt, &summary.UpdatedAt,
    )
    if err != nil {
        return nil, fmt.Errorf("query order summary: %w", err)
    }
    return &summary, nil
}

func (s *OrderQueryService) ListOrdersByCustomer(
    ctx context.Context,
    customerID uuid.UUID,
    limit, offset int,
) ([]projections.OrderSummary, error) {
    rows, err := s.readPool.Query(ctx,
        `SELECT order_id, customer_id, status, total_cents, item_count,
                COALESCE(tracking_number, ''), created_at, updated_at
         FROM order_summaries
         WHERE customer_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        customerID, limit, offset,
    )
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var results []projections.OrderSummary
    for rows.Next() {
        var s projections.OrderSummary
        if err := rows.Scan(
            &s.OrderID, &s.CustomerID, &s.Status,
            &s.TotalCents, &s.ItemCount, &s.TrackingNumber,
            &s.CreatedAt, &s.UpdatedAt,
        ); err != nil {
            return nil, err
        }
        results = append(results, s)
    }
    return results, rows.Err()
}
```

## Section 9: Testing Event Sourcing

```go
// domain/order/aggregate_test.go
package order_test

import (
    "testing"
    "time"

    "github.com/google/uuid"
    "github.com/example/domain/order"
    "github.com/example/eventsource"
)

func TestOrderLifecycle(t *testing.T) {
    customerID := uuid.New()
    items := []order.OrderItem{
        {ProductID: uuid.New(), Quantity: 2, PriceCents: 1999},
        {ProductID: uuid.New(), Quantity: 1, PriceCents: 4999},
    }

    o := order.NewOrder()
    o.id = uuid.New()

    // Place
    if err := o.PlaceOrder(customerID, items); err != nil {
        t.Fatalf("PlaceOrder: %v", err)
    }
    if o.Status() != order.StatusPending {
        t.Fatalf("expected Pending, got %s", o.Status())
    }
    if len(o.Uncommitted()) != 1 {
        t.Fatalf("expected 1 uncommitted event, got %d", len(o.Uncommitted()))
    }

    // Simulate persistence
    o.ClearUncommitted()

    // Confirm
    if err := o.Confirm(); err != nil {
        t.Fatalf("Confirm: %v", err)
    }
    if o.Status() != order.StatusConfirmed {
        t.Fatalf("expected Confirmed, got %s", o.Status())
    }

    // Ship
    if err := o.Ship("1Z999AA10123456784", "UPS"); err != nil {
        t.Fatalf("Ship: %v", err)
    }
    if o.Status() != order.StatusShipped {
        t.Fatalf("expected Shipped, got %s", o.Status())
    }

    // Cannot cancel after shipping
    if err := o.Cancel("changed mind"); err == nil {
        t.Fatal("expected error cancelling shipped order")
    }
}

func TestOrderReplay(t *testing.T) {
    orderID := uuid.New()
    customerID := uuid.New()
    productID := uuid.New()
    now := time.Now().UTC()

    events := []eventsource.Event{
        {
            ID: 1, StreamID: orderID, Version: 0,
            EventType: "OrderPlaced",
            Data: mustJSON(order.OrderPlaced{
                OrderID:    orderID,
                CustomerID: customerID,
                Items:      []order.OrderItem{{ProductID: productID, Quantity: 1, PriceCents: 999}},
                TotalCents: 999,
                PlacedAt:   now,
            }),
        },
        {
            ID: 2, StreamID: orderID, Version: 1,
            EventType: "OrderConfirmed",
            Data: mustJSON(order.OrderConfirmed{OrderID: orderID, ConfirmedAt: now.Add(time.Minute)}),
        },
    }

    o := order.NewOrder()
    o.id = orderID
    if err := o.Reconstruct(events); err != nil {
        t.Fatalf("Reconstruct: %v", err)
    }

    if o.Status() != order.StatusConfirmed {
        t.Fatalf("expected Confirmed after replay, got %s", o.Status())
    }
    if o.Version() != 2 {
        t.Fatalf("expected version 2, got %d", o.Version())
    }
}
```

## Summary

Event sourcing with CQRS in Go delivers an architecture where the write side is simple append-only operations and the read side is flexible projections that can be rebuilt at any time. Key production lessons:

- Use PostgreSQL's `UNIQUE INDEX (stream_id, version)` as the concurrency guard — it prevents double-writes more reliably than application-level checks under high concurrency
- Implement snapshots at a configurable threshold (50-100 events) to keep aggregate reconstruction fast without complicating the event stream
- Projection checkpointing must be reliable — a lost checkpoint causes re-processing from scratch which is expensive but correct
- Event replay is the killer feature: any new read model can be built by running the projection runner from event ID 0 against the complete history
- Design event types to be additive only — never change an existing event's schema; add new event types instead
