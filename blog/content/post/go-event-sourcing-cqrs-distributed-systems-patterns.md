---
title: "Go Event Sourcing and CQRS: Patterns for Distributed Systems"
date: 2029-06-14T00:00:00-05:00
draft: false
tags: ["Go", "Event Sourcing", "CQRS", "Kafka", "Distributed Systems", "Architecture"]
categories: ["Go", "Distributed Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production patterns for event sourcing and CQRS in Go: event store design, event replay mechanics, snapshot strategies, read/write model separation, using Kafka as an event log, and handling eventual consistency in practice."
more_link: "yes"
url: "/go-event-sourcing-cqrs-distributed-systems-patterns/"
---

Event sourcing and CQRS solve specific problems in distributed systems: how to maintain an auditable history of state changes, how to reconstruct state at any point in time, and how to separate read scalability from write throughput. These patterns are not always the right choice, but when they are, Go's type system and concurrency primitives make for clean implementations. This guide covers the full event sourcing stack in Go — from event store design to Kafka-backed projections.

<!--more-->

# Go Event Sourcing and CQRS: Distributed Systems Patterns

## When to Use Event Sourcing

Event sourcing is the right architectural choice when you need:
- Full audit trail of every state change with who made it and why
- Ability to replay events to reconstruct state at any historical point
- Event-driven integration with other services
- Complex domain logic that benefits from explicit event modeling

It is the wrong choice when:
- Your domain is simple CRUD with no complex business rules
- You need strong consistency across aggregates
- Your team is small and the operational overhead outweighs the benefits

## Core Concepts

```
Traditional (state-based):
  Database: { orderId: "123", status: "shipped", items: [...] }
  ← only current state, history lost

Event Sourcing:
  Event log:
    OrderCreated   { orderId: "123", items: [...],  at: T1 }
    PaymentReceived{ orderId: "123", amount: 99.99, at: T2 }
    OrderShipped   { orderId: "123", carrier: "UPS", at: T3 }
  ← full history, current state derived by replaying events
```

## Event and Aggregate Design

### Defining Events

```go
package order

import (
    "time"
    "encoding/json"
)

// Event is the base interface all domain events implement
type Event interface {
    AggregateID() string
    AggregateType() string
    EventType() string
    OccurredAt() time.Time
    Version() int64
}

// BaseEvent provides common fields for all events
type BaseEvent struct {
    ID            string    `json:"id"`
    AggID         string    `json:"aggregate_id"`
    AggType       string    `json:"aggregate_type"`
    Type          string    `json:"type"`
    OccurredAtUTC time.Time `json:"occurred_at"`
    Ver           int64     `json:"version"`
    // Metadata for audit trail
    UserID        string    `json:"user_id,omitempty"`
    CorrelationID string    `json:"correlation_id,omitempty"`
    CausationID   string    `json:"causation_id,omitempty"`
}

func (e BaseEvent) AggregateID()   string    { return e.AggID }
func (e BaseEvent) AggregateType() string    { return e.AggType }
func (e BaseEvent) EventType()     string    { return e.Type }
func (e BaseEvent) OccurredAt()    time.Time { return e.OccurredAtUTC }
func (e BaseEvent) Version()       int64     { return e.Ver }

// Domain events
type OrderCreated struct {
    BaseEvent
    CustomerID string      `json:"customer_id"`
    Items      []OrderItem `json:"items"`
    Currency   string      `json:"currency"`
}

type OrderItem struct {
    SKU      string  `json:"sku"`
    Quantity int     `json:"quantity"`
    Price    float64 `json:"price"`
}

type PaymentReceived struct {
    BaseEvent
    Amount        float64 `json:"amount"`
    Currency      string  `json:"currency"`
    PaymentMethod string  `json:"payment_method"`
    TransactionID string  `json:"transaction_id"`
}

type OrderShipped struct {
    BaseEvent
    Carrier        string `json:"carrier"`
    TrackingNumber string `json:"tracking_number"`
    EstimatedAt    time.Time `json:"estimated_at"`
}

type OrderCancelled struct {
    BaseEvent
    Reason string `json:"reason"`
}
```

### The Aggregate

```go
type OrderStatus string

const (
    StatusPending   OrderStatus = "pending"
    StatusPaid      OrderStatus = "paid"
    StatusShipped   OrderStatus = "shipped"
    StatusCancelled OrderStatus = "cancelled"
)

// Order is the aggregate root
type Order struct {
    id         string
    customerID string
    status     OrderStatus
    items      []OrderItem
    totalPaid  float64

    // Event sourcing bookkeeping
    version        int64    // Current version (sequence number of last applied event)
    pendingEvents  []Event  // Events generated but not yet persisted
}

// Apply applies an event to update aggregate state.
// This is a pure function — no side effects, no I/O.
func (o *Order) Apply(event Event) error {
    switch e := event.(type) {
    case *OrderCreated:
        o.id = e.AggID
        o.customerID = e.CustomerID
        o.items = e.Items
        o.status = StatusPending

    case *PaymentReceived:
        if o.status != StatusPending {
            return fmt.Errorf("cannot receive payment for order in status %q", o.status)
        }
        o.totalPaid += e.Amount
        o.status = StatusPaid

    case *OrderShipped:
        if o.status != StatusPaid {
            return fmt.Errorf("cannot ship unpaid order")
        }
        o.status = StatusShipped

    case *OrderCancelled:
        if o.status == StatusShipped {
            return fmt.Errorf("cannot cancel shipped order")
        }
        o.status = StatusCancelled

    default:
        return fmt.Errorf("unknown event type: %T", event)
    }

    o.version = event.Version()
    return nil
}

// RecordEvent generates a new event and appends it to pendingEvents
func (o *Order) RecordEvent(event Event) {
    o.pendingEvents = append(o.pendingEvents, event)
    o.Apply(event) // Apply immediately to update in-memory state
}

// PendingEvents returns events that need to be persisted
func (o *Order) PendingEvents() []Event { return o.pendingEvents }

// ClearPendingEvents marks pending events as committed
func (o *Order) ClearPendingEvents() { o.pendingEvents = nil }

// Domain commands — these enforce business rules and generate events
func (o *Order) ReceivePayment(amount float64, currency, method, txID, userID string) error {
    if o.status != StatusPending {
        return fmt.Errorf("order %q cannot receive payment: status is %q", o.id, o.status)
    }
    o.RecordEvent(&PaymentReceived{
        BaseEvent: BaseEvent{
            ID:      newEventID(),
            AggID:   o.id,
            AggType: "order",
            Type:    "PaymentReceived",
            OccurredAtUTC: time.Now().UTC(),
            Ver:    o.version + 1,
            UserID: userID,
        },
        Amount:        amount,
        Currency:      currency,
        PaymentMethod: method,
        TransactionID: txID,
    })
    return nil
}
```

## Event Store Design

### The EventStore Interface

```go
// EventStore is the persistence layer for events
type EventStore interface {
    // AppendEvents persists new events, enforcing optimistic concurrency
    // expectedVersion is the version the caller believes the aggregate is at
    // Returns ErrOptimisticConcurrency if the aggregate has been modified since
    AppendEvents(ctx context.Context, aggregateID string, expectedVersion int64, events []Event) error

    // LoadEvents loads all events for an aggregate, in order
    LoadEvents(ctx context.Context, aggregateID string) ([]Event, error)

    // LoadEventsFrom loads events starting from a specific version
    LoadEventsFrom(ctx context.Context, aggregateID string, fromVersion int64) ([]Event, error)

    // Subscribe returns a channel that receives all new events
    // Used by projections to build read models
    Subscribe(ctx context.Context, aggregateType string) (<-chan StoredEvent, error)
}

var ErrOptimisticConcurrency = errors.New("optimistic concurrency violation")

type StoredEvent struct {
    Event
    GlobalSequence int64  // Global ordering across all aggregates
    StoredAt       time.Time
}
```

### PostgreSQL Event Store

```go
package eventstore

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/jackc/pgx/v5/pgxpool"
)

type PostgresEventStore struct {
    db *pgxpool.Pool
}

const schema = `
CREATE TABLE IF NOT EXISTS events (
    global_seq      BIGSERIAL PRIMARY KEY,
    aggregate_id    TEXT        NOT NULL,
    aggregate_type  TEXT        NOT NULL,
    event_type      TEXT        NOT NULL,
    version         BIGINT      NOT NULL,
    payload         JSONB       NOT NULL,
    metadata        JSONB       NOT NULL DEFAULT '{}',
    occurred_at     TIMESTAMPTZ NOT NULL,
    stored_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Enforce ordering within an aggregate: no duplicate versions
    UNIQUE(aggregate_id, version)
);

CREATE INDEX IF NOT EXISTS idx_events_aggregate_id
    ON events(aggregate_id, version);

CREATE INDEX IF NOT EXISTS idx_events_global_seq
    ON events(global_seq);

CREATE INDEX IF NOT EXISTS idx_events_aggregate_type
    ON events(aggregate_type, global_seq);
`

func (s *PostgresEventStore) AppendEvents(
    ctx context.Context,
    aggregateID string,
    expectedVersion int64,
    events []Event,
) error {
    tx, err := s.db.Begin(ctx)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback(ctx)

    // Optimistic concurrency check: verify current version
    var currentVersion int64
    err = tx.QueryRow(ctx,
        `SELECT COALESCE(MAX(version), 0) FROM events WHERE aggregate_id = $1`,
        aggregateID,
    ).Scan(&currentVersion)
    if err != nil {
        return fmt.Errorf("check current version: %w", err)
    }

    if currentVersion != expectedVersion {
        return fmt.Errorf("%w: expected version %d, got %d",
            ErrOptimisticConcurrency, expectedVersion, currentVersion)
    }

    // Insert all events in a single batch
    for _, event := range events {
        payload, err := json.Marshal(event)
        if err != nil {
            return fmt.Errorf("marshal event: %w", err)
        }
        metadata, err := json.Marshal(map[string]string{
            "user_id":        getUserID(event),
            "correlation_id": getCorrelationID(event),
        })
        if err != nil {
            return fmt.Errorf("marshal metadata: %w", err)
        }

        _, err = tx.Exec(ctx, `
            INSERT INTO events
                (aggregate_id, aggregate_type, event_type, version, payload, metadata, occurred_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
            event.AggregateID(),
            event.AggregateType(),
            event.EventType(),
            event.Version(),
            payload,
            metadata,
            event.OccurredAt(),
        )
        if err != nil {
            // Unique constraint violation = concurrent modification
            if isUniqueViolation(err) {
                return ErrOptimisticConcurrency
            }
            return fmt.Errorf("insert event: %w", err)
        }
    }

    return tx.Commit(ctx)
}

func (s *PostgresEventStore) LoadEvents(ctx context.Context, aggregateID string) ([]Event, error) {
    rows, err := s.db.Query(ctx, `
        SELECT event_type, payload
        FROM events
        WHERE aggregate_id = $1
        ORDER BY version ASC
    `, aggregateID)
    if err != nil {
        return nil, fmt.Errorf("query events: %w", err)
    }
    defer rows.Close()

    var events []Event
    for rows.Next() {
        var eventType string
        var payload []byte
        if err := rows.Scan(&eventType, &payload); err != nil {
            return nil, err
        }
        event, err := deserializeEvent(eventType, payload)
        if err != nil {
            return nil, fmt.Errorf("deserialize %q: %w", eventType, err)
        }
        events = append(events, event)
    }
    return events, rows.Err()
}
```

## Event Replay

### Loading an Aggregate from Its Event History

```go
// OrderRepository loads and saves Order aggregates
type OrderRepository struct {
    store    EventStore
    snapshot SnapshotStore // optional
}

func (r *OrderRepository) Load(ctx context.Context, id string) (*Order, error) {
    order := &Order{}
    fromVersion := int64(0)

    // Load snapshot if available (avoids replaying all events)
    if r.snapshot != nil {
        snap, err := r.snapshot.Load(ctx, id)
        if err != nil && !errors.Is(err, ErrSnapshotNotFound) {
            return nil, fmt.Errorf("load snapshot: %w", err)
        }
        if snap != nil {
            if err := order.RestoreFromSnapshot(snap); err != nil {
                return nil, fmt.Errorf("restore snapshot: %w", err)
            }
            fromVersion = snap.Version
        }
    }

    // Load events since the snapshot (or all events if no snapshot)
    events, err := r.store.LoadEventsFrom(ctx, id, fromVersion)
    if err != nil {
        return nil, fmt.Errorf("load events: %w", err)
    }

    if len(events) == 0 && fromVersion == 0 {
        return nil, fmt.Errorf("order %q: %w", id, ErrAggregateNotFound)
    }

    // Replay events to rebuild current state
    for _, event := range events {
        if err := order.Apply(event); err != nil {
            return nil, fmt.Errorf("apply event %T (version %d): %w",
                event, event.Version(), err)
        }
    }

    return order, nil
}

func (r *OrderRepository) Save(ctx context.Context, order *Order) error {
    events := order.PendingEvents()
    if len(events) == 0 {
        return nil
    }

    if err := r.store.AppendEvents(ctx, order.id, order.version-int64(len(events)), events); err != nil {
        return fmt.Errorf("append events: %w", err)
    }

    order.ClearPendingEvents()

    // Take a snapshot if we've accumulated enough events since the last one
    if r.snapshot != nil && order.version%50 == 0 {
        if err := r.snapshot.Save(ctx, order.Snapshot()); err != nil {
            // Snapshot failure is not fatal — just log it
            log.Printf("WARN: save snapshot for order %q: %v", order.id, err)
        }
    }

    return nil
}
```

## Snapshot Patterns

Snapshots optimize replay performance. Without snapshots, loading an aggregate that has had 10,000 events requires replaying all 10,000 events. With snapshots, you only replay events since the last snapshot.

```go
type Snapshot struct {
    AggregateID   string
    AggregateType string
    Version       int64
    Data          json.RawMessage
    TakenAt       time.Time
}

// Snapshot captures the Order's current state
func (o *Order) Snapshot() *Snapshot {
    data, _ := json.Marshal(struct {
        CustomerID string      `json:"customer_id"`
        Status     OrderStatus `json:"status"`
        Items      []OrderItem `json:"items"`
        TotalPaid  float64     `json:"total_paid"`
    }{
        CustomerID: o.customerID,
        Status:     o.status,
        Items:      o.items,
        TotalPaid:  o.totalPaid,
    })
    return &Snapshot{
        AggregateID:   o.id,
        AggregateType: "order",
        Version:       o.version,
        Data:          data,
        TakenAt:       time.Now().UTC(),
    }
}

// RestoreFromSnapshot rebuilds Order state from a snapshot
func (o *Order) RestoreFromSnapshot(s *Snapshot) error {
    var data struct {
        CustomerID string      `json:"customer_id"`
        Status     OrderStatus `json:"status"`
        Items      []OrderItem `json:"items"`
        TotalPaid  float64     `json:"total_paid"`
    }
    if err := json.Unmarshal(s.Data, &data); err != nil {
        return err
    }
    o.id = s.AggregateID
    o.version = s.Version
    o.customerID = data.CustomerID
    o.status = data.Status
    o.items = data.Items
    o.totalPaid = data.TotalPaid
    return nil
}

// Snapshotting policy: take a snapshot every N events
const snapshotInterval = 50

// PostgreSQL snapshot store
const snapshotSchema = `
CREATE TABLE IF NOT EXISTS snapshots (
    aggregate_id    TEXT        NOT NULL,
    aggregate_type  TEXT        NOT NULL,
    version         BIGINT      NOT NULL,
    data            JSONB       NOT NULL,
    taken_at        TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (aggregate_id, version)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_latest
    ON snapshots(aggregate_id, version DESC);
`
```

## CQRS: Separating Read and Write Models

CQRS separates the write model (aggregates + event store) from the read model (projections optimized for queries). The write model is optimized for correctness; the read model is optimized for read performance.

```
Write Side:
  Command → Handler → Load Aggregate → Execute Command → Append Events

Read Side:
  Events → Projector → Read Model (SQL/Redis/Elasticsearch)
  Query → Handler → Read Model → Response
```

### Command Handlers

```go
// Command types
type PlaceOrderCommand struct {
    CustomerID string
    Items      []OrderItem
    Currency   string
    UserID     string
}

type ReceivePaymentCommand struct {
    OrderID       string
    Amount        float64
    Currency      string
    PaymentMethod string
    TransactionID string
    UserID        string
}

// Command handler with retry on optimistic concurrency conflict
type OrderCommandHandler struct {
    repo *OrderRepository
}

func (h *OrderCommandHandler) HandleReceivePayment(
    ctx context.Context,
    cmd ReceivePaymentCommand,
) error {
    const maxAttempts = 3
    for attempt := 0; attempt < maxAttempts; attempt++ {
        if attempt > 0 {
            // Wait before retrying concurrent modification
            time.Sleep(time.Duration(attempt*attempt) * 10 * time.Millisecond)
        }

        order, err := h.repo.Load(ctx, cmd.OrderID)
        if err != nil {
            return fmt.Errorf("load order: %w", err)
        }

        if err := order.ReceivePayment(
            cmd.Amount, cmd.Currency, cmd.PaymentMethod,
            cmd.TransactionID, cmd.UserID,
        ); err != nil {
            return err // Business rule violation — don't retry
        }

        if err := h.repo.Save(ctx, order); err != nil {
            if errors.Is(err, ErrOptimisticConcurrency) {
                continue // Retry on concurrent modification
            }
            return fmt.Errorf("save order: %w", err)
        }
        return nil
    }
    return fmt.Errorf("max retry attempts exceeded for order %q", cmd.OrderID)
}
```

### Projections

A projection subscribes to events and builds a read-optimized data model:

```go
// OrderSummaryProjection builds a denormalized view for the order list screen
type OrderSummaryProjection struct {
    db *pgxpool.Pool
}

const orderSummarySchema = `
CREATE TABLE IF NOT EXISTS order_summaries (
    order_id        TEXT PRIMARY KEY,
    customer_id     TEXT NOT NULL,
    status          TEXT NOT NULL,
    total_amount    DECIMAL(10,2),
    item_count      INT,
    created_at      TIMESTAMPTZ,
    shipped_at      TIMESTAMPTZ,
    last_updated    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_summaries_customer
    ON order_summaries(customer_id, created_at DESC);
`

func (p *OrderSummaryProjection) Handle(ctx context.Context, event Event) error {
    switch e := event.(type) {
    case *OrderCreated:
        _, err := p.db.Exec(ctx, `
            INSERT INTO order_summaries
                (order_id, customer_id, status, item_count, created_at, last_updated)
            VALUES ($1, $2, 'pending', $3, $4, NOW())
            ON CONFLICT (order_id) DO NOTHING
        `, e.AggID, e.CustomerID, len(e.Items), e.OccurredAtUTC)
        return err

    case *PaymentReceived:
        _, err := p.db.Exec(ctx, `
            UPDATE order_summaries
            SET status = 'paid', total_amount = $2, last_updated = NOW()
            WHERE order_id = $1
        `, e.AggID, e.Amount)
        return err

    case *OrderShipped:
        _, err := p.db.Exec(ctx, `
            UPDATE order_summaries
            SET status = 'shipped', shipped_at = $2, last_updated = NOW()
            WHERE order_id = $1
        `, e.AggID, e.OccurredAtUTC)
        return err

    case *OrderCancelled:
        _, err := p.db.Exec(ctx, `
            UPDATE order_summaries
            SET status = 'cancelled', last_updated = NOW()
            WHERE order_id = $1
        `, e.AggID)
        return err
    }
    return nil // Ignore unknown events
}

// Query handler — reads from the projection
func (p *OrderSummaryProjection) GetOrdersByCustomer(
    ctx context.Context,
    customerID string,
    limit, offset int,
) ([]OrderSummary, error) {
    rows, err := p.db.Query(ctx, `
        SELECT order_id, status, total_amount, item_count, created_at, shipped_at
        FROM order_summaries
        WHERE customer_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
    `, customerID, limit, offset)
    if err != nil {
        return nil, err
    }
    defer rows.Close()
    // ... scan rows
}
```

## Kafka as the Event Log

Using Kafka as the durable event log enables fan-out to multiple projections and cross-service event streaming.

### Publishing Events to Kafka

```go
import "github.com/IBM/sarama"

type KafkaEventPublisher struct {
    producer sarama.SyncProducer
    topic    string
}

func (p *KafkaEventPublisher) Publish(ctx context.Context, events []Event) error {
    msgs := make([]*sarama.ProducerMessage, 0, len(events))
    for _, event := range events {
        payload, err := json.Marshal(event)
        if err != nil {
            return fmt.Errorf("marshal event: %w", err)
        }

        msgs = append(msgs, &sarama.ProducerMessage{
            Topic: p.topic,
            // Use aggregate ID as the partition key
            // ensures all events for one aggregate go to the same partition
            // and are consumed in order
            Key:   sarama.StringEncoder(event.AggregateID()),
            Value: sarama.ByteEncoder(payload),
            Headers: []sarama.RecordHeader{
                {
                    Key:   []byte("event_type"),
                    Value: []byte(event.EventType()),
                },
                {
                    Key:   []byte("aggregate_type"),
                    Value: []byte(event.AggregateType()),
                },
            },
        })
    }

    return p.producer.SendMessages(msgs)
}

// Transactional outbox pattern: publish events atomically with the DB commit
// Store events in an outbox table, then a separate process reads and publishes to Kafka
// This prevents the dual-write problem (event stored but not published, or vice versa)
```

### Consuming Events for Projections

```go
type ProjectionRunner struct {
    consumer    sarama.ConsumerGroup
    projections []Projection
    checkpoints CheckpointStore
}

func (r *ProjectionRunner) Run(ctx context.Context) error {
    handler := &consumerGroupHandler{
        projections: r.projections,
        checkpoints: r.checkpoints,
    }

    for {
        if err := r.consumer.Consume(ctx, []string{"order-events"}, handler); err != nil {
            if errors.Is(err, context.Canceled) {
                return nil
            }
            return err
        }
    }
}

type consumerGroupHandler struct {
    projections []Projection
    checkpoints CheckpointStore
}

func (h *consumerGroupHandler) ConsumeClaim(
    session sarama.ConsumerGroupSession,
    claim sarama.ConsumerGroupClaim,
) error {
    for msg := range claim.Messages() {
        event, err := deserializeEventFromKafka(msg)
        if err != nil {
            // Log and skip unrecognized events — don't crash the projection
            log.Printf("WARN: deserialize event: %v", err)
            session.MarkMessage(msg, "")
            continue
        }

        for _, proj := range h.projections {
            if err := proj.Handle(context.Background(), event); err != nil {
                // Projection errors are usually retriable — don't mark as committed
                return fmt.Errorf("projection %T: %w", proj, err)
            }
        }

        session.MarkMessage(msg, "")
    }
    return nil
}
```

### Rebuilding Projections

One of the key benefits of event sourcing: you can rebuild any projection by replaying events from the beginning:

```go
func (r *ProjectionRunner) Rebuild(ctx context.Context, projection Projection) error {
    // Reset the projection's read model
    if err := projection.Reset(ctx); err != nil {
        return fmt.Errorf("reset projection: %w", err)
    }

    // Consume from the beginning of the topic
    consumer, err := sarama.NewConsumer(r.brokers, r.config)
    if err != nil {
        return err
    }
    defer consumer.Close()

    partitions, err := consumer.Partitions("order-events")
    if err != nil {
        return err
    }

    for _, partition := range partitions {
        pc, err := consumer.ConsumePartition("order-events", partition, sarama.OffsetOldest)
        if err != nil {
            return err
        }
        defer pc.Close()

        highWaterMark := pc.HighWaterMarkOffset()

        for msg := range pc.Messages() {
            event, err := deserializeEventFromKafka(msg)
            if err != nil {
                log.Printf("WARN: skip malformed event offset=%d: %v", msg.Offset, err)
                continue
            }

            if err := projection.Handle(ctx, event); err != nil {
                return fmt.Errorf("handle event offset=%d: %w", msg.Offset, err)
            }

            // Stop at high water mark (don't process new events during rebuild)
            if msg.Offset+1 >= highWaterMark {
                break
            }
        }
    }
    return nil
}
```

## Eventual Consistency in Practice

CQRS systems are eventually consistent: there is always a lag between writing events and the read model being updated.

```go
// For the UI, return the optimistic state from the write side
// while the projection catches up
type OrderService struct {
    commandHandler *OrderCommandHandler
    queryHandler   *OrderQueryHandler
}

func (s *OrderService) PlaceOrder(ctx context.Context, cmd PlaceOrderCommand) (OrderSummary, error) {
    orderID, err := s.commandHandler.HandlePlaceOrder(ctx, cmd)
    if err != nil {
        return OrderSummary{}, err
    }

    // Return an optimistic response immediately
    // The read model will be updated asynchronously
    return OrderSummary{
        OrderID:    orderID,
        CustomerID: cmd.CustomerID,
        Status:     "pending",
        ItemCount:  len(cmd.Items),
        CreatedAt:  time.Now(),
        // Note: reads from the projection may return stale data for a brief period
    }, nil
}

// For operations that require read-your-writes consistency:
func (s *OrderService) GetOrderWithConsistency(
    ctx context.Context,
    orderID string,
    requiredVersion int64,
) (OrderSummary, error) {
    // Poll the read model until it catches up to the required version
    deadline := time.Now().Add(5 * time.Second)
    for time.Now().Before(deadline) {
        summary, err := s.queryHandler.GetOrder(ctx, orderID)
        if err != nil {
            return OrderSummary{}, err
        }
        if summary.Version >= requiredVersion {
            return summary, nil
        }
        time.Sleep(50 * time.Millisecond)
    }
    // Timeout: return the write-side state directly
    return s.queryHandler.GetOrderFromAggregate(ctx, orderID)
}
```

## Testing Event-Sourced Aggregates

The pure `Apply` function makes aggregates trivially testable:

```go
func TestOrderReceivePayment(t *testing.T) {
    tests := []struct {
        name        string
        events      []Event     // Events to apply before the command
        cmd         ReceivePaymentCommand
        wantEvents  []string    // Expected new event types
        wantErr     bool
    }{
        {
            name: "payment accepted for pending order",
            events: []Event{
                &OrderCreated{
                    BaseEvent: BaseEvent{AggID: "o1", Type: "OrderCreated", Ver: 1},
                    CustomerID: "c1",
                    Items: []OrderItem{{SKU: "sku1", Quantity: 1, Price: 99.99}},
                },
            },
            cmd:        ReceivePaymentCommand{OrderID: "o1", Amount: 99.99},
            wantEvents: []string{"PaymentReceived"},
        },
        {
            name: "payment rejected for already-paid order",
            events: []Event{
                &OrderCreated{BaseEvent: BaseEvent{AggID: "o1", Ver: 1}},
                &PaymentReceived{BaseEvent: BaseEvent{AggID: "o1", Ver: 2}},
            },
            cmd:     ReceivePaymentCommand{OrderID: "o1"},
            wantErr: true,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            order := &Order{}
            for _, e := range tt.events {
                order.Apply(e)
            }

            err := order.ReceivePayment(
                tt.cmd.Amount, "USD", "card", "tx123", "user1",
            )
            if (err != nil) != tt.wantErr {
                t.Fatalf("ReceivePayment() error = %v, wantErr %v", err, tt.wantErr)
            }

            if !tt.wantErr {
                pending := order.PendingEvents()
                var eventTypes []string
                for _, e := range pending {
                    eventTypes = append(eventTypes, e.EventType())
                }
                if !reflect.DeepEqual(eventTypes, tt.wantEvents) {
                    t.Errorf("pending events = %v, want %v", eventTypes, tt.wantEvents)
                }
            }
        })
    }
}
```

## Summary

Event sourcing and CQRS in Go work well together because Go's type system makes the event model explicit and the lack of inheritance prevents the aggregate hierarchy from becoming complex. The key implementation decisions are:

1. **Optimistic concurrency**: enforce version checks in `AppendEvents` to prevent concurrent modifications from corrupting aggregate state
2. **Snapshot policy**: snapshot every 50-100 events balances replay speed against storage overhead
3. **Projection rebuild**: make it easy to rebuild projections from scratch — this is your escape hatch when a projection has bugs
4. **Eventual consistency UX**: design the UI to handle the lag between write and read model, or use version-based polling for read-your-writes consistency

The dual-write problem (event stored vs. Kafka published) requires the outbox pattern or transactional event publishing for production reliability.
