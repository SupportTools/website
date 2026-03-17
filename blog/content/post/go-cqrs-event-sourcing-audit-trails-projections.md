---
title: "Go CQRS with Event Sourcing: Building Audit Trails and Projections"
date: 2029-11-04T00:00:00-05:00
draft: false
tags: ["Go", "CQRS", "Event Sourcing", "PostgreSQL", "NATS", "Audit Trail", "Domain-Driven Design"]
categories: ["Go", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to implementing CQRS and Event Sourcing in Go: PostgreSQL-backed event store, NATS JetStream event bus, projection rebuilding, snapshot optimization for long aggregate histories, and read model consistency patterns."
more_link: "yes"
url: "/go-cqrs-event-sourcing-audit-trails-projections/"
---

CQRS (Command Query Responsibility Segregation) and Event Sourcing are architectural patterns that solve specific production problems: perfect audit trails, temporal queries, replay-based debugging, and horizontal scaling of read models. Go is well-suited for these patterns due to its strong type system, interface composition, and excellent PostgreSQL driver ecosystem. This guide builds a complete implementation: a PostgreSQL-backed event store, NATS JetStream for event fanout, projections that can be rebuilt from scratch, snapshot optimization, and read model consistency strategies.

<!--more-->

# Go CQRS with Event Sourcing: Building Audit Trails and Projections

## Section 1: Core Concepts

**Event Sourcing**: Instead of storing current state, store every state-changing event that occurred. The current state is derived by replaying events. The append-only event log is the source of truth.

**CQRS**: Commands modify state (write model); queries read from optimized projections (read model). The models are completely separate and can use different databases.

**Aggregate**: A cluster of domain objects treated as a single unit. Commands are handled by aggregates, which produce events.

**Projection**: A read model built by consuming events. Can be rebuilt at any time by replaying the event log.

```
Command → CommandHandler → Aggregate → Events → EventStore
                                                     │
                                                     ├── Projection 1 (PostgreSQL: current state)
                                                     ├── Projection 2 (Elasticsearch: full-text search)
                                                     └── Projection 3 (Redis: cached read model)
```

## Section 2: Event and Aggregate Types

```go
// internal/eventsourcing/types.go
package eventsourcing

import (
    "encoding/json"
    "time"

    "github.com/google/uuid"
)

// Event is the base type for all domain events
type Event struct {
    EventID       string          `json:"event_id"`
    EventType     string          `json:"event_type"`
    AggregateID   string          `json:"aggregate_id"`
    AggregateType string          `json:"aggregate_type"`
    Version       int             `json:"version"`
    OccurredAt    time.Time       `json:"occurred_at"`
    Payload       json.RawMessage `json:"payload"`
    Metadata      EventMetadata   `json:"metadata"`
}

type EventMetadata struct {
    CorrelationID string `json:"correlation_id"`
    CausationID   string `json:"causation_id"`
    UserID        string `json:"user_id"`
    IPAddress     string `json:"ip_address"`
    UserAgent     string `json:"user_agent"`
}

func NewEvent(aggregateID, aggregateType, eventType string, version int, payload interface{}, meta EventMetadata) (Event, error) {
    payloadBytes, err := json.Marshal(payload)
    if err != nil {
        return Event{}, err
    }

    return Event{
        EventID:       uuid.New().String(),
        EventType:     eventType,
        AggregateID:   aggregateID,
        AggregateType: aggregateType,
        Version:       version,
        OccurredAt:    time.Now().UTC(),
        Payload:       payloadBytes,
        Metadata:      meta,
    }, nil
}

// DomainEventPayload is implemented by all event payload types
type DomainEventPayload interface {
    EventType() string
}

// Aggregate base type
type Aggregate struct {
    ID           string
    Type         string
    Version      int
    pendingEvents []Event
}

func (a *Aggregate) appendEvent(event Event) {
    a.pendingEvents = append(a.pendingEvents, event)
    a.Version = event.Version
}

func (a *Aggregate) PopEvents() []Event {
    events := make([]Event, len(a.pendingEvents))
    copy(events, a.pendingEvents)
    a.pendingEvents = nil
    return events
}

func (a *Aggregate) HasPendingEvents() bool {
    return len(a.pendingEvents) > 0
}
```

### Order Aggregate Example

```go
// internal/domain/order/aggregate.go
package order

import (
    "errors"
    "time"

    "github.com/example/app/internal/eventsourcing"
)

type OrderStatus string

const (
    StatusDraft      OrderStatus = "draft"
    StatusPending    OrderStatus = "pending"
    StatusConfirmed  OrderStatus = "confirmed"
    StatusShipped    OrderStatus = "shipped"
    StatusDelivered  OrderStatus = "delivered"
    StatusCancelled  OrderStatus = "cancelled"
)

type Order struct {
    eventsourcing.Aggregate

    CustomerID  string
    Status      OrderStatus
    Items       []OrderItem
    TotalAmount float64
    PlacedAt    *time.Time
    CancelledAt *time.Time
    CancelReason string
}

type OrderItem struct {
    ProductID string
    SKU       string
    Name      string
    Quantity  int
    Price     float64
}

// Commands → Events

func NewOrder(id, customerID string) (*Order, error) {
    if id == "" || customerID == "" {
        return nil, errors.New("id and customerID are required")
    }

    o := &Order{}
    o.ID = id
    o.Type = "Order"

    event, err := eventsourcing.NewEvent(id, "Order", EventTypeOrderCreated, 1,
        OrderCreatedPayload{
            CustomerID: customerID,
        },
        eventsourcing.EventMetadata{},
    )
    if err != nil {
        return nil, err
    }

    o.apply(event)
    o.appendEvent(event)
    return o, nil
}

func (o *Order) AddItem(productID, sku, name string, quantity int, price float64) error {
    if o.Status != StatusDraft {
        return errors.New("cannot add items to non-draft order")
    }
    if quantity <= 0 {
        return errors.New("quantity must be positive")
    }
    if price <= 0 {
        return errors.New("price must be positive")
    }

    event, err := eventsourcing.NewEvent(o.ID, "Order", EventTypeItemAdded, o.Version+1,
        ItemAddedPayload{
            ProductID: productID,
            SKU:       sku,
            Name:      name,
            Quantity:  quantity,
            Price:     price,
        },
        eventsourcing.EventMetadata{},
    )
    if err != nil {
        return err
    }

    o.apply(event)
    o.appendEvent(event)
    return nil
}

func (o *Order) PlaceOrder(meta eventsourcing.EventMetadata) error {
    if o.Status != StatusDraft {
        return errors.New("order is not in draft state")
    }
    if len(o.Items) == 0 {
        return errors.New("cannot place empty order")
    }

    event, err := eventsourcing.NewEvent(o.ID, "Order", EventTypeOrderPlaced, o.Version+1,
        OrderPlacedPayload{
            PlacedAt:    time.Now().UTC(),
            TotalAmount: o.TotalAmount,
        },
        meta,
    )
    if err != nil {
        return err
    }

    o.apply(event)
    o.appendEvent(event)
    return nil
}

func (o *Order) Cancel(reason string, meta eventsourcing.EventMetadata) error {
    switch o.Status {
    case StatusDelivered:
        return errors.New("cannot cancel delivered order")
    case StatusCancelled:
        return errors.New("order is already cancelled")
    }

    event, err := eventsourcing.NewEvent(o.ID, "Order", EventTypeOrderCancelled, o.Version+1,
        OrderCancelledPayload{
            Reason:      reason,
            CancelledAt: time.Now().UTC(),
        },
        meta,
    )
    if err != nil {
        return err
    }

    o.apply(event)
    o.appendEvent(event)
    return nil
}

// apply rebuilds state from a single event (used during load and new events)
func (o *Order) apply(event eventsourcing.Event) {
    switch event.EventType {
    case EventTypeOrderCreated:
        var p OrderCreatedPayload
        json.Unmarshal(event.Payload, &p)
        o.CustomerID = p.CustomerID
        o.Status = StatusDraft
        o.Items = []OrderItem{}

    case EventTypeItemAdded:
        var p ItemAddedPayload
        json.Unmarshal(event.Payload, &p)
        o.Items = append(o.Items, OrderItem{
            ProductID: p.ProductID,
            SKU:       p.SKU,
            Name:      p.Name,
            Quantity:  p.Quantity,
            Price:     p.Price,
        })
        o.TotalAmount = calculateTotal(o.Items)

    case EventTypeOrderPlaced:
        var p OrderPlacedPayload
        json.Unmarshal(event.Payload, &p)
        o.Status = StatusPending
        o.PlacedAt = &p.PlacedAt

    case EventTypeOrderCancelled:
        var p OrderCancelledPayload
        json.Unmarshal(event.Payload, &p)
        o.Status = StatusCancelled
        o.CancelledAt = &p.CancelledAt
        o.CancelReason = p.Reason
    }
}
```

## Section 3: PostgreSQL Event Store

```sql
-- migrations/001_event_store.sql
CREATE TABLE events (
    id            BIGSERIAL PRIMARY KEY,
    event_id      UUID        NOT NULL UNIQUE,
    event_type    VARCHAR(255) NOT NULL,
    aggregate_id  UUID        NOT NULL,
    aggregate_type VARCHAR(255) NOT NULL,
    version       INTEGER     NOT NULL,
    occurred_at   TIMESTAMPTZ NOT NULL,
    payload       JSONB       NOT NULL,
    metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,

    -- Optimistic concurrency control
    CONSTRAINT uq_aggregate_version UNIQUE (aggregate_id, version)
);

CREATE INDEX idx_events_aggregate ON events (aggregate_id, version ASC);
CREATE INDEX idx_events_type ON events (event_type, occurred_at DESC);
CREATE INDEX idx_events_occurred ON events (occurred_at DESC);

-- Snapshots table
CREATE TABLE snapshots (
    id             BIGSERIAL PRIMARY KEY,
    aggregate_id   UUID        NOT NULL,
    aggregate_type VARCHAR(255) NOT NULL,
    version        INTEGER     NOT NULL,
    state          JSONB       NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_snapshot_aggregate UNIQUE (aggregate_id)
);

-- Audit log view (human-readable)
CREATE VIEW audit_log AS
SELECT
    e.occurred_at,
    e.aggregate_type,
    e.aggregate_id,
    e.event_type,
    e.version,
    e.metadata->>'user_id' AS user_id,
    e.metadata->>'ip_address' AS ip_address,
    e.metadata->>'correlation_id' AS correlation_id,
    e.payload
FROM events e
ORDER BY e.occurred_at DESC;
```

```go
// internal/eventsourcing/store.go
package eventsourcing

import (
    "context"
    "database/sql"
    "encoding/json"
    "errors"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

var ErrConcurrencyConflict = errors.New("optimistic concurrency conflict: version mismatch")
var ErrAggregateNotFound = errors.New("aggregate not found")

type EventStore struct {
    db *pgxpool.Pool
}

func NewEventStore(db *pgxpool.Pool) *EventStore {
    return &EventStore{db: db}
}

// AppendEvents stores events with optimistic concurrency control
func (s *EventStore) AppendEvents(ctx context.Context, events []Event) error {
    if len(events) == 0 {
        return nil
    }

    tx, err := s.db.Begin(ctx)
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }
    defer tx.Rollback(ctx)

    for _, event := range events {
        metadataJSON, err := json.Marshal(event.Metadata)
        if err != nil {
            return fmt.Errorf("marshaling metadata: %w", err)
        }

        _, err = tx.Exec(ctx, `
            INSERT INTO events (
                event_id, event_type, aggregate_id, aggregate_type,
                version, occurred_at, payload, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
            event.EventID,
            event.EventType,
            event.AggregateID,
            event.AggregateType,
            event.Version,
            event.OccurredAt,
            event.Payload,
            metadataJSON,
        )
        if err != nil {
            // Check for unique constraint violation (concurrency conflict)
            if isUniqueViolation(err) {
                return fmt.Errorf("%w: aggregate %s at version %d",
                    ErrConcurrencyConflict, event.AggregateID, event.Version)
            }
            return fmt.Errorf("inserting event: %w", err)
        }
    }

    if err := tx.Commit(ctx); err != nil {
        return fmt.Errorf("committing transaction: %w", err)
    }

    return nil
}

// LoadEvents retrieves all events for an aggregate
func (s *EventStore) LoadEvents(ctx context.Context, aggregateID string, fromVersion int) ([]Event, error) {
    rows, err := s.db.Query(ctx, `
        SELECT event_id, event_type, aggregate_id, aggregate_type,
               version, occurred_at, payload, metadata
        FROM events
        WHERE aggregate_id = $1 AND version > $2
        ORDER BY version ASC
    `, aggregateID, fromVersion)
    if err != nil {
        return nil, fmt.Errorf("querying events: %w", err)
    }
    defer rows.Close()

    return scanEvents(rows)
}

// LoadEventsByType retrieves events of a specific type (useful for projections)
func (s *EventStore) LoadEventsByType(
    ctx context.Context,
    eventType string,
    after time.Time,
    limit int,
) ([]Event, error) {
    rows, err := s.db.Query(ctx, `
        SELECT event_id, event_type, aggregate_id, aggregate_type,
               version, occurred_at, payload, metadata
        FROM events
        WHERE event_type = $1 AND occurred_at > $2
        ORDER BY occurred_at ASC
        LIMIT $3
    `, eventType, after, limit)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    return scanEvents(rows)
}

// StreamEvents uses a cursor for efficient bulk reading during projection rebuild
func (s *EventStore) StreamEvents(
    ctx context.Context,
    aggregateType string,
    handler func(Event) error,
) error {
    rows, err := s.db.Query(ctx, `
        SELECT event_id, event_type, aggregate_id, aggregate_type,
               version, occurred_at, payload, metadata
        FROM events
        WHERE aggregate_type = $1
        ORDER BY id ASC
    `, aggregateType)
    if err != nil {
        return err
    }
    defer rows.Close()

    for rows.Next() {
        var event Event
        var metadataJSON []byte

        err := rows.Scan(
            &event.EventID, &event.EventType,
            &event.AggregateID, &event.AggregateType,
            &event.Version, &event.OccurredAt,
            &event.Payload, &metadataJSON,
        )
        if err != nil {
            return err
        }

        if err := json.Unmarshal(metadataJSON, &event.Metadata); err != nil {
            return err
        }

        if err := handler(event); err != nil {
            return err
        }
    }

    return rows.Err()
}

func scanEvents(rows pgx.Rows) ([]Event, error) {
    var events []Event
    for rows.Next() {
        var event Event
        var metadataJSON []byte

        err := rows.Scan(
            &event.EventID, &event.EventType,
            &event.AggregateID, &event.AggregateType,
            &event.Version, &event.OccurredAt,
            &event.Payload, &metadataJSON,
        )
        if err != nil {
            return nil, err
        }

        if err := json.Unmarshal(metadataJSON, &event.Metadata); err != nil {
            return nil, err
        }

        events = append(events, event)
    }
    return events, rows.Err()
}
```

## Section 4: Snapshot Optimization

For aggregates with long event histories, loading hundreds of events on every command becomes expensive. Snapshots store the serialized state at a version, allowing event loading to start from the snapshot:

```go
// internal/eventsourcing/snapshot.go
package eventsourcing

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/jackc/pgx/v5/pgxpool"
)

type Snapshot struct {
    AggregateID   string
    AggregateType string
    Version       int
    State         json.RawMessage
    CreatedAt     time.Time
}

type SnapshotStore struct {
    db              *pgxpool.Pool
    snapshotEvery   int  // Create snapshot every N events
}

func NewSnapshotStore(db *pgxpool.Pool, snapshotEvery int) *SnapshotStore {
    if snapshotEvery <= 0 {
        snapshotEvery = 50  // Default: snapshot every 50 events
    }
    return &SnapshotStore{db: db, snapshotEvery: snapshotEvery}
}

func (s *SnapshotStore) LoadSnapshot(ctx context.Context, aggregateID string) (*Snapshot, error) {
    var snap Snapshot
    err := s.db.QueryRow(ctx, `
        SELECT aggregate_id, aggregate_type, version, state, created_at
        FROM snapshots
        WHERE aggregate_id = $1
    `, aggregateID).Scan(
        &snap.AggregateID,
        &snap.AggregateType,
        &snap.Version,
        &snap.State,
        &snap.CreatedAt,
    )
    if err != nil {
        if err.Error() == "no rows in result set" {
            return nil, nil  // No snapshot exists
        }
        return nil, fmt.Errorf("loading snapshot: %w", err)
    }
    return &snap, nil
}

func (s *SnapshotStore) SaveSnapshot(ctx context.Context, snap Snapshot) error {
    _, err := s.db.Exec(ctx, `
        INSERT INTO snapshots (aggregate_id, aggregate_type, version, state, created_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (aggregate_id) DO UPDATE
        SET version = EXCLUDED.version,
            state = EXCLUDED.state,
            created_at = EXCLUDED.created_at
    `,
        snap.AggregateID,
        snap.AggregateType,
        snap.Version,
        snap.State,
        time.Now().UTC(),
    )
    return err
}

func (s *SnapshotStore) ShouldSnapshot(version int, lastSnapshotVersion int) bool {
    return version-lastSnapshotVersion >= s.snapshotEvery
}
```

### Repository with Snapshot Support

```go
// internal/domain/order/repository.go
package order

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/example/app/internal/eventsourcing"
)

type Repository struct {
    eventStore    *eventsourcing.EventStore
    snapshotStore *eventsourcing.SnapshotStore
    publisher     eventsourcing.EventPublisher
}

func NewRepository(
    es *eventsourcing.EventStore,
    ss *eventsourcing.SnapshotStore,
    pub eventsourcing.EventPublisher,
) *Repository {
    return &Repository{
        eventStore:    es,
        snapshotStore: ss,
        publisher:     pub,
    }
}

func (r *Repository) Load(ctx context.Context, id string) (*Order, error) {
    order := &Order{}
    order.ID = id
    order.Type = "Order"

    // Try to load from snapshot first
    snap, err := r.snapshotStore.LoadSnapshot(ctx, id)
    if err != nil {
        return nil, fmt.Errorf("loading snapshot: %w", err)
    }

    fromVersion := 0
    if snap != nil {
        // Restore state from snapshot
        if err := json.Unmarshal(snap.State, order); err != nil {
            return nil, fmt.Errorf("unmarshaling snapshot: %w", err)
        }
        fromVersion = snap.Version
    }

    // Load events since the snapshot
    events, err := r.eventStore.LoadEvents(ctx, id, fromVersion)
    if err != nil {
        return nil, fmt.Errorf("loading events: %w", err)
    }

    if snap == nil && len(events) == 0 {
        return nil, eventsourcing.ErrAggregateNotFound
    }

    // Replay events to rebuild current state
    for _, event := range events {
        order.apply(event)
    }

    return order, nil
}

func (r *Repository) Save(ctx context.Context, order *Order) error {
    pendingEvents := order.PopEvents()
    if len(pendingEvents) == 0 {
        return nil
    }

    // Save events with optimistic concurrency control
    if err := r.eventStore.AppendEvents(ctx, pendingEvents); err != nil {
        return fmt.Errorf("appending events: %w", err)
    }

    // Create snapshot if threshold reached
    snap, err := r.snapshotStore.LoadSnapshot(ctx, order.ID)
    if err != nil {
        // Non-fatal: log and continue
        return nil
    }

    lastSnapshotVersion := 0
    if snap != nil {
        lastSnapshotVersion = snap.Version
    }

    if r.snapshotStore.ShouldSnapshot(order.Version, lastSnapshotVersion) {
        stateJSON, err := json.Marshal(order)
        if err == nil {
            _ = r.snapshotStore.SaveSnapshot(ctx, eventsourcing.Snapshot{
                AggregateID:   order.ID,
                AggregateType: "Order",
                Version:       order.Version,
                State:         stateJSON,
            })
        }
    }

    // Publish events to NATS
    if err := r.publisher.Publish(ctx, pendingEvents...); err != nil {
        // Log but don't fail the write — events are already persisted
        // Use a background job to republish if needed
        return fmt.Errorf("publishing events: %w", err)
    }

    return nil
}
```

## Section 5: NATS JetStream Event Bus

```go
// internal/eventsourcing/publisher.go
package eventsourcing

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

type EventPublisher interface {
    Publish(ctx context.Context, events ...Event) error
}

type EventSubscriber interface {
    Subscribe(ctx context.Context, subject string, handler func(Event) error) error
}

type NATSPublisher struct {
    js     jetstream.JetStream
    stream string
}

func NewNATSPublisher(nc *nats.Conn, streamName string) (*NATSPublisher, error) {
    js, err := jetstream.New(nc)
    if err != nil {
        return nil, err
    }

    // Ensure stream exists
    _, err = js.CreateOrUpdateStream(context.Background(), jetstream.StreamConfig{
        Name:        streamName,
        Subjects:    []string{streamName + ".>"},
        Retention:   jetstream.LimitsPolicy,
        MaxAge:      365 * 24 * time.Hour,  // Keep events for 1 year
        Storage:     jetstream.FileStorage,
        Replicas:    3,
        MaxMsgSize:  1 * 1024 * 1024,  // 1MB max event size
        Compression: jetstream.S2Compression,
    })
    if err != nil {
        return nil, fmt.Errorf("creating stream: %w", err)
    }

    return &NATSPublisher{js: js, stream: streamName}, nil
}

func (p *NATSPublisher) Publish(ctx context.Context, events ...Event) error {
    for _, event := range events {
        data, err := json.Marshal(event)
        if err != nil {
            return fmt.Errorf("marshaling event: %w", err)
        }

        // Subject format: stream.AggregateType.EventType
        subject := fmt.Sprintf("%s.%s.%s", p.stream, event.AggregateType, event.EventType)

        msg := &nats.Msg{
            Subject: subject,
            Data:    data,
            Header: nats.Header{
                "Event-ID":       {event.EventID},
                "Aggregate-ID":   {event.AggregateID},
                "Event-Type":     {event.EventType},
                "Correlation-ID": {event.Metadata.CorrelationID},
            },
        }

        // Publish with acknowledgment (JetStream guarantees delivery)
        _, err = p.js.PublishMsg(ctx, msg)
        if err != nil {
            return fmt.Errorf("publishing event %s: %w", event.EventID, err)
        }
    }
    return nil
}

// Subscribe creates a durable consumer for a projection
func (p *NATSPublisher) Subscribe(
    ctx context.Context,
    consumerName string,
    subjects []string,
    handler func(Event) error,
) error {
    js, err := jetstream.New(p.nc)
    if err != nil {
        return err
    }

    consumer, err := js.CreateOrUpdateConsumer(ctx, p.stream, jetstream.ConsumerConfig{
        Name:          consumerName,
        FilterSubjects: subjects,
        DeliverPolicy: jetstream.DeliverAllPolicy,
        AckPolicy:     jetstream.AckExplicitPolicy,
        MaxDeliver:    5,
        AckWait:       30 * time.Second,
        BackOff: []time.Duration{
            1 * time.Second,
            5 * time.Second,
            30 * time.Second,
        },
    })
    if err != nil {
        return fmt.Errorf("creating consumer: %w", err)
    }

    _, err = consumer.Consume(func(msg jetstream.Msg) {
        var event Event
        if err := json.Unmarshal(msg.Data(), &event); err != nil {
            msg.Nak()
            return
        }

        if err := handler(event); err != nil {
            msg.NakWithDelay(5 * time.Second)
            return
        }

        msg.Ack()
    })
    return err
}
```

## Section 6: Projections

### Order Read Model Projection

```go
// internal/projection/order_summary.go
package projection

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"

    "github.com/example/app/internal/domain/order"
    "github.com/example/app/internal/eventsourcing"
)

type OrderSummaryProjection struct {
    db     *pgxpool.Pool
    logger *slog.Logger
}

func NewOrderSummaryProjection(db *pgxpool.Pool, logger *slog.Logger) *OrderSummaryProjection {
    return &OrderSummaryProjection{db: db, logger: logger}
}

// Handle processes a single event and updates the read model
func (p *OrderSummaryProjection) Handle(ctx context.Context, event eventsourcing.Event) error {
    switch event.EventType {
    case order.EventTypeOrderCreated:
        return p.handleOrderCreated(ctx, event)
    case order.EventTypeItemAdded:
        return p.handleItemAdded(ctx, event)
    case order.EventTypeOrderPlaced:
        return p.handleOrderPlaced(ctx, event)
    case order.EventTypeOrderCancelled:
        return p.handleOrderCancelled(ctx, event)
    default:
        // Unknown event type — ignore (forward compatibility)
        return nil
    }
}

func (p *OrderSummaryProjection) handleOrderCreated(ctx context.Context, event eventsourcing.Event) error {
    var payload order.OrderCreatedPayload
    if err := json.Unmarshal(event.Payload, &payload); err != nil {
        return err
    }

    _, err := p.db.Exec(ctx, `
        INSERT INTO order_summaries (
            order_id, customer_id, status, total_amount,
            item_count, created_at, updated_at, version
        ) VALUES ($1, $2, 'draft', 0, 0, $3, $3, 1)
        ON CONFLICT (order_id) DO NOTHING
    `, event.AggregateID, payload.CustomerID, event.OccurredAt)
    return err
}

func (p *OrderSummaryProjection) handleItemAdded(ctx context.Context, event eventsourcing.Event) error {
    var payload order.ItemAddedPayload
    if err := json.Unmarshal(event.Payload, &payload); err != nil {
        return err
    }

    _, err := p.db.Exec(ctx, `
        UPDATE order_summaries
        SET total_amount = total_amount + ($1 * $2),
            item_count = item_count + 1,
            updated_at = $3,
            version = $4
        WHERE order_id = $5
    `, payload.Price, payload.Quantity, event.OccurredAt, event.Version, event.AggregateID)
    return err
}

func (p *OrderSummaryProjection) handleOrderPlaced(ctx context.Context, event eventsourcing.Event) error {
    var payload order.OrderPlacedPayload
    if err := json.Unmarshal(event.Payload, &payload); err != nil {
        return err
    }

    _, err := p.db.Exec(ctx, `
        UPDATE order_summaries
        SET status = 'pending',
            placed_at = $1,
            updated_at = $1,
            version = $2
        WHERE order_id = $3
    `, payload.PlacedAt, event.Version, event.AggregateID)
    return err
}

func (p *OrderSummaryProjection) handleOrderCancelled(ctx context.Context, event eventsourcing.Event) error {
    var payload order.OrderCancelledPayload
    if err := json.Unmarshal(event.Payload, &payload); err != nil {
        return err
    }

    _, err := p.db.Exec(ctx, `
        UPDATE order_summaries
        SET status = 'cancelled',
            cancel_reason = $1,
            cancelled_at = $2,
            updated_at = $2,
            version = $3
        WHERE order_id = $4
    `, payload.Reason, payload.CancelledAt, event.Version, event.AggregateID)
    return err
}
```

## Section 7: Projection Rebuilding

```go
// internal/projection/rebuilder.go
package projection

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"

    "github.com/example/app/internal/eventsourcing"
)

type ProjectionRebuilder struct {
    eventStore  *eventsourcing.EventStore
    projections map[string]ProjectionHandler
    db          *pgxpool.Pool
    logger      *slog.Logger
}

type ProjectionHandler interface {
    Handle(ctx context.Context, event eventsourcing.Event) error
}

type RebuildResult struct {
    EventsProcessed int
    Duration        time.Duration
    Errors          int
}

func (r *ProjectionRebuilder) Rebuild(ctx context.Context, aggregateType string) (*RebuildResult, error) {
    r.logger.Info("starting projection rebuild", "aggregate_type", aggregateType)
    start := time.Now()

    // Step 1: Truncate the read model tables (within a transaction for atomicity)
    tx, err := r.db.Begin(ctx)
    if err != nil {
        return nil, err
    }

    if _, err := tx.Exec(ctx, "TRUNCATE TABLE order_summaries"); err != nil {
        tx.Rollback(ctx)
        return nil, fmt.Errorf("truncating read model: %w", err)
    }

    // Reset projection checkpoint
    if _, err := tx.Exec(ctx, `
        INSERT INTO projection_checkpoints (projection_name, last_event_id, last_position)
        VALUES ($1, '', 0)
        ON CONFLICT (projection_name) DO UPDATE
        SET last_event_id = '', last_position = 0
    `, aggregateType+"-projection"); err != nil {
        tx.Rollback(ctx)
        return nil, err
    }

    if err := tx.Commit(ctx); err != nil {
        return nil, err
    }

    // Step 2: Stream all events and replay them
    result := &RebuildResult{}
    batchTx, _ := r.db.Begin(ctx)
    batchSize := 0

    err = r.eventStore.StreamEvents(ctx, aggregateType, func(event eventsourcing.Event) error {
        handler, ok := r.projections[aggregateType]
        if !ok {
            return fmt.Errorf("no projection handler for %s", aggregateType)
        }

        if err := handler.Handle(ctx, event); err != nil {
            result.Errors++
            r.logger.Error("projection handler error",
                "event_id", event.EventID,
                "event_type", event.EventType,
                "error", err,
            )
            // Continue despite errors (soft failure)
            return nil
        }

        result.EventsProcessed++
        batchSize++

        // Commit in batches for memory efficiency
        if batchSize >= 1000 {
            if err := batchTx.Commit(ctx); err != nil {
                return err
            }
            batchTx, _ = r.db.Begin(ctx)
            batchSize = 0

            r.logger.Info("rebuild progress",
                "events_processed", result.EventsProcessed,
            )
        }

        return nil
    })

    if batchSize > 0 {
        batchTx.Commit(ctx)
    }

    if err != nil {
        return result, fmt.Errorf("streaming events: %w", err)
    }

    result.Duration = time.Since(start)
    r.logger.Info("projection rebuild complete",
        "events_processed", result.EventsProcessed,
        "duration", result.Duration,
        "errors", result.Errors,
    )

    return result, nil
}
```

## Section 8: Read Model Consistency Strategies

### Eventually Consistent vs. Strongly Consistent

Event sourcing naturally produces eventually consistent read models. Choose the right strategy:

**Strategy 1: Eventual Consistency (Default)**
- Write command → save events → publish to NATS → projection consumes asynchronously
- Read from read model (may be slightly stale)
- Suitable for most use cases (order listing, dashboards)

**Strategy 2: Read-Your-Writes Consistency**
- After writing, poll the read model until it reflects the new version

```go
func (s *OrderService) PlaceOrderAndRead(ctx context.Context, cmd PlaceOrderCommand) (*OrderSummary, error) {
    // Write
    order, err := s.repo.Load(ctx, cmd.OrderID)
    if err != nil {
        return nil, err
    }

    if err := order.PlaceOrder(cmd.Metadata); err != nil {
        return nil, err
    }

    if err := s.repo.Save(ctx, order); err != nil {
        return nil, err
    }

    targetVersion := order.Version

    // Wait for read model to catch up
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    for {
        summary, err := s.queries.GetOrder(ctx, cmd.OrderID)
        if err == nil && summary.Version >= targetVersion {
            return summary, nil
        }

        select {
        case <-ctx.Done():
            // Timeout — return what we have or an error
            return summary, nil
        case <-time.After(50 * time.Millisecond):
            continue
        }
    }
}
```

**Strategy 3: Inline Projection (Synchronous)**
- Update the read model in the same transaction as saving events
- Strongest consistency but couples write and read models

```go
func (r *Repository) SaveWithProjection(ctx context.Context, order *Order, proj *OrderSummaryProjection) error {
    pendingEvents := order.PopEvents()

    tx, err := r.db.Begin(ctx)
    if err != nil {
        return err
    }
    defer tx.Rollback(ctx)

    // Save events
    for _, event := range pendingEvents {
        if err := r.appendEventTx(ctx, tx, event); err != nil {
            return err
        }
    }

    // Update projection in same transaction
    for _, event := range pendingEvents {
        if err := proj.HandleTx(ctx, tx, event); err != nil {
            return err
        }
    }

    return tx.Commit(ctx)
}
```

## Section 9: Audit Trail Queries

The event store is a complete audit trail by design:

```go
// internal/audit/service.go
package audit

import (
    "context"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
)

type AuditEvent struct {
    OccurredAt    time.Time
    AggregateType string
    AggregateID   string
    EventType     string
    Version       int
    UserID        string
    IPAddress     string
    CorrelationID string
    Payload       json.RawMessage
}

type AuditService struct {
    db *pgxpool.Pool
}

func (s *AuditService) GetAggregateHistory(ctx context.Context, aggregateID string) ([]AuditEvent, error) {
    rows, err := s.db.Query(ctx, `
        SELECT
            occurred_at,
            aggregate_type,
            aggregate_id,
            event_type,
            version,
            metadata->>'user_id',
            metadata->>'ip_address',
            metadata->>'correlation_id',
            payload
        FROM events
        WHERE aggregate_id = $1
        ORDER BY version ASC
    `, aggregateID)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var events []AuditEvent
    for rows.Next() {
        var e AuditEvent
        err := rows.Scan(
            &e.OccurredAt, &e.AggregateType, &e.AggregateID,
            &e.EventType, &e.Version, &e.UserID, &e.IPAddress,
            &e.CorrelationID, &e.Payload,
        )
        if err != nil {
            return nil, err
        }
        events = append(events, e)
    }
    return events, nil
}

// GetUserActions retrieves all events caused by a specific user
func (s *AuditService) GetUserActions(ctx context.Context, userID string, from, to time.Time) ([]AuditEvent, error) {
    rows, err := s.db.Query(ctx, `
        SELECT occurred_at, aggregate_type, aggregate_id, event_type, version,
               metadata->>'ip_address', metadata->>'correlation_id', payload
        FROM events
        WHERE metadata->>'user_id' = $1
          AND occurred_at BETWEEN $2 AND $3
        ORDER BY occurred_at DESC
        LIMIT 1000
    `, userID, from, to)
    // ... scan and return
}

// TemporalQuery reconstructs aggregate state at a point in time
func (s *AuditService) GetOrderStateAt(ctx context.Context, orderID string, at time.Time) (*order.Order, error) {
    events, err := s.db.Query(ctx, `
        SELECT event_id, event_type, aggregate_id, aggregate_type,
               version, occurred_at, payload, metadata
        FROM events
        WHERE aggregate_id = $1 AND occurred_at <= $2
        ORDER BY version ASC
    `, orderID, at)
    // Replay events up to the timestamp to reconstruct historical state
}
```

## Conclusion

CQRS with Event Sourcing in Go provides powerful capabilities: perfect audit trails, temporal queries, projection rebuilding without data migration, and independent scaling of read and write models. The PostgreSQL event store gives you ACID guarantees for event persistence, while NATS JetStream provides reliable fanout to multiple projections.

Key takeaways:
- The event store is append-only — never update or delete events
- Use optimistic concurrency control (unique constraint on aggregate_id + version) to prevent concurrent modifications
- Snapshots are a performance optimization, not a correctness concern — you can always rebuild from events
- Choose your consistency model deliberately: eventual consistency is simpler; inline projections add coupling
- CQRS shines when read and write patterns diverge significantly (e.g., complex queries vs. simple writes)
- Audit trail and temporal queries come for free from the event log — no additional implementation needed
