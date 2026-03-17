---
title: "Go Event Sourcing: CQRS Pattern Implementation with EventStore and Kafka"
date: 2030-12-28T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Event Sourcing", "CQRS", "EventStore", "Kafka", "DDD", "Microservices"]
categories:
- Go
- Architecture
- Microservices
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing event sourcing and CQRS in Go, covering aggregate design, EventStore and Kafka as event logs, projection rebuilding, snapshot optimization, and saga orchestration for distributed transactions."
more_link: "yes"
url: "/go-event-sourcing-cqrs-eventstore-kafka/"
---

Event sourcing replaces mutable state storage with an immutable log of state-changing events. Instead of storing "the current balance is $100", you store "deposited $50, withdrew $20, deposited $70" - the current state is derived by replaying events. This approach provides a complete audit trail, temporal queries, and the ability to rebuild projections for any point in time. Combined with CQRS (Command Query Responsibility Segregation), event sourcing enables highly scalable systems that separate read and write concerns. This guide implements production-grade event sourcing in Go.

<!--more-->

# Go Event Sourcing: CQRS Pattern Implementation with EventStore and Kafka

## Core Concepts

Before examining the implementation, the key concepts must be clear:

**Event**: An immutable record of something that happened ("OrderPlaced", "PaymentProcessed", "OrderShipped")
**Aggregate**: A cluster of domain objects that can be consistently modified together. It is the unit of transactional consistency in event sourcing.
**Event Store**: The append-only database that stores all events, indexed by aggregate ID and version number
**Projection/Read Model**: A denormalized view derived from replaying events, optimized for queries
**CQRS**: Commands modify state (write model), queries read from projections (read model)
**Saga**: A sequence of local transactions coordinated through events, replacing distributed transactions

## Domain Model Design

### Event Definitions

Events must be immutable value objects. Define them with all necessary information to replay state:

```go
package events

import (
    "time"
)

// EventType identifies the type of event for routing and handling
type EventType string

const (
    OrderPlaced        EventType = "order.placed"
    OrderItemAdded     EventType = "order.item_added"
    OrderItemRemoved   EventType = "order.item_removed"
    OrderConfirmed     EventType = "order.confirmed"
    OrderCancelled     EventType = "order.cancelled"
    PaymentProcessed   EventType = "payment.processed"
    PaymentFailed      EventType = "payment.failed"
    OrderShipped       EventType = "order.shipped"
    OrderDelivered     EventType = "order.delivered"
)

// EventMetadata contains common fields for all events
type EventMetadata struct {
    EventID       string    `json:"event_id"`
    AggregateID   string    `json:"aggregate_id"`
    AggregateType string    `json:"aggregate_type"`
    EventType     EventType `json:"event_type"`
    Version       int       `json:"version"`
    Timestamp     time.Time `json:"timestamp"`
    CorrelationID string    `json:"correlation_id,omitempty"`
    CausationID   string    `json:"causation_id,omitempty"` // ID of the event that caused this
    UserID        string    `json:"user_id,omitempty"`
}

// DomainEvent is the interface all events must implement
type DomainEvent interface {
    GetMetadata() EventMetadata
    EventType() EventType
}

// BaseEvent provides common implementation
type BaseEvent struct {
    Metadata EventMetadata `json:"metadata"`
}

func (e BaseEvent) GetMetadata() EventMetadata {
    return e.Metadata
}

// Order aggregate events

type OrderPlacedEvent struct {
    BaseEvent
    CustomerID  string     `json:"customer_id"`
    Items       []OrderItem `json:"items"`
    TotalAmount int64      `json:"total_amount_cents"`
    Currency    string     `json:"currency"`
}

func (e OrderPlacedEvent) EventType() EventType { return OrderPlaced }

type OrderItem struct {
    ProductID  string `json:"product_id"`
    SKU        string `json:"sku"`
    Quantity   int    `json:"quantity"`
    UnitPrice  int64  `json:"unit_price_cents"`
}

type OrderItemAddedEvent struct {
    BaseEvent
    Item OrderItem `json:"item"`
}

func (e OrderItemAddedEvent) EventType() EventType { return OrderItemAdded }

type OrderConfirmedEvent struct {
    BaseEvent
    ConfirmedAt time.Time `json:"confirmed_at"`
}

func (e OrderConfirmedEvent) EventType() EventType { return OrderConfirmed }

type OrderCancelledEvent struct {
    BaseEvent
    Reason      string    `json:"reason"`
    CancelledAt time.Time `json:"cancelled_at"`
}

func (e OrderCancelledEvent) EventType() EventType { return OrderCancelled }

type PaymentProcessedEvent struct {
    BaseEvent
    PaymentID       string    `json:"payment_id"`
    AmountCents     int64     `json:"amount_cents"`
    PaymentMethod   string    `json:"payment_method"`
    TransactionID   string    `json:"transaction_id"`
    ProcessedAt     time.Time `json:"processed_at"`
}

func (e PaymentProcessedEvent) EventType() EventType { return PaymentProcessed }
```

### Aggregate Implementation

The aggregate enforces business rules and generates events. It never writes to storage directly - it only emits events:

```go
package aggregate

import (
    "errors"
    "fmt"
    "time"

    "myapp/events"
)

// OrderStatus represents the current state of an order
type OrderStatus string

const (
    OrderStatusDraft     OrderStatus = "draft"
    OrderStatusConfirmed OrderStatus = "confirmed"
    OrderStatusPaid      OrderStatus = "paid"
    OrderStatusShipped   OrderStatus = "shipped"
    OrderStatusDelivered OrderStatus = "delivered"
    OrderStatusCancelled OrderStatus = "cancelled"
)

var (
    ErrOrderAlreadyConfirmed = errors.New("order is already confirmed")
    ErrOrderCancelled        = errors.New("order has been cancelled")
    ErrOrderNotConfirmed     = errors.New("order must be confirmed before payment")
    ErrInvalidTransition     = errors.New("invalid state transition")
    ErrEmptyOrder            = errors.New("cannot confirm an order with no items")
)

// Order is the order aggregate
type Order struct {
    // Identity
    ID      string
    Version int

    // State (rebuilt from events)
    Status     OrderStatus
    CustomerID string
    Items      []events.OrderItem
    TotalCents int64
    Currency   string
    PaymentID  string

    // Uncommitted events waiting to be saved
    uncommittedEvents []events.DomainEvent
}

// NewOrder creates an order from a command
func NewOrder(id, customerID string, items []events.OrderItem, currency string) (*Order, error) {
    if len(items) == 0 {
        return nil, errors.New("order must have at least one item")
    }

    totalCents := int64(0)
    for _, item := range items {
        totalCents += item.UnitPrice * int64(item.Quantity)
    }

    order := &Order{}

    event := events.OrderPlacedEvent{
        BaseEvent: events.BaseEvent{
            Metadata: events.EventMetadata{
                EventID:       generateEventID(),
                AggregateID:   id,
                AggregateType: "order",
                EventType:     events.OrderPlaced,
                Version:       1,
                Timestamp:     time.Now().UTC(),
            },
        },
        CustomerID:  customerID,
        Items:       items,
        TotalAmount: totalCents,
        Currency:    currency,
    }

    order.apply(event)
    return order, nil
}

// LoadFrom reconstructs an aggregate from stored events
func LoadFrom(storedEvents []events.DomainEvent) (*Order, error) {
    if len(storedEvents) == 0 {
        return nil, errors.New("cannot load order from empty events")
    }

    order := &Order{}
    for _, event := range storedEvents {
        order.apply(event)
    }
    return order, nil
}

// Confirm confirms the order, validating business rules
func (o *Order) Confirm() error {
    switch o.Status {
    case OrderStatusConfirmed:
        return ErrOrderAlreadyConfirmed
    case OrderStatusCancelled:
        return ErrOrderCancelled
    case OrderStatusDraft:
        // valid
    default:
        return ErrInvalidTransition
    }

    if len(o.Items) == 0 {
        return ErrEmptyOrder
    }

    event := events.OrderConfirmedEvent{
        BaseEvent: events.BaseEvent{
            Metadata: events.EventMetadata{
                EventID:       generateEventID(),
                AggregateID:   o.ID,
                AggregateType: "order",
                EventType:     events.OrderConfirmed,
                Version:       o.Version + 1,
                Timestamp:     time.Now().UTC(),
            },
        },
        ConfirmedAt: time.Now().UTC(),
    }

    o.apply(event)
    return nil
}

// Cancel cancels the order
func (o *Order) Cancel(reason string) error {
    if o.Status == OrderStatusCancelled {
        return ErrOrderCancelled
    }
    if o.Status == OrderStatusShipped || o.Status == OrderStatusDelivered {
        return fmt.Errorf("cannot cancel order in status %s", o.Status)
    }

    event := events.OrderCancelledEvent{
        BaseEvent: events.BaseEvent{
            Metadata: events.EventMetadata{
                EventID:       generateEventID(),
                AggregateID:   o.ID,
                AggregateType: "order",
                EventType:     events.OrderCancelled,
                Version:       o.Version + 1,
                Timestamp:     time.Now().UTC(),
            },
        },
        Reason:      reason,
        CancelledAt: time.Now().UTC(),
    }

    o.apply(event)
    return nil
}

// apply updates the aggregate state based on an event (no validation, pure state mutation)
func (o *Order) apply(event events.DomainEvent) {
    meta := event.GetMetadata()
    o.Version = meta.Version

    switch e := event.(type) {
    case events.OrderPlacedEvent:
        o.ID = meta.AggregateID
        o.Status = OrderStatusDraft
        o.CustomerID = e.CustomerID
        o.Items = e.Items
        o.TotalCents = e.TotalAmount
        o.Currency = e.Currency

    case events.OrderConfirmedEvent:
        o.Status = OrderStatusConfirmed

    case events.OrderCancelledEvent:
        o.Status = OrderStatusCancelled

    case events.PaymentProcessedEvent:
        o.Status = OrderStatusPaid
        o.PaymentID = e.PaymentID
    }

    // Track uncommitted events for persistence
    if o.Version == meta.Version {
        o.uncommittedEvents = append(o.uncommittedEvents, event)
    }
}

// GetUncommittedEvents returns events that haven't been persisted yet
func (o *Order) GetUncommittedEvents() []events.DomainEvent {
    return o.uncommittedEvents
}

// ClearUncommittedEvents clears events after they've been persisted
func (o *Order) ClearUncommittedEvents() {
    o.uncommittedEvents = nil
}
```

## Event Store Implementation

### EventStore Interface

```go
package store

import (
    "context"

    "myapp/events"
)

// EventStore defines the interface for event persistence
type EventStore interface {
    // AppendEvents saves new events for an aggregate with optimistic concurrency
    AppendEvents(ctx context.Context, aggregateID string, aggregateType string, expectedVersion int, newEvents []events.DomainEvent) error

    // LoadEvents retrieves all events for an aggregate
    LoadEvents(ctx context.Context, aggregateID string) ([]events.DomainEvent, error)

    // LoadEventsFrom retrieves events starting from a specific version
    LoadEventsFrom(ctx context.Context, aggregateID string, fromVersion int) ([]events.DomainEvent, error)

    // LoadEventsByType retrieves events of a specific type (for projections)
    LoadEventsByType(ctx context.Context, eventType events.EventType, fromPosition int64) ([]StoredEvent, error)

    // GetCurrentVersion returns the latest version of an aggregate
    GetCurrentVersion(ctx context.Context, aggregateID string) (int, error)
}

// StoredEvent wraps a domain event with global stream position
type StoredEvent struct {
    GlobalPosition int64
    Event          events.DomainEvent
}

// ErrVersionConflict is returned when optimistic concurrency check fails
type ErrVersionConflict struct {
    AggregateID     string
    ExpectedVersion int
    ActualVersion   int
}

func (e ErrVersionConflict) Error() string {
    return fmt.Sprintf("version conflict for aggregate %s: expected %d, got %d",
        e.AggregateID, e.ExpectedVersion, e.ActualVersion)
}
```

### PostgreSQL Event Store

```go
package store

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "myapp/events"
)

// PostgresEventStore stores events in PostgreSQL
type PostgresEventStore struct {
    pool *pgxpool.Pool
}

func NewPostgresEventStore(pool *pgxpool.Pool) *PostgresEventStore {
    return &PostgresEventStore{pool: pool}
}

// Schema definition
const createEventsTableSQL = `
CREATE TABLE IF NOT EXISTS events (
    global_position  BIGSERIAL   PRIMARY KEY,
    aggregate_id     TEXT        NOT NULL,
    aggregate_type   TEXT        NOT NULL,
    event_id         TEXT        NOT NULL UNIQUE,
    event_type       TEXT        NOT NULL,
    version          INTEGER     NOT NULL,
    payload          JSONB       NOT NULL,
    metadata         JSONB       NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT events_aggregate_version_unique UNIQUE (aggregate_id, version)
);

CREATE INDEX IF NOT EXISTS idx_events_aggregate_id ON events(aggregate_id);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
`

func (s *PostgresEventStore) AppendEvents(
    ctx context.Context,
    aggregateID string,
    aggregateType string,
    expectedVersion int,
    newEvents []events.DomainEvent,
) error {
    if len(newEvents) == 0 {
        return nil
    }

    tx, err := s.pool.Begin(ctx)
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }
    defer tx.Rollback(ctx)

    // Optimistic concurrency check
    var currentVersion int
    err = tx.QueryRow(ctx, `
        SELECT COALESCE(MAX(version), 0)
        FROM events
        WHERE aggregate_id = $1
    `, aggregateID).Scan(&currentVersion)

    if err != nil {
        return fmt.Errorf("checking current version: %w", err)
    }

    if currentVersion != expectedVersion {
        return ErrVersionConflict{
            AggregateID:     aggregateID,
            ExpectedVersion: expectedVersion,
            ActualVersion:   currentVersion,
        }
    }

    // Insert all new events
    for _, event := range newEvents {
        meta := event.GetMetadata()

        payload, err := json.Marshal(event)
        if err != nil {
            return fmt.Errorf("marshaling event: %w", err)
        }

        metadataJSON, err := json.Marshal(meta)
        if err != nil {
            return fmt.Errorf("marshaling event metadata: %w", err)
        }

        _, err = tx.Exec(ctx, `
            INSERT INTO events (
                aggregate_id, aggregate_type, event_id, event_type,
                version, payload, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
            aggregateID,
            aggregateType,
            meta.EventID,
            meta.EventType,
            meta.Version,
            payload,
            metadataJSON,
        )

        if err != nil {
            return fmt.Errorf("inserting event: %w", err)
        }
    }

    return tx.Commit(ctx)
}

func (s *PostgresEventStore) LoadEvents(ctx context.Context, aggregateID string) ([]events.DomainEvent, error) {
    return s.LoadEventsFrom(ctx, aggregateID, 0)
}

func (s *PostgresEventStore) LoadEventsFrom(ctx context.Context, aggregateID string, fromVersion int) ([]events.DomainEvent, error) {
    rows, err := s.pool.Query(ctx, `
        SELECT event_type, payload
        FROM events
        WHERE aggregate_id = $1 AND version > $2
        ORDER BY version ASC
    `, aggregateID, fromVersion)

    if err != nil {
        return nil, fmt.Errorf("querying events: %w", err)
    }
    defer rows.Close()

    var domainEvents []events.DomainEvent

    for rows.Next() {
        var eventType events.EventType
        var payload []byte

        if err := rows.Scan(&eventType, &payload); err != nil {
            return nil, fmt.Errorf("scanning event row: %w", err)
        }

        event, err := deserializeEvent(eventType, payload)
        if err != nil {
            return nil, fmt.Errorf("deserializing event %s: %w", eventType, err)
        }

        domainEvents = append(domainEvents, event)
    }

    return domainEvents, rows.Err()
}

// deserializeEvent reconstructs the concrete event type from JSON
func deserializeEvent(eventType events.EventType, payload []byte) (events.DomainEvent, error) {
    switch eventType {
    case events.OrderPlaced:
        var e events.OrderPlacedEvent
        return e, json.Unmarshal(payload, &e)
    case events.OrderConfirmed:
        var e events.OrderConfirmedEvent
        return e, json.Unmarshal(payload, &e)
    case events.OrderCancelled:
        var e events.OrderCancelledEvent
        return e, json.Unmarshal(payload, &e)
    case events.PaymentProcessed:
        var e events.PaymentProcessedEvent
        return e, json.Unmarshal(payload, &e)
    default:
        return nil, fmt.Errorf("unknown event type: %s", eventType)
    }
}
```

## Snapshots for Performance

As aggregates accumulate events, replaying thousands of events to reconstruct state becomes slow. Snapshots capture the aggregate state at a specific version, allowing replay from that point:

```go
package snapshot

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/jackc/pgx/v5/pgxpool"
    "myapp/aggregate"
)

// Snapshot stores the state of an aggregate at a specific version
type Snapshot struct {
    AggregateID   string
    AggregateType string
    Version       int
    State         []byte
    CreatedAt     time.Time
}

type SnapshotStore struct {
    pool *pgxpool.Pool
}

const createSnapshotTableSQL = `
CREATE TABLE IF NOT EXISTS snapshots (
    aggregate_id    TEXT        NOT NULL,
    aggregate_type  TEXT        NOT NULL,
    version         INTEGER     NOT NULL,
    state           JSONB       NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (aggregate_id, aggregate_type)
);
`

func (s *SnapshotStore) SaveSnapshot(ctx context.Context, snap Snapshot) error {
    _, err := s.pool.Exec(ctx, `
        INSERT INTO snapshots (aggregate_id, aggregate_type, version, state)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (aggregate_id, aggregate_type)
        DO UPDATE SET
            version = EXCLUDED.version,
            state = EXCLUDED.state,
            created_at = NOW()
        WHERE EXCLUDED.version > snapshots.version
    `,
        snap.AggregateID,
        snap.AggregateType,
        snap.Version,
        snap.State,
    )
    return err
}

func (s *SnapshotStore) LoadSnapshot(ctx context.Context, aggregateID, aggregateType string) (*Snapshot, error) {
    snap := &Snapshot{}
    err := s.pool.QueryRow(ctx, `
        SELECT aggregate_id, aggregate_type, version, state, created_at
        FROM snapshots
        WHERE aggregate_id = $1 AND aggregate_type = $2
    `, aggregateID, aggregateType).Scan(
        &snap.AggregateID,
        &snap.AggregateType,
        &snap.Version,
        &snap.State,
        &snap.CreatedAt,
    )

    if err != nil {
        if errors.Is(err, pgx.ErrNoRows) {
            return nil, nil // No snapshot exists
        }
        return nil, err
    }

    return snap, nil
}

// SnapshotThreshold is the number of events after which a snapshot is taken
const SnapshotThreshold = 50

// OrderRepository loads and saves orders with snapshot optimization
type OrderRepository struct {
    eventStore    EventStore
    snapshotStore *SnapshotStore
}

func (r *OrderRepository) Load(ctx context.Context, orderID string) (*aggregate.Order, error) {
    // Try to load snapshot first
    snap, err := r.snapshotStore.LoadSnapshot(ctx, orderID, "order")
    if err != nil {
        return nil, fmt.Errorf("loading snapshot: %w", err)
    }

    var order *aggregate.Order
    fromVersion := 0

    if snap != nil {
        // Restore from snapshot
        order, err = aggregate.RestoreFromSnapshot(snap.State)
        if err != nil {
            return nil, fmt.Errorf("restoring from snapshot: %w", err)
        }
        fromVersion = snap.Version
    }

    // Load only events since the snapshot
    storedEvents, err := r.eventStore.LoadEventsFrom(ctx, orderID, fromVersion)
    if err != nil {
        return nil, fmt.Errorf("loading events: %w", err)
    }

    if order == nil && len(storedEvents) == 0 {
        return nil, fmt.Errorf("order %s not found", orderID)
    }

    if order == nil {
        order, err = aggregate.LoadFrom(storedEvents)
    } else {
        err = order.ApplyEvents(storedEvents)
    }

    return order, err
}

func (r *OrderRepository) Save(ctx context.Context, order *aggregate.Order) error {
    uncommitted := order.GetUncommittedEvents()
    if len(uncommitted) == 0 {
        return nil
    }

    expectedVersion := order.Version - len(uncommitted)

    err := r.eventStore.AppendEvents(ctx, order.ID, "order", expectedVersion, uncommitted)
    if err != nil {
        return fmt.Errorf("appending events: %w", err)
    }

    order.ClearUncommittedEvents()

    // Save snapshot if threshold reached
    if order.Version%SnapshotThreshold == 0 {
        snapState, err := json.Marshal(order)
        if err != nil {
            return fmt.Errorf("marshaling snapshot: %w", err)
        }

        if err := r.snapshotStore.SaveSnapshot(ctx, Snapshot{
            AggregateID:   order.ID,
            AggregateType: "order",
            Version:       order.Version,
            State:         snapState,
        }); err != nil {
            // Log but don't fail - snapshot is an optimization
            slog.Warn("failed to save snapshot", "error", err, "order_id", order.ID)
        }
    }

    return nil
}
```

## Projections: Building Read Models

Projections subscribe to events and build optimized read models:

```go
package projection

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "myapp/events"
)

// OrderSummary is a denormalized read model for order listings
type OrderSummary struct {
    OrderID    string
    CustomerID string
    Status     string
    TotalCents int64
    Currency   string
    ItemCount  int
    PlacedAt   time.Time
    UpdatedAt  time.Time
}

// OrderProjection builds the order summary read model
type OrderProjection struct {
    pool     *pgxpool.Pool
    position int64 // Last processed global position
}

const createOrderSummaryTableSQL = `
CREATE TABLE IF NOT EXISTS order_summaries (
    order_id    TEXT        PRIMARY KEY,
    customer_id TEXT        NOT NULL,
    status      TEXT        NOT NULL,
    total_cents BIGINT      NOT NULL,
    currency    TEXT        NOT NULL,
    item_count  INTEGER     NOT NULL DEFAULT 0,
    placed_at   TIMESTAMPTZ NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_summaries_customer ON order_summaries(customer_id);
CREATE INDEX IF NOT EXISTS idx_order_summaries_status ON order_summaries(status);
`

// HandleEvent processes a single event and updates the read model
func (p *OrderProjection) HandleEvent(ctx context.Context, event events.DomainEvent) error {
    meta := event.GetMetadata()

    switch e := event.(type) {
    case events.OrderPlacedEvent:
        _, err := p.pool.Exec(ctx, `
            INSERT INTO order_summaries
                (order_id, customer_id, status, total_cents, currency, item_count, placed_at, updated_at)
            VALUES ($1, $2, 'draft', $3, $4, $5, $6, $6)
            ON CONFLICT (order_id) DO NOTHING
        `,
            meta.AggregateID,
            e.CustomerID,
            e.TotalAmount,
            e.Currency,
            len(e.Items),
            meta.Timestamp,
        )
        return err

    case events.OrderConfirmedEvent:
        _, err := p.pool.Exec(ctx, `
            UPDATE order_summaries
            SET status = 'confirmed', updated_at = $1
            WHERE order_id = $2
        `, meta.Timestamp, meta.AggregateID)
        return err

    case events.OrderCancelledEvent:
        _, err := p.pool.Exec(ctx, `
            UPDATE order_summaries
            SET status = 'cancelled', updated_at = $1
            WHERE order_id = $2
        `, meta.Timestamp, meta.AggregateID)
        return err

    case events.PaymentProcessedEvent:
        _, err := p.pool.Exec(ctx, `
            UPDATE order_summaries
            SET status = 'paid', updated_at = $1
            WHERE order_id = $2
        `, meta.Timestamp, meta.AggregateID)
        return err
    }

    return nil
}

// RebuildProjection replays all events to rebuild the read model from scratch
func (p *OrderProjection) RebuildProjection(ctx context.Context, eventStore EventStore) error {
    // Clear existing data
    _, err := p.pool.Exec(ctx, "TRUNCATE TABLE order_summaries")
    if err != nil {
        return fmt.Errorf("truncating order_summaries: %w", err)
    }

    // Replay all events in order
    position := int64(0)
    batchSize := 1000

    for {
        storedEvents, err := eventStore.LoadEventsByType(ctx, "", position)
        if err != nil {
            return fmt.Errorf("loading events at position %d: %w", position, err)
        }

        if len(storedEvents) == 0 {
            break
        }

        for _, se := range storedEvents {
            if err := p.HandleEvent(ctx, se.Event); err != nil {
                return fmt.Errorf("handling event at position %d: %w", se.GlobalPosition, err)
            }
            position = se.GlobalPosition
        }

        if len(storedEvents) < batchSize {
            break
        }
    }

    return nil
}
```

## Kafka as Event Bus

Publishing events to Kafka enables other microservices to react to domain events:

```go
package kafka

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/segmentio/kafka-go"
    "myapp/events"
)

// EventPublisher publishes domain events to Kafka
type EventPublisher struct {
    writer *kafka.Writer
}

func NewEventPublisher(brokers []string, topic string) *EventPublisher {
    return &EventPublisher{
        writer: &kafka.Writer{
            Addr:                   kafka.TCP(brokers...),
            Topic:                  topic,
            Balancer:               &kafka.Hash{},  // Route by aggregate ID for ordering
            BatchSize:              100,
            BatchTimeout:           5 * time.Millisecond,
            RequiredAcks:           kafka.RequireAll,  // Wait for all replicas
            Async:                  false,
            AllowAutoTopicCreation: false,
        },
    }
}

// PublishEvents sends domain events to Kafka
// The aggregate ID is used as the partition key to ensure ordering per aggregate
func (p *EventPublisher) PublishEvents(ctx context.Context, domainEvents []events.DomainEvent) error {
    messages := make([]kafka.Message, 0, len(domainEvents))

    for _, event := range domainEvents {
        meta := event.GetMetadata()

        // Envelope wraps the event with routing metadata
        envelope := struct {
            EventType     string          `json:"event_type"`
            AggregateType string          `json:"aggregate_type"`
            AggregateID   string          `json:"aggregate_id"`
            Version       int             `json:"version"`
            CorrelationID string          `json:"correlation_id,omitempty"`
            Payload       json.RawMessage `json:"payload"`
        }{
            EventType:     string(meta.EventType),
            AggregateType: meta.AggregateType,
            AggregateID:   meta.AggregateID,
            Version:       meta.Version,
            CorrelationID: meta.CorrelationID,
        }

        payloadJSON, err := json.Marshal(event)
        if err != nil {
            return fmt.Errorf("marshaling event %s: %w", meta.EventID, err)
        }
        envelope.Payload = json.RawMessage(payloadJSON)

        envelopeJSON, err := json.Marshal(envelope)
        if err != nil {
            return fmt.Errorf("marshaling envelope: %w", err)
        }

        messages = append(messages, kafka.Message{
            Key:   []byte(meta.AggregateID), // Partition key ensures ordering per aggregate
            Value: envelopeJSON,
            Headers: []kafka.Header{
                {Key: "event-type", Value: []byte(meta.EventType)},
                {Key: "aggregate-type", Value: []byte(meta.AggregateType)},
                {Key: "event-id", Value: []byte(meta.EventID)},
                {Key: "correlation-id", Value: []byte(meta.CorrelationID)},
            },
        })
    }

    return p.writer.WriteMessages(ctx, messages...)
}
```

## Saga Orchestration

Sagas implement distributed transactions as a sequence of compensating transactions:

```go
package saga

import (
    "context"
    "fmt"
    "time"

    "myapp/events"
)

// SagaState represents the state of a saga instance
type SagaState string

const (
    SagaStarted   SagaState = "started"
    SagaCompleted SagaState = "completed"
    SagaFailed    SagaState = "failed"
    SagaCompensating SagaState = "compensating"
)

// OrderFulfillmentSaga orchestrates the order fulfillment process:
// 1. Confirm order
// 2. Reserve inventory
// 3. Process payment
// 4. Ship order
// If any step fails, compensate all previous steps
type OrderFulfillmentSaga struct {
    SagaID      string
    OrderID     string
    State       SagaState
    CurrentStep int
    StartedAt   time.Time
    UpdatedAt   time.Time

    // Data accumulated during saga execution
    PaymentIntentID string
    InventoryReservationID string
}

// OrderFulfillmentSagaHandler handles events to progress the saga
type OrderFulfillmentSagaHandler struct {
    sagaStore    SagaStore
    orderService OrderService
    inventoryService InventoryService
    paymentService PaymentService
    shippingService ShippingService
    eventPublisher  EventPublisher
}

// HandleOrderConfirmed starts the fulfillment saga when an order is confirmed
func (h *OrderFulfillmentSagaHandler) HandleOrderConfirmed(
    ctx context.Context,
    event events.OrderConfirmedEvent,
) error {
    saga := &OrderFulfillmentSaga{
        SagaID:      generateSagaID(),
        OrderID:     event.GetMetadata().AggregateID,
        State:       SagaStarted,
        CurrentStep: 1,
        StartedAt:   time.Now().UTC(),
        UpdatedAt:   time.Now().UTC(),
    }

    if err := h.sagaStore.Save(ctx, saga); err != nil {
        return fmt.Errorf("saving saga: %w", err)
    }

    // Step 1: Reserve inventory
    reservationID, err := h.inventoryService.ReserveItems(ctx, saga.OrderID)
    if err != nil {
        // Compensate: cancel the order
        h.compensate(ctx, saga, "inventory_reservation_failed")
        return fmt.Errorf("reserving inventory: %w", err)
    }

    saga.InventoryReservationID = reservationID
    saga.CurrentStep = 2
    h.sagaStore.Save(ctx, saga)

    // Step 2: Create payment intent
    paymentIntentID, err := h.paymentService.CreatePaymentIntent(ctx, saga.OrderID)
    if err != nil {
        // Compensate: release inventory, cancel order
        h.compensate(ctx, saga, "payment_intent_failed")
        return fmt.Errorf("creating payment intent: %w", err)
    }

    saga.PaymentIntentID = paymentIntentID
    saga.CurrentStep = 3
    h.sagaStore.Save(ctx, saga)

    // Step 3: Publish event requesting payment confirmation
    // Payment will be confirmed asynchronously by the payment service
    // When PaymentProcessed event arrives, we proceed to shipping

    return nil
}

// HandlePaymentProcessed continues the saga when payment is confirmed
func (h *OrderFulfillmentSagaHandler) HandlePaymentProcessed(
    ctx context.Context,
    event events.PaymentProcessedEvent,
) error {
    saga, err := h.sagaStore.FindByOrderID(ctx, event.GetMetadata().AggregateID)
    if err != nil {
        return fmt.Errorf("finding saga: %w", err)
    }

    if saga == nil || saga.State != SagaStarted {
        return nil // Saga not found or already completed
    }

    // Step 4: Trigger shipment
    if err := h.shippingService.CreateShipment(ctx, saga.OrderID); err != nil {
        // Compensate: refund payment, release inventory, cancel order
        h.compensate(ctx, saga, "shipment_creation_failed")
        return fmt.Errorf("creating shipment: %w", err)
    }

    saga.State = SagaCompleted
    saga.CurrentStep = 4
    saga.UpdatedAt = time.Now().UTC()

    return h.sagaStore.Save(ctx, saga)
}

// compensate executes compensation actions in reverse order
func (h *OrderFulfillmentSagaHandler) compensate(ctx context.Context, saga *OrderFulfillmentSaga, reason string) {
    saga.State = SagaCompensating
    h.sagaStore.Save(ctx, saga)

    // Compensate in reverse order
    switch saga.CurrentStep {
    case 3, 4:
        if saga.PaymentIntentID != "" {
            if err := h.paymentService.CancelPaymentIntent(ctx, saga.PaymentIntentID); err != nil {
                slog.Error("failed to cancel payment intent during compensation",
                    "error", err, "saga_id", saga.SagaID)
            }
        }
        fallthrough
    case 2, 3:
        if saga.InventoryReservationID != "" {
            if err := h.inventoryService.ReleaseReservation(ctx, saga.InventoryReservationID); err != nil {
                slog.Error("failed to release inventory reservation during compensation",
                    "error", err, "saga_id", saga.SagaID)
            }
        }
        fallthrough
    case 1, 2:
        if err := h.orderService.Cancel(ctx, saga.OrderID, reason); err != nil {
            slog.Error("failed to cancel order during compensation",
                "error", err, "saga_id", saga.SagaID)
        }
    }

    saga.State = SagaFailed
    saga.UpdatedAt = time.Now().UTC()
    h.sagaStore.Save(ctx, saga)
}
```

## CQRS Command and Query Handlers

```go
package handler

import (
    "context"
    "fmt"

    "myapp/aggregate"
    "myapp/events"
)

// PlaceOrderCommand initiates order placement
type PlaceOrderCommand struct {
    CustomerID string
    Items      []events.OrderItem
    Currency   string
}

// OrderCommandHandler handles write-side commands
type OrderCommandHandler struct {
    repository OrderRepository
    publisher  EventPublisher
}

func (h *OrderCommandHandler) HandlePlaceOrder(ctx context.Context, cmd PlaceOrderCommand) (string, error) {
    orderID := generateOrderID()

    order, err := aggregate.NewOrder(orderID, cmd.CustomerID, cmd.Items, cmd.Currency)
    if err != nil {
        return "", fmt.Errorf("creating order: %w", err)
    }

    if err := h.repository.Save(ctx, order); err != nil {
        return "", fmt.Errorf("saving order: %w", err)
    }

    // Publish events after successful persistence (transactional outbox pattern)
    if err := h.publisher.PublishEvents(ctx, order.GetUncommittedEvents()); err != nil {
        // Log but don't fail - events can be republished from the store
        slog.Error("failed to publish events", "error", err, "order_id", orderID)
    }

    return orderID, nil
}

// OrderQueryHandler handles read-side queries against projections
type OrderQueryHandler struct {
    pool *pgxpool.Pool
}

func (h *OrderQueryHandler) GetOrdersByCustomer(
    ctx context.Context,
    customerID string,
    limit, offset int,
) ([]*OrderSummary, error) {
    rows, err := h.pool.Query(ctx, `
        SELECT order_id, customer_id, status, total_cents, currency, item_count, placed_at, updated_at
        FROM order_summaries
        WHERE customer_id = $1
        ORDER BY placed_at DESC
        LIMIT $2 OFFSET $3
    `, customerID, limit, offset)

    if err != nil {
        return nil, fmt.Errorf("querying order summaries: %w", err)
    }
    defer rows.Close()

    var summaries []*OrderSummary
    for rows.Next() {
        s := &OrderSummary{}
        if err := rows.Scan(
            &s.OrderID, &s.CustomerID, &s.Status,
            &s.TotalCents, &s.Currency, &s.ItemCount,
            &s.PlacedAt, &s.UpdatedAt,
        ); err != nil {
            return nil, err
        }
        summaries = append(summaries, s)
    }

    return summaries, rows.Err()
}
```

## Summary

Event sourcing with CQRS provides powerful capabilities for complex domain models at the cost of implementation complexity:

- Design events as immutable value objects with complete context - avoid events like "StatusChanged" without the new status value
- Use optimistic concurrency (expectedVersion check) to prevent concurrent modifications without distributed locks
- Implement snapshots when aggregates accumulate more than ~50-100 events to keep load times reasonable
- Projections must be idempotent and handle out-of-order delivery gracefully
- Kafka's partition key routing by aggregate ID ensures ordering guarantees per aggregate while providing horizontal scalability
- Sagas replace distributed transactions with compensating transactions - design compensation steps before implementing the happy path
- The transactional outbox pattern (save events to DB, then publish to Kafka) eliminates the dual-write problem
- Projection rebuilding provides a powerful operational tool: any new read model can be built from the complete event history
