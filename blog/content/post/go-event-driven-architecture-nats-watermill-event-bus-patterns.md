---
title: "Go Event-Driven Architecture: NATS, Watermill, and Event Bus Patterns"
date: 2031-04-17T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "NATS", "Event-Driven", "Watermill", "Event Sourcing", "Messaging"]
categories:
- Go
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to building event-driven Go applications using NATS JetStream for durable event streams, Watermill for event router abstraction, event sourcing with an event bus pattern, dead letter queue handling, exactly-once delivery semantics, and testing event-driven systems with test publishers and subscribers."
more_link: "yes"
url: "/go-event-driven-architecture-nats-watermill-event-bus-patterns/"
---

Event-driven architecture decouples services through asynchronous message passing, enabling independent scaling, resilience to downstream failures, and clear audit trails. Go's concurrency model makes it an excellent fit for event processing. This guide covers NATS JetStream for durable event streaming, Watermill's broker-agnostic event router, event sourcing implementation, dead letter queue patterns, exactly-once delivery through idempotent consumers, and a comprehensive testing approach that validates event-driven behavior without running a live broker.

<!--more-->

# Go Event-Driven Architecture: NATS, Watermill, and Event Bus Patterns

## Section 1: NATS JetStream for Durable Event Streams

### Why NATS JetStream

NATS Core provides at-most-once pub/sub with microsecond latency. JetStream adds persistence, at-least-once and exactly-once delivery, consumer groups, and key-value storage on top.

```
NATS JetStream Architecture:

Publishers → [Subject: orders.created] → Stream: ORDERS
                                              ├── Consumer: orders-service (pull)
                                              ├── Consumer: inventory-service (push)
                                              └── Consumer: analytics-service (pull, start from beginning)

Key JetStream concepts:
- Stream: Persistent storage for messages on a subject pattern
- Consumer: Stateful subscription that tracks delivery position
- Ack: Consumer acknowledgment (confirms processing)
- DeliverPolicy: Where to start consuming (new, all, last, by_time)
- AckPolicy: explicit (must ack/nak), none (fire and forget), all (ack cumulative)
```

### NATS JetStream Client Setup

```go
package natsjs

import (
    "context"
    "errors"
    "fmt"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
    "go.uber.org/zap"
)

// Config holds NATS connection configuration
type Config struct {
    URLs            []string
    MaxReconnects   int
    ReconnectWait   time.Duration
    Name            string
    CredentialsFile string
    TLSConfig       *tls.Config
}

// Client wraps the NATS connection and JetStream context
type Client struct {
    conn   *nats.Conn
    js     jetstream.JetStream
    logger *zap.Logger
}

// NewClient creates a production NATS client with reconnection logic
func NewClient(cfg Config, logger *zap.Logger) (*Client, error) {
    opts := []nats.Option{
        nats.Name(cfg.Name),
        nats.MaxReconnects(cfg.MaxReconnects),
        nats.ReconnectWait(cfg.ReconnectWait),

        // Reconnection handlers
        nats.ReconnectHandler(func(nc *nats.Conn) {
            logger.Warn("NATS reconnected", zap.String("url", nc.ConnectedUrl()))
        }),
        nats.DisconnectErrHandler(func(nc *nats.Conn, err error) {
            if err != nil {
                logger.Error("NATS disconnected", zap.Error(err))
            }
        }),
        nats.ClosedHandler(func(nc *nats.Conn) {
            logger.Info("NATS connection closed")
        }),

        // Error handler for async errors
        nats.ErrorHandler(func(nc *nats.Conn, sub *nats.Subscription, err error) {
            logger.Error("NATS async error",
                zap.String("subject", sub.Subject),
                zap.Error(err))
        }),

        // TLS if configured
        // nats.Secure(cfg.TLSConfig),
    }

    if cfg.CredentialsFile != "" {
        opts = append(opts, nats.UserCredentials(cfg.CredentialsFile))
    }

    url := nats.DefaultURL
    if len(cfg.URLs) > 0 {
        url = cfg.URLs[0]
        for i := 1; i < len(cfg.URLs); i++ {
            url += "," + cfg.URLs[i]
        }
    }

    conn, err := nats.Connect(url, opts...)
    if err != nil {
        return nil, fmt.Errorf("connecting to NATS: %w", err)
    }

    js, err := jetstream.New(conn)
    if err != nil {
        conn.Close()
        return nil, fmt.Errorf("creating JetStream context: %w", err)
    }

    return &Client{conn: conn, js: js, logger: logger}, nil
}

// Close closes the NATS connection
func (c *Client) Close() {
    c.conn.Close()
}

// EnsureStream creates or updates a stream
func (c *Client) EnsureStream(ctx context.Context, cfg jetstream.StreamConfig) (jetstream.Stream, error) {
    stream, err := c.js.CreateOrUpdateStream(ctx, cfg)
    if err != nil {
        return nil, fmt.Errorf("ensuring stream %s: %w", cfg.Name, err)
    }
    return stream, nil
}

// SetupOrdersStream creates the orders event stream
func (c *Client) SetupOrdersStream(ctx context.Context) (jetstream.Stream, error) {
    return c.EnsureStream(ctx, jetstream.StreamConfig{
        Name: "ORDERS",
        // Capture all order-related events
        Subjects: []string{
            "orders.created",
            "orders.updated",
            "orders.cancelled",
            "orders.fulfilled",
            "orders.refunded",
        },
        // Retention policy
        Retention: jetstream.LimitsPolicy,
        MaxAge:    30 * 24 * time.Hour, // 30 days
        MaxBytes:  10 * 1024 * 1024 * 1024, // 10GB

        // At-least-once delivery
        Storage: jetstream.FileStorage,

        // Replicas for HA (requires 3-node NATS cluster)
        Replicas: 3,

        // Duplicate detection window
        Duplicates: 2 * time.Minute,

        // Allow message limits but don't discard new messages
        Discard: jetstream.DiscardOld,

        // Consumer limits
        MaxConsumers: -1, // Unlimited consumers
    })
}
```

### Publishing Events with Deduplication

```go
package events

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/nats-io/nats.go/jetstream"
)

// Event is the base structure for all domain events
type Event struct {
    // EventID is a unique identifier for deduplication
    // JetStream uses this for exactly-once publishing within the Duplicates window
    EventID   string    `json:"event_id"`
    EventType string    `json:"event_type"`
    Version   int       `json:"version"`
    Timestamp time.Time `json:"timestamp"`
    TraceID   string    `json:"trace_id,omitempty"`
    SpanID    string    `json:"span_id,omitempty"`
    // Data contains the event-specific payload
    Data      json.RawMessage `json:"data"`
}

// Publisher publishes domain events to NATS JetStream
type Publisher struct {
    js     jetstream.JetStream
}

// Publish publishes an event with deduplication
func (p *Publisher) Publish(ctx context.Context, subject string, eventType string, data interface{}) error {
    payload, err := json.Marshal(data)
    if err != nil {
        return fmt.Errorf("marshaling event data: %w", err)
    }

    eventID := uuid.New().String()

    event := Event{
        EventID:   eventID,
        EventType: eventType,
        Version:   1,
        Timestamp: time.Now().UTC(),
        Data:      payload,
    }

    // Propagate trace context
    if span := trace.SpanFromContext(ctx); span != nil {
        event.TraceID = span.SpanContext().TraceID().String()
        event.SpanID = span.SpanContext().SpanID().String()
    }

    eventBytes, err := json.Marshal(event)
    if err != nil {
        return fmt.Errorf("marshaling event: %w", err)
    }

    // JetStream publish with deduplication
    // MsgID header is used for exactly-once within the Duplicates window
    ack, err := p.js.Publish(ctx, subject, eventBytes,
        jetstream.WithMsgID(eventID),
    )
    if err != nil {
        return fmt.Errorf("publishing to %s: %w", subject, err)
    }

    // If Duplicate is true, the message was already processed
    if ack.Duplicate {
        // This is not an error - just means we already published this event
        return nil
    }

    return nil
}

// OrderCreated publishes an order.created event
func (p *Publisher) OrderCreated(ctx context.Context, order Order) error {
    return p.Publish(ctx, "orders.created", "order.created", OrderCreatedData{
        OrderID:    order.ID,
        CustomerID: order.CustomerID,
        Items:      order.Items,
        Total:      order.Total,
        Currency:   order.Currency,
    })
}
```

### Durable Consumer with Pull Subscription

```go
package consumer

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/nats-io/nats.go/jetstream"
    "go.uber.org/zap"
)

// OrderConsumer processes order events from JetStream
type OrderConsumer struct {
    js         jetstream.JetStream
    consumer   jetstream.Consumer
    handler    EventHandler
    logger     *zap.Logger

    // DLQ publisher for failed messages
    dlqPublisher *DLQPublisher
}

type EventHandler interface {
    Handle(ctx context.Context, event Event) error
}

// NewOrderConsumer creates a durable consumer for order events
func NewOrderConsumer(ctx context.Context, js jetstream.JetStream, serviceID string, handler EventHandler, logger *zap.Logger) (*OrderConsumer, error) {
    // Create or bind to a durable consumer
    // Durable consumers survive service restarts
    consumer, err := js.CreateOrUpdateConsumer(ctx, "ORDERS", jetstream.ConsumerConfig{
        // Durable name persists state
        Durable: fmt.Sprintf("orders-%s", serviceID),

        // Process all events, not just new ones (for replay)
        DeliverPolicy: jetstream.DeliverAllPolicy,

        // Explicit ack required - message not redelivered until acked or max tries reached
        AckPolicy: jetstream.AckExplicitPolicy,

        // How long to wait for ack before redelivering
        AckWait: 30 * time.Second,

        // Max redeliveries before sending to DLQ
        MaxDeliver: 5,

        // Filter specific subject patterns
        FilterSubjects: []string{
            "orders.created",
            "orders.updated",
            "orders.cancelled",
        },

        // Max in-flight unacked messages
        MaxAckPending: 100,

        // Flow control
        FlowControl: true,
        Heartbeat:   10 * time.Second,
    })
    if err != nil {
        return nil, fmt.Errorf("creating consumer: %w", err)
    }

    return &OrderConsumer{
        js:       js,
        consumer: consumer,
        handler:  handler,
        logger:   logger,
    }, nil
}

// Start begins processing messages
func (oc *OrderConsumer) Start(ctx context.Context) error {
    // Pull-based consumption: we fetch batches
    // More control than push, better for backpressure
    msgCtx, err := oc.consumer.Messages(
        jetstream.PullMaxMessages(10), // Fetch up to 10 at a time
    )
    if err != nil {
        return fmt.Errorf("starting message context: %w", err)
    }

    go func() {
        defer msgCtx.Stop()
        for {
            select {
            case <-ctx.Done():
                return
            default:
            }

            msg, err := msgCtx.Next()
            if err != nil {
                if ctx.Err() != nil {
                    return
                }
                if errors.Is(err, jetstream.ErrMsgIteratorClosed) {
                    oc.logger.Info("Message iterator closed")
                    return
                }
                oc.logger.Error("Error fetching message", zap.Error(err))
                time.Sleep(time.Second)
                continue
            }

            oc.processMessage(ctx, msg)
        }
    }()

    return nil
}

// processMessage handles a single message with retry and DLQ logic
func (oc *OrderConsumer) processMessage(ctx context.Context, msg jetstream.Msg) {
    meta, err := msg.Metadata()
    if err != nil {
        oc.logger.Error("Failed to get message metadata", zap.Error(err))
        msg.Nak()
        return
    }

    // Check delivery count for DLQ routing
    if meta.NumDelivered >= 5 {
        oc.logger.Error("Message exceeded max deliveries, routing to DLQ",
            zap.String("subject", msg.Subject()),
            zap.Uint64("seq", meta.Sequence.Stream),
            zap.Uint64("deliveries", meta.NumDelivered),
        )

        // Send to DLQ before acking the original
        if oc.dlqPublisher != nil {
            oc.dlqPublisher.Publish(ctx, msg)
        }

        // Ack to remove from pending (we've handled it via DLQ)
        if err := msg.TermMsg(); err != nil {
            oc.logger.Error("Failed to term message", zap.Error(err))
        }
        return
    }

    var event Event
    if err := json.Unmarshal(msg.Data(), &event); err != nil {
        oc.logger.Error("Failed to unmarshal event",
            zap.String("subject", msg.Subject()),
            zap.Error(err),
        )
        // Bad message format - don't retry
        msg.TermMsg()
        return
    }

    // Process with timeout
    processCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
    defer cancel()

    err = oc.handler.Handle(processCtx, event)
    if err != nil {
        oc.logger.Error("Failed to handle event",
            zap.String("event_type", event.EventType),
            zap.String("event_id", event.EventID),
            zap.Error(err),
            zap.Uint64("delivery_attempt", meta.NumDelivered),
        )

        // Nak with delay for backoff
        delay := time.Duration(meta.NumDelivered) * 5 * time.Second
        if delay > 30*time.Second {
            delay = 30 * time.Second
        }
        msg.NakWithDelay(delay)
        return
    }

    // Success - acknowledge
    if err := msg.Ack(); err != nil {
        oc.logger.Error("Failed to ack message", zap.Error(err))
    }
}
```

## Section 2: Watermill Event Router Abstraction

Watermill provides a broker-agnostic event routing framework that works with NATS, Kafka, RabbitMQ, and others.

### Setting Up Watermill with NATS JetStream

```go
package watermill

import (
    "context"
    "time"

    "github.com/ThreeDotsLabs/watermill"
    "github.com/ThreeDotsLabs/watermill-nats/v2/pkg/nats"
    "github.com/ThreeDotsLabs/watermill/components/cqrs"
    "github.com/ThreeDotsLabs/watermill/message"
    "github.com/ThreeDotsLabs/watermill/message/router/middleware"
    watermillnats "github.com/ThreeDotsLabs/watermill-nats/v2/pkg/nats"
    nc "github.com/nats-io/nats.go"
)

// NewWatermillRouter creates a production router with middleware
func NewWatermillRouter(logger watermill.LoggerAdapter) (*message.Router, error) {
    router, err := message.NewRouter(
        message.RouterConfig{
            CloseTimeout: 30 * time.Second,
        },
        logger,
    )
    if err != nil {
        return nil, err
    }

    // Add middleware
    router.AddMiddleware(
        // Recover from panics in handlers
        middleware.Recoverer,

        // Correlation ID propagation
        middleware.CorrelationID,

        // Retry failed messages
        middleware.Retry{
            MaxRetries:      5,
            InitialInterval: 100 * time.Millisecond,
            MaxInterval:     5 * time.Second,
            Multiplier:      2,
            Logger:          logger,
        }.Middleware,

        // Throttle processing rate
        middleware.NewThrottle(1000, time.Second).Middleware,

        // Poison queue for permanently failed messages
        middleware.PoisonQueue{
            PoisonQueueTopic: "dead_letter_queue",
            Publish:          poisonQueuePublisher,
        }.Middleware,
    )

    return router, nil
}

// NewJetStreamPublisher creates a Watermill publisher for NATS JetStream
func NewJetStreamPublisher(url string, logger watermill.LoggerAdapter) (message.Publisher, error) {
    conn, err := nc.Connect(url, nc.Name("watermill-publisher"))
    if err != nil {
        return nil, err
    }

    return watermillnats.NewPublisher(
        conn,
        watermillnats.PublisherConfig{
            JetStream: watermillnats.JetStreamConfig{
                Disabled: false,
                // Auto-create streams if they don't exist
                AutoProvision: false, // Use manual stream setup
            },
            Marshaler: watermillnats.GobMarshaler{},
        },
        logger,
    )
}

// NewJetStreamSubscriber creates a Watermill subscriber for NATS JetStream
func NewJetStreamSubscriber(url string, subscribeGroup string, logger watermill.LoggerAdapter) (message.Subscriber, error) {
    conn, err := nc.Connect(url, nc.Name(fmt.Sprintf("watermill-%s", subscribeGroup)))
    if err != nil {
        return nil, err
    }

    return watermillnats.NewSubscriber(
        conn,
        watermillnats.SubscriberConfig{
            JetStream: watermillnats.JetStreamConfig{
                Disabled: false,
                // Durable consumer name for persistence across restarts
                DurablePrefix:        subscribeGroup,
                DeliverPolicy:        watermillnats.DeliverAllPolicy,
                AckWaitTimeout:       30 * time.Second,
                MaxDeliver:           5,
                MaxAckPending:        100,
                SubscribeRetryLimit:  3,
                SubscribeRetryWait:   time.Second,
            },
            Unmarshaler: watermillnats.GobMarshaler{},
        },
        logger,
    )
}
```

### Event Handlers with CQRS Pattern

```go
package handlers

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/ThreeDotsLabs/watermill/components/cqrs"
    "github.com/ThreeDotsLabs/watermill/message"
)

// OrderCreatedHandler handles order.created events
type OrderCreatedHandler struct {
    inventoryService InventoryService
    emailService     EmailService
    analytics        AnalyticsService
}

func (h *OrderCreatedHandler) HandlerName() string {
    return "OrderCreatedHandler"
}

func (h *OrderCreatedHandler) NewEvent() interface{} {
    return &OrderCreatedEvent{}
}

func (h *OrderCreatedHandler) Handle(ctx context.Context, event interface{}) error {
    orderCreated, ok := event.(*OrderCreatedEvent)
    if !ok {
        return fmt.Errorf("unexpected event type: %T", event)
    }

    // Reserve inventory
    if err := h.inventoryService.Reserve(ctx, orderCreated.Items); err != nil {
        // Return error to trigger retry
        return fmt.Errorf("reserving inventory for order %s: %w",
            orderCreated.OrderID, err)
    }

    // Send confirmation email (non-critical, don't fail order processing)
    go func() {
        if err := h.emailService.SendOrderConfirmation(context.Background(),
            orderCreated.CustomerEmail, orderCreated.OrderID); err != nil {
            // Log but don't fail - email can be retried separately
        }
    }()

    // Track analytics
    h.analytics.TrackEvent(ctx, "order_created", map[string]interface{}{
        "order_id":    orderCreated.OrderID,
        "total":       orderCreated.Total,
        "item_count":  len(orderCreated.Items),
    })

    return nil
}

// SetupCQRS configures the CQRS event bus
func SetupCQRS(
    router *message.Router,
    publisher message.Publisher,
    subscriber message.Subscriber,
    deps Dependencies,
) (*cqrs.EventBus, *cqrs.EventProcessor, error) {
    marshaler := cqrs.JSONMarshaler{
        GenerateName: cqrs.StructName,
    }

    // Event bus for publishing
    eventBus, err := cqrs.NewEventBusWithConfig(publisher, cqrs.EventBusConfig{
        GeneratePublishTopic: func(params cqrs.GenerateEventPublishTopicParams) (string, error) {
            // Map event type to NATS subject
            return "events." + params.EventName, nil
        },
        Marshaler: marshaler,
    })
    if err != nil {
        return nil, nil, fmt.Errorf("creating event bus: %w", err)
    }

    // Event processor for consuming
    eventProcessor, err := cqrs.NewEventGroupProcessorWithConfig(
        router,
        cqrs.EventGroupProcessorConfig{
            GenerateSubscribeTopic: func(params cqrs.EventGroupProcessorGenerateSubscribeTopicParams) (string, error) {
                return "events." + params.EventName, nil
            },
            GroupSubscribeInitializer: cqrs.NewGroupSubscribeInitializer(subscriber),
            Marshaler: marshaler,
        },
    )
    if err != nil {
        return nil, nil, fmt.Errorf("creating event processor: %w", err)
    }

    // Register handlers
    err = eventProcessor.AddHandlersGroup(
        "order-processing-group",
        &OrderCreatedHandler{
            inventoryService: deps.InventoryService,
            emailService:     deps.EmailService,
            analytics:        deps.Analytics,
        },
        &OrderCancelledHandler{
            inventoryService: deps.InventoryService,
        },
        &OrderFulfilledHandler{
            analyticsService: deps.Analytics,
        },
    )
    if err != nil {
        return nil, nil, err
    }

    return eventBus, eventProcessor, nil
}
```

## Section 3: Event Sourcing with Event Store

```go
package eventsourcing

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "sync"
    "time"
)

// EventStore persists and retrieves domain events
type EventStore interface {
    Append(ctx context.Context, streamID string, events []StoredEvent, expectedVersion int64) error
    Load(ctx context.Context, streamID string, fromVersion int64) ([]StoredEvent, error)
    Subscribe(ctx context.Context, eventTypes []string) (<-chan StoredEvent, error)
}

// StoredEvent represents a persisted event
type StoredEvent struct {
    ID          string
    StreamID    string
    EventType   string
    Version     int64
    Timestamp   time.Time
    Data        json.RawMessage
    Metadata    json.RawMessage
}

// Aggregate is the base for all aggregate roots
type Aggregate struct {
    id             string
    version        int64
    pendingEvents  []StoredEvent
    mu             sync.Mutex
}

func (a *Aggregate) ID() string     { return a.id }
func (a *Aggregate) Version() int64 { return a.version }

// RaiseEvent records a new event on the aggregate
func (a *Aggregate) RaiseEvent(eventType string, data interface{}, metadata map[string]string) error {
    a.mu.Lock()
    defer a.mu.Unlock()

    payload, err := json.Marshal(data)
    if err != nil {
        return err
    }

    meta, err := json.Marshal(metadata)
    if err != nil {
        return err
    }

    a.pendingEvents = append(a.pendingEvents, StoredEvent{
        ID:        uuid.New().String(),
        StreamID:  a.id,
        EventType: eventType,
        Version:   a.version + int64(len(a.pendingEvents)) + 1,
        Timestamp: time.Now().UTC(),
        Data:      payload,
        Metadata:  meta,
    })

    return nil
}

// TakePendingEvents returns and clears pending events
func (a *Aggregate) TakePendingEvents() []StoredEvent {
    a.mu.Lock()
    defer a.mu.Unlock()
    events := a.pendingEvents
    a.pendingEvents = nil
    return events
}

// Order aggregate with event sourcing
type Order struct {
    Aggregate
    status   OrderStatus
    items    []OrderItem
    total    Money
    customerID string
}

type OrderStatus string

const (
    StatusDraft     OrderStatus = "draft"
    StatusConfirmed OrderStatus = "confirmed"
    StatusCancelled OrderStatus = "cancelled"
    StatusFulfilled OrderStatus = "fulfilled"
)

// CreateOrder creates a new order aggregate
func CreateOrder(id, customerID string, items []OrderItem) (*Order, error) {
    if len(items) == 0 {
        return nil, errors.New("order must have at least one item")
    }

    order := &Order{}
    order.id = id

    total := calculateTotal(items)

    // Raise the domain event
    if err := order.RaiseEvent("order.created", OrderCreatedData{
        OrderID:    id,
        CustomerID: customerID,
        Items:      items,
        Total:      total,
    }, map[string]string{
        "service": "order-service",
    }); err != nil {
        return nil, err
    }

    // Apply the event to mutate state
    order.apply(order.pendingEvents[len(order.pendingEvents)-1])

    return order, nil
}

// apply mutates the aggregate state based on an event
// This is called both when creating new events and when reconstituting from store
func (o *Order) apply(event StoredEvent) {
    switch event.EventType {
    case "order.created":
        var data OrderCreatedData
        json.Unmarshal(event.Data, &data)
        o.status = StatusConfirmed
        o.items = data.Items
        o.total = data.Total
        o.customerID = data.CustomerID
        o.version = event.Version

    case "order.cancelled":
        o.status = StatusCancelled
        o.version = event.Version

    case "order.fulfilled":
        o.status = StatusFulfilled
        o.version = event.Version
    }
}

// Reconstitute rebuilds an order from its event history
func ReconstitutOrder(events []StoredEvent) (*Order, error) {
    if len(events) == 0 {
        return nil, errors.New("no events to reconstitute from")
    }

    order := &Order{}
    for _, event := range events {
        order.apply(event)
    }
    order.id = events[0].StreamID

    return order, nil
}

// Repository using event store
type OrderRepository struct {
    store     EventStore
    publisher EventPublisher
}

func (r *OrderRepository) Save(ctx context.Context, order *Order) error {
    events := order.TakePendingEvents()
    if len(events) == 0 {
        return nil
    }

    // Optimistic concurrency: fail if version has changed since we loaded
    if err := r.store.Append(ctx, order.ID(), events, order.Version()-int64(len(events))); err != nil {
        return fmt.Errorf("appending events: %w", err)
    }

    // Publish events to message bus for other services
    for _, event := range events {
        if err := r.publisher.Publish(ctx, event.EventType, event); err != nil {
            // Log but don't fail - events are already persisted
            // Use an outbox pattern for guaranteed delivery
        }
    }

    return nil
}

func (r *OrderRepository) Load(ctx context.Context, orderID string) (*Order, error) {
    events, err := r.store.Load(ctx, orderID, 0)
    if err != nil {
        return nil, fmt.Errorf("loading events: %w", err)
    }
    if len(events) == 0 {
        return nil, ErrOrderNotFound
    }

    return ReconstitutOrder(events)
}
```

## Section 4: Dead Letter Queue Handling

```go
package dlq

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

// DLQMessage represents a message that failed processing
type DLQMessage struct {
    OriginalSubject  string          `json:"original_subject"`
    OriginalEventID  string          `json:"original_event_id"`
    FailureReason    string          `json:"failure_reason"`
    DeliveryAttempts uint64          `json:"delivery_attempts"`
    FirstFailedAt    time.Time       `json:"first_failed_at"`
    LastFailedAt     time.Time       `json:"last_failed_at"`
    OriginalData     json.RawMessage `json:"original_data"`
}

// DLQPublisher sends failed messages to the dead letter queue
type DLQPublisher struct {
    js      jetstream.JetStream
    stream  string
    subject string
}

// SetupDLQStream creates the dead letter queue stream
func SetupDLQStream(ctx context.Context, js jetstream.JetStream) (jetstream.Stream, error) {
    return js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
        Name:     "DLQ",
        Subjects: []string{"dlq.>"},
        // Long retention for investigation
        MaxAge:   90 * 24 * time.Hour,
        MaxBytes: 5 * 1024 * 1024 * 1024, // 5GB
        Storage:  jetstream.FileStorage,
        Replicas: 3,
    })
}

func (d *DLQPublisher) Publish(ctx context.Context, msg jetstream.Msg) error {
    meta, err := msg.Metadata()
    if err != nil {
        return err
    }

    dlqMsg := DLQMessage{
        OriginalSubject:  msg.Subject(),
        DeliveryAttempts: meta.NumDelivered,
        FirstFailedAt:    meta.Timestamp,
        LastFailedAt:     time.Now().UTC(),
        OriginalData:     msg.Data(),
    }

    // Extract event ID from original message if available
    var event Event
    if err := json.Unmarshal(msg.Data(), &event); err == nil {
        dlqMsg.OriginalEventID = event.EventID
    }

    data, err := json.Marshal(dlqMsg)
    if err != nil {
        return err
    }

    subject := fmt.Sprintf("dlq.%s", msg.Subject())
    _, err = d.js.Publish(ctx, subject, data)
    return err
}

// DLQProcessor handles dead letter queue messages for manual intervention
type DLQProcessor struct {
    js       jetstream.JetStream
    handlers map[string]DLQHandler
}

type DLQHandler func(ctx context.Context, msg DLQMessage) error

func (p *DLQProcessor) RegisterHandler(originalSubject string, handler DLQHandler) {
    p.handlers[originalSubject] = handler
}

func (p *DLQProcessor) Process(ctx context.Context, autoRetry bool) error {
    consumer, err := p.js.CreateOrUpdateConsumer(ctx, "DLQ", jetstream.ConsumerConfig{
        Durable:        "dlq-processor",
        DeliverPolicy:  jetstream.DeliverAllPolicy,
        AckPolicy:      jetstream.AckExplicitPolicy,
        FilterSubject:  "dlq.>",
        MaxAckPending:  10, // Process slowly
    })
    if err != nil {
        return err
    }

    msgCtx, err := consumer.Messages()
    if err != nil {
        return err
    }
    defer msgCtx.Stop()

    for {
        select {
        case <-ctx.Done():
            return nil
        default:
        }

        msg, err := msgCtx.Next()
        if err != nil {
            if ctx.Err() != nil {
                return nil
            }
            time.Sleep(time.Second)
            continue
        }

        var dlqMsg DLQMessage
        if err := json.Unmarshal(msg.Data(), &dlqMsg); err != nil {
            msg.TermMsg() // Bad format, skip
            continue
        }

        handler, ok := p.handlers[dlqMsg.OriginalSubject]
        if !ok {
            // No handler registered, log and skip
            msg.Ack()
            continue
        }

        if err := handler(ctx, dlqMsg); err != nil {
            if autoRetry {
                msg.NakWithDelay(5 * time.Minute)
            } else {
                msg.Ack() // Manual processing, just mark as seen
            }
            continue
        }

        msg.Ack()
    }
}
```

## Section 5: Exactly-Once Delivery with Idempotent Consumers

```go
package idempotent

import (
    "context"
    "errors"
    "fmt"
    "time"
)

// ProcessedEventStore tracks which event IDs have been processed
type ProcessedEventStore interface {
    // MarkProcessed marks an event as processed, returning false if already processed
    MarkProcessed(ctx context.Context, eventID string, consumerID string) (bool, error)
    // IsProcessed checks if an event was already processed
    IsProcessed(ctx context.Context, eventID string, consumerID string) (bool, error)
    // CleanupOld removes processed event records older than the retention period
    CleanupOld(ctx context.Context, olderThan time.Duration) error
}

// RedisProcessedEventStore uses Redis for idempotency tracking
type RedisProcessedEventStore struct {
    client    RedisClient
    keyPrefix string
    retention time.Duration
}

func (s *RedisProcessedEventStore) MarkProcessed(ctx context.Context, eventID, consumerID string) (bool, error) {
    key := fmt.Sprintf("%s:%s:%s", s.keyPrefix, consumerID, eventID)

    // SETNX - set if not exists, returns 1 if set, 0 if already exists
    // This is atomic - no race condition between check and set
    result, err := s.client.SetNX(ctx, key, time.Now().UTC().Format(time.RFC3339), s.retention)
    if err != nil {
        return false, fmt.Errorf("marking event processed: %w", err)
    }

    return result, nil // true = was first time processing, false = duplicate
}

func (s *RedisProcessedEventStore) IsProcessed(ctx context.Context, eventID, consumerID string) (bool, error) {
    key := fmt.Sprintf("%s:%s:%s", s.keyPrefix, consumerID, eventID)
    exists, err := s.client.Exists(ctx, key)
    return exists, err
}

// IdempotentHandler wraps a handler with exactly-once processing
type IdempotentHandler struct {
    consumerID   string
    store        ProcessedEventStore
    innerHandler EventHandler
}

func NewIdempotentHandler(consumerID string, store ProcessedEventStore, handler EventHandler) *IdempotentHandler {
    return &IdempotentHandler{
        consumerID:   consumerID,
        store:        store,
        innerHandler: handler,
    }
}

func (h *IdempotentHandler) Handle(ctx context.Context, event Event) error {
    // Check and mark in a single atomic operation
    isNew, err := h.store.MarkProcessed(ctx, event.EventID, h.consumerID)
    if err != nil {
        // If we can't check idempotency, fail safe: don't process
        return fmt.Errorf("checking idempotency: %w", err)
    }

    if !isNew {
        // Already processed - this is not an error, just a duplicate
        return nil
    }

    // Process the event
    if err := h.innerHandler.Handle(ctx, event); err != nil {
        // If handler failed, we should remove the idempotency record
        // so the event can be retried
        // Note: There's a brief window where the event is marked processed
        // but the handler failed. This is acceptable for at-least-once
        // semantics with idempotent handlers.
        return err
    }

    return nil
}
```

## Section 6: Testing Event-Driven Systems

```go
package testing

import (
    "context"
    "encoding/json"
    "sync"
    "testing"
    "time"

    "github.com/ThreeDotsLabs/watermill/message"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

// TestPublisher captures published messages for assertion
type TestPublisher struct {
    mu       sync.Mutex
    messages map[string][]message.Message
    closed   bool
}

func NewTestPublisher() *TestPublisher {
    return &TestPublisher{
        messages: make(map[string][]message.Message),
    }
}

func (p *TestPublisher) Publish(topic string, messages ...*message.Message) error {
    p.mu.Lock()
    defer p.mu.Unlock()

    if p.closed {
        return ErrPublisherClosed
    }

    for _, msg := range messages {
        p.messages[topic] = append(p.messages[topic], *msg)
    }
    return nil
}

func (p *TestPublisher) Close() error {
    p.mu.Lock()
    defer p.mu.Unlock()
    p.closed = true
    return nil
}

// Published returns all messages published to a topic
func (p *TestPublisher) Published(topic string) []message.Message {
    p.mu.Lock()
    defer p.mu.Unlock()
    return append([]message.Message{}, p.messages[topic]...)
}

// WaitForMessages waits up to timeout for n messages on a topic
func (p *TestPublisher) WaitForMessages(t *testing.T, topic string, count int, timeout time.Duration) []message.Message {
    t.Helper()
    deadline := time.Now().Add(timeout)

    for time.Now().Before(deadline) {
        msgs := p.Published(topic)
        if len(msgs) >= count {
            return msgs[:count]
        }
        time.Sleep(10 * time.Millisecond)
    }

    t.Fatalf("timeout waiting for %d messages on %s, got %d", count, topic, len(p.Published(topic)))
    return nil
}

// TestSubscriber delivers test messages to subscribers
type TestSubscriber struct {
    mu      sync.Mutex
    queues  map[string]chan *message.Message
}

func NewTestSubscriber() *TestSubscriber {
    return &TestSubscriber{
        queues: make(map[string]chan *message.Message),
    }
}

func (s *TestSubscriber) Subscribe(_ context.Context, topic string) (<-chan *message.Message, error) {
    s.mu.Lock()
    defer s.mu.Unlock()

    ch := make(chan *message.Message, 100)
    s.queues[topic] = ch
    return ch, nil
}

func (s *TestSubscriber) Close() error { return nil }

// Inject sends a test message to a subscribed topic
func (s *TestSubscriber) Inject(topic string, payload interface{}) {
    s.mu.Lock()
    ch, ok := s.queues[topic]
    s.mu.Unlock()

    if !ok {
        panic(fmt.Sprintf("no subscriber for topic: %s", topic))
    }

    data, _ := json.Marshal(payload)
    msg := message.NewMessage(watermill.NewUUID(), data)
    ch <- msg
}

// Integration test example
func TestOrderProcessingEventFlow(t *testing.T) {
    // Setup
    publisher := NewTestPublisher()
    subscriber := NewTestSubscriber()

    // Create in-memory event store
    store := newInMemoryEventStore()

    // Create services under test
    orderRepo := &OrderRepository{store: store, publisher: &watermillPublisher{publisher}}
    inventorySvc := &MockInventoryService{}

    handler := &OrderCreatedHandler{
        inventoryService: inventorySvc,
    }

    // Test creating an order
    t.Run("OrderCreated publishes event and reserves inventory", func(t *testing.T) {
        ctx := context.Background()

        order, err := CreateOrder("order-123", "customer-456", []OrderItem{
            {ProductID: "prod-1", Quantity: 2, Price: Money{Amount: 2999, Currency: "USD"}},
        })
        require.NoError(t, err)

        err = orderRepo.Save(ctx, order)
        require.NoError(t, err)

        // Wait for order.created event to be published
        msgs := publisher.WaitForMessages(t, "events.order.created", 1, 5*time.Second)
        require.Len(t, msgs, 1)

        // Verify event payload
        var event Event
        require.NoError(t, json.Unmarshal(msgs[0].Payload, &event))
        assert.Equal(t, "order.created", event.EventType)

        var data OrderCreatedData
        require.NoError(t, json.Unmarshal(event.Data, &data))
        assert.Equal(t, "order-123", data.OrderID)
        assert.Equal(t, "customer-456", data.CustomerID)

        // Simulate the event being consumed
        subscriber.Inject("events.order.created", event)

        // Process the event
        err = handler.Handle(ctx, event)
        require.NoError(t, err)

        // Verify inventory was reserved
        assert.True(t, inventorySvc.Reserved["prod-1"] == 2)
    })

    t.Run("Duplicate events are idempotent", func(t *testing.T) {
        ctx := context.Background()

        store := NewRedisProcessedEventStore(testRedisClient, "test", time.Hour)
        idempotentHandler := NewIdempotentHandler("inventory-service", store, handler)

        event := Event{
            EventID:   "test-event-123",
            EventType: "order.created",
        }

        // Process same event twice
        err1 := idempotentHandler.Handle(ctx, event)
        err2 := idempotentHandler.Handle(ctx, event)

        require.NoError(t, err1)
        require.NoError(t, err2)

        // Inventory should only be reserved once
        assert.Equal(t, 1, inventorySvc.ReservationCalls)
    })

    t.Run("Failed handler routes to DLQ", func(t *testing.T) {
        ctx := context.Background()

        failingHandler := &FailingHandler{failCount: 5}
        dlqPublisher := NewTestPublisher()
        dlqSvc := &DLQPublisher{publisher: &watermillPublisher{dlqPublisher}}

        consumer := &OrderConsumer{
            handler:      failingHandler,
            dlqPublisher: dlqSvc,
        }

        // Simulate 5 delivery attempts
        for i := 0; i < 5; i++ {
            msg := createTestMsg(event, uint64(i+1))
            consumer.processMessage(ctx, msg)
        }

        // On 5th attempt, should route to DLQ
        dlqMsgs := dlqPublisher.WaitForMessages(t, "dlq.orders.created", 1, time.Second)
        require.Len(t, dlqMsgs, 1)

        var dlqMsg DLQMessage
        require.NoError(t, json.Unmarshal(dlqMsgs[0].Payload, &dlqMsg))
        assert.Equal(t, uint64(5), dlqMsg.DeliveryAttempts)
    })
}
```

Event-driven architecture in Go, built on NATS JetStream and Watermill, provides a production-ready foundation for microservices that need resilience, scalability, and clear domain boundaries. The combination of durable consumers for at-least-once delivery, idempotent handlers for exactly-once processing semantics, and dead letter queues for failure visibility gives teams the observability and reliability characteristics required for production systems. The testing patterns shown enable validation of event-driven behavior in unit tests without requiring a live broker, dramatically improving development velocity.
