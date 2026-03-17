---
title: "Go Event-Driven Architecture: Outbox Pattern, Saga Pattern, and Event Sourcing with PostgreSQL"
date: 2028-08-15T00:00:00-05:00
draft: false
tags: ["Go", "Event-Driven", "Outbox Pattern", "Saga", "Event Sourcing", "PostgreSQL"]
categories:
- Go
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to event-driven architecture in Go. Covers the Transactional Outbox Pattern, Saga Pattern for distributed transactions, and Event Sourcing with PostgreSQL — with complete code examples."
more_link: "yes"
url: "/go-event-driven-outbox-saga-event-sourcing-guide/"
---

Event-driven architecture solves one of the most fundamental problems in distributed systems: how do you reliably perform a database write and publish an event to a message broker without a distributed transaction? Dual-write problems, lost events, and split-brain scenarios have caused production incidents at every organization that did not think carefully about consistency guarantees. This guide covers three patterns that eliminate these failure modes: the Transactional Outbox, the Saga pattern, and Event Sourcing — all implemented in Go with PostgreSQL.

<!--more-->

# [Go Event-Driven Architecture](#go-event-driven-architecture)

## Section 1: The Dual-Write Problem

Every event-driven system faces the dual-write problem: your service needs to update the database AND publish an event to Kafka/NATS/RabbitMQ. These are two separate systems, and you cannot do them atomically without a distributed transaction.

**What can go wrong:**

1. DB write succeeds, Kafka publish fails → Order created but fulfillment service never notified
2. Kafka publish succeeds, DB write fails → Ghost events for orders that do not exist
3. Service crashes between the DB write and Kafka publish → Silent data loss

```go
// BAD: Classic dual-write race condition
func (s *OrderService) CreateOrder(ctx context.Context, order Order) error {
    // Step 1: Write to database
    if err := s.db.InsertOrder(ctx, order); err != nil {
        return err
    }

    // Step 2: Publish event — CAN FAIL independently
    // If this fails, the order exists but no event is published
    if err := s.kafka.Publish(ctx, "orders.created", OrderCreatedEvent{
        OrderID: order.ID,
        Amount:  order.Amount,
    }); err != nil {
        // What do you do here? Retry? Log and ignore?
        // There is no safe answer without the Outbox Pattern.
        return err
    }

    return nil
}
```

## Section 2: The Transactional Outbox Pattern

The Outbox pattern solves dual-write by storing the event in the same database transaction as the business data. A separate process then reads from the outbox table and publishes to the message broker. If publishing fails, it retries. If the service crashes, the outbox relay picks up where it left off.

### Schema

```sql
-- migrations/001_create_outbox.sql

CREATE TABLE orders (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    total_cents BIGINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE outbox_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type  TEXT NOT NULL,          -- 'order', 'payment', 'shipment'
    aggregate_id    TEXT NOT NULL,
    event_type      TEXT NOT NULL,          -- 'OrderCreated', 'OrderShipped'
    payload         JSONB NOT NULL,
    headers         JSONB NOT NULL DEFAULT '{}',
    topic           TEXT NOT NULL,
    partition_key   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT
);

-- Index for the outbox relay worker
CREATE INDEX idx_outbox_unprocessed ON outbox_events(created_at)
    WHERE processed_at IS NULL;

-- Partition outbox by week to keep it small
-- (processed events are archived/deleted by the relay worker)
```

### Core Outbox Implementation

```go
// internal/outbox/outbox.go
package outbox

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "time"

    "github.com/google/uuid"
)

type Event struct {
    ID             uuid.UUID       `db:"id"`
    AggregateType  string          `db:"aggregate_type"`
    AggregateID    string          `db:"aggregate_id"`
    EventType      string          `db:"event_type"`
    Payload        json.RawMessage `db:"payload"`
    Headers        json.RawMessage `db:"headers"`
    Topic          string          `db:"topic"`
    PartitionKey   *string         `db:"partition_key"`
    CreatedAt      time.Time       `db:"created_at"`
    ProcessedAt    *time.Time      `db:"processed_at"`
    Attempts       int             `db:"attempts"`
    LastError      *string         `db:"last_error"`
}

type Writer struct {
    db *sql.DB
}

func NewWriter(db *sql.DB) *Writer {
    return &Writer{db: db}
}

// WriteEvent writes an outbox event within an existing transaction.
// The tx MUST be the same transaction that writes the business data.
func (w *Writer) WriteEvent(ctx context.Context, tx *sql.Tx, event Event) error {
    if event.ID == uuid.Nil {
        event.ID = uuid.New()
    }
    if event.Headers == nil {
        event.Headers = json.RawMessage("{}")
    }

    _, err := tx.ExecContext(ctx, `
        INSERT INTO outbox_events (
            id, aggregate_type, aggregate_id, event_type,
            payload, headers, topic, partition_key
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
        event.ID,
        event.AggregateType,
        event.AggregateID,
        event.EventType,
        event.Payload,
        event.Headers,
        event.Topic,
        event.PartitionKey,
    )
    return err
}

// BatchWrite writes multiple outbox events in a single statement
func (w *Writer) BatchWrite(ctx context.Context, tx *sql.Tx, events []Event) error {
    if len(events) == 0 {
        return nil
    }

    stmt := `
        INSERT INTO outbox_events (
            id, aggregate_type, aggregate_id, event_type,
            payload, headers, topic, partition_key
        ) VALUES `

    args := make([]interface{}, 0, len(events)*8)
    for i, e := range events {
        if e.ID == uuid.Nil {
            e.ID = uuid.New()
        }
        if e.Headers == nil {
            e.Headers = json.RawMessage("{}")
        }
        if i > 0 {
            stmt += ","
        }
        base := i * 8
        stmt += fmt.Sprintf("($%d,$%d,$%d,$%d,$%d,$%d,$%d,$%d)",
            base+1, base+2, base+3, base+4,
            base+5, base+6, base+7, base+8)
        args = append(args,
            e.ID, e.AggregateType, e.AggregateID, e.EventType,
            e.Payload, e.Headers, e.Topic, e.PartitionKey)
    }

    _, err := tx.ExecContext(ctx, stmt, args...)
    return err
}
```

### Order Service Using Outbox

```go
// internal/service/order_service.go
package service

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/myorg/myapp/internal/outbox"
)

type Order struct {
    ID         uuid.UUID
    UserID     uuid.UUID
    Status     string
    TotalCents int64
    CreatedAt  time.Time
}

type OrderCreatedEvent struct {
    OrderID    string `json:"order_id"`
    UserID     string `json:"user_id"`
    TotalCents int64  `json:"total_cents"`
    CreatedAt  string `json:"created_at"`
}

type OrderService struct {
    db     *sql.DB
    outbox *outbox.Writer
}

func NewOrderService(db *sql.DB, outboxWriter *outbox.Writer) *OrderService {
    return &OrderService{db: db, outbox: outboxWriter}
}

func (s *OrderService) CreateOrder(ctx context.Context, userID uuid.UUID, totalCents int64) (*Order, error) {
    order := &Order{
        ID:         uuid.New(),
        UserID:     userID,
        Status:     "pending",
        TotalCents: totalCents,
        CreatedAt:  time.Now(),
    }

    // Begin transaction
    tx, err := s.db.BeginTx(ctx, &sql.TxOptions{
        Isolation: sql.LevelReadCommitted,
    })
    if err != nil {
        return nil, fmt.Errorf("beginning transaction: %w", err)
    }
    defer tx.Rollback()

    // 1. Write business data
    _, err = tx.ExecContext(ctx, `
        INSERT INTO orders (id, user_id, status, total_cents, created_at)
        VALUES ($1, $2, $3, $4, $5)
    `, order.ID, order.UserID, order.Status, order.TotalCents, order.CreatedAt)
    if err != nil {
        return nil, fmt.Errorf("inserting order: %w", err)
    }

    // 2. Write outbox event IN THE SAME TRANSACTION
    eventPayload, err := json.Marshal(OrderCreatedEvent{
        OrderID:    order.ID.String(),
        UserID:     order.UserID.String(),
        TotalCents: order.TotalCents,
        CreatedAt:  order.CreatedAt.Format(time.RFC3339),
    })
    if err != nil {
        return nil, fmt.Errorf("marshaling event: %w", err)
    }

    partitionKey := order.UserID.String()
    if err := s.outbox.WriteEvent(ctx, tx, outbox.Event{
        AggregateType: "order",
        AggregateID:   order.ID.String(),
        EventType:     "OrderCreated",
        Payload:       eventPayload,
        Topic:         "orders.events",
        PartitionKey:  &partitionKey,
    }); err != nil {
        return nil, fmt.Errorf("writing outbox event: %w", err)
    }

    // 3. Commit — both business data and outbox event atomically
    if err := tx.Commit(); err != nil {
        return nil, fmt.Errorf("committing transaction: %w", err)
    }

    return order, nil
}
```

### Outbox Relay Worker

```go
// internal/outbox/relay.go
package outbox

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "log/slog"
    "time"
)

type Publisher interface {
    Publish(ctx context.Context, topic, key string, headers map[string]string, payload []byte) error
}

type RelayConfig struct {
    BatchSize    int
    PollInterval time.Duration
    MaxAttempts  int
    LockTimeout  time.Duration
}

func DefaultRelayConfig() RelayConfig {
    return RelayConfig{
        BatchSize:    100,
        PollInterval: 100 * time.Millisecond,
        MaxAttempts:  10,
        LockTimeout:  30 * time.Second,
    }
}

type Relay struct {
    db        *sql.DB
    publisher Publisher
    cfg       RelayConfig
    logger    *slog.Logger
}

func NewRelay(db *sql.DB, publisher Publisher, cfg RelayConfig, logger *slog.Logger) *Relay {
    return &Relay{
        db:        db,
        publisher: publisher,
        cfg:       cfg,
        logger:    logger,
    }
}

func (r *Relay) Run(ctx context.Context) error {
    ticker := time.NewTicker(r.cfg.PollInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            if err := r.processOutbox(ctx); err != nil {
                r.logger.Error("outbox relay error", "error", err)
            }
        }
    }
}

func (r *Relay) processOutbox(ctx context.Context) error {
    // Use SELECT FOR UPDATE SKIP LOCKED for concurrent relay workers
    // This allows multiple relay instances without conflicts
    tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
    if err != nil {
        return err
    }
    defer tx.Rollback()

    rows, err := tx.QueryContext(ctx, `
        SELECT id, aggregate_type, aggregate_id, event_type,
               payload, headers, topic, partition_key, attempts
        FROM outbox_events
        WHERE processed_at IS NULL
          AND attempts < $1
        ORDER BY created_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
    `, r.cfg.MaxAttempts, r.cfg.BatchSize)
    if err != nil {
        return fmt.Errorf("querying outbox: %w", err)
    }

    var events []Event
    for rows.Next() {
        var e Event
        if err := rows.Scan(
            &e.ID, &e.AggregateType, &e.AggregateID, &e.EventType,
            &e.Payload, &e.Headers, &e.Topic, &e.PartitionKey, &e.Attempts,
        ); err != nil {
            rows.Close()
            return fmt.Errorf("scanning row: %w", err)
        }
        events = append(events, e)
    }
    rows.Close()

    if len(events) == 0 {
        tx.Rollback()
        return nil
    }

    // Publish events (outside transaction to avoid long locks)
    tx.Rollback()

    for _, event := range events {
        if err := r.publishEvent(ctx, event); err != nil {
            r.logger.Error("failed to publish event",
                "event_id", event.ID,
                "event_type", event.EventType,
                "error", err,
            )
            // Mark as failed but don't stop processing other events
            r.markFailed(ctx, event.ID, err.Error())
        }
    }

    return nil
}

func (r *Relay) publishEvent(ctx context.Context, event Event) error {
    var headers map[string]string
    if err := json.Unmarshal(event.Headers, &headers); err != nil {
        headers = make(map[string]string)
    }
    headers["event-type"] = event.EventType
    headers["aggregate-type"] = event.AggregateType
    headers["aggregate-id"] = event.AggregateID
    headers["event-id"] = event.ID.String()

    var key string
    if event.PartitionKey != nil {
        key = *event.PartitionKey
    } else {
        key = event.AggregateID
    }

    if err := r.publisher.Publish(ctx, event.Topic, key, headers, event.Payload); err != nil {
        return err
    }

    // Mark as processed
    _, err := r.db.ExecContext(ctx, `
        UPDATE outbox_events
        SET processed_at = NOW(), last_error = NULL
        WHERE id = $1
    `, event.ID)
    return err
}

func (r *Relay) markFailed(ctx context.Context, id interface{}, errMsg string) {
    _, err := r.db.ExecContext(ctx, `
        UPDATE outbox_events
        SET attempts = attempts + 1, last_error = $2
        WHERE id = $1
    `, id, errMsg)
    if err != nil {
        r.logger.Error("failed to mark event as failed", "id", id, "error", err)
    }
}
```

## Section 3: The Saga Pattern for Distributed Transactions

Sagas replace distributed transactions with a sequence of local transactions coordinated by events. Each step has a compensating transaction for rollback.

### Order Fulfillment Saga

```
Create Order (Local TX) →
    Reserve Inventory (Local TX) →
        Charge Payment (Local TX) →
            Create Shipment (Local TX)

On failure at any step:
    Create Shipment fails → [Cancel Shipment (no-op)]
    Charge Payment fails  → [Release Inventory] ← compensating
    Reserve Inventory fails → [Cancel Order] ← compensating
```

### Saga State Machine

```go
// internal/saga/order_saga.go
package saga

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "time"

    "github.com/google/uuid"
)

type SagaStatus string

const (
    SagaStatusRunning    SagaStatus = "running"
    SagaStatusCompleted  SagaStatus = "completed"
    SagaStatusFailed     SagaStatus = "failed"
    SagaStatusCompensating SagaStatus = "compensating"
    SagaStatusCompensated  SagaStatus = "compensated"
)

type SagaStep string

const (
    StepCreateOrder       SagaStep = "create_order"
    StepReserveInventory  SagaStep = "reserve_inventory"
    StepChargePayment     SagaStep = "charge_payment"
    StepCreateShipment    SagaStep = "create_shipment"
)

type OrderSagaData struct {
    OrderID     string  `json:"order_id"`
    UserID      string  `json:"user_id"`
    TotalCents  int64   `json:"total_cents"`
    Items       []Item  `json:"items"`
    ReservationID *string `json:"reservation_id,omitempty"`
    PaymentID    *string `json:"payment_id,omitempty"`
    ShipmentID   *string `json:"shipment_id,omitempty"`
}

type Item struct {
    ProductID string `json:"product_id"`
    Quantity  int    `json:"quantity"`
    PriceCents int64 `json:"price_cents"`
}

type Saga struct {
    ID          uuid.UUID
    Type        string
    Status      SagaStatus
    CurrentStep SagaStep
    Data        json.RawMessage
    CreatedAt   time.Time
    UpdatedAt   time.Time
    CompletedAt *time.Time
}

type SagaRepository struct {
    db *sql.DB
}

func NewSagaRepository(db *sql.DB) *SagaRepository {
    return &SagaRepository{db: db}
}

func (r *SagaRepository) Create(ctx context.Context, tx *sql.Tx, sagaType string, data interface{}) (*Saga, error) {
    payload, err := json.Marshal(data)
    if err != nil {
        return nil, err
    }

    saga := &Saga{
        ID:          uuid.New(),
        Type:        sagaType,
        Status:      SagaStatusRunning,
        CurrentStep: StepCreateOrder,
        Data:        payload,
        CreatedAt:   time.Now(),
        UpdatedAt:   time.Now(),
    }

    var execErr error
    if tx != nil {
        _, execErr = tx.ExecContext(ctx, `
            INSERT INTO sagas (id, type, status, current_step, data, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, saga.ID, saga.Type, saga.Status, saga.CurrentStep, saga.Data, saga.CreatedAt, saga.UpdatedAt)
    } else {
        _, execErr = r.db.ExecContext(ctx, `
            INSERT INTO sagas (id, type, status, current_step, data, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, saga.ID, saga.Type, saga.Status, saga.CurrentStep, saga.Data, saga.CreatedAt, saga.UpdatedAt)
    }
    if execErr != nil {
        return nil, execErr
    }

    return saga, nil
}

func (r *SagaRepository) Advance(ctx context.Context, sagaID uuid.UUID, nextStep SagaStep, updatedData interface{}) error {
    payload, err := json.Marshal(updatedData)
    if err != nil {
        return err
    }

    _, err = r.db.ExecContext(ctx, `
        UPDATE sagas
        SET current_step = $2, data = $3, updated_at = NOW()
        WHERE id = $1 AND status = 'running'
    `, sagaID, nextStep, payload)
    return err
}

func (r *SagaRepository) Complete(ctx context.Context, sagaID uuid.UUID) error {
    _, err := r.db.ExecContext(ctx, `
        UPDATE sagas
        SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE id = $1
    `, sagaID)
    return err
}

func (r *SagaRepository) StartCompensation(ctx context.Context, sagaID uuid.UUID, reason string) error {
    _, err := r.db.ExecContext(ctx, `
        UPDATE sagas
        SET status = 'compensating', failure_reason = $2, updated_at = NOW()
        WHERE id = $1
    `, sagaID, reason)
    return err
}
```

### Saga Orchestrator

```go
// internal/saga/orchestrator.go
package saga

import (
    "context"
    "fmt"
    "log/slog"
)

type InventoryService interface {
    ReserveInventory(ctx context.Context, items []Item) (reservationID string, err error)
    ReleaseReservation(ctx context.Context, reservationID string) error
}

type PaymentService interface {
    ChargeUser(ctx context.Context, userID string, amountCents int64) (paymentID string, err error)
    RefundPayment(ctx context.Context, paymentID string) error
}

type ShipmentService interface {
    CreateShipment(ctx context.Context, orderID string, items []Item) (shipmentID string, err error)
    CancelShipment(ctx context.Context, shipmentID string) error
}

type OrderSagaOrchestrator struct {
    repo      *SagaRepository
    inventory InventoryService
    payment   PaymentService
    shipment  ShipmentService
    logger    *slog.Logger
}

func NewOrderSagaOrchestrator(
    repo *SagaRepository,
    inventory InventoryService,
    payment PaymentService,
    shipment ShipmentService,
    logger *slog.Logger,
) *OrderSagaOrchestrator {
    return &OrderSagaOrchestrator{
        repo:      repo,
        inventory: inventory,
        payment:   payment,
        shipment:  shipment,
        logger:    logger,
    }
}

func (o *OrderSagaOrchestrator) Execute(ctx context.Context, sagaID string, data *OrderSagaData) error {
    id, err := parseUUID(sagaID)
    if err != nil {
        return err
    }

    // Step 1: Reserve Inventory
    o.logger.Info("saga: reserving inventory", "saga_id", sagaID)
    reservationID, err := o.inventory.ReserveInventory(ctx, data.Items)
    if err != nil {
        o.logger.Error("saga: inventory reservation failed", "error", err)
        if compErr := o.compensate(ctx, id, data, StepCreateOrder); compErr != nil {
            o.logger.Error("saga: compensation failed", "error", compErr)
        }
        return fmt.Errorf("reserving inventory: %w", err)
    }
    data.ReservationID = &reservationID

    if err := o.repo.Advance(ctx, id, StepReserveInventory, data); err != nil {
        return fmt.Errorf("advancing saga: %w", err)
    }

    // Step 2: Charge Payment
    o.logger.Info("saga: charging payment", "saga_id", sagaID)
    paymentID, err := o.payment.ChargeUser(ctx, data.UserID, data.TotalCents)
    if err != nil {
        o.logger.Error("saga: payment failed", "error", err)
        if compErr := o.compensate(ctx, id, data, StepReserveInventory); compErr != nil {
            o.logger.Error("saga: compensation failed", "error", compErr)
        }
        return fmt.Errorf("charging payment: %w", err)
    }
    data.PaymentID = &paymentID

    if err := o.repo.Advance(ctx, id, StepChargePayment, data); err != nil {
        return fmt.Errorf("advancing saga: %w", err)
    }

    // Step 3: Create Shipment
    o.logger.Info("saga: creating shipment", "saga_id", sagaID)
    shipmentID, err := o.shipment.CreateShipment(ctx, data.OrderID, data.Items)
    if err != nil {
        o.logger.Error("saga: shipment creation failed", "error", err)
        if compErr := o.compensate(ctx, id, data, StepChargePayment); compErr != nil {
            o.logger.Error("saga: compensation failed", "error", compErr)
        }
        return fmt.Errorf("creating shipment: %w", err)
    }
    data.ShipmentID = &shipmentID

    if err := o.repo.Complete(ctx, id); err != nil {
        return fmt.Errorf("completing saga: %w", err)
    }

    o.logger.Info("saga: completed successfully",
        "saga_id", sagaID,
        "order_id", data.OrderID,
        "shipment_id", shipmentID,
    )
    return nil
}

// compensate runs compensating transactions from the failed step backward
func (o *OrderSagaOrchestrator) compensate(ctx context.Context, sagaID interface{}, data *OrderSagaData, failedAt SagaStep) error {
    o.logger.Info("saga: starting compensation", "failed_at", failedAt)

    switch failedAt {
    case StepChargePayment:
        // Refund payment if it was charged
        if data.PaymentID != nil {
            if err := o.payment.RefundPayment(ctx, *data.PaymentID); err != nil {
                return fmt.Errorf("refunding payment: %w", err)
            }
        }
        fallthrough
    case StepReserveInventory:
        // Release inventory reservation
        if data.ReservationID != nil {
            if err := o.inventory.ReleaseReservation(ctx, *data.ReservationID); err != nil {
                return fmt.Errorf("releasing reservation: %w", err)
            }
        }
        fallthrough
    case StepCreateOrder:
        // Cancel order (mark as failed in DB)
        o.logger.Info("saga: order cancelled", "order_id", data.OrderID)
    }

    return nil
}

func parseUUID(s string) (interface{}, error) {
    return s, nil // Simplified for example
}
```

## Section 4: Event Sourcing with PostgreSQL

Event Sourcing stores every state change as an immutable event instead of the current state. The current state is derived by replaying all events for an entity.

### Schema

```sql
-- Event store schema
CREATE TABLE event_store (
    id              BIGSERIAL PRIMARY KEY,
    stream_id       TEXT NOT NULL,          -- 'order-uuid', 'account-uuid'
    stream_type     TEXT NOT NULL,          -- 'Order', 'Account'
    event_type      TEXT NOT NULL,          -- 'OrderCreated', 'OrderShipped'
    event_version   INTEGER NOT NULL,       -- monotonic version per stream
    payload         JSONB NOT NULL,
    metadata        JSONB NOT NULL DEFAULT '{}',
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optimistic concurrency: only one event per version per stream
CREATE UNIQUE INDEX idx_event_store_stream_version
    ON event_store(stream_id, event_version);

CREATE INDEX idx_event_store_stream_id ON event_store(stream_id);
CREATE INDEX idx_event_store_stream_type ON event_store(stream_type);

-- Snapshot table for performance (optional)
CREATE TABLE event_store_snapshots (
    stream_id       TEXT NOT NULL,
    stream_type     TEXT NOT NULL,
    version         INTEGER NOT NULL,
    state           JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (stream_id, version)
);
```

### Event Store Implementation

```go
// internal/eventstore/store.go
package eventstore

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "time"
)

type Event struct {
    ID            int64
    StreamID      string
    StreamType    string
    EventType     string
    EventVersion  int
    Payload       json.RawMessage
    Metadata      json.RawMessage
    OccurredAt    time.Time
    RecordedAt    time.Time
}

type AppendRequest struct {
    StreamID        string
    StreamType      string
    EventType       string
    Payload         interface{}
    Metadata        interface{}
    ExpectedVersion int  // for optimistic concurrency (-1 = new stream)
}

type Store struct {
    db *sql.DB
}

func NewStore(db *sql.DB) *Store {
    return &Store{db: db}
}

func (s *Store) Append(ctx context.Context, req AppendRequest) (*Event, error) {
    payload, err := json.Marshal(req.Payload)
    if err != nil {
        return nil, fmt.Errorf("marshaling payload: %w", err)
    }

    metadata := json.RawMessage("{}")
    if req.Metadata != nil {
        metadata, err = json.Marshal(req.Metadata)
        if err != nil {
            return nil, fmt.Errorf("marshaling metadata: %w", err)
        }
    }

    tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
    if err != nil {
        return nil, err
    }
    defer tx.Rollback()

    // Get current version for optimistic concurrency check
    var currentVersion int
    err = tx.QueryRowContext(ctx, `
        SELECT COALESCE(MAX(event_version), -1)
        FROM event_store
        WHERE stream_id = $1
    `, req.StreamID).Scan(&currentVersion)
    if err != nil {
        return nil, fmt.Errorf("getting current version: %w", err)
    }

    if req.ExpectedVersion != -1 && currentVersion != req.ExpectedVersion {
        return nil, fmt.Errorf("optimistic concurrency conflict: expected version %d but got %d",
            req.ExpectedVersion, currentVersion)
    }

    nextVersion := currentVersion + 1

    var event Event
    err = tx.QueryRowContext(ctx, `
        INSERT INTO event_store (
            stream_id, stream_type, event_type, event_version,
            payload, metadata, occurred_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING id, stream_id, stream_type, event_type, event_version,
                  payload, metadata, occurred_at, recorded_at
    `,
        req.StreamID, req.StreamType, req.EventType, nextVersion,
        payload, metadata,
    ).Scan(
        &event.ID, &event.StreamID, &event.StreamType, &event.EventType,
        &event.EventVersion, &event.Payload, &event.Metadata,
        &event.OccurredAt, &event.RecordedAt,
    )
    if err != nil {
        return nil, fmt.Errorf("inserting event: %w", err)
    }

    return &event, tx.Commit()
}

func (s *Store) Load(ctx context.Context, streamID string, fromVersion int) ([]Event, error) {
    rows, err := s.db.QueryContext(ctx, `
        SELECT id, stream_id, stream_type, event_type, event_version,
               payload, metadata, occurred_at, recorded_at
        FROM event_store
        WHERE stream_id = $1 AND event_version >= $2
        ORDER BY event_version ASC
    `, streamID, fromVersion)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var events []Event
    for rows.Next() {
        var e Event
        if err := rows.Scan(
            &e.ID, &e.StreamID, &e.StreamType, &e.EventType, &e.EventVersion,
            &e.Payload, &e.Metadata, &e.OccurredAt, &e.RecordedAt,
        ); err != nil {
            return nil, err
        }
        events = append(events, e)
    }
    return events, rows.Err()
}
```

### Order Aggregate with Event Sourcing

```go
// internal/domain/order.go
package domain

import (
    "encoding/json"
    "fmt"
    "time"

    "github.com/google/uuid"
)

// Events
type OrderCreatedEvent struct {
    OrderID    string    `json:"order_id"`
    UserID     string    `json:"user_id"`
    TotalCents int64     `json:"total_cents"`
    CreatedAt  time.Time `json:"created_at"`
}

type OrderItemAddedEvent struct {
    ProductID  string `json:"product_id"`
    Quantity   int    `json:"quantity"`
    PriceCents int64  `json:"price_cents"`
}

type OrderShippedEvent struct {
    ShipmentID string    `json:"shipment_id"`
    ShippedAt  time.Time `json:"shipped_at"`
}

type OrderCancelledEvent struct {
    Reason      string    `json:"reason"`
    CancelledAt time.Time `json:"cancelled_at"`
}

// Aggregate
type OrderStatus string

const (
    OrderStatusPending   OrderStatus = "pending"
    OrderStatusConfirmed OrderStatus = "confirmed"
    OrderStatusShipped   OrderStatus = "shipped"
    OrderStatusCancelled OrderStatus = "cancelled"
)

type OrderItem struct {
    ProductID  string
    Quantity   int
    PriceCents int64
}

type Order struct {
    ID          uuid.UUID
    UserID      uuid.UUID
    Status      OrderStatus
    TotalCents  int64
    Items       []OrderItem
    ShipmentID  string
    CreatedAt   time.Time
    Version     int
    uncommitted []pendingEvent
}

type pendingEvent struct {
    eventType string
    payload   interface{}
}

func NewOrder(userID uuid.UUID) *Order {
    o := &Order{}
    o.apply("OrderCreated", OrderCreatedEvent{
        OrderID:   uuid.New().String(),
        UserID:    userID.String(),
        CreatedAt: time.Now(),
    }, true)
    return o
}

func (o *Order) AddItem(productID string, quantity int, priceCents int64) error {
    if o.Status != OrderStatusPending {
        return fmt.Errorf("cannot add items to order in status %s", o.Status)
    }

    o.apply("OrderItemAdded", OrderItemAddedEvent{
        ProductID:  productID,
        Quantity:   quantity,
        PriceCents: priceCents,
    }, true)
    return nil
}

func (o *Order) Ship(shipmentID string) error {
    if o.Status != OrderStatusConfirmed {
        return fmt.Errorf("cannot ship order in status %s", o.Status)
    }

    o.apply("OrderShipped", OrderShippedEvent{
        ShipmentID: shipmentID,
        ShippedAt:  time.Now(),
    }, true)
    return nil
}

func (o *Order) Cancel(reason string) error {
    if o.Status == OrderStatusShipped || o.Status == OrderStatusCancelled {
        return fmt.Errorf("cannot cancel order in status %s", o.Status)
    }

    o.apply("OrderCancelled", OrderCancelledEvent{
        Reason:      reason,
        CancelledAt: time.Now(),
    }, true)
    return nil
}

// apply updates aggregate state and optionally records uncommitted event
func (o *Order) apply(eventType string, event interface{}, isNew bool) {
    switch e := event.(type) {
    case OrderCreatedEvent:
        o.ID, _ = uuid.Parse(e.OrderID)
        o.UserID, _ = uuid.Parse(e.UserID)
        o.Status = OrderStatusPending
        o.CreatedAt = e.CreatedAt

    case OrderItemAddedEvent:
        o.Items = append(o.Items, OrderItem{
            ProductID:  e.ProductID,
            Quantity:   e.Quantity,
            PriceCents: e.PriceCents,
        })
        o.TotalCents += int64(e.Quantity) * e.PriceCents

    case OrderShippedEvent:
        o.Status = OrderStatusShipped
        o.ShipmentID = e.ShipmentID

    case OrderCancelledEvent:
        o.Status = OrderStatusCancelled
    }

    o.Version++

    if isNew {
        o.uncommitted = append(o.uncommitted, pendingEvent{
            eventType: eventType,
            payload:   event,
        })
    }
}

// ReplayFrom rebuilds aggregate state from event history
func (o *Order) ReplayFrom(events []RawEvent) error {
    for _, raw := range events {
        event, err := deserializeEvent(raw.EventType, raw.Payload)
        if err != nil {
            return fmt.Errorf("deserializing event %s: %w", raw.EventType, err)
        }
        o.apply(raw.EventType, event, false)
    }
    return nil
}

func (o *Order) UncommittedEvents() []pendingEvent {
    return o.uncommitted
}

func (o *Order) ClearUncommitted() {
    o.uncommitted = nil
}

type RawEvent struct {
    EventType string
    Payload   json.RawMessage
    Version   int
}

func deserializeEvent(eventType string, payload json.RawMessage) (interface{}, error) {
    switch eventType {
    case "OrderCreated":
        var e OrderCreatedEvent
        return e, json.Unmarshal(payload, &e)
    case "OrderItemAdded":
        var e OrderItemAddedEvent
        return e, json.Unmarshal(payload, &e)
    case "OrderShipped":
        var e OrderShippedEvent
        return e, json.Unmarshal(payload, &e)
    case "OrderCancelled":
        var e OrderCancelledEvent
        return e, json.Unmarshal(payload, &e)
    default:
        return nil, fmt.Errorf("unknown event type: %s", eventType)
    }
}
```

### Repository with Snapshots

```go
// internal/repository/order_repository.go
package repository

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/myorg/myapp/internal/domain"
    "github.com/myorg/myapp/internal/eventstore"
)

const snapshotInterval = 50 // Snapshot every 50 events

type OrderRepository struct {
    store *eventstore.Store
}

func NewOrderRepository(store *eventstore.Store) *OrderRepository {
    return &OrderRepository{store: store}
}

func (r *OrderRepository) Save(ctx context.Context, order *domain.Order) error {
    uncommitted := order.UncommittedEvents()
    if len(uncommitted) == 0 {
        return nil
    }

    for i, pending := range uncommitted {
        expectedVersion := order.Version - len(uncommitted) + i
        if i == 0 && order.Version == len(uncommitted) {
            expectedVersion = -1 // New stream
        }

        _, err := r.store.Append(ctx, eventstore.AppendRequest{
            StreamID:        "order-" + order.ID.String(),
            StreamType:      "Order",
            EventType:       pending.EventType(),
            Payload:         pending.Payload(),
            ExpectedVersion: expectedVersion,
        })
        if err != nil {
            return fmt.Errorf("appending event %s: %w", pending.EventType(), err)
        }
    }

    order.ClearUncommitted()

    // Snapshot if needed
    if order.Version%snapshotInterval == 0 {
        if err := r.saveSnapshot(ctx, order); err != nil {
            // Non-fatal — snapshots are optional
            fmt.Printf("warning: failed to save snapshot: %v\n", err)
        }
    }

    return nil
}

func (r *OrderRepository) Load(ctx context.Context, orderID string) (*domain.Order, error) {
    streamID := "order-" + orderID

    // Try loading from snapshot first
    order, fromVersion, err := r.loadSnapshot(ctx, streamID)
    if err != nil || order == nil {
        order = &domain.Order{}
        fromVersion = 0
    }

    // Load events since snapshot
    rawEvents, err := r.store.Load(ctx, streamID, fromVersion)
    if err != nil {
        return nil, fmt.Errorf("loading events: %w", err)
    }

    if len(rawEvents) == 0 && order.ID.String() == "00000000-0000-0000-0000-000000000000" {
        return nil, fmt.Errorf("order %s not found", orderID)
    }

    // Convert to domain events
    domainEvents := make([]domain.RawEvent, len(rawEvents))
    for i, e := range rawEvents {
        domainEvents[i] = domain.RawEvent{
            EventType: e.EventType,
            Payload:   e.Payload,
            Version:   e.EventVersion,
        }
    }

    if err := order.ReplayFrom(domainEvents); err != nil {
        return nil, fmt.Errorf("replaying events: %w", err)
    }

    return order, nil
}

func (r *OrderRepository) saveSnapshot(ctx context.Context, order *domain.Order) error {
    state, err := json.Marshal(order)
    if err != nil {
        return err
    }

    _, err = r.store.DB().ExecContext(ctx, `
        INSERT INTO event_store_snapshots (stream_id, stream_type, version, state)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (stream_id, version) DO NOTHING
    `, "order-"+order.ID.String(), "Order", order.Version, state)
    return err
}

func (r *OrderRepository) loadSnapshot(ctx context.Context, streamID string) (*domain.Order, int, error) {
    var state json.RawMessage
    var version int

    err := r.store.DB().QueryRowContext(ctx, `
        SELECT state, version FROM event_store_snapshots
        WHERE stream_id = $1
        ORDER BY version DESC
        LIMIT 1
    `, streamID).Scan(&state, &version)
    if err != nil {
        return nil, 0, nil // No snapshot
    }

    var order domain.Order
    if err := json.Unmarshal(state, &order); err != nil {
        return nil, 0, err
    }

    return &order, version + 1, nil
}
```

## Section 5: CQRS — Projections from the Event Stream

Event sourcing naturally leads to CQRS (Command Query Responsibility Segregation). Projections build read-optimized views from the event stream.

```go
// internal/projection/order_projection.go
package projection

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "log/slog"
    "time"

    "github.com/myorg/myapp/internal/eventstore"
)

type OrderProjector struct {
    db     *sql.DB
    store  *eventstore.Store
    logger *slog.Logger
}

func NewOrderProjector(db *sql.DB, store *eventstore.Store, logger *slog.Logger) *OrderProjector {
    return &OrderProjector{db: db, store: store, logger: logger}
}

func (p *OrderProjector) Project(ctx context.Context, event eventstore.Event) error {
    switch event.EventType {
    case "OrderCreated":
        return p.handleOrderCreated(ctx, event)
    case "OrderItemAdded":
        return p.handleOrderItemAdded(ctx, event)
    case "OrderShipped":
        return p.handleOrderShipped(ctx, event)
    case "OrderCancelled":
        return p.handleOrderCancelled(ctx, event)
    default:
        p.logger.Debug("ignoring unknown event type", "type", event.EventType)
        return nil
    }
}

func (p *OrderProjector) handleOrderCreated(ctx context.Context, event eventstore.Event) error {
    var payload struct {
        OrderID   string    `json:"order_id"`
        UserID    string    `json:"user_id"`
        CreatedAt time.Time `json:"created_at"`
    }
    if err := json.Unmarshal(event.Payload, &payload); err != nil {
        return err
    }

    _, err := p.db.ExecContext(ctx, `
        INSERT INTO orders_view (id, user_id, status, total_cents, created_at)
        VALUES ($1, $2, 'pending', 0, $3)
        ON CONFLICT (id) DO NOTHING
    `, payload.OrderID, payload.UserID, payload.CreatedAt)
    return err
}

func (p *OrderProjector) handleOrderItemAdded(ctx context.Context, event eventstore.Event) error {
    var payload struct {
        ProductID  string `json:"product_id"`
        Quantity   int    `json:"quantity"`
        PriceCents int64  `json:"price_cents"`
    }
    if err := json.Unmarshal(event.Payload, &payload); err != nil {
        return err
    }

    // Extract order ID from stream ID (order-<uuid>)
    orderID := event.StreamID[6:]
    lineCost := int64(payload.Quantity) * payload.PriceCents

    _, err := p.db.ExecContext(ctx, `
        UPDATE orders_view
        SET total_cents = total_cents + $2
        WHERE id = $1
    `, orderID, lineCost)
    return err
}

func (p *OrderProjector) handleOrderShipped(ctx context.Context, event eventstore.Event) error {
    var payload struct {
        ShipmentID string    `json:"shipment_id"`
        ShippedAt  time.Time `json:"shipped_at"`
    }
    if err := json.Unmarshal(event.Payload, &payload); err != nil {
        return err
    }

    orderID := event.StreamID[6:]
    _, err := p.db.ExecContext(ctx, `
        UPDATE orders_view
        SET status = 'shipped', shipment_id = $2, shipped_at = $3
        WHERE id = $1
    `, orderID, payload.ShipmentID, payload.ShippedAt)
    return err
}

func (p *OrderProjector) handleOrderCancelled(ctx context.Context, event eventstore.Event) error {
    orderID := event.StreamID[6:]
    _, err := p.db.ExecContext(ctx, `
        UPDATE orders_view
        SET status = 'cancelled'
        WHERE id = $1
    `, orderID)
    return err
}

// Rebuild rebuilds the entire projection from the event store
func (p *OrderProjector) Rebuild(ctx context.Context) error {
    p.logger.Info("rebuilding order projection")

    // Clear existing projection
    if _, err := p.db.ExecContext(ctx, "TRUNCATE TABLE orders_view"); err != nil {
        return fmt.Errorf("truncating view: %w", err)
    }

    // Stream all order events
    rows, err := p.db.QueryContext(ctx, `
        SELECT id, stream_id, stream_type, event_type, event_version,
               payload, metadata, occurred_at, recorded_at
        FROM event_store
        WHERE stream_type = 'Order'
        ORDER BY id ASC
    `)
    if err != nil {
        return err
    }
    defer rows.Close()

    count := 0
    for rows.Next() {
        var event eventstore.Event
        if err := rows.Scan(
            &event.ID, &event.StreamID, &event.StreamType, &event.EventType,
            &event.EventVersion, &event.Payload, &event.Metadata,
            &event.OccurredAt, &event.RecordedAt,
        ); err != nil {
            return err
        }

        if err := p.Project(ctx, event); err != nil {
            return fmt.Errorf("projecting event %d: %w", event.ID, err)
        }
        count++
    }

    p.logger.Info("projection rebuild complete", "events_processed", count)
    return nil
}
```

## Conclusion

Event-driven architecture in Go requires careful thought about consistency boundaries. The Transactional Outbox eliminates the dual-write problem by keeping events in the same database transaction as your business data. The Saga pattern handles multi-service workflows with explicit compensation logic. Event Sourcing gives you a complete audit log, time-travel debugging, and the ability to rebuild projections at any time.

The outbox pattern should be your default for any service that publishes events. Sagas are warranted when you have multi-service workflows with no distributed transaction coordinator. Event sourcing adds significant complexity and is best reserved for domains where audit history, temporal queries, or projection rebuilding are genuine requirements.
