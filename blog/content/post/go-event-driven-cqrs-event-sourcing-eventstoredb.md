---
title: "Go Event-Driven Architecture: CQRS, Event Sourcing with EventStoreDB"
date: 2030-01-15T00:00:00-05:00
draft: false
tags: ["Go", "CQRS", "Event Sourcing", "EventStoreDB", "Microservices", "Architecture"]
categories: ["Go", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Implementing production-grade CQRS and event sourcing patterns in Go using EventStoreDB, covering projections, snapshots, eventual consistency, and aggregate lifecycle management."
more_link: "yes"
url: "/go-event-driven-cqrs-event-sourcing-eventstoredb/"
---

Event sourcing solves one of the hardest problems in distributed systems: maintaining an authoritative, auditable record of every state transition in your domain. Combined with CQRS (Command Query Responsibility Segregation), it enables read models optimized for query performance while the write side maintains strict domain integrity. This guide implements a complete order management system in Go backed by EventStoreDB, covering the full lifecycle from aggregate design through projections, snapshots, and eventual consistency patterns that hold up under production load.

<!--more-->

# Go Event-Driven Architecture: CQRS, Event Sourcing with EventStoreDB

## Foundations: Why Event Sourcing?

Traditional CRUD systems store current state. When a user updates their address, the old address is gone. When an order is cancelled, the journey from cart to cancellation is invisible. Event sourcing inverts this: state is a projection of a sequence of immutable events. The current state is always derivable from the event history.

The practical benefits at enterprise scale:

- **Complete audit trail** — every state transition is recorded with timestamp, actor, and causation
- **Temporal queries** — reconstruct state at any point in time
- **Event replay** — rebuild read models from scratch after schema changes
- **Event-driven integration** — downstream systems consume the same event stream

EventStoreDB is purpose-built for this pattern: it provides persistent, ordered, append-only streams with built-in projection infrastructure and a Go client that handles connection management, reconnection, and subscription lifecycle.

## Architecture Overview

```
Write Side (Commands)                Read Side (Queries)
┌──────────────────┐                ┌──────────────────────┐
│  HTTP Handler    │                │  HTTP Handler        │
│  (commands)      │                │  (queries)           │
└────────┬─────────┘                └──────────┬───────────┘
         │                                      │
┌────────▼─────────┐                ┌──────────▼───────────┐
│  Command Handler │                │  Query Handler       │
│  + Validation    │                │  (read from          │
└────────┬─────────┘                │   projections DB)    │
         │                          └──────────────────────┘
┌────────▼─────────┐                           ▲
│  Aggregate       │                           │
│  (domain logic)  │                ┌──────────┴───────────┐
└────────┬─────────┘                │  Projection Engine   │
         │ events                   │  (EventStoreDB       │
┌────────▼─────────┐                │   subscriptions)     │
│  EventStoreDB    │───────────────▶│                      │
│  (append-only    │  subscription  └──────────────────────┘
│   streams)       │
└──────────────────┘
```

## EventStoreDB Setup

### Docker Compose for Development

```yaml
# docker-compose.yaml
version: "3.8"
services:
  eventstore:
    image: eventstore/eventstore:23.10.0-bookworm-slim
    environment:
      EVENTSTORE_CLUSTER_SIZE: 1
      EVENTSTORE_RUN_PROJECTIONS: All
      EVENTSTORE_START_STANDARD_PROJECTIONS: true
      EVENTSTORE_HTTP_PORT: 2113
      EVENTSTORE_INSECURE: true
      EVENTSTORE_ENABLE_ATOM_PUB_OVER_HTTP: true
    ports:
      - "2113:2113"
    volumes:
      - eventstore-data:/var/lib/eventstore
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:2113/health/live"]
      interval: 10s
      timeout: 5s
      retries: 5

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: projections
      POSTGRES_USER: app
      POSTGRES_PASSWORD: secret
    ports:
      - "5432:5432"

volumes:
  eventstore-data:
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: eventstore
  namespace: eventsourcing
spec:
  serviceName: eventstore
  replicas: 3
  selector:
    matchLabels:
      app: eventstore
  template:
    metadata:
      labels:
        app: eventstore
    spec:
      containers:
        - name: eventstore
          image: eventstore/eventstore:23.10.0-bookworm-slim
          ports:
            - containerPort: 2113
              name: http
            - containerPort: 1113
              name: tcp
          env:
            - name: EVENTSTORE_CLUSTER_SIZE
              value: "3"
            - name: EVENTSTORE_CLUSTER_DNS
              value: "eventstore.eventsourcing.svc.cluster.local"
            - name: EVENTSTORE_INT_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
            - name: EVENTSTORE_EXT_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
            - name: EVENTSTORE_RUN_PROJECTIONS
              value: All
            - name: EVENTSTORE_CERTIFICATE_FILE
              value: /etc/eventstore/certs/node.crt
            - name: EVENTSTORE_CERTIFICATE_PRIVATE_KEY_FILE
              value: /etc/eventstore/certs/node.key
          volumeMounts:
            - name: data
              mountPath: /var/lib/eventstore
            - name: certs
              mountPath: /etc/eventstore/certs
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
          readinessProbe:
            httpGet:
              path: /health/live
              port: 2113
              scheme: HTTPS
            initialDelaySeconds: 30
            periodSeconds: 10
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 100Gi
```

## Domain Model: Order Aggregate

### Event Definitions

```go
// domain/events/order_events.go
package events

import (
    "time"

    "github.com/google/uuid"
)

// EventType is a typed string for event discrimination
type EventType string

const (
    OrderPlaced          EventType = "OrderPlaced"
    OrderItemAdded       EventType = "OrderItemAdded"
    OrderConfirmed       EventType = "OrderConfirmed"
    OrderPaymentReceived EventType = "OrderPaymentReceived"
    OrderShipped         EventType = "OrderShipped"
    OrderDelivered       EventType = "OrderDelivered"
    OrderCancelled       EventType = "OrderCancelled"
)

// DomainEvent is the base interface all events implement
type DomainEvent interface {
    AggregateID() uuid.UUID
    EventType() EventType
    OccurredAt() time.Time
    Version() int64
}

// BaseEvent provides common fields
type BaseEvent struct {
    AggregateId  uuid.UUID `json:"aggregateId"`
    Type         EventType `json:"type"`
    OccurredAtTs time.Time `json:"occurredAt"`
    VersionNum   int64     `json:"version"`
}

func (b BaseEvent) AggregateID() uuid.UUID { return b.AggregateId }
func (b BaseEvent) EventType() EventType   { return b.Type }
func (b BaseEvent) OccurredAt() time.Time  { return b.OccurredAtTs }
func (b BaseEvent) Version() int64         { return b.VersionNum }

// OrderPlacedEvent is emitted when a new order is created
type OrderPlacedEvent struct {
    BaseEvent
    CustomerID uuid.UUID `json:"customerId"`
    Items      []OrderItem `json:"items"`
}

// OrderItemAddedEvent is emitted when an item is added to a pending order
type OrderItemAddedEvent struct {
    BaseEvent
    Item OrderItem `json:"item"`
}

// OrderConfirmedEvent is emitted when inventory is reserved
type OrderConfirmedEvent struct {
    BaseEvent
    ConfirmedBy string    `json:"confirmedBy"`
    ConfirmedAt time.Time `json:"confirmedAt"`
}

// OrderPaymentReceivedEvent is emitted when payment clears
type OrderPaymentReceivedEvent struct {
    BaseEvent
    PaymentID     string    `json:"paymentId"`
    Amount        int64     `json:"amountCents"`
    Currency      string    `json:"currency"`
    PaymentMethod string    `json:"paymentMethod"`
    ProcessedAt   time.Time `json:"processedAt"`
}

// OrderShippedEvent is emitted when the order leaves the warehouse
type OrderShippedEvent struct {
    BaseEvent
    TrackingNumber string    `json:"trackingNumber"`
    Carrier        string    `json:"carrier"`
    ShippedAt      time.Time `json:"shippedAt"`
}

// OrderCancelledEvent is emitted when an order is cancelled
type OrderCancelledEvent struct {
    BaseEvent
    Reason      string    `json:"reason"`
    CancelledBy string    `json:"cancelledBy"`
    CancelledAt time.Time `json:"cancelledAt"`
}

// OrderItem represents a line item
type OrderItem struct {
    ProductID uuid.UUID `json:"productId"`
    SKU       string    `json:"sku"`
    Quantity  int       `json:"quantity"`
    UnitPrice int64     `json:"unitPriceCents"`
}
```

### Order Aggregate

```go
// domain/aggregate/order.go
package aggregate

import (
    "errors"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/company/orders/domain/events"
)

// OrderStatus represents the lifecycle state of an order
type OrderStatus string

const (
    OrderStatusDraft     OrderStatus = "draft"
    OrderStatusConfirmed OrderStatus = "confirmed"
    OrderStatusPaid      OrderStatus = "paid"
    OrderStatusShipped   OrderStatus = "shipped"
    OrderStatusDelivered OrderStatus = "delivered"
    OrderStatusCancelled OrderStatus = "cancelled"
)

// Order is the aggregate root for the order domain
type Order struct {
    id            uuid.UUID
    version       int64
    uncommitted   []events.DomainEvent

    // Domain state
    customerID    uuid.UUID
    status        OrderStatus
    items         []events.OrderItem
    totalCents    int64
    paymentID     string
    trackingNumber string
}

// NewOrder creates a new order aggregate (factory method, not a constructor)
func NewOrder() *Order {
    return &Order{}
}

// LoadFromHistory reconstitutes an order from its event history
func LoadFromHistory(history []events.DomainEvent) (*Order, error) {
    o := NewOrder()
    for _, event := range history {
        if err := o.apply(event, false); err != nil {
            return nil, fmt.Errorf("failed to apply event %v: %w", event.EventType(), err)
        }
    }
    return o, nil
}

// --- Commands ---

// Place creates an order from a placement command
func (o *Order) Place(customerID uuid.UUID, items []events.OrderItem) error {
    if o.id != uuid.Nil {
        return errors.New("order already exists")
    }
    if len(items) == 0 {
        return errors.New("order must contain at least one item")
    }
    for _, item := range items {
        if item.Quantity <= 0 {
            return fmt.Errorf("item %s has invalid quantity %d", item.SKU, item.Quantity)
        }
        if item.UnitPrice <= 0 {
            return fmt.Errorf("item %s has invalid price %d", item.SKU, item.UnitPrice)
        }
    }

    event := &events.OrderPlacedEvent{
        BaseEvent: events.BaseEvent{
            AggregateId:  uuid.New(),
            Type:         events.OrderPlaced,
            OccurredAtTs: time.Now().UTC(),
            VersionNum:   o.version + 1,
        },
        CustomerID: customerID,
        Items:      items,
    }
    return o.apply(event, true)
}

// Confirm reserves inventory and transitions to confirmed state
func (o *Order) Confirm(confirmedBy string) error {
    if o.status != OrderStatusDraft {
        return fmt.Errorf("cannot confirm order in status %s", o.status)
    }

    event := &events.OrderConfirmedEvent{
        BaseEvent: events.BaseEvent{
            AggregateId:  o.id,
            Type:         events.OrderConfirmed,
            OccurredAtTs: time.Now().UTC(),
            VersionNum:   o.version + 1,
        },
        ConfirmedBy: confirmedBy,
        ConfirmedAt: time.Now().UTC(),
    }
    return o.apply(event, true)
}

// RecordPayment records successful payment
func (o *Order) RecordPayment(paymentID string, amount int64, currency, method string) error {
    if o.status != OrderStatusConfirmed {
        return fmt.Errorf("cannot record payment for order in status %s", o.status)
    }
    if amount != o.totalCents {
        return fmt.Errorf("payment amount %d does not match order total %d", amount, o.totalCents)
    }

    event := &events.OrderPaymentReceivedEvent{
        BaseEvent: events.BaseEvent{
            AggregateId:  o.id,
            Type:         events.OrderPaymentReceived,
            OccurredAtTs: time.Now().UTC(),
            VersionNum:   o.version + 1,
        },
        PaymentID:     paymentID,
        Amount:        amount,
        Currency:      currency,
        PaymentMethod: method,
        ProcessedAt:   time.Now().UTC(),
    }
    return o.apply(event, true)
}

// Ship transitions to shipped state
func (o *Order) Ship(trackingNumber, carrier string) error {
    if o.status != OrderStatusPaid {
        return fmt.Errorf("cannot ship order in status %s", o.status)
    }

    event := &events.OrderShippedEvent{
        BaseEvent: events.BaseEvent{
            AggregateId:  o.id,
            Type:         events.OrderShipped,
            OccurredAtTs: time.Now().UTC(),
            VersionNum:   o.version + 1,
        },
        TrackingNumber: trackingNumber,
        Carrier:        carrier,
        ShippedAt:      time.Now().UTC(),
    }
    return o.apply(event, true)
}

// Cancel cancels the order (allowed in draft, confirmed, or paid states)
func (o *Order) Cancel(reason, cancelledBy string) error {
    switch o.status {
    case OrderStatusShipped, OrderStatusDelivered, OrderStatusCancelled:
        return fmt.Errorf("cannot cancel order in status %s", o.status)
    }

    event := &events.OrderCancelledEvent{
        BaseEvent: events.BaseEvent{
            AggregateId:  o.id,
            Type:         events.OrderCancelled,
            OccurredAtTs: time.Now().UTC(),
            VersionNum:   o.version + 1,
        },
        Reason:      reason,
        CancelledBy: cancelledBy,
        CancelledAt: time.Now().UTC(),
    }
    return o.apply(event, true)
}

// --- State Application (Event Sourcing) ---

func (o *Order) apply(event events.DomainEvent, isNew bool) error {
    switch e := event.(type) {
    case *events.OrderPlacedEvent:
        o.id = e.AggregateId
        o.customerID = e.CustomerID
        o.items = e.Items
        o.status = OrderStatusDraft
        o.totalCents = calculateTotal(e.Items)

    case *events.OrderItemAddedEvent:
        o.items = append(o.items, e.Item)
        o.totalCents += int64(e.Item.Quantity) * e.Item.UnitPrice

    case *events.OrderConfirmedEvent:
        o.status = OrderStatusConfirmed

    case *events.OrderPaymentReceivedEvent:
        o.status = OrderStatusPaid
        o.paymentID = e.PaymentID

    case *events.OrderShippedEvent:
        o.status = OrderStatusShipped
        o.trackingNumber = e.TrackingNumber

    case *events.OrderDeliveredEvent:
        o.status = OrderStatusDelivered

    case *events.OrderCancelledEvent:
        o.status = OrderStatusCancelled

    default:
        return fmt.Errorf("unknown event type: %T", event)
    }

    o.version = event.Version()
    if isNew {
        o.uncommitted = append(o.uncommitted, event)
    }
    return nil
}

// --- Accessors ---

func (o *Order) ID() uuid.UUID          { return o.id }
func (o *Order) Version() int64         { return o.version }
func (o *Order) Status() OrderStatus    { return o.status }
func (o *Order) CustomerID() uuid.UUID  { return o.customerID }
func (o *Order) TotalCents() int64      { return o.totalCents }

func (o *Order) UncommittedEvents() []events.DomainEvent {
    return o.uncommitted
}

func (o *Order) MarkCommitted() {
    o.uncommitted = nil
}

func calculateTotal(items []events.OrderItem) int64 {
    var total int64
    for _, item := range items {
        total += int64(item.Quantity) * item.UnitPrice
    }
    return total
}
```

## EventStore Repository

### EventStoreDB Client Integration

```go
// infrastructure/eventstore/repository.go
package eventstore

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "strings"

    esdb "github.com/EventStore/EventStore-Client-Go/v4/esdb"
    "github.com/google/uuid"

    "github.com/company/orders/domain/aggregate"
    "github.com/company/orders/domain/events"
)

const (
    streamPrefix     = "order-"
    snapshotSuffix   = "-snapshot"
    snapshotInterval = 50 // Create snapshot every 50 events
)

// OrderRepository handles persistence of Order aggregates
type OrderRepository struct {
    client *esdb.Client
}

func NewOrderRepository(connectionString string) (*OrderRepository, error) {
    settings, err := esdb.ParseConnectionString(connectionString)
    if err != nil {
        return nil, fmt.Errorf("failed to parse connection string: %w", err)
    }

    client, err := esdb.NewClient(settings)
    if err != nil {
        return nil, fmt.Errorf("failed to create EventStoreDB client: %w", err)
    }

    return &OrderRepository{client: client}, nil
}

// Save appends uncommitted events to the aggregate's stream
func (r *OrderRepository) Save(ctx context.Context, order *aggregate.Order) error {
    uncommitted := order.UncommittedEvents()
    if len(uncommitted) == 0 {
        return nil
    }

    streamName := streamPrefix + order.ID().String()

    var eventData []esdb.EventData
    for _, event := range uncommitted {
        data, err := json.Marshal(event)
        if err != nil {
            return fmt.Errorf("failed to marshal event %v: %w", event.EventType(), err)
        }

        metadata := map[string]interface{}{
            "aggregateId": event.AggregateID().String(),
            "eventType":   string(event.EventType()),
            "occurredAt":  event.OccurredAt().UnixNano(),
        }
        metaData, _ := json.Marshal(metadata)

        eventData = append(eventData, esdb.EventData{
            EventID:     uuid.New(),
            EventType:   string(event.EventType()),
            ContentType: esdb.ContentTypeJson,
            Data:        data,
            Metadata:    metaData,
        })
    }

    // Optimistic concurrency: expected version is current version minus new events
    expectedVersion := order.Version() - int64(len(uncommitted))

    var appendOptions esdb.AppendToStreamOptions
    if expectedVersion < 0 {
        appendOptions.ExpectedRevision = esdb.NoStream{}
    } else {
        appendOptions.ExpectedRevision = esdb.Revision(uint64(expectedVersion))
    }

    _, err := r.client.AppendToStream(ctx, streamName, appendOptions, eventData...)
    if err != nil {
        var wrongVersionErr *esdb.Error
        if errors.As(err, &wrongVersionErr) && wrongVersionErr.Code() == esdb.ErrorCodeWrongExpectedVersion {
            return fmt.Errorf("optimistic concurrency conflict for order %s: %w",
                order.ID(), ErrConcurrencyConflict)
        }
        return fmt.Errorf("failed to append events: %w", err)
    }

    order.MarkCommitted()

    // Create snapshot if needed
    if order.Version()%snapshotInterval == 0 {
        if err := r.saveSnapshot(ctx, order); err != nil {
            // Non-fatal: log but don't fail the save
            fmt.Printf("warning: failed to create snapshot for order %s: %v\n",
                order.ID(), err)
        }
    }

    return nil
}

// GetByID loads an order aggregate by ID, using snapshot if available
func (r *OrderRepository) GetByID(ctx context.Context, id uuid.UUID) (*aggregate.Order, error) {
    // Try to load from snapshot first
    snapshot, snapshotVersion, err := r.loadSnapshot(ctx, id)
    if err != nil && !errors.Is(err, ErrSnapshotNotFound) {
        return nil, fmt.Errorf("failed to load snapshot: %w", err)
    }

    streamName := streamPrefix + id.String()

    var readOptions esdb.ReadStreamOptions
    if snapshot != nil {
        readOptions.From = esdb.Revision(uint64(snapshotVersion))
    } else {
        readOptions.From = esdb.Start{}
    }
    readOptions.Direction = esdb.Forwards

    stream, err := r.client.ReadStream(ctx, streamName, readOptions, 0)
    if err != nil {
        var notFoundErr *esdb.Error
        if errors.As(err, &notFoundErr) && notFoundErr.Code() == esdb.ErrorCodeResourceNotFound {
            return nil, ErrOrderNotFound
        }
        return nil, fmt.Errorf("failed to read stream: %w", err)
    }
    defer stream.Close()

    var domainEvents []events.DomainEvent
    if snapshot != nil {
        // Start from snapshot state
        domainEvents = nil // snapshot already applied
    }

    for {
        event, err := stream.Recv()
        if err != nil {
            if errors.Is(err, esdb.ErrStreamNotFound) || strings.Contains(err.Error(), "EOF") {
                break
            }
            return nil, fmt.Errorf("error reading stream: %w", err)
        }
        if event == nil {
            break
        }

        domainEvent, err := deserializeEvent(event.Event)
        if err != nil {
            return nil, fmt.Errorf("failed to deserialize event: %w", err)
        }
        domainEvents = append(domainEvents, domainEvent)
    }

    if snapshot != nil {
        return applyEventsToSnapshot(snapshot, domainEvents)
    }

    if len(domainEvents) == 0 {
        return nil, ErrOrderNotFound
    }

    return aggregate.LoadFromHistory(domainEvents)
}

// saveSnapshot persists the current aggregate state as a snapshot
func (r *OrderRepository) saveSnapshot(ctx context.Context, order *aggregate.Order) error {
    snapshot := orderSnapshot{
        ID:             order.ID(),
        Version:        order.Version(),
        CustomerID:     order.CustomerID(),
        Status:         string(order.Status()),
        TotalCents:     order.TotalCents(),
    }

    data, err := json.Marshal(snapshot)
    if err != nil {
        return err
    }

    snapshotStreamName := streamPrefix + order.ID().String() + snapshotSuffix
    eventData := esdb.EventData{
        EventID:     uuid.New(),
        EventType:   "OrderSnapshot",
        ContentType: esdb.ContentTypeJson,
        Data:        data,
    }

    _, err = r.client.AppendToStream(
        ctx,
        snapshotStreamName,
        esdb.AppendToStreamOptions{},
        eventData,
    )
    return err
}

// loadSnapshot retrieves the latest snapshot for an order
func (r *OrderRepository) loadSnapshot(
    ctx context.Context,
    id uuid.UUID,
) (*orderSnapshot, int64, error) {
    snapshotStreamName := streamPrefix + id.String() + snapshotSuffix

    stream, err := r.client.ReadStream(ctx, snapshotStreamName, esdb.ReadStreamOptions{
        Direction: esdb.Backwards,
        From:      esdb.End{},
    }, 1)
    if err != nil {
        var esdbErr *esdb.Error
        if errors.As(err, &esdbErr) && esdbErr.Code() == esdb.ErrorCodeResourceNotFound {
            return nil, 0, ErrSnapshotNotFound
        }
        return nil, 0, err
    }
    defer stream.Close()

    event, err := stream.Recv()
    if err != nil {
        return nil, 0, ErrSnapshotNotFound
    }

    var snapshot orderSnapshot
    if err := json.Unmarshal(event.Event.Data, &snapshot); err != nil {
        return nil, 0, err
    }

    return &snapshot, snapshot.Version, nil
}

type orderSnapshot struct {
    ID         uuid.UUID `json:"id"`
    Version    int64     `json:"version"`
    CustomerID uuid.UUID `json:"customerId"`
    Status     string    `json:"status"`
    TotalCents int64     `json:"totalCents"`
}

// deserializeEvent converts an EventStoreDB recorded event to a domain event
func deserializeEvent(recorded *esdb.RecordedEvent) (events.DomainEvent, error) {
    eventType := events.EventType(recorded.EventType)

    switch eventType {
    case events.OrderPlaced:
        var e events.OrderPlacedEvent
        if err := json.Unmarshal(recorded.Data, &e); err != nil {
            return nil, err
        }
        return &e, nil

    case events.OrderConfirmed:
        var e events.OrderConfirmedEvent
        if err := json.Unmarshal(recorded.Data, &e); err != nil {
            return nil, err
        }
        return &e, nil

    case events.OrderPaymentReceived:
        var e events.OrderPaymentReceivedEvent
        if err := json.Unmarshal(recorded.Data, &e); err != nil {
            return nil, err
        }
        return &e, nil

    case events.OrderShipped:
        var e events.OrderShippedEvent
        if err := json.Unmarshal(recorded.Data, &e); err != nil {
            return nil, err
        }
        return &e, nil

    case events.OrderCancelled:
        var e events.OrderCancelledEvent
        if err := json.Unmarshal(recorded.Data, &e); err != nil {
            return nil, err
        }
        return &e, nil

    default:
        return nil, fmt.Errorf("unknown event type: %s", eventType)
    }
}

func applyEventsToSnapshot(
    snapshot *orderSnapshot,
    newEvents []events.DomainEvent,
) (*aggregate.Order, error) {
    // Reconstruct partial state from snapshot, then apply new events
    // In a real implementation, the aggregate would support hydration from snapshot
    return aggregate.LoadFromHistory(newEvents)
}

var (
    ErrOrderNotFound      = errors.New("order not found")
    ErrConcurrencyConflict = errors.New("optimistic concurrency conflict")
    ErrSnapshotNotFound   = errors.New("snapshot not found")
)
```

## Projections: Building Read Models

### Persistent Subscription Handler

```go
// infrastructure/projections/order_projection.go
package projections

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "time"

    esdb "github.com/EventStore/EventStore-Client-Go/v4/esdb"
    "github.com/google/uuid"

    "github.com/company/orders/domain/events"
)

// OrderProjection builds and maintains the orders read model
type OrderProjection struct {
    client    *esdb.Client
    db        *sql.DB
    groupName string
}

func NewOrderProjection(client *esdb.Client, db *sql.DB) *OrderProjection {
    return &OrderProjection{
        client:    client,
        db:        db,
        groupName: "order-read-model-projection",
    }
}

// SetupSubscription creates the persistent subscription if it doesn't exist
func (p *OrderProjection) SetupSubscription(ctx context.Context) error {
    settings := esdb.SubscriptionSettings{
        ResolveLinkTos:    true,
        StartFrom:         esdb.Start{},
        MaxRetryCount:     10,
        CheckpointAfter:   10 * time.Second,
        MaxCheckpointCount: 1000,
        MinCheckpointCount: 10,
        MaxSubscriberCount: 10,
        LiveBufferSize:     500,
        ReadBatchSize:      20,
        HistoryBufferSize:  500,
        MessageTimeout:     30 * time.Second,
    }

    err := p.client.CreatePersistentSubscriptionToAll(ctx,
        p.groupName, settings, nil)
    if err != nil {
        var esdbErr *esdb.Error
        if esdbErr, ok := err.(*esdb.Error); ok {
            if esdbErr.Code() == esdb.ErrorCodeResourceAlreadyExists {
                return nil // Already exists, not an error
            }
        }
        return fmt.Errorf("failed to create persistent subscription: %w", err)
    }

    return nil
}

// Start begins consuming events and updating the read model
func (p *OrderProjection) Start(ctx context.Context) error {
    sub, err := p.client.SubscribeToPersistentSubscriptionToAll(
        ctx,
        p.groupName,
        esdb.SubscribeToPersistentSubscriptionOptions{},
    )
    if err != nil {
        return fmt.Errorf("failed to subscribe: %w", err)
    }
    defer sub.Close()

    fmt.Println("[Projection] Started consuming order events")

    for {
        select {
        case <-ctx.Done():
            return nil
        default:
        }

        event := sub.Recv()
        if event.SubscriptionDropped != nil {
            if event.SubscriptionDropped.Error != nil {
                return fmt.Errorf("subscription dropped: %w", event.SubscriptionDropped.Error)
            }
            return nil
        }

        if event.EventAppeared == nil {
            continue
        }

        recorded := event.EventAppeared.Event
        if recorded == nil {
            sub.Ack(event.EventAppeared)
            continue
        }

        // Only process order stream events
        eventType := events.EventType(recorded.EventType)
        if err := p.handleEvent(ctx, eventType, recorded.Data, recorded.EventID); err != nil {
            fmt.Printf("[Projection] Error handling event %s: %v\n", eventType, err)
            sub.Nack(event.EventAppeared, esdb.NackActionRetry, err.Error())
            continue
        }

        sub.Ack(event.EventAppeared)
    }
}

func (p *OrderProjection) handleEvent(
    ctx context.Context,
    eventType events.EventType,
    data []byte,
    eventID uuid.UUID,
) error {
    // Idempotency check
    if processed, _ := p.isEventProcessed(ctx, eventID); processed {
        return nil
    }

    tx, err := p.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    switch eventType {
    case events.OrderPlaced:
        var e events.OrderPlacedEvent
        if err := json.Unmarshal(data, &e); err != nil {
            return err
        }
        if err := p.handleOrderPlaced(ctx, tx, &e); err != nil {
            return err
        }

    case events.OrderConfirmed:
        var e events.OrderConfirmedEvent
        if err := json.Unmarshal(data, &e); err != nil {
            return err
        }
        if err := p.handleOrderConfirmed(ctx, tx, &e); err != nil {
            return err
        }

    case events.OrderPaymentReceived:
        var e events.OrderPaymentReceivedEvent
        if err := json.Unmarshal(data, &e); err != nil {
            return err
        }
        if err := p.handlePaymentReceived(ctx, tx, &e); err != nil {
            return err
        }

    case events.OrderShipped:
        var e events.OrderShippedEvent
        if err := json.Unmarshal(data, &e); err != nil {
            return err
        }
        if err := p.handleOrderShipped(ctx, tx, &e); err != nil {
            return err
        }

    case events.OrderCancelled:
        var e events.OrderCancelledEvent
        if err := json.Unmarshal(data, &e); err != nil {
            return err
        }
        if err := p.handleOrderCancelled(ctx, tx, &e); err != nil {
            return err
        }

    default:
        // Unknown event types are silently ignored (forward compatibility)
        return tx.Commit()
    }

    // Record processed event for idempotency
    if err := p.markEventProcessed(ctx, tx, eventID); err != nil {
        return err
    }

    return tx.Commit()
}

func (p *OrderProjection) handleOrderPlaced(
    ctx context.Context,
    tx *sql.Tx,
    e *events.OrderPlacedEvent,
) error {
    _, err := tx.ExecContext(ctx, `
        INSERT INTO orders_read (
            id, customer_id, status, total_cents,
            item_count, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $6)
        ON CONFLICT (id) DO NOTHING`,
        e.AggregateId, e.CustomerID, "draft",
        calculateTotal(e.Items), len(e.Items),
        e.OccurredAtTs,
    )
    return err
}

func (p *OrderProjection) handleOrderConfirmed(
    ctx context.Context,
    tx *sql.Tx,
    e *events.OrderConfirmedEvent,
) error {
    _, err := tx.ExecContext(ctx, `
        UPDATE orders_read
        SET status = $1, confirmed_at = $2, updated_at = $2
        WHERE id = $3`,
        "confirmed", e.ConfirmedAt, e.AggregateId,
    )
    return err
}

func (p *OrderProjection) handlePaymentReceived(
    ctx context.Context,
    tx *sql.Tx,
    e *events.OrderPaymentReceivedEvent,
) error {
    _, err := tx.ExecContext(ctx, `
        UPDATE orders_read
        SET status = $1, payment_id = $2, paid_at = $3, updated_at = $3
        WHERE id = $4`,
        "paid", e.PaymentID, e.ProcessedAt, e.AggregateId,
    )
    return err
}

func (p *OrderProjection) handleOrderShipped(
    ctx context.Context,
    tx *sql.Tx,
    e *events.OrderShippedEvent,
) error {
    _, err := tx.ExecContext(ctx, `
        UPDATE orders_read
        SET status = $1, tracking_number = $2, carrier = $3,
            shipped_at = $4, updated_at = $4
        WHERE id = $5`,
        "shipped", e.TrackingNumber, e.Carrier, e.ShippedAt, e.AggregateId,
    )
    return err
}

func (p *OrderProjection) handleOrderCancelled(
    ctx context.Context,
    tx *sql.Tx,
    e *events.OrderCancelledEvent,
) error {
    _, err := tx.ExecContext(ctx, `
        UPDATE orders_read
        SET status = $1, cancellation_reason = $2,
            cancelled_at = $3, updated_at = $3
        WHERE id = $4`,
        "cancelled", e.Reason, e.CancelledAt, e.AggregateId,
    )
    return err
}

func (p *OrderProjection) isEventProcessed(ctx context.Context, eventID uuid.UUID) (bool, error) {
    var count int
    err := p.db.QueryRowContext(ctx,
        "SELECT COUNT(1) FROM processed_events WHERE event_id = $1", eventID,
    ).Scan(&count)
    return count > 0, err
}

func (p *OrderProjection) markEventProcessed(
    ctx context.Context,
    tx *sql.Tx,
    eventID uuid.UUID,
) error {
    _, err := tx.ExecContext(ctx,
        "INSERT INTO processed_events (event_id, processed_at) VALUES ($1, NOW())",
        eventID,
    )
    return err
}

func calculateTotal(items []events.OrderItem) int64 {
    var total int64
    for _, item := range items {
        total += int64(item.Quantity) * item.UnitPrice
    }
    return total
}
```

### Read Model Schema

```sql
-- migrations/001_create_read_models.sql

CREATE TABLE orders_read (
    id              UUID PRIMARY KEY,
    customer_id     UUID NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'draft',
    total_cents     BIGINT NOT NULL DEFAULT 0,
    item_count      INTEGER NOT NULL DEFAULT 0,
    payment_id      VARCHAR(100),
    tracking_number VARCHAR(100),
    carrier         VARCHAR(50),
    cancellation_reason TEXT,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL,
    confirmed_at    TIMESTAMP WITH TIME ZONE,
    paid_at         TIMESTAMP WITH TIME ZONE,
    shipped_at      TIMESTAMP WITH TIME ZONE,
    delivered_at    TIMESTAMP WITH TIME ZONE,
    cancelled_at    TIMESTAMP WITH TIME ZONE,
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX idx_orders_read_customer_id ON orders_read(customer_id);
CREATE INDEX idx_orders_read_status ON orders_read(status);
CREATE INDEX idx_orders_read_created_at ON orders_read(created_at DESC);

CREATE TABLE processed_events (
    event_id      UUID PRIMARY KEY,
    processed_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Customer order summary (denormalized for performance)
CREATE MATERIALIZED VIEW customer_order_summary AS
SELECT
    customer_id,
    COUNT(*) AS total_orders,
    COUNT(*) FILTER (WHERE status = 'delivered') AS completed_orders,
    COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_orders,
    SUM(total_cents) FILTER (WHERE status NOT IN ('cancelled')) AS lifetime_value_cents,
    MAX(created_at) AS last_order_at
FROM orders_read
GROUP BY customer_id;

CREATE UNIQUE INDEX idx_customer_order_summary ON customer_order_summary(customer_id);

-- Refresh function (called by scheduled job or trigger)
CREATE OR REPLACE FUNCTION refresh_customer_order_summary()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY customer_order_summary;
END;
$$ LANGUAGE plpgsql;
```

## Command and Query Handlers

### Command Handler with Process Manager

```go
// application/command_handler.go
package application

import (
    "context"
    "fmt"

    "github.com/google/uuid"

    "github.com/company/orders/domain/aggregate"
    "github.com/company/orders/domain/events"
    "github.com/company/orders/infrastructure/eventstore"
)

type PlaceOrderCommand struct {
    CustomerID uuid.UUID
    Items      []events.OrderItem
}

type ConfirmOrderCommand struct {
    OrderID     uuid.UUID
    ConfirmedBy string
}

type RecordPaymentCommand struct {
    OrderID       uuid.UUID
    PaymentID     string
    AmountCents   int64
    Currency      string
    PaymentMethod string
}

type ShipOrderCommand struct {
    OrderID        uuid.UUID
    TrackingNumber string
    Carrier        string
}

type CancelOrderCommand struct {
    OrderID     uuid.UUID
    Reason      string
    CancelledBy string
}

// OrderCommandHandler processes commands against the Order aggregate
type OrderCommandHandler struct {
    repo     *eventstore.OrderRepository
    eventBus EventBus
}

type EventBus interface {
    Publish(ctx context.Context, event events.DomainEvent) error
}

func NewOrderCommandHandler(
    repo *eventstore.OrderRepository,
    bus EventBus,
) *OrderCommandHandler {
    return &OrderCommandHandler{repo: repo, eventBus: bus}
}

func (h *OrderCommandHandler) HandlePlaceOrder(
    ctx context.Context,
    cmd PlaceOrderCommand,
) (uuid.UUID, error) {
    order := aggregate.NewOrder()

    if err := order.Place(cmd.CustomerID, cmd.Items); err != nil {
        return uuid.Nil, fmt.Errorf("place order failed: %w", err)
    }

    if err := h.repo.Save(ctx, order); err != nil {
        return uuid.Nil, fmt.Errorf("failed to save order: %w", err)
    }

    // Publish domain events to downstream systems
    for _, event := range order.UncommittedEvents() {
        if err := h.eventBus.Publish(ctx, event); err != nil {
            fmt.Printf("warning: failed to publish event %v: %v\n", event.EventType(), err)
        }
    }

    return order.ID(), nil
}

func (h *OrderCommandHandler) HandleConfirmOrder(
    ctx context.Context,
    cmd ConfirmOrderCommand,
) error {
    order, err := h.repo.GetByID(ctx, cmd.OrderID)
    if err != nil {
        return fmt.Errorf("order not found: %w", err)
    }

    if err := order.Confirm(cmd.ConfirmedBy); err != nil {
        return fmt.Errorf("confirm order failed: %w", err)
    }

    return h.repo.Save(ctx, order)
}

func (h *OrderCommandHandler) HandleRecordPayment(
    ctx context.Context,
    cmd RecordPaymentCommand,
) error {
    // Retry loop for optimistic concurrency conflicts
    maxRetries := 3
    for attempt := 0; attempt < maxRetries; attempt++ {
        order, err := h.repo.GetByID(ctx, cmd.OrderID)
        if err != nil {
            return fmt.Errorf("order not found: %w", err)
        }

        if err := order.RecordPayment(
            cmd.PaymentID, cmd.AmountCents, cmd.Currency, cmd.PaymentMethod,
        ); err != nil {
            return fmt.Errorf("record payment failed: %w", err)
        }

        if err := h.repo.Save(ctx, order); err != nil {
            if errors.Is(err, eventstore.ErrConcurrencyConflict) && attempt < maxRetries-1 {
                fmt.Printf("Concurrency conflict, retrying (attempt %d/%d)\n",
                    attempt+1, maxRetries)
                continue
            }
            return fmt.Errorf("failed to save order: %w", err)
        }
        return nil
    }
    return fmt.Errorf("max retries exceeded")
}
```

### Query Handler

```go
// application/query_handler.go
package application

import (
    "context"
    "database/sql"
    "time"

    "github.com/google/uuid"
)

type OrderSummary struct {
    ID             uuid.UUID  `json:"id"`
    CustomerID     uuid.UUID  `json:"customerId"`
    Status         string     `json:"status"`
    TotalCents     int64      `json:"totalCents"`
    ItemCount      int        `json:"itemCount"`
    PaymentID      *string    `json:"paymentId,omitempty"`
    TrackingNumber *string    `json:"trackingNumber,omitempty"`
    Carrier        *string    `json:"carrier,omitempty"`
    CreatedAt      time.Time  `json:"createdAt"`
    UpdatedAt      time.Time  `json:"updatedAt"`
}

type OrderQueryHandler struct {
    db *sql.DB
}

func NewOrderQueryHandler(db *sql.DB) *OrderQueryHandler {
    return &OrderQueryHandler{db: db}
}

func (h *OrderQueryHandler) GetOrder(
    ctx context.Context,
    orderID uuid.UUID,
) (*OrderSummary, error) {
    var order OrderSummary
    err := h.db.QueryRowContext(ctx, `
        SELECT id, customer_id, status, total_cents, item_count,
               payment_id, tracking_number, carrier,
               created_at, updated_at
        FROM orders_read
        WHERE id = $1`,
        orderID,
    ).Scan(
        &order.ID, &order.CustomerID, &order.Status,
        &order.TotalCents, &order.ItemCount,
        &order.PaymentID, &order.TrackingNumber, &order.Carrier,
        &order.CreatedAt, &order.UpdatedAt,
    )
    if err == sql.ErrNoRows {
        return nil, ErrOrderNotFound
    }
    return &order, err
}

func (h *OrderQueryHandler) ListCustomerOrders(
    ctx context.Context,
    customerID uuid.UUID,
    limit, offset int,
) ([]OrderSummary, int, error) {
    var total int
    err := h.db.QueryRowContext(ctx,
        "SELECT COUNT(*) FROM orders_read WHERE customer_id = $1",
        customerID,
    ).Scan(&total)
    if err != nil {
        return nil, 0, err
    }

    rows, err := h.db.QueryContext(ctx, `
        SELECT id, customer_id, status, total_cents, item_count,
               payment_id, tracking_number, carrier,
               created_at, updated_at
        FROM orders_read
        WHERE customer_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
        customerID, limit, offset,
    )
    if err != nil {
        return nil, 0, err
    }
    defer rows.Close()

    var orders []OrderSummary
    for rows.Next() {
        var o OrderSummary
        if err := rows.Scan(
            &o.ID, &o.CustomerID, &o.Status,
            &o.TotalCents, &o.ItemCount,
            &o.PaymentID, &o.TrackingNumber, &o.Carrier,
            &o.CreatedAt, &o.UpdatedAt,
        ); err != nil {
            return nil, 0, err
        }
        orders = append(orders, o)
    }

    return orders, total, rows.Err()
}
```

## Production Considerations

### Eventual Consistency Handling

```go
// patterns/read_your_writes.go - Handle read-your-writes consistency
package patterns

import (
    "context"
    "time"

    "github.com/google/uuid"
)

// ConsistencyToken carries the minimum event position the client needs
type ConsistencyToken struct {
    StreamName string `json:"stream"`
    Position   uint64 `json:"position"`
}

// WaitForProjection polls until the projection has caught up to the required position
func WaitForProjection(
    ctx context.Context,
    token ConsistencyToken,
    checkFn func(ctx context.Context) (uint64, error),
    timeout time.Duration,
) error {
    deadline := time.Now().Add(timeout)
    ticker := time.NewTicker(50 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            if time.Now().After(deadline) {
                return fmt.Errorf("timeout waiting for projection consistency")
            }

            currentPosition, err := checkFn(ctx)
            if err != nil {
                continue
            }

            if currentPosition >= token.Position {
                return nil
            }
        }
    }
}
```

### Monitoring Configuration

```yaml
# prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: eventsourcing-alerts
  namespace: monitoring
spec:
  groups:
    - name: eventsourcing
      rules:
        - alert: ProjectionLag
          expr: |
            eventstore_projection_lag_seconds > 30
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "EventStore projection lagging"
            description: "Projection {{ $labels.projection }} is {{ $value }}s behind"

        - alert: ConcurrencyConflictRateHigh
          expr: |
            rate(order_concurrency_conflicts_total[5m]) > 0.1
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "High optimistic concurrency conflict rate"

        - alert: EventStoreConnectionLost
          expr: |
            eventstore_connection_state != 1
          for: 30s
          labels:
            severity: critical
          annotations:
            summary: "EventStoreDB connection lost"
```

## Conclusion

Event sourcing with CQRS is a powerful architecture for domains where auditability, temporal querying, and event-driven integration are requirements. The key takeaways:

- **Aggregates** enforce domain invariants and emit events as the sole output of command processing
- **Optimistic concurrency** via expected stream revision prevents concurrent mutation without pessimistic locking
- **Snapshots** bound the cost of aggregate reconstruction for long-lived entities
- **Persistent subscriptions** decouple projection updates from the write path, enabling read models to be rebuilt without touching the event store
- **Idempotent event handlers** make projection rebuilds safe and allow at-least-once delivery guarantees from EventStoreDB

The separation of concerns between write models (aggregates + EventStoreDB) and read models (PostgreSQL projections) allows each side to evolve independently and be scaled and optimized for their respective workloads.
