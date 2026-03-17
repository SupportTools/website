---
title: "Database-per-Service Pattern: Implementation Guide for Microservices on Kubernetes"
date: 2027-11-22T00:00:00-05:00
draft: false
tags: ["Microservices", "Database", "Kubernetes", "Saga Pattern", "Event Sourcing"]
categories:
- Architecture
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive implementation guide for database-per-service pattern in Kubernetes microservices, covering database isolation strategies, saga pattern, outbox pattern, event sourcing with Kafka, CQRS, cross-service queries, and schema migrations."
more_link: "yes"
url: "/database-per-service-pattern-kubernetes/"
---

The database-per-service pattern is the foundation of true microservice independence. When services share a database, a schema change that breaks one service breaks all services, a slow query from one service degrades all services, and scaling one service forces you to scale the shared database. Database-per-service eliminates these coupling problems but introduces distributed consistency challenges that require careful architectural solutions.

This guide covers practical implementation of database-per-service on Kubernetes, including saga pattern for distributed transactions, the outbox pattern for reliable event publishing, CQRS for cross-service queries, and schema migration strategies in polyglot persistence environments.

<!--more-->

# Database-per-Service Pattern: Implementation Guide for Microservices on Kubernetes

## Section 1: Database Isolation Strategies

Database isolation can be implemented at multiple levels of granularity, each with different tradeoffs between isolation, resource efficiency, and operational complexity.

### Level 1: Schema Isolation (Same Database Engine, Different Schema)

Share one PostgreSQL instance but use separate schemas per service. This provides logical isolation with minimal resource overhead but allows a runaway query from one service to consume all database resources.

```yaml
# Database instance shared by multiple services
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: shared-postgres
  namespace: data-tier
spec:
  serviceName: shared-postgres
  replicas: 1
  selector:
    matchLabels:
      app: shared-postgres
  template:
    metadata:
      labels:
        app: shared-postgres
    spec:
      containers:
      - name: postgres
        image: postgres:16.2
        env:
        - name: POSTGRES_DB
          value: appdb
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: shared-postgres-secret
              key: password
        ports:
        - containerPort: 5432
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-nvme
      resources:
        requests:
          storage: 500Gi
```

Initialize schemas and users per service:

```sql
-- Initialize schema isolation for order-service
CREATE SCHEMA IF NOT EXISTS orders;
CREATE USER order_service WITH PASSWORD 'securepassword123';
GRANT USAGE ON SCHEMA orders TO order_service;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA orders TO order_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA orders
    GRANT ALL ON TABLES TO order_service;

-- Initialize schema for inventory-service
CREATE SCHEMA IF NOT EXISTS inventory;
CREATE USER inventory_service WITH PASSWORD 'securepassword456';
GRANT USAGE ON SCHEMA inventory TO inventory_service;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA inventory TO inventory_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA inventory
    GRANT ALL ON TABLES TO inventory_service;
```

### Level 2: Separate Database Instances (Recommended)

Each service gets its own database instance. This is the standard database-per-service implementation:

```yaml
# order-service PostgreSQL instance
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: order-db
  namespace: order-service
spec:
  serviceName: order-db
  replicas: 1
  selector:
    matchLabels:
      app: order-db
  template:
    metadata:
      labels:
        app: order-db
    spec:
      containers:
      - name: postgres
        image: postgres:16.2
        env:
        - name: POSTGRES_DB
          value: orders
        - name: POSTGRES_USER
          value: orders_app
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: order-db-credentials
              key: password
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        livenessProbe:
          exec:
            command: [pg_isready, -U, orders_app]
          initialDelaySeconds: 30
          periodSeconds: 10
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-nvme
      resources:
        requests:
          storage: 100Gi
---
# inventory-service uses MongoDB for flexible schema
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: inventory-db
  namespace: inventory-service
spec:
  serviceName: inventory-db
  replicas: 3  # MongoDB replica set
  selector:
    matchLabels:
      app: inventory-db
  template:
    metadata:
      labels:
        app: inventory-db
    spec:
      containers:
      - name: mongo
        image: mongo:7.0
        command: [mongod, --replSet, rs0, --bind_ip_all]
        env:
        - name: MONGO_INITDB_ROOT_USERNAME
          valueFrom:
            secretKeyRef:
              name: inventory-db-credentials
              key: username
        - name: MONGO_INITDB_ROOT_PASSWORD
          valueFrom:
            secretKeyRef:
              name: inventory-db-credentials
              key: password
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi
        volumeMounts:
        - name: data
          mountPath: /data/db
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-nvme
      resources:
        requests:
          storage: 200Gi
```

## Section 2: Saga Pattern for Distributed Transactions

When a business operation spans multiple services, traditional ACID transactions are not available. The saga pattern coordinates distributed transactions through a sequence of local transactions with compensating transactions for rollback.

### Choreography-Based Saga

In choreography, services emit events that trigger the next step. No central coordinator is required.

```go
// order-service/internal/saga/order_saga.go
package saga

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/segmentio/kafka-go"
)

// OrderCreatedEvent is published when an order is created
type OrderCreatedEvent struct {
    OrderID    string    `json:"order_id"`
    CustomerID string    `json:"customer_id"`
    Items      []Item    `json:"items"`
    Total      int64     `json:"total_cents"`
    CreatedAt  time.Time `json:"created_at"`
}

// PaymentAuthorizedEvent is published by payment-service when payment succeeds
type PaymentAuthorizedEvent struct {
    OrderID       string    `json:"order_id"`
    PaymentID     string    `json:"payment_id"`
    Amount        int64     `json:"amount_cents"`
    AuthorizedAt  time.Time `json:"authorized_at"`
}

// InventoryReservedEvent is published by inventory-service when stock is reserved
type InventoryReservedEvent struct {
    OrderID    string    `json:"order_id"`
    Items      []Item    `json:"items"`
    ReservedAt time.Time `json:"reserved_at"`
}

// OrderFulfillmentSaga implements the create-order saga step
type OrderFulfillmentSaga struct {
    orderRepo   OrderRepository
    eventBus    EventBus
}

// CreateOrder is the first step in the saga
func (s *OrderFulfillmentSaga) CreateOrder(ctx context.Context, req CreateOrderRequest) error {
    // Step 1: Create order in PENDING state
    order, err := s.orderRepo.Create(ctx, Order{
        CustomerID: req.CustomerID,
        Items:      req.Items,
        Total:      req.Total,
        Status:     "PENDING",
    })
    if err != nil {
        return fmt.Errorf("creating order: %w", err)
    }

    // Step 2: Publish OrderCreated event to trigger next saga steps
    event := OrderCreatedEvent{
        OrderID:    order.ID,
        CustomerID: order.CustomerID,
        Items:      order.Items,
        Total:      order.Total,
        CreatedAt:  time.Now(),
    }

    if err := s.eventBus.Publish(ctx, "orders.created", event); err != nil {
        // If event publish fails, compensate by cancelling the order
        _ = s.orderRepo.UpdateStatus(ctx, order.ID, "CANCELLED")
        return fmt.Errorf("publishing OrderCreated event: %w", err)
    }

    return nil
}

// HandlePaymentAuthorized processes the PaymentAuthorized event
// This is triggered by the payment-service publishing to its topic
func (s *OrderFulfillmentSaga) HandlePaymentAuthorized(ctx context.Context, event PaymentAuthorizedEvent) error {
    order, err := s.orderRepo.GetByID(ctx, event.OrderID)
    if err != nil {
        return fmt.Errorf("getting order %s: %w", event.OrderID, err)
    }

    if order.Status != "PENDING" {
        // Idempotency: already processed
        return nil
    }

    // Update order with payment ID
    if err := s.orderRepo.UpdatePayment(ctx, order.ID, event.PaymentID); err != nil {
        return fmt.Errorf("updating order payment: %w", err)
    }

    return nil
}

// HandleInventoryReservationFailed compensates when inventory cannot be reserved
func (s *OrderFulfillmentSaga) HandleInventoryReservationFailed(ctx context.Context, orderID string) error {
    // Compensating transaction: cancel the order and trigger payment refund
    if err := s.orderRepo.UpdateStatus(ctx, orderID, "CANCELLED"); err != nil {
        return fmt.Errorf("cancelling order %s: %w", orderID, err)
    }

    // Publish cancellation event to trigger payment refund in payment-service
    return s.eventBus.Publish(ctx, "orders.cancelled", OrderCancelledEvent{
        OrderID:     orderID,
        Reason:      "inventory_unavailable",
        CancelledAt: time.Now(),
    })
}
```

### Orchestration-Based Saga

In orchestration, a central saga orchestrator drives the workflow:

```go
// saga-orchestrator/internal/order_saga.go
package orchestrator

import (
    "context"
    "fmt"
    "time"
)

// OrderSagaState tracks the current state of an order saga
type OrderSagaState struct {
    ID          string
    OrderID     string
    Status      string // STARTED, PAYMENT_AUTHORIZED, INVENTORY_RESERVED, COMPLETED, FAILED
    PaymentID   string
    CompensationsRun []string
    CreatedAt   time.Time
    UpdatedAt   time.Time
}

// OrderSagaOrchestrator coordinates the order fulfillment saga
type OrderSagaOrchestrator struct {
    sagaRepo        SagaRepository
    orderService    OrderServiceClient
    paymentService  PaymentServiceClient
    inventoryService InventoryServiceClient
    notificationService NotificationServiceClient
}

// Execute runs the order fulfillment saga from start to finish
func (o *OrderSagaOrchestrator) Execute(ctx context.Context, req CreateOrderRequest) error {
    // Create saga state record
    saga, err := o.sagaRepo.Create(ctx, OrderSagaState{
        ID:      generateID(),
        OrderID: req.OrderID,
        Status:  "STARTED",
    })
    if err != nil {
        return fmt.Errorf("creating saga state: %w", err)
    }

    // Step 1: Authorize payment
    paymentID, err := o.paymentService.Authorize(ctx, PaymentRequest{
        OrderID:    req.OrderID,
        CustomerID: req.CustomerID,
        Amount:     req.Total,
    })
    if err != nil {
        return o.compensate(ctx, saga, "payment_failed", err)
    }

    saga.PaymentID = paymentID
    saga.Status = "PAYMENT_AUTHORIZED"
    o.sagaRepo.Update(ctx, saga)

    // Step 2: Reserve inventory
    reservationID, err := o.inventoryService.Reserve(ctx, ReservationRequest{
        OrderID: req.OrderID,
        Items:   req.Items,
    })
    if err != nil {
        return o.compensate(ctx, saga, "inventory_failed", err)
    }

    saga.Status = "INVENTORY_RESERVED"
    o.sagaRepo.Update(ctx, saga)

    // Step 3: Confirm order
    if err := o.orderService.Confirm(ctx, req.OrderID, paymentID, reservationID); err != nil {
        return o.compensate(ctx, saga, "order_confirmation_failed", err)
    }

    // Step 4: Send confirmation notification (best-effort, no compensation needed)
    _ = o.notificationService.SendOrderConfirmation(ctx, req.CustomerID, req.OrderID)

    saga.Status = "COMPLETED"
    o.sagaRepo.Update(ctx, saga)

    return nil
}

// compensate runs compensation transactions in reverse order
func (o *OrderSagaOrchestrator) compensate(ctx context.Context, saga *OrderSagaState, reason string, originalErr error) error {
    var compensationErrors []error

    // Compensate in reverse order based on how far we got
    switch saga.Status {
    case "INVENTORY_RESERVED":
        if err := o.inventoryService.ReleaseReservation(ctx, saga.OrderID); err != nil {
            compensationErrors = append(compensationErrors, fmt.Errorf("releasing inventory: %w", err))
        }
        fallthrough

    case "PAYMENT_AUTHORIZED":
        if saga.PaymentID != "" {
            if err := o.paymentService.Void(ctx, saga.PaymentID); err != nil {
                compensationErrors = append(compensationErrors, fmt.Errorf("voiding payment: %w", err))
            }
        }
        fallthrough

    case "STARTED":
        if err := o.orderService.Cancel(ctx, saga.OrderID, reason); err != nil {
            compensationErrors = append(compensationErrors, fmt.Errorf("cancelling order: %w", err))
        }
    }

    saga.Status = "FAILED"
    o.sagaRepo.Update(ctx, saga)

    if len(compensationErrors) > 0 {
        return fmt.Errorf("saga failed (%v) and compensation had errors: %v",
            originalErr, compensationErrors)
    }

    return fmt.Errorf("saga failed: %w", originalErr)
}
```

## Section 3: Outbox Pattern for Reliable Event Publishing

The outbox pattern solves the dual-write problem: writing to the database and publishing an event must be atomic, but they involve two different systems.

```go
// outbox/outbox.go
package outbox

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "time"
)

// OutboxEntry represents a pending event in the outbox table
type OutboxEntry struct {
    ID          string
    AggregateID string
    Topic       string
    Payload     json.RawMessage
    Status      string    // PENDING, PUBLISHED, FAILED
    CreatedAt   time.Time
    PublishedAt *time.Time
    RetryCount  int
}

// Publisher polls the outbox table and publishes pending entries
type Publisher struct {
    db       *sql.DB
    producer EventProducer
    logger   Logger
}

// PublishWithinTransaction writes an event to the outbox table within an existing transaction.
// This ensures the event is only published if the business transaction commits.
func PublishWithinTransaction(ctx context.Context, tx *sql.Tx, topic string, aggregateID string, payload interface{}) error {
    data, err := json.Marshal(payload)
    if err != nil {
        return fmt.Errorf("marshaling event payload: %w", err)
    }

    _, err = tx.ExecContext(ctx, `
        INSERT INTO outbox_entries (
            id, aggregate_id, topic, payload, status, created_at
        ) VALUES (
            gen_random_uuid(), $1, $2, $3, 'PENDING', NOW()
        )`,
        aggregateID,
        topic,
        data,
    )
    if err != nil {
        return fmt.Errorf("inserting outbox entry: %w", err)
    }

    return nil
}

// PollAndPublish reads pending outbox entries and publishes them.
// Should run in a background goroutine.
func (p *Publisher) PollAndPublish(ctx context.Context) {
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            if err := p.processNextBatch(ctx); err != nil {
                p.logger.Error("outbox processing failed", "error", err)
            }
        }
    }
}

func (p *Publisher) processNextBatch(ctx context.Context) error {
    tx, err := p.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }
    defer tx.Rollback()

    // Select and lock pending entries (SKIP LOCKED enables multiple publishers)
    rows, err := tx.QueryContext(ctx, `
        SELECT id, aggregate_id, topic, payload
        FROM outbox_entries
        WHERE status = 'PENDING'
          AND retry_count < 5
        ORDER BY created_at ASC
        LIMIT 10
        FOR UPDATE SKIP LOCKED
    `)
    if err != nil {
        return fmt.Errorf("querying outbox: %w", err)
    }
    defer rows.Close()

    var entries []OutboxEntry
    for rows.Next() {
        var e OutboxEntry
        if err := rows.Scan(&e.ID, &e.AggregateID, &e.Topic, &e.Payload); err != nil {
            return fmt.Errorf("scanning outbox entry: %w", err)
        }
        entries = append(entries, e)
    }
    if rows.Err() != nil {
        return rows.Err()
    }

    // Publish each entry
    for _, entry := range entries {
        if err := p.producer.Publish(ctx, entry.Topic, entry.AggregateID, entry.Payload); err != nil {
            // Mark as failed for retry
            _, _ = tx.ExecContext(ctx, `
                UPDATE outbox_entries
                SET retry_count = retry_count + 1,
                    last_error = $2
                WHERE id = $1`,
                entry.ID, err.Error(),
            )
            continue
        }

        // Mark as published
        now := time.Now()
        _, err = tx.ExecContext(ctx, `
            UPDATE outbox_entries
            SET status = 'PUBLISHED',
                published_at = $2
            WHERE id = $1`,
            entry.ID, now,
        )
        if err != nil {
            return fmt.Errorf("marking entry %s as published: %w", entry.ID, err)
        }
    }

    return tx.Commit()
}
```

The outbox table schema:

```sql
-- outbox schema for any service that needs reliable event publishing
CREATE TABLE IF NOT EXISTS outbox_entries (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_id TEXT NOT NULL,
    topic        TEXT NOT NULL,
    payload      JSONB NOT NULL,
    status       TEXT NOT NULL DEFAULT 'PENDING',
    retry_count  INT NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

CREATE INDEX idx_outbox_pending ON outbox_entries (created_at)
    WHERE status = 'PENDING' AND retry_count < 5;

CREATE INDEX idx_outbox_aggregate ON outbox_entries (aggregate_id);

-- Cleanup old published entries (run daily)
CREATE OR REPLACE FUNCTION cleanup_outbox() RETURNS void AS $$
BEGIN
    DELETE FROM outbox_entries
    WHERE status = 'PUBLISHED'
      AND published_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;
```

## Section 4: CQRS Implementation

CQRS (Command Query Responsibility Segregation) separates the write model (commands) from the read model (queries). This is the solution for cross-service queries: each service maintains a read-optimized projection of relevant data from other services.

```go
// cqrs/read_model.go
package cqrs

import (
    "context"
    "database/sql"
    "encoding/json"
    "time"
)

// OrderSummaryProjection is the read model for the order list view.
// It combines data from order-service, customer-service, and payment-service.
type OrderSummaryProjection struct {
    OrderID        string    `json:"order_id"`
    CustomerName   string    `json:"customer_name"`
    CustomerEmail  string    `json:"customer_email"`
    Status         string    `json:"status"`
    ItemCount      int       `json:"item_count"`
    TotalCents     int64     `json:"total_cents"`
    PaymentStatus  string    `json:"payment_status"`
    CreatedAt      time.Time `json:"created_at"`
}

// OrderProjectionHandler maintains the order summary read model
// by subscribing to events from multiple services
type OrderProjectionHandler struct {
    db *sql.DB
}

// HandleOrderCreated updates the projection when a new order is created
func (h *OrderProjectionHandler) HandleOrderCreated(ctx context.Context, event OrderCreatedEvent) error {
    _, err := h.db.ExecContext(ctx, `
        INSERT INTO order_summary_projection (
            order_id, status, item_count, total_cents, created_at
        ) VALUES ($1, 'PENDING', $2, $3, $4)
        ON CONFLICT (order_id) DO NOTHING`,
        event.OrderID,
        len(event.Items),
        event.TotalCents,
        event.CreatedAt,
    )
    return err
}

// HandleCustomerUpdated updates the customer denormalized data in the projection
func (h *OrderProjectionHandler) HandleCustomerUpdated(ctx context.Context, event CustomerUpdatedEvent) error {
    _, err := h.db.ExecContext(ctx, `
        UPDATE order_summary_projection
        SET customer_name = $2,
            customer_email = $3
        WHERE customer_id = $1`,
        event.CustomerID,
        event.Name,
        event.Email,
    )
    return err
}

// HandlePaymentStatusChanged updates payment status in the projection
func (h *OrderProjectionHandler) HandlePaymentStatusChanged(ctx context.Context, event PaymentStatusChangedEvent) error {
    _, err := h.db.ExecContext(ctx, `
        UPDATE order_summary_projection
        SET payment_status = $2
        WHERE order_id = $1`,
        event.OrderID,
        event.Status,
    )
    return err
}

// QueryOrderSummaries returns paginated order summaries from the read model
func (h *OrderProjectionHandler) QueryOrderSummaries(
    ctx context.Context,
    customerID string,
    offset, limit int,
) ([]OrderSummaryProjection, error) {
    rows, err := h.db.QueryContext(ctx, `
        SELECT order_id, customer_name, customer_email, status,
               item_count, total_cents, payment_status, created_at
        FROM order_summary_projection
        WHERE ($1 = '' OR customer_id = $1)
        ORDER BY created_at DESC
        OFFSET $2
        LIMIT $3`,
        customerID, offset, limit,
    )
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var summaries []OrderSummaryProjection
    for rows.Next() {
        var s OrderSummaryProjection
        if err := rows.Scan(
            &s.OrderID, &s.CustomerName, &s.CustomerEmail,
            &s.Status, &s.ItemCount, &s.TotalCents,
            &s.PaymentStatus, &s.CreatedAt,
        ); err != nil {
            return nil, err
        }
        summaries = append(summaries, s)
    }

    return summaries, rows.Err()
}
```

The CQRS projection schema:

```sql
-- Projection table maintained by subscribing to events
CREATE TABLE IF NOT EXISTS order_summary_projection (
    order_id       TEXT PRIMARY KEY,
    customer_id    TEXT,
    customer_name  TEXT,
    customer_email TEXT,
    status         TEXT NOT NULL,
    item_count     INT NOT NULL,
    total_cents    BIGINT NOT NULL,
    payment_status TEXT,
    created_at     TIMESTAMPTZ NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_summary_customer ON order_summary_projection (customer_id, created_at DESC);
CREATE INDEX idx_order_summary_status ON order_summary_projection (status) WHERE status != 'COMPLETED';
```

## Section 5: Event Sourcing with Kafka

Event sourcing stores the full history of state changes as an append-only log, rather than the current state. Kafka is the natural backbone for event-sourced microservices.

### Kafka Topic Architecture

```yaml
# kafka-topics.yaml - topic configuration via Strimzi Kafka operator
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: order-events
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
spec:
  # 12 partitions allows 12x parallelism for consumers
  partitions: 12
  replicas: 3
  config:
    # Retain all events for event replay capability
    retention.ms: "2592000000"  # 30 days
    # Compaction ensures latest state per key is always available
    cleanup.policy: compact
    # Segment size for efficient compaction
    segment.bytes: "104857600"  # 100MB
    # Minimum compaction lag (don't compact messages newer than 1 hour)
    min.compaction.lag.ms: "3600000"
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: inventory-events
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
spec:
  partitions: 6
  replicas: 3
  config:
    retention.ms: "2592000000"
    cleanup.policy: compact
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: payment-events
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
spec:
  partitions: 6
  replicas: 3
  config:
    retention.ms: "2592000000"
    cleanup.policy: compact
```

### Event Store Implementation

```go
// eventstore/kafka_event_store.go
package eventstore

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/segmentio/kafka-go"
)

// Event represents a domain event
type Event struct {
    ID          string          `json:"id"`
    Type        string          `json:"type"`
    AggregateID string          `json:"aggregate_id"`
    Version     int             `json:"version"`
    Timestamp   time.Time       `json:"timestamp"`
    Payload     json.RawMessage `json:"payload"`
    Metadata    map[string]string `json:"metadata,omitempty"`
}

// KafkaEventStore publishes events to Kafka with exactly-once semantics
type KafkaEventStore struct {
    writer *kafka.Writer
}

func NewKafkaEventStore(brokers []string, topic string) *KafkaEventStore {
    return &KafkaEventStore{
        writer: &kafka.Writer{
            Addr:         kafka.TCP(brokers...),
            Topic:        topic,
            Balancer:     &kafka.Hash{},  // Hash ensures events for same aggregate go to same partition
            RequiredAcks: kafka.RequireAll,  // All replicas must ack
            MaxAttempts:  3,
            BatchSize:    100,
            BatchTimeout: 10 * time.Millisecond,
            // Idempotent writer prevents duplicate messages on retry
            Async: false,
        },
    }
}

// AppendEvents publishes events to Kafka for a given aggregate.
// Events are keyed by aggregateID to ensure ordering per aggregate.
func (s *KafkaEventStore) AppendEvents(ctx context.Context, aggregateID string, events []Event) error {
    messages := make([]kafka.Message, len(events))
    for i, event := range events {
        data, err := json.Marshal(event)
        if err != nil {
            return fmt.Errorf("marshaling event %s: %w", event.ID, err)
        }
        messages[i] = kafka.Message{
            Key:   []byte(aggregateID),  // Same aggregate = same partition
            Value: data,
            Headers: []kafka.Header{
                {Key: "event-type", Value: []byte(event.Type)},
                {Key: "aggregate-id", Value: []byte(aggregateID)},
            },
        }
    }

    if err := s.writer.WriteMessages(ctx, messages...); err != nil {
        return fmt.Errorf("publishing events for aggregate %s: %w", aggregateID, err)
    }

    return nil
}

// OrderAggregate uses event sourcing to rebuild state from events
type OrderAggregate struct {
    ID         string
    CustomerID string
    Items      []Item
    Status     string
    Version    int
    events     []Event  // uncommitted events
}

// Apply rebuilds aggregate state from an event
func (o *OrderAggregate) Apply(event Event) {
    switch event.Type {
    case "OrderCreated":
        var payload OrderCreatedPayload
        json.Unmarshal(event.Payload, &payload)
        o.ID = payload.OrderID
        o.CustomerID = payload.CustomerID
        o.Items = payload.Items
        o.Status = "PENDING"
    case "OrderConfirmed":
        o.Status = "CONFIRMED"
    case "OrderCancelled":
        o.Status = "CANCELLED"
    case "OrderShipped":
        o.Status = "SHIPPED"
    }
    o.Version = event.Version
}

// Replay rebuilds aggregate state from all historical events
func (o *OrderAggregate) Replay(events []Event) {
    for _, event := range events {
        o.Apply(event)
    }
}

// AddItem records an item addition as an event (not yet persisted)
func (o *OrderAggregate) AddItem(item Item) {
    event := Event{
        ID:          generateID(),
        Type:        "ItemAdded",
        AggregateID: o.ID,
        Version:     o.Version + 1,
        Timestamp:   time.Now(),
    }
    payload, _ := json.Marshal(item)
    event.Payload = payload

    o.Apply(event)
    o.events = append(o.events, event)
}

// UncommittedEvents returns events added since last save
func (o *OrderAggregate) UncommittedEvents() []Event {
    return o.events
}

// ClearUncommittedEvents marks events as committed after successful persistence
func (o *OrderAggregate) ClearUncommittedEvents() {
    o.events = nil
}
```

## Section 6: Schema Migrations in Polyglot Persistence

Managing schema migrations across multiple independent databases requires per-service migration tooling and a strategy for backward-compatible changes.

### Per-Service Migration with golang-migrate

```go
// migrations/migrator.go
package migrations

import (
    "database/sql"
    "fmt"

    "github.com/golang-migrate/migrate/v4"
    "github.com/golang-migrate/migrate/v4/database/postgres"
    _ "github.com/golang-migrate/migrate/v4/source/file"
)

// RunMigrations applies all pending database migrations for this service.
// Called during service startup before accepting traffic.
func RunMigrations(db *sql.DB, migrationsPath string) error {
    driver, err := postgres.WithInstance(db, &postgres.Config{
        MigrationsTable: "_schema_migrations",
        DatabaseName:    "orders",
    })
    if err != nil {
        return fmt.Errorf("creating postgres driver: %w", err)
    }

    m, err := migrate.NewWithDatabaseInstance(
        "file://"+migrationsPath,
        "postgres",
        driver,
    )
    if err != nil {
        return fmt.Errorf("creating migrator: %w", err)
    }

    if err := m.Up(); err != nil && err != migrate.ErrNoChange {
        return fmt.Errorf("running migrations: %w", err)
    }

    version, _, err := m.Version()
    if err != nil {
        return fmt.Errorf("getting migration version: %w", err)
    }

    fmt.Printf("Database schema at version %d\n", version)
    return nil
}
```

Migration files for order-service:

```sql
-- migrations/000001_create_orders.up.sql
CREATE TABLE IF NOT EXISTS orders (
    id           TEXT PRIMARY KEY,
    customer_id  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'PENDING',
    total_cents  BIGINT NOT NULL,
    payment_id   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_customer ON orders (customer_id, created_at DESC);
CREATE INDEX idx_orders_status ON orders (status) WHERE status NOT IN ('COMPLETED', 'CANCELLED');

CREATE TABLE IF NOT EXISTS order_items (
    id         BIGSERIAL PRIMARY KEY,
    order_id   TEXT NOT NULL REFERENCES orders(id),
    product_id TEXT NOT NULL,
    quantity   INT NOT NULL,
    unit_price BIGINT NOT NULL
);

CREATE INDEX idx_order_items_order ON order_items (order_id);
```

```sql
-- migrations/000002_add_shipping_address.up.sql
-- Backward-compatible: adding a nullable column
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS shipping_address_json JSONB;
```

```sql
-- migrations/000003_add_order_events.up.sql
-- Outbox table for reliable event publishing
CREATE TABLE IF NOT EXISTS outbox_entries (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_id TEXT NOT NULL,
    topic        TEXT NOT NULL,
    payload      JSONB NOT NULL,
    status       TEXT NOT NULL DEFAULT 'PENDING',
    retry_count  INT NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

CREATE INDEX idx_outbox_pending ON outbox_entries (created_at)
    WHERE status = 'PENDING' AND retry_count < 5;
```

## Section 7: Kubernetes Deployment Pattern

```yaml
# order-service full deployment with init container for migrations
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: order-service
spec:
  replicas: 3
  selector:
    matchLabels:
      app: order-service
  template:
    metadata:
      labels:
        app: order-service
    spec:
      serviceAccountName: order-service
      initContainers:
      # Run database migrations before starting the main container
      - name: migrate
        image: myregistry/order-service:1.4.2
        command: ["/app/order-service", "migrate"]
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: order-db-credentials
              key: url
        - name: MIGRATIONS_PATH
          value: "/app/migrations"
      containers:
      - name: order-service
        image: myregistry/order-service:1.4.2
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9090
          name: metrics
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: order-db-credentials
              key: url
        - name: KAFKA_BROKERS
          value: "kafka-0.kafka.kafka:9092,kafka-1.kafka.kafka:9092,kafka-2.kafka.kafka:9092"
        - name: OUTBOX_POLL_INTERVAL
          value: "100ms"
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 512Mi
        livenessProbe:
          httpGet:
            path: /health/live
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
```

## Summary

The database-per-service pattern trades the simplicity of shared databases for the independence needed to truly decouple microservices. Success requires solving the distributed consistency problems that shared databases handled implicitly:

**Saga pattern** replaces ACID transactions with a sequence of local transactions and compensating transactions. Use choreography for simple flows and orchestration for complex multi-step workflows that require explicit coordination and compensation tracking.

**Outbox pattern** solves the dual-write problem by writing events to a database table within the same transaction as business data, then asynchronously publishing them to Kafka. This guarantees exactly-once event delivery without distributed transactions.

**CQRS read models** solve cross-service query needs by maintaining denormalized projections updated via event subscriptions. Each service owns its read model and rebuilds it from events when needed.

**Event sourcing** stores all state changes as events, enabling complete audit trails, temporal queries, and projection rebuilds. Kafka's compacted topics are the ideal storage layer.

**Schema migrations** run as init containers before the main service starts, ensuring each service manages its own schema lifecycle independently. Use backward-compatible changes (additive only, no drops or renames) during rolling deploys.

The operational overhead is real: more databases to manage, more failure modes to handle, more complex debugging. The payoff is services that can be deployed, scaled, and failed independently, with teams that can own their data stores completely.
