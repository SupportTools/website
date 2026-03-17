---
title: "Go Event-Driven Microservices: Domain Events, Outbox Pattern, Event Deduplication, and Idempotent Consumers"
date: 2032-03-11T00:00:00-05:00
draft: false
tags: ["Go", "Microservices", "Event-Driven", "Outbox Pattern", "Kafka", "Idempotency", "Domain Events"]
categories:
- Go
- Microservices
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to event-driven Go microservices: modeling domain events, implementing the transactional outbox pattern, achieving exactly-once processing with deduplication, and building idempotent consumers for reliable message delivery."
more_link: "yes"
url: "/go-event-driven-microservices-domain-events-outbox-pattern-idempotent-consumers/"
---

Event-driven architectures decouple services and enable independent scaling, but they introduce new failure modes: lost events, duplicate delivery, and ordering violations. Go's strong typing, goroutine model, and database/sql interface make it an excellent language for building the reliability infrastructure that event-driven systems require. This post covers the complete stack from domain event modeling through transactional outbox publication to idempotent consumer implementation.

<!--more-->

# Go Event-Driven Microservices: Domain Events, Outbox Pattern, Event Deduplication, and Idempotent Consumers

## The Core Problem: Dual-Write Failure

The naive approach to publishing events creates a dual-write problem:

```go
// DANGEROUS: dual-write without atomicity
func (s *OrderService) PlaceOrder(ctx context.Context, order Order) error {
    // Step 1: save to database
    if err := s.repo.Save(ctx, order); err != nil {
        return err
    }

    // Step 2: publish event
    // If this fails or the process crashes between step 1 and step 2,
    // the order is saved but the event is never published.
    // The payment service never processes it.
    if err := s.publisher.Publish(ctx, OrderPlaced{OrderID: order.ID}); err != nil {
        return err  // Order was saved but not communicated to other services
    }

    return nil
}
```

The failure scenarios:
1. Database save succeeds, publish call crashes: order exists but payment never triggered
2. Publish succeeds, database rollback occurs: payment attempts to process a non-existent order
3. Network partition: publish may or may not have been received

The Transactional Outbox pattern solves this by making the event write part of the same database transaction as the business operation.

## Domain Event Modeling

### Event Type System

```go
// pkg/events/events.go
package events

import (
    "encoding/json"
    "time"

    "github.com/google/uuid"
)

// Event is the base interface for all domain events
type Event interface {
    EventID() string
    EventType() string
    AggregateID() string
    AggregateType() string
    OccurredAt() time.Time
    Version() int
    Payload() ([]byte, error)
}

// BaseEvent provides the common fields for all domain events
type BaseEvent struct {
    ID            string    `json:"event_id"`
    Type          string    `json:"event_type"`
    AggID         string    `json:"aggregate_id"`
    AggType       string    `json:"aggregate_type"`
    OccurredAtUTC time.Time `json:"occurred_at"`
    Ver           int       `json:"version"`
}

func NewBaseEvent(eventType, aggregateID, aggregateType string) BaseEvent {
    return BaseEvent{
        ID:            uuid.NewString(),
        Type:          eventType,
        AggID:         aggregateID,
        AggType:       aggregateType,
        OccurredAtUTC: time.Now().UTC(),
        Ver:           1,
    }
}

func (b BaseEvent) EventID() string       { return b.ID }
func (b BaseEvent) EventType() string     { return b.Type }
func (b BaseEvent) AggregateID() string   { return b.AggID }
func (b BaseEvent) AggregateType() string { return b.AggType }
func (b BaseEvent) OccurredAt() time.Time { return b.OccurredAtUTC }
func (b BaseEvent) Version() int          { return b.Ver }

// Domain events for the Order aggregate
type OrderPlaced struct {
    BaseEvent
    CustomerID  string     `json:"customer_id"`
    Items       []OrderItem `json:"items"`
    TotalAmount Money      `json:"total_amount"`
    ShippingAddr Address   `json:"shipping_address"`
}

func NewOrderPlaced(orderID, customerID string, items []OrderItem, total Money, addr Address) *OrderPlaced {
    return &OrderPlaced{
        BaseEvent:    NewBaseEvent("order.placed", orderID, "Order"),
        CustomerID:   customerID,
        Items:        items,
        TotalAmount:  total,
        ShippingAddr: addr,
    }
}

func (e *OrderPlaced) Payload() ([]byte, error) {
    return json.Marshal(e)
}

type OrderCancelled struct {
    BaseEvent
    Reason     string `json:"reason"`
    CancelledBy string `json:"cancelled_by"`
}

type OrderShipped struct {
    BaseEvent
    TrackingNumber string    `json:"tracking_number"`
    Carrier        string    `json:"carrier"`
    ShippedAt      time.Time `json:"shipped_at"`
}

// Aggregate base with event recording
type Aggregate struct {
    id      string
    version int
    events  []Event
}

func (a *Aggregate) ID() string      { return a.id }
func (a *Aggregate) Version() int    { return a.version }
func (a *Aggregate) Events() []Event { return a.events }
func (a *Aggregate) ClearEvents()    { a.events = nil }

func (a *Aggregate) record(e Event) {
    a.events = append(a.events, e)
}

// Order aggregate
type Order struct {
    Aggregate
    CustomerID  string
    Status      OrderStatus
    Items       []OrderItem
    TotalAmount Money
}

func PlaceOrder(id, customerID string, items []OrderItem, total Money, addr Address) (*Order, error) {
    if len(items) == 0 {
        return nil, fmt.Errorf("order must have at least one item")
    }
    if total.Amount <= 0 {
        return nil, fmt.Errorf("order total must be positive")
    }

    o := &Order{
        Aggregate:   Aggregate{id: id, version: 1},
        CustomerID:  customerID,
        Status:      OrderStatusPending,
        Items:       items,
        TotalAmount: total,
    }
    o.record(NewOrderPlaced(id, customerID, items, total, addr))
    return o, nil
}

func (o *Order) Cancel(reason, cancelledBy string) error {
    if o.Status == OrderStatusShipped {
        return fmt.Errorf("cannot cancel a shipped order")
    }
    o.Status = OrderStatusCancelled
    o.version++
    o.record(&OrderCancelled{
        BaseEvent:   NewBaseEvent("order.cancelled", o.id, "Order"),
        Reason:      reason,
        CancelledBy: cancelledBy,
    })
    return nil
}
```

## Transactional Outbox Pattern

### Database Schema

```sql
-- Outbox table: events pending publication
CREATE TABLE outbox_events (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID        NOT NULL UNIQUE,
    event_type      TEXT        NOT NULL,
    aggregate_id    TEXT        NOT NULL,
    aggregate_type  TEXT        NOT NULL,
    payload         JSONB       NOT NULL,
    headers         JSONB       NOT NULL DEFAULT '{}',
    occurred_at     TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at    TIMESTAMPTZ,
    publish_attempts INT        NOT NULL DEFAULT 0,
    last_error      TEXT,
    status          TEXT        NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'publishing', 'published', 'failed'))
);

CREATE INDEX idx_outbox_status_created ON outbox_events (status, created_at)
    WHERE status = 'pending';

CREATE INDEX idx_outbox_aggregate ON outbox_events (aggregate_type, aggregate_id);

-- Deduplication table for consumers
CREATE TABLE processed_events (
    event_id        UUID        PRIMARY KEY,
    consumer_group  TEXT        NOT NULL,
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    result          JSONB
);

CREATE INDEX idx_processed_events_group ON processed_events (consumer_group, processed_at);
```

### Outbox Repository

```go
// internal/outbox/repository.go
package outbox

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "time"

    "myorg/pkg/events"
)

type OutboxRecord struct {
    ID             string
    EventID        string
    EventType      string
    AggregateID    string
    AggregateType  string
    Payload        json.RawMessage
    Headers        map[string]string
    OccurredAt     time.Time
    CreatedAt      time.Time
    PublishedAt    *time.Time
    PublishAttempts int
    LastError      *string
    Status         string
}

type Repository struct {
    db *sql.DB
}

func NewRepository(db *sql.DB) *Repository {
    return &Repository{db: db}
}

// SaveWithinTx writes events to the outbox within an existing transaction
// This is the key operation: the outbox write and the business operation
// share the same database transaction, ensuring atomicity.
func (r *Repository) SaveWithinTx(ctx context.Context, tx *sql.Tx, evts []events.Event) error {
    for _, evt := range evts {
        payload, err := evt.Payload()
        if err != nil {
            return fmt.Errorf("marshaling event %s: %w", evt.EventID(), err)
        }

        headers := map[string]string{
            "content-type": "application/json",
            "version":      fmt.Sprintf("%d", evt.Version()),
        }
        headersJSON, _ := json.Marshal(headers)

        _, err = tx.ExecContext(ctx, `
            INSERT INTO outbox_events (
                event_id, event_type, aggregate_id, aggregate_type,
                payload, headers, occurred_at, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
            ON CONFLICT (event_id) DO NOTHING`,
            evt.EventID(),
            evt.EventType(),
            evt.AggregateID(),
            evt.AggregateType(),
            payload,
            headersJSON,
            evt.OccurredAt(),
        )
        if err != nil {
            return fmt.Errorf("inserting outbox event %s: %w", evt.EventID(), err)
        }
    }
    return nil
}

// FetchPending returns pending events for publishing (with advisory lock)
func (r *Repository) FetchPending(ctx context.Context, limit int) ([]OutboxRecord, error) {
    // Use SKIP LOCKED to allow multiple publisher instances without conflicts
    rows, err := r.db.QueryContext(ctx, `
        UPDATE outbox_events
        SET status = 'publishing', publish_attempts = publish_attempts + 1
        WHERE id IN (
            SELECT id FROM outbox_events
            WHERE status = 'pending'
               OR (status = 'publishing' AND created_at < NOW() - INTERVAL '2 minutes')
            ORDER BY created_at ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING id, event_id, event_type, aggregate_id, aggregate_type,
                  payload, headers, occurred_at, created_at, publish_attempts`,
        limit,
    )
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var records []OutboxRecord
    for rows.Next() {
        var r OutboxRecord
        var headersJSON []byte
        if err := rows.Scan(
            &r.ID, &r.EventID, &r.EventType, &r.AggregateID, &r.AggregateType,
            &r.Payload, &headersJSON, &r.OccurredAt, &r.CreatedAt, &r.PublishAttempts,
        ); err != nil {
            return nil, err
        }
        json.Unmarshal(headersJSON, &r.Headers)
        records = append(records, r)
    }
    return records, rows.Err()
}

// MarkPublished marks an event as successfully published
func (r *Repository) MarkPublished(ctx context.Context, id string) error {
    _, err := r.db.ExecContext(ctx, `
        UPDATE outbox_events
        SET status = 'published', published_at = NOW()
        WHERE id = $1`, id)
    return err
}

// MarkFailed marks a publish attempt as failed
func (r *Repository) MarkFailed(ctx context.Context, id, errMsg string, maxAttempts int) error {
    _, err := r.db.ExecContext(ctx, `
        UPDATE outbox_events
        SET status = CASE WHEN publish_attempts >= $3 THEN 'failed' ELSE 'pending' END,
            last_error = $2
        WHERE id = $1`, id, errMsg, maxAttempts)
    return err
}
```

### Outbox Publisher

```go
// internal/outbox/publisher.go
package outbox

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/IBM/sarama"
)

type KafkaPublisher struct {
    repo      *Repository
    producer  sarama.SyncProducer
    logger    *slog.Logger
    topicFunc func(eventType string) string
}

func NewKafkaPublisher(repo *Repository, producer sarama.SyncProducer,
    logger *slog.Logger, topicFunc func(string) string) *KafkaPublisher {
    return &KafkaPublisher{
        repo:      repo,
        producer:  producer,
        logger:    logger,
        topicFunc: topicFunc,
    }
}

// Run polls the outbox and publishes pending events
func (p *KafkaPublisher) Run(ctx context.Context) error {
    ticker := time.NewTicker(500 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            if err := p.publishBatch(ctx); err != nil {
                p.logger.Error("outbox publish batch failed", "error", err)
            }
        }
    }
}

func (p *KafkaPublisher) publishBatch(ctx context.Context) error {
    records, err := p.repo.FetchPending(ctx, 100)
    if err != nil {
        return fmt.Errorf("fetching pending events: %w", err)
    }
    if len(records) == 0 {
        return nil
    }

    for _, record := range records {
        if err := p.publishOne(ctx, record); err != nil {
            p.logger.Error("failed to publish event",
                "event_id", record.EventID,
                "event_type", record.EventType,
                "attempts", record.PublishAttempts,
                "error", err,
            )
            if markErr := p.repo.MarkFailed(ctx, record.ID, err.Error(), 5); markErr != nil {
                p.logger.Error("failed to mark event as failed",
                    "id", record.ID, "error", markErr)
            }
            continue
        }
        if err := p.repo.MarkPublished(ctx, record.ID); err != nil {
            p.logger.Error("failed to mark event as published",
                "id", record.ID, "error", err)
        }
    }
    return nil
}

func (p *KafkaPublisher) publishOne(ctx context.Context, record OutboxRecord) error {
    topic := p.topicFunc(record.EventType)

    headers := make([]sarama.RecordHeader, 0, len(record.Headers)+3)
    headers = append(headers,
        sarama.RecordHeader{Key: []byte("event-id"), Value: []byte(record.EventID)},
        sarama.RecordHeader{Key: []byte("event-type"), Value: []byte(record.EventType)},
        sarama.RecordHeader{Key: []byte("aggregate-id"), Value: []byte(record.AggregateID)},
        sarama.RecordHeader{Key: []byte("occurred-at"), Value: []byte(record.OccurredAt.Format(time.RFC3339Nano))},
    )
    for k, v := range record.Headers {
        headers = append(headers, sarama.RecordHeader{
            Key: []byte(k), Value: []byte(v),
        })
    }

    msg := &sarama.ProducerMessage{
        Topic:   topic,
        Key:     sarama.StringEncoder(record.AggregateID),  // Partition by aggregate
        Value:   sarama.ByteEncoder(record.Payload),
        Headers: headers,
        Metadata: record.EventID,
    }

    _, _, err := p.producer.SendMessage(msg)
    return err
}
```

### Using the Outbox in a Service

```go
// internal/orders/service.go
package orders

import (
    "context"
    "database/sql"
    "fmt"

    "myorg/internal/outbox"
)

type Service struct {
    db          *sql.DB
    repo        *Repository
    outboxRepo  *outbox.Repository
}

func (s *Service) PlaceOrder(ctx context.Context, cmd PlaceOrderCommand) (*Order, error) {
    // Create the aggregate (records events internally)
    order, err := PlaceOrder(
        uuid.NewString(),
        cmd.CustomerID,
        cmd.Items,
        cmd.TotalAmount,
        cmd.ShippingAddress,
    )
    if err != nil {
        return nil, fmt.Errorf("creating order: %w", err)
    }

    // Begin transaction
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return nil, fmt.Errorf("beginning transaction: %w", err)
    }
    defer tx.Rollback()  // No-op if committed

    // Save aggregate state
    if err := s.repo.SaveWithinTx(ctx, tx, order); err != nil {
        return nil, fmt.Errorf("saving order: %w", err)
    }

    // Save events to outbox IN THE SAME TRANSACTION
    if err := s.outboxRepo.SaveWithinTx(ctx, tx, order.Events()); err != nil {
        return nil, fmt.Errorf("saving outbox events: %w", err)
    }

    // Commit: order AND outbox events are saved atomically
    if err := tx.Commit(); err != nil {
        return nil, fmt.Errorf("committing transaction: %w", err)
    }

    // Clear events from the aggregate after successful commit
    order.ClearEvents()
    return order, nil
}
```

## Idempotent Consumers

### The Deduplication Problem

Kafka guarantees at-least-once delivery. Even with idempotent producers and transactions, consumer rebalancing or application crashes can cause the same event to be processed twice. Idempotent consumers detect and skip duplicates:

```go
// internal/consumer/idempotent.go
package consumer

import (
    "context"
    "database/sql"
    "errors"
    "fmt"
    "log/slog"
    "time"

    "github.com/IBM/sarama"
)

// ErrAlreadyProcessed is returned when an event has already been processed
var ErrAlreadyProcessed = errors.New("event already processed")

type DeduplicationStore struct {
    db            *sql.DB
    consumerGroup string
    retentionDays int
}

func NewDeduplicationStore(db *sql.DB, consumerGroup string) *DeduplicationStore {
    return &DeduplicationStore{
        db:            db,
        consumerGroup: consumerGroup,
        retentionDays: 7,
    }
}

// ProcessOnce executes the handler exactly once for a given event ID.
// If the event has already been processed, it returns ErrAlreadyProcessed.
// The handler runs within a database transaction, and the deduplication
// record is written in the same transaction.
func (d *DeduplicationStore) ProcessOnce(
    ctx context.Context,
    eventID string,
    handler func(ctx context.Context, tx *sql.Tx) error,
) error {
    tx, err := d.db.BeginTx(ctx, &sql.TxOptions{
        Isolation: sql.LevelReadCommitted,
    })
    if err != nil {
        return fmt.Errorf("begin transaction: %w", err)
    }
    defer tx.Rollback()

    // Attempt to insert the deduplication record
    // ON CONFLICT means the event was already processed
    result, err := tx.ExecContext(ctx, `
        INSERT INTO processed_events (event_id, consumer_group, processed_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (event_id) DO NOTHING`,
        eventID, d.consumerGroup,
    )
    if err != nil {
        return fmt.Errorf("inserting dedup record: %w", err)
    }

    rowsAffected, _ := result.RowsAffected()
    if rowsAffected == 0 {
        // Duplicate: already processed
        return ErrAlreadyProcessed
    }

    // Run the actual handler within the same transaction
    if err := handler(ctx, tx); err != nil {
        return fmt.Errorf("handler error: %w", err)
    }

    return tx.Commit()
}

// CleanExpiredRecords removes deduplication records older than retention period
func (d *DeduplicationStore) CleanExpiredRecords(ctx context.Context) error {
    _, err := d.db.ExecContext(ctx, `
        DELETE FROM processed_events
        WHERE consumer_group = $1
          AND processed_at < NOW() - ($2 || ' days')::INTERVAL`,
        d.consumerGroup, d.retentionDays,
    )
    return err
}
```

### Consumer Implementation

```go
// internal/consumer/payment_consumer.go
package consumer

import (
    "context"
    "database/sql"
    "encoding/json"
    "errors"
    "fmt"
    "log/slog"

    "github.com/IBM/sarama"
    "myorg/pkg/events"
)

type PaymentConsumer struct {
    dedup      *DeduplicationStore
    paymentSvc *payment.Service
    logger     *slog.Logger
}

func NewPaymentConsumer(db *sql.DB, paymentSvc *payment.Service, logger *slog.Logger) *PaymentConsumer {
    return &PaymentConsumer{
        dedup:      NewDeduplicationStore(db, "payment-service"),
        paymentSvc: paymentSvc,
        logger:     logger,
    }
}

// ConsumeClaim implements sarama.ConsumerGroupHandler
func (c *PaymentConsumer) ConsumeClaim(session sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
    for msg := range claim.Messages() {
        if err := c.handleMessage(session.Context(), msg); err != nil {
            c.logger.Error("failed to handle message",
                "topic", msg.Topic,
                "partition", msg.Partition,
                "offset", msg.Offset,
                "error", err,
            )
            // For certain errors, we may want to retry; for others, dead-letter
            // For now: mark the message as consumed and continue
            // In production, implement a dead-letter queue for unrecoverable errors
        }
        session.MarkMessage(msg, "")
    }
    return nil
}

func (c *PaymentConsumer) handleMessage(ctx context.Context, msg *sarama.ConsumerMessage) error {
    // Extract event ID from headers
    eventID := extractHeader(msg.Headers, "event-id")
    eventType := extractHeader(msg.Headers, "event-type")

    if eventID == "" {
        c.logger.Warn("message missing event-id header, skipping",
            "topic", msg.Topic, "offset", msg.Offset)
        return nil
    }

    logger := c.logger.With(
        "event_id", eventID,
        "event_type", eventType,
        "partition", msg.Partition,
        "offset", msg.Offset,
    )

    err := c.dedup.ProcessOnce(ctx, eventID, func(ctx context.Context, tx *sql.Tx) error {
        switch eventType {
        case "order.placed":
            return c.handleOrderPlaced(ctx, tx, msg.Value)
        case "order.cancelled":
            return c.handleOrderCancelled(ctx, tx, msg.Value)
        default:
            logger.Debug("ignoring unknown event type")
            return nil
        }
    })

    if errors.Is(err, ErrAlreadyProcessed) {
        logger.Debug("duplicate event, skipping")
        return nil
    }
    if err != nil {
        return fmt.Errorf("processing event %s: %w", eventID, err)
    }

    logger.Info("event processed successfully")
    return nil
}

func (c *PaymentConsumer) handleOrderPlaced(ctx context.Context, tx *sql.Tx, payload []byte) error {
    var evt events.OrderPlaced
    if err := json.Unmarshal(payload, &evt); err != nil {
        return fmt.Errorf("unmarshaling OrderPlaced: %w", err)
    }

    // Business logic: initiate payment within the same transaction
    payment := &payment.Payment{
        ID:         uuid.NewString(),
        OrderID:    evt.AggID,
        CustomerID: evt.CustomerID,
        Amount:     evt.TotalAmount,
        Status:     payment.StatusPending,
    }

    return c.paymentSvc.CreateWithinTx(ctx, tx, payment)
}

func (c *PaymentConsumer) handleOrderCancelled(ctx context.Context, tx *sql.Tx, payload []byte) error {
    var evt events.OrderCancelled
    if err := json.Unmarshal(payload, &evt); err != nil {
        return fmt.Errorf("unmarshaling OrderCancelled: %w", err)
    }

    return c.paymentSvc.CancelForOrderWithinTx(ctx, tx, evt.AggID)
}

func extractHeader(headers []*sarama.RecordHeader, key string) string {
    for _, h := range headers {
        if string(h.Key) == key {
            return string(h.Value)
        }
    }
    return ""
}

func (c *PaymentConsumer) Setup(session sarama.ConsumerGroupSession) error   { return nil }
func (c *PaymentConsumer) Cleanup(session sarama.ConsumerGroupSession) error { return nil }
```

## Event Deduplication Strategies

### Strategy 1: Database Deduplication (Transactional)

The approach shown above: write the dedup record in the same transaction as the business operation. Provides strong guarantees but requires a database per consumer service.

```sql
-- Efficient deduplication with partitioning for scale
CREATE TABLE processed_events (
    event_id       UUID        NOT NULL,
    consumer_group TEXT        NOT NULL,
    processed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, consumer_group)
) PARTITION BY RANGE (processed_at);

-- Create monthly partitions
CREATE TABLE processed_events_2032_03
    PARTITION OF processed_events
    FOR VALUES FROM ('2032-03-01') TO ('2032-04-01');

-- Automated partition management
CREATE OR REPLACE FUNCTION create_monthly_partition(year int, month int)
RETURNS void AS $$
DECLARE
    partition_name text;
    start_date date;
    end_date date;
BEGIN
    partition_name := 'processed_events_' || year || '_' || LPAD(month::text, 2, '0');
    start_date := make_date(year, month, 1);
    end_date := start_date + INTERVAL '1 month';

    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF processed_events FOR VALUES FROM (%L) TO (%L)',
        partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;
```

### Strategy 2: Redis-Based Deduplication (High Throughput)

For consumers that cannot perform transactional deduplication (e.g., stateless services):

```go
type RedisDeduplicationStore struct {
    client    *redis.Client
    group     string
    ttl       time.Duration
}

func (r *RedisDeduplicationStore) IsProcessed(ctx context.Context, eventID string) (bool, error) {
    key := fmt.Sprintf("dedup:%s:%s", r.group, eventID)
    set, err := r.client.SetNX(ctx, key, "1", r.ttl).Result()
    if err != nil {
        return false, err
    }
    // SetNX returns true if the key was newly set (not a duplicate)
    // Returns false if the key already existed (duplicate)
    return !set, nil
}
```

Note: Redis-based deduplication does not provide exactly-once semantics because the Redis write and the business operation are not atomic. If the business operation succeeds but the Redis write fails, the event will be reprocessed.

### Strategy 3: Idempotent Business Logic

The most robust strategy: design the business operation itself to be idempotent using `INSERT ... ON CONFLICT DO NOTHING` or UPSERT patterns:

```go
func (r *PaymentRepository) CreatePaymentIdempotent(ctx context.Context, tx *sql.Tx, p *Payment) error {
    // ON CONFLICT DO NOTHING makes this idempotent
    // Duplicate OrderID from reprocessed events simply doesn't create a second payment
    _, err := tx.ExecContext(ctx, `
        INSERT INTO payments (id, order_id, customer_id, amount, currency, status, created_at)
        VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
        ON CONFLICT (order_id) DO NOTHING`,
        p.ID, p.OrderID, p.CustomerID, p.Amount.Value, p.Amount.Currency,
    )
    return err
}
```

## Event Versioning and Schema Evolution

### Versioned Event Envelopes

```go
type EventEnvelope struct {
    SchemaVersion int             `json:"schema_version"`
    EventID       string          `json:"event_id"`
    EventType     string          `json:"event_type"`
    Payload       json.RawMessage `json:"payload"`
    Metadata      EventMetadata   `json:"metadata"`
}

type EventMetadata struct {
    CorrelationID string            `json:"correlation_id"`
    CausationID   string            `json:"causation_id"`  // ID of the command that caused this event
    UserID        string            `json:"user_id,omitempty"`
    Headers       map[string]string `json:"headers,omitempty"`
}

// Upcaster upgrades older event versions to current
type Upcaster interface {
    CanUpcast(eventType string, fromVersion int) bool
    Upcast(eventType string, fromVersion int, payload json.RawMessage) (json.RawMessage, int, error)
}

type OrderPlacedV1ToV2Upcaster struct{}

func (u *OrderPlacedV1ToV2Upcaster) CanUpcast(eventType string, fromVersion int) bool {
    return eventType == "order.placed" && fromVersion == 1
}

func (u *OrderPlacedV1ToV2Upcaster) Upcast(eventType string, fromVersion int, payload json.RawMessage) (json.RawMessage, int, error) {
    // V1 had no shipping_method field; V2 adds it with default "standard"
    var v1 map[string]interface{}
    if err := json.Unmarshal(payload, &v1); err != nil {
        return nil, 0, err
    }
    if _, ok := v1["shipping_method"]; !ok {
        v1["shipping_method"] = "standard"
    }
    upgraded, err := json.Marshal(v1)
    return upgraded, 2, err
}

// Upcaster chain
type UpcasterChain struct {
    upcasters []Upcaster
}

func (c *UpcasterChain) Upcast(envelope EventEnvelope) (EventEnvelope, error) {
    payload := envelope.Payload
    version := envelope.SchemaVersion

    changed := true
    for changed {
        changed = false
        for _, upcaster := range c.upcasters {
            if upcaster.CanUpcast(envelope.EventType, version) {
                var err error
                payload, version, err = upcaster.Upcast(envelope.EventType, version, payload)
                if err != nil {
                    return EventEnvelope{}, err
                }
                changed = true
            }
        }
    }

    return EventEnvelope{
        SchemaVersion: version,
        EventID:       envelope.EventID,
        EventType:     envelope.EventType,
        Payload:       payload,
        Metadata:      envelope.Metadata,
    }, nil
}
```

## Dead Letter Queue Pattern

```go
// Dead letter queue for unrecoverable events
type DeadLetterQueue struct {
    db     *sql.DB
    logger *slog.Logger
}

func (d *DeadLetterQueue) Store(ctx context.Context, msg *sarama.ConsumerMessage, processingErr error) error {
    headers := make(map[string]string)
    for _, h := range msg.Headers {
        headers[string(h.Key)] = string(h.Value)
    }
    headersJSON, _ := json.Marshal(headers)

    _, err := d.db.ExecContext(ctx, `
        INSERT INTO dead_letter_events (
            topic, partition, offset, key, value, headers,
            error_message, failed_at, consumer_group
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)`,
        msg.Topic, msg.Partition, msg.Offset,
        string(msg.Key), msg.Value, headersJSON,
        processingErr.Error(), "payment-service",
    )
    if err != nil {
        d.logger.Error("failed to store dead letter event",
            "topic", msg.Topic,
            "offset", msg.Offset,
            "error", err,
        )
        return err
    }

    d.logger.Warn("event sent to dead letter queue",
        "topic", msg.Topic,
        "partition", msg.Partition,
        "offset", msg.Offset,
        "error", processingErr.Error(),
    )
    return nil
}

// Replay dead letter events (for debugging and recovery)
func (d *DeadLetterQueue) Replay(ctx context.Context, producer sarama.SyncProducer, limit int) error {
    rows, err := d.db.QueryContext(ctx, `
        SELECT id, topic, key, value, headers
        FROM dead_letter_events
        WHERE replayed_at IS NULL
        ORDER BY failed_at ASC
        LIMIT $1`, limit)
    if err != nil {
        return err
    }
    defer rows.Close()

    for rows.Next() {
        var id int64
        var topic string
        var key, value []byte
        var headersJSON []byte

        if err := rows.Scan(&id, &topic, &key, &value, &headersJSON); err != nil {
            return err
        }

        var headers map[string]string
        json.Unmarshal(headersJSON, &headers)

        kafkaHeaders := make([]sarama.RecordHeader, 0, len(headers))
        for k, v := range headers {
            kafkaHeaders = append(kafkaHeaders, sarama.RecordHeader{
                Key: []byte(k), Value: []byte(v),
            })
        }

        _, _, err := producer.SendMessage(&sarama.ProducerMessage{
            Topic:   topic,
            Key:     sarama.ByteEncoder(key),
            Value:   sarama.ByteEncoder(value),
            Headers: kafkaHeaders,
        })
        if err != nil {
            return fmt.Errorf("replaying message %d: %w", id, err)
        }

        d.db.ExecContext(ctx, `UPDATE dead_letter_events SET replayed_at = NOW() WHERE id = $1`, id)
    }
    return rows.Err()
}
```

## Testing Event-Driven Services

```go
// Test the full outbox → kafka → consumer pipeline
func TestOrderPlacedEventFlow(t *testing.T) {
    // Use testcontainers for PostgreSQL and Kafka
    ctx := context.Background()

    pgContainer, _ := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
        ContainerRequest: testcontainers.ContainerRequest{
            Image:        "postgres:16",
            ExposedPorts: []string{"5432/tcp"},
            Env: map[string]string{
                "POSTGRES_DB":       "testdb",
                "POSTGRES_USER":     "test",
                "POSTGRES_PASSWORD": "test",
            },
            WaitingFor: wait.ForListeningPort("5432/tcp"),
        },
        Started: true,
    })
    defer pgContainer.Terminate(ctx)

    pgHost, _ := pgContainer.Host(ctx)
    pgPort, _ := pgContainer.MappedPort(ctx, "5432")

    db, _ := sql.Open("postgres", fmt.Sprintf(
        "host=%s port=%s user=test password=test dbname=testdb sslmode=disable",
        pgHost, pgPort.Port(),
    ))

    // Run migrations
    migrate(db)

    // Create service
    outboxRepo := outbox.NewRepository(db)
    orderRepo := orders.NewRepository(db)
    svc := orders.NewService(db, orderRepo, outboxRepo)

    // Place an order
    order, err := svc.PlaceOrder(ctx, orders.PlaceOrderCommand{
        CustomerID:  "cust-123",
        Items:       []orders.OrderItem{{SKU: "SKU-1", Qty: 2, Price: 9.99}},
        TotalAmount: orders.Money{Amount: 19.98, Currency: "USD"},
    })
    require.NoError(t, err)
    require.NotEmpty(t, order.ID)

    // Verify outbox has the event
    records, err := outboxRepo.FetchPending(ctx, 10)
    require.NoError(t, err)
    require.Len(t, records, 1)
    assert.Equal(t, "order.placed", records[0].EventType)
    assert.Equal(t, order.ID, records[0].AggregateID)

    // Simulate duplicate processing
    dedup := consumer.NewDeduplicationStore(db, "test-consumer")

    processedCount := 0
    for i := 0; i < 3; i++ {
        err := dedup.ProcessOnce(ctx, records[0].EventID, func(ctx context.Context, tx *sql.Tx) error {
            processedCount++
            return nil
        })
        if errors.Is(err, consumer.ErrAlreadyProcessed) {
            continue
        }
        require.NoError(t, err)
    }

    // Should have processed exactly once despite 3 attempts
    assert.Equal(t, 1, processedCount, "event should be processed exactly once")
}
```

## Summary

Building reliable event-driven Go microservices requires solving three independent problems that interact:

- The transactional outbox solves the dual-write problem by making event publication part of the same database transaction as the business operation; no event is lost and no event is published for a rolled-back operation
- The outbox poller provides at-least-once delivery guarantees; use `SKIP LOCKED` to allow horizontal scaling of publishers without message duplication at the database level
- Idempotent consumers solve the at-least-once delivery problem by detecting and skipping duplicate events; the strongest approach writes the deduplication record in the same transaction as the business effect
- Schema evolution via upcasters allows consumers to handle old event versions without breaking changes; always version your event payloads
- Dead letter queues prevent processing loops for unrecoverable errors; implement replay tooling for manual investigation and recovery
