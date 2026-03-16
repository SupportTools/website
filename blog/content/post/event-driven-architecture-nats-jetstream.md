---
title: "Event-Driven Architecture with NATS JetStream"
date: 2026-07-06T00:00:00-05:00
draft: false
tags: ["NATS", "JetStream", "Event-Driven Architecture", "Streaming", "Microservices", "Message Queue", "Real-time"]
categories:
- Streaming
- Architecture
- Microservices
- Real-time
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into building robust event-driven architectures using NATS JetStream, covering stream processing patterns, guaranteed delivery mechanisms, clustering for high availability, microservices integration, and performance optimization techniques"
more_link: "yes"
url: "/event-driven-architecture-nats-jetstream/"
---

Event-driven architectures have become fundamental to building scalable, resilient microservices systems. NATS JetStream emerges as a powerful solution that combines the simplicity of NATS Core with the persistence and reliability required for mission-critical applications. This comprehensive guide explores how to architect, implement, and optimize event-driven systems using NATS JetStream, from basic streaming patterns to advanced clustering configurations.

<!--more-->

# Event-Driven Architecture with NATS JetStream

## NATS JetStream Architecture

NATS JetStream represents a significant evolution from traditional message queues, offering a cloud-native approach to event streaming with built-in persistence, replay capabilities, and exactly-once delivery guarantees.

### Core Components and Data Flow

Understanding JetStream's architecture is crucial for designing effective event-driven systems:

```
┌─────────────────────────────────────────────────────────────┐
│                        NATS Server                          │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │   NATS Core     │    │   JetStream     │                │
│  │   (Messaging)   │    │   (Streaming)   │                │
│  └─────────────────┘    └─────────────────┘                │
│           │                       │                         │
│           └───────────────┬───────┘                         │
├───────────────────────────┼─────────────────────────────────┤
│                          │                                  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                  Stream Storage                      │  │
│  ├──────────────┬─────────────┬─────────────┬───────────┤  │
│  │   Stream 1   │   Stream 2  │   Stream 3  │  Stream N │  │
│  │              │             │             │           │  │
│  │  Messages    │  Messages   │  Messages   │ Messages  │  │
│  │  Consumers   │  Consumers  │  Consumers  │ Consumers │  │
│  │  Policies    │  Policies   │  Policies   │ Policies  │  │
│  └──────────────┴─────────────┴─────────────┴───────────┘  │
└─────────────────────────────────────────────────────────────┘
                               │
                  ┌────────────┴────────────┐
                  │                         │
           ┌──────▼──────┐           ┌──────▼──────┐
           │  Publisher  │           │  Consumer   │
           │ Application │           │ Application │
           └─────────────┘           └─────────────┘
```

### Stream and Consumer Configuration

JetStream's flexibility comes from its configurable streams and consumers:

```go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "time"

    "github.com/nats-io/nats.go"
)

type JetStreamManager struct {
    nc *nats.Conn
    js nats.JetStreamContext
}

func NewJetStreamManager(url string) (*JetStreamManager, error) {
    // Connect to NATS with enhanced options
    nc, err := nats.Connect(url,
        nats.ReconnectWait(2*time.Second),
        nats.MaxReconnects(5),
        nats.ReconnectBufSize(5*1024*1024), // 5MB buffer
        nats.DrainTimeout(10*time.Second),
        nats.ErrorHandler(func(nc *nats.Conn, s *nats.Subscription, err error) {
            log.Printf("NATS error: %v on connection %v, subscription %v", err, nc, s)
        }),
        nats.DisconnectErrHandler(func(nc *nats.Conn, err error) {
            log.Printf("NATS disconnected: %v", err)
        }),
        nats.ReconnectHandler(func(nc *nats.Conn) {
            log.Printf("NATS reconnected to %v", nc.ConnectedUrl())
        }),
    )
    if err != nil {
        return nil, fmt.Errorf("failed to connect to NATS: %w", err)
    }

    // Create JetStream context
    js, err := nc.JetStream()
    if err != nil {
        return nil, fmt.Errorf("failed to create JetStream context: %w", err)
    }

    return &JetStreamManager{
        nc: nc,
        js: js,
    }, nil
}

func (jsm *JetStreamManager) CreateOptimizedStream(name string, subjects []string) error {
    streamConfig := &nats.StreamConfig{
        Name:              name,
        Subjects:          subjects,
        Retention:         nats.InterestPolicy,     // Delete after consumers ack
        MaxConsumers:      -1,                      // Unlimited consumers
        MaxMsgs:           1000000,                 // 1M messages max
        MaxBytes:          100 * 1024 * 1024,      // 100MB max
        MaxAge:            24 * time.Hour,          // 24 hour retention
        MaxMsgSize:        1024 * 1024,             // 1MB max message size
        Storage:           nats.FileStorage,         // Persistent storage
        Replicas:          3,                       // HA with 3 replicas
        NoAck:             false,                   // Require acknowledgments
        Discard:           nats.DiscardOld,         // Remove old when limits hit
        DuplicateWindow:   2 * time.Minute,        // Deduplication window
        
        // Compression settings for efficiency
        Compression: nats.S2Compression,
        
        // Subject transform for complex routing
        SubjectTransform: &nats.SubjectTransformConfig{
            Source:      "events.>",
            Destination: "processed.{{wildcard(1)}}",
        },
        
        // Advanced placement for geo-distribution
        Placement: &nats.Placement{
            Cluster: "production-cluster",
            Tags:    []string{"ssd", "high-memory"},
        },
    }

    _, err := jsm.js.AddStream(streamConfig)
    if err != nil {
        return fmt.Errorf("failed to create stream %s: %w", name, err)
    }

    log.Printf("Created optimized stream: %s", name)
    return nil
}

func (jsm *JetStreamManager) CreateConsumer(streamName, consumerName string, 
    config ConsumerConfig) (*nats.ConsumerInfo, error) {
    
    consumerConfig := &nats.ConsumerConfig{
        Durable:           consumerName,
        DeliverPolicy:     config.DeliverPolicy,
        OptStartSeq:       config.StartSequence,
        OptStartTime:      config.StartTime,
        AckPolicy:         config.AckPolicy,
        AckWait:           config.AckWait,
        MaxDeliver:        config.MaxRetries,
        BackOff:           config.BackoffDurations,
        ReplayPolicy:      config.ReplayPolicy,
        FilterSubject:     config.FilterSubject,
        SampleFreq:        config.SampleFrequency,
        MaxRequestBatch:   config.BatchSize,
        MaxRequestExpires: config.RequestExpiry,
        
        // Flow control and rate limiting
        RateLimit: config.RateLimit, // Messages per second
        
        // Memory optimization
        MemoryStorage: config.MemoryStorage,
        
        // Heartbeat for consumer health monitoring
        Heartbeat: 30 * time.Second,
        
        // Consumer metadata for debugging
        Description: fmt.Sprintf("Consumer for %s processing %s events", 
            consumerName, config.FilterSubject),
    }

    info, err := jsm.js.AddConsumer(streamName, consumerConfig)
    if err != nil {
        return nil, fmt.Errorf("failed to create consumer %s: %w", consumerName, err)
    }

    return info, nil
}

type ConsumerConfig struct {
    DeliverPolicy     nats.DeliverPolicy
    StartSequence     uint64
    StartTime         *time.Time
    AckPolicy         nats.AckPolicy
    AckWait           time.Duration
    MaxRetries        int
    BackoffDurations  []time.Duration
    ReplayPolicy      nats.ReplayPolicy
    FilterSubject     string
    SampleFrequency   string
    BatchSize         int
    RequestExpiry     time.Duration
    RateLimit         uint64
    MemoryStorage     bool
}

// Event structures for type safety
type EventEnvelope struct {
    ID        string                 `json:"id"`
    Type      string                 `json:"type"`
    Source    string                 `json:"source"`
    Subject   string                 `json:"subject"`
    Time      time.Time              `json:"time"`
    Data      map[string]interface{} `json:"data"`
    Metadata  EventMetadata          `json:"metadata"`
}

type EventMetadata struct {
    Version     string            `json:"version"`
    ContentType string            `json:"content_type"`
    Headers     map[string]string `json:"headers"`
    TraceID     string            `json:"trace_id"`
    CorrelationID string          `json:"correlation_id"`
}

func (jsm *JetStreamManager) PublishEvent(subject string, event EventEnvelope) error {
    // Ensure event metadata
    if event.ID == "" {
        event.ID = generateEventID()
    }
    if event.Time.IsZero() {
        event.Time = time.Now()
    }
    
    // Serialize event
    data, err := json.Marshal(event)
    if err != nil {
        return fmt.Errorf("failed to marshal event: %w", err)
    }
    
    // Publish with deduplication
    ack, err := jsm.js.Publish(subject, data, nats.MsgId(event.ID))
    if err != nil {
        return fmt.Errorf("failed to publish event: %w", err)
    }
    
    log.Printf("Published event %s to %s (seq: %d)", event.ID, subject, ack.Sequence)
    return nil
}

func generateEventID() string {
    return fmt.Sprintf("evt_%d_%s", time.Now().UnixNano(), 
        randomString(8))
}

func randomString(length int) string {
    const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
    b := make([]byte, length)
    for i := range b {
        b[i] = charset[rand.Intn(len(charset))]
    }
    return string(b)
}
```

## Stream Processing Patterns

JetStream supports various stream processing patterns essential for event-driven architectures.

### Event Sourcing Implementation

Implementing event sourcing with JetStream for complete audit trails:

```go
package eventsource

import (
    "context"
    "encoding/json"
    "fmt"
    "reflect"
    "time"

    "github.com/nats-io/nats.go"
)

type EventStore struct {
    js nats.JetStreamContext
    streamName string
}

type Event interface {
    GetAggregateID() string
    GetEventType() string
    GetVersion() int
    GetTimestamp() time.Time
}

type BaseEvent struct {
    AggregateID string    `json:"aggregate_id"`
    EventType   string    `json:"event_type"`
    Version     int       `json:"version"`
    Timestamp   time.Time `json:"timestamp"`
}

func (e BaseEvent) GetAggregateID() string { return e.AggregateID }
func (e BaseEvent) GetEventType() string   { return e.EventType }
func (e BaseEvent) GetVersion() int        { return e.Version }
func (e BaseEvent) GetTimestamp() time.Time { return e.Timestamp }

// Domain events for an e-commerce system
type OrderCreated struct {
    BaseEvent
    CustomerID string  `json:"customer_id"`
    Amount     float64 `json:"amount"`
    Items      []Item  `json:"items"`
}

type OrderShipped struct {
    BaseEvent
    TrackingNumber string `json:"tracking_number"`
    ShippingDate   time.Time `json:"shipping_date"`
    Carrier        string    `json:"carrier"`
}

type OrderCancelled struct {
    BaseEvent
    Reason        string    `json:"reason"`
    RefundAmount  float64   `json:"refund_amount"`
    CancelledDate time.Time `json:"cancelled_date"`
}

type Item struct {
    SKU      string  `json:"sku"`
    Quantity int     `json:"quantity"`
    Price    float64 `json:"price"`
}

func NewEventStore(js nats.JetStreamContext, streamName string) *EventStore {
    return &EventStore{
        js:         js,
        streamName: streamName,
    }
}

func (es *EventStore) AppendEvents(aggregateID string, events []Event, 
    expectedVersion int) error {
    
    // Check current version for optimistic concurrency
    currentVersion, err := es.getCurrentVersion(aggregateID)
    if err != nil {
        return fmt.Errorf("failed to get current version: %w", err)
    }
    
    if currentVersion != expectedVersion {
        return fmt.Errorf("concurrency conflict: expected version %d, got %d", 
            expectedVersion, currentVersion)
    }
    
    // Publish events atomically using transactions
    for i, event := range events {
        // Set version for this event
        if setter, ok := event.(interface{ SetVersion(int) }); ok {
            setter.SetVersion(expectedVersion + i + 1)
        }
        
        subject := fmt.Sprintf("events.%s.%s", aggregateID, event.GetEventType())
        
        eventData, err := json.Marshal(event)
        if err != nil {
            return fmt.Errorf("failed to marshal event: %w", err)
        }
        
        // Publish with headers for metadata
        headers := nats.Header{}
        headers.Set("Aggregate-ID", aggregateID)
        headers.Set("Event-Type", event.GetEventType())
        headers.Set("Event-Version", fmt.Sprintf("%d", event.GetVersion()))
        headers.Set("Event-Timestamp", event.GetTimestamp().Format(time.RFC3339))
        
        msg := &nats.Msg{
            Subject: subject,
            Data:    eventData,
            Header:  headers,
        }
        
        ack, err := es.js.PublishMsg(msg)
        if err != nil {
            return fmt.Errorf("failed to publish event: %w", err)
        }
        
        fmt.Printf("Published event %s for aggregate %s (seq: %d)\n", 
            event.GetEventType(), aggregateID, ack.Sequence)
    }
    
    return nil
}

func (es *EventStore) GetEvents(aggregateID string, fromVersion int) ([]Event, error) {
    subject := fmt.Sprintf("events.%s.>", aggregateID)
    
    // Create temporary consumer for reading events
    consumerConfig := &nats.ConsumerConfig{
        DeliverPolicy: nats.DeliverByStartSequence,
        OptStartSeq:   uint64(fromVersion),
        AckPolicy:     nats.AckExplicitPolicy,
        FilterSubject: subject,
    }
    
    sub, err := es.js.PullSubscribe(subject, "", nats.ConsumerConfig(*consumerConfig))
    if err != nil {
        return nil, fmt.Errorf("failed to create subscription: %w", err)
    }
    defer sub.Unsubscribe()
    
    var events []Event
    
    // Fetch events in batches
    for {
        msgs, err := sub.Fetch(100, nats.MaxWait(1*time.Second))
        if err != nil {
            if err == nats.ErrTimeout {
                break // No more messages
            }
            return nil, fmt.Errorf("failed to fetch messages: %w", err)
        }
        
        for _, msg := range msgs {
            event, err := es.deserializeEvent(msg)
            if err != nil {
                return nil, fmt.Errorf("failed to deserialize event: %w", err)
            }
            
            events = append(events, event)
            msg.Ack()
        }
        
        if len(msgs) == 0 {
            break
        }
    }
    
    return events, nil
}

func (es *EventStore) deserializeEvent(msg *nats.Msg) (Event, error) {
    eventType := msg.Header.Get("Event-Type")
    
    var event Event
    
    switch eventType {
    case "OrderCreated":
        event = &OrderCreated{}
    case "OrderShipped":
        event = &OrderShipped{}
    case "OrderCancelled":
        event = &OrderCancelled{}
    default:
        return nil, fmt.Errorf("unknown event type: %s", eventType)
    }
    
    if err := json.Unmarshal(msg.Data, event); err != nil {
        return nil, fmt.Errorf("failed to unmarshal event: %w", err)
    }
    
    return event, nil
}

func (es *EventStore) getCurrentVersion(aggregateID string) (int, error) {
    // Get the last event for this aggregate
    subject := fmt.Sprintf("events.%s.>", aggregateID)
    
    // Use consumer to get the last message
    consumerConfig := &nats.ConsumerConfig{
        DeliverPolicy: nats.DeliverLastPerSubject,
        AckPolicy:     nats.AckExplicitPolicy,
        FilterSubject: subject,
    }
    
    sub, err := es.js.PullSubscribe(subject, "", nats.ConsumerConfig(*consumerConfig))
    if err != nil {
        return 0, fmt.Errorf("failed to create subscription: %w", err)
    }
    defer sub.Unsubscribe()
    
    msgs, err := sub.Fetch(1, nats.MaxWait(1*time.Second))
    if err != nil {
        if err == nats.ErrTimeout {
            return 0, nil // No events yet
        }
        return 0, fmt.Errorf("failed to fetch last message: %w", err)
    }
    
    if len(msgs) == 0 {
        return 0, nil
    }
    
    versionStr := msgs[0].Header.Get("Event-Version")
    var version int
    if _, err := fmt.Sscanf(versionStr, "%d", &version); err != nil {
        return 0, fmt.Errorf("failed to parse version: %w", err)
    }
    
    msgs[0].Ack()
    return version, nil
}

// Aggregate reconstruction
type Order struct {
    ID         string    `json:"id"`
    CustomerID string    `json:"customer_id"`
    Amount     float64   `json:"amount"`
    Items      []Item    `json:"items"`
    Status     string    `json:"status"`
    CreatedAt  time.Time `json:"created_at"`
    ShippedAt  *time.Time `json:"shipped_at,omitempty"`
    Version    int       `json:"version"`
}

func (es *EventStore) ReconstructAggregate(aggregateID string) (*Order, error) {
    events, err := es.GetEvents(aggregateID, 0)
    if err != nil {
        return nil, fmt.Errorf("failed to get events: %w", err)
    }
    
    if len(events) == 0 {
        return nil, fmt.Errorf("aggregate not found: %s", aggregateID)
    }
    
    order := &Order{ID: aggregateID}
    
    for _, event := range events {
        switch e := event.(type) {
        case *OrderCreated:
            order.CustomerID = e.CustomerID
            order.Amount = e.Amount
            order.Items = e.Items
            order.Status = "created"
            order.CreatedAt = e.Timestamp
            
        case *OrderShipped:
            order.Status = "shipped"
            order.ShippedAt = &e.ShippingDate
            
        case *OrderCancelled:
            order.Status = "cancelled"
        }
        
        order.Version = event.GetVersion()
    }
    
    return order, nil
}

// Usage example
func ExampleEventSourcing() {
    // Connect to NATS JetStream
    nc, _ := nats.Connect("nats://localhost:4222")
    js, _ := nc.JetStream()
    
    eventStore := NewEventStore(js, "event-store")
    
    // Create new order
    orderID := "order-123"
    events := []Event{
        &OrderCreated{
            BaseEvent: BaseEvent{
                AggregateID: orderID,
                EventType:   "OrderCreated",
                Timestamp:   time.Now(),
            },
            CustomerID: "customer-456",
            Amount:     99.99,
            Items: []Item{
                {SKU: "SKU001", Quantity: 2, Price: 49.995},
            },
        },
    }
    
    err := eventStore.AppendEvents(orderID, events, 0)
    if err != nil {
        log.Printf("Failed to append events: %v", err)
        return
    }
    
    // Ship the order
    shipEvents := []Event{
        &OrderShipped{
            BaseEvent: BaseEvent{
                AggregateID: orderID,
                EventType:   "OrderShipped",
                Timestamp:   time.Now(),
            },
            TrackingNumber: "TRACK123",
            ShippingDate:   time.Now(),
            Carrier:        "FedEx",
        },
    }
    
    err = eventStore.AppendEvents(orderID, shipEvents, 1)
    if err != nil {
        log.Printf("Failed to append ship events: %v", err)
        return
    }
    
    // Reconstruct the order
    order, err := eventStore.ReconstructAggregate(orderID)
    if err != nil {
        log.Printf("Failed to reconstruct order: %v", err)
        return
    }
    
    fmt.Printf("Reconstructed order: %+v\n", order)
}
```

### CQRS with Read Model Projections

Implementing Command Query Responsibility Segregation with projections:

```go
package cqrs

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "sync"
    "time"

    "github.com/nats-io/nats.go"
)

type ProjectionManager struct {
    js          nats.JetStreamContext
    projections map[string]*Projection
    mu          sync.RWMutex
}

type Projection struct {
    Name            string
    StreamName      string
    ConsumerName    string
    FilterSubjects  []string
    Handler         ProjectionHandler
    subscription    *nats.Subscription
    lastProcessed   uint64
    mu              sync.RWMutex
}

type ProjectionHandler interface {
    Handle(event Event) error
    GetName() string
}

// Order summary projection for fast queries
type OrderSummaryProjection struct {
    store map[string]*OrderSummary // In production, use Redis/MongoDB
    mu    sync.RWMutex
}

type OrderSummary struct {
    ID           string    `json:"id"`
    CustomerID   string    `json:"customer_id"`
    Status       string    `json:"status"`
    TotalAmount  float64   `json:"total_amount"`
    ItemCount    int       `json:"item_count"`
    CreatedAt    time.Time `json:"created_at"`
    LastUpdated  time.Time `json:"last_updated"`
}

func NewOrderSummaryProjection() *OrderSummaryProjection {
    return &OrderSummaryProjection{
        store: make(map[string]*OrderSummary),
    }
}

func (p *OrderSummaryProjection) GetName() string {
    return "order-summary"
}

func (p *OrderSummaryProjection) Handle(event Event) error {
    p.mu.Lock()
    defer p.mu.Unlock()
    
    aggregateID := event.GetAggregateID()
    
    switch e := event.(type) {
    case *OrderCreated:
        summary := &OrderSummary{
            ID:          aggregateID,
            CustomerID:  e.CustomerID,
            Status:      "created",
            TotalAmount: e.Amount,
            ItemCount:   len(e.Items),
            CreatedAt:   e.Timestamp,
            LastUpdated: e.Timestamp,
        }
        p.store[aggregateID] = summary
        log.Printf("Created order summary for %s", aggregateID)
        
    case *OrderShipped:
        if summary, exists := p.store[aggregateID]; exists {
            summary.Status = "shipped"
            summary.LastUpdated = e.Timestamp
            log.Printf("Updated order summary for %s: shipped", aggregateID)
        }
        
    case *OrderCancelled:
        if summary, exists := p.store[aggregateID]; exists {
            summary.Status = "cancelled"
            summary.LastUpdated = e.Timestamp
            log.Printf("Updated order summary for %s: cancelled", aggregateID)
        }
    }
    
    return nil
}

func (p *OrderSummaryProjection) GetOrderSummary(orderID string) (*OrderSummary, error) {
    p.mu.RLock()
    defer p.mu.RUnlock()
    
    summary, exists := p.store[orderID]
    if !exists {
        return nil, fmt.Errorf("order summary not found: %s", orderID)
    }
    
    // Return a copy to prevent mutations
    result := *summary
    return &result, nil
}

func (p *OrderSummaryProjection) GetOrdersByCustomer(customerID string) ([]*OrderSummary, error) {
    p.mu.RLock()
    defer p.mu.RUnlock()
    
    var orders []*OrderSummary
    for _, summary := range p.store {
        if summary.CustomerID == customerID {
            // Copy to prevent mutations
            orderCopy := *summary
            orders = append(orders, &orderCopy)
        }
    }
    
    return orders, nil
}

// Customer analytics projection
type CustomerAnalyticsProjection struct {
    analytics map[string]*CustomerAnalytics
    mu        sync.RWMutex
}

type CustomerAnalytics struct {
    CustomerID       string    `json:"customer_id"`
    TotalOrders      int       `json:"total_orders"`
    TotalSpent       float64   `json:"total_spent"`
    AverageOrderSize float64   `json:"average_order_size"`
    LastOrderDate    time.Time `json:"last_order_date"`
    Status           string    `json:"status"`
}

func NewCustomerAnalyticsProjection() *CustomerAnalyticsProjection {
    return &CustomerAnalyticsProjection{
        analytics: make(map[string]*CustomerAnalytics),
    }
}

func (p *CustomerAnalyticsProjection) GetName() string {
    return "customer-analytics"
}

func (p *CustomerAnalyticsProjection) Handle(event Event) error {
    p.mu.Lock()
    defer p.mu.Unlock()
    
    switch e := event.(type) {
    case *OrderCreated:
        analytics, exists := p.analytics[e.CustomerID]
        if !exists {
            analytics = &CustomerAnalytics{
                CustomerID: e.CustomerID,
                Status:     "active",
            }
            p.analytics[e.CustomerID] = analytics
        }
        
        analytics.TotalOrders++
        analytics.TotalSpent += e.Amount
        analytics.AverageOrderSize = analytics.TotalSpent / float64(analytics.TotalOrders)
        analytics.LastOrderDate = e.Timestamp
        
        log.Printf("Updated customer analytics for %s: %d orders, $%.2f total", 
            e.CustomerID, analytics.TotalOrders, analytics.TotalSpent)
    }
    
    return nil
}

func (p *CustomerAnalyticsProjection) GetCustomerAnalytics(customerID string) (*CustomerAnalytics, error) {
    p.mu.RLock()
    defer p.mu.RUnlock()
    
    analytics, exists := p.analytics[customerID]
    if !exists {
        return nil, fmt.Errorf("customer analytics not found: %s", customerID)
    }
    
    result := *analytics
    return &result, nil
}

func NewProjectionManager(js nats.JetStreamContext) *ProjectionManager {
    return &ProjectionManager{
        js:          js,
        projections: make(map[string]*Projection),
    }
}

func (pm *ProjectionManager) RegisterProjection(streamName string, 
    handler ProjectionHandler, filterSubjects []string) error {
    
    pm.mu.Lock()
    defer pm.mu.Unlock()
    
    projection := &Projection{
        Name:           handler.GetName(),
        StreamName:     streamName,
        ConsumerName:   fmt.Sprintf("projection-%s", handler.GetName()),
        FilterSubjects: filterSubjects,
        Handler:        handler,
    }
    
    // Create durable consumer for the projection
    consumerConfig := &nats.ConsumerConfig{
        Durable:           projection.ConsumerName,
        DeliverPolicy:     nats.DeliverAllPolicy,
        AckPolicy:         nats.AckExplicitPolicy,
        MaxDeliver:        3,
        AckWait:           30 * time.Second,
        ReplayPolicy:      nats.ReplayInstantPolicy,
        FilterSubject:     buildFilterSubject(filterSubjects),
        MaxRequestBatch:   100,
        MaxRequestExpires: 5 * time.Second,
    }
    
    _, err := pm.js.AddConsumer(streamName, consumerConfig)
    if err != nil {
        return fmt.Errorf("failed to create consumer for projection %s: %w", 
            projection.Name, err)
    }
    
    pm.projections[projection.Name] = projection
    log.Printf("Registered projection: %s", projection.Name)
    
    return nil
}

func buildFilterSubject(subjects []string) string {
    if len(subjects) == 1 {
        return subjects[0]
    }
    // For multiple subjects, use the most general pattern
    return "events.>"
}

func (pm *ProjectionManager) StartProjections(ctx context.Context) error {
    pm.mu.RLock()
    defer pm.mu.RUnlock()
    
    for _, projection := range pm.projections {
        if err := pm.startProjection(ctx, projection); err != nil {
            return fmt.Errorf("failed to start projection %s: %w", 
                projection.Name, err)
        }
    }
    
    log.Printf("Started %d projections", len(pm.projections))
    return nil
}

func (pm *ProjectionManager) startProjection(ctx context.Context, 
    projection *Projection) error {
    
    // Create pull subscription
    sub, err := pm.js.PullSubscribe("", projection.ConsumerName)
    if err != nil {
        return fmt.Errorf("failed to create subscription: %w", err)
    }
    
    projection.subscription = sub
    
    // Start processing in goroutine
    go func() {
        defer sub.Unsubscribe()
        
        for {
            select {
            case <-ctx.Done():
                log.Printf("Stopping projection: %s", projection.Name)
                return
            default:
                pm.processBatch(projection)
            }
        }
    }()
    
    return nil
}

func (pm *ProjectionManager) processBatch(projection *Projection) {
    // Fetch batch of messages
    msgs, err := projection.subscription.Fetch(50, nats.MaxWait(1*time.Second))
    if err != nil {
        if err != nats.ErrTimeout {
            log.Printf("Error fetching messages for projection %s: %v", 
                projection.Name, err)
        }
        return
    }
    
    for _, msg := range msgs {
        if err := pm.processMessage(projection, msg); err != nil {
            log.Printf("Error processing message in projection %s: %v", 
                projection.Name, err)
            msg.Nak()
        } else {
            msg.Ack()
        }
    }
}

func (pm *ProjectionManager) processMessage(projection *Projection, 
    msg *nats.Msg) error {
    
    // Deserialize event
    event, err := deserializeEventFromMessage(msg)
    if err != nil {
        return fmt.Errorf("failed to deserialize event: %w", err)
    }
    
    // Check if this event should be processed by this projection
    if !pm.shouldProcessEvent(projection, msg.Subject) {
        return nil
    }
    
    // Handle the event
    if err := projection.Handler.Handle(event); err != nil {
        return fmt.Errorf("handler error: %w", err)
    }
    
    // Update last processed sequence
    projection.mu.Lock()
    meta, _ := msg.Metadata()
    projection.lastProcessed = meta.Sequence.Stream
    projection.mu.Unlock()
    
    return nil
}

func (pm *ProjectionManager) shouldProcessEvent(projection *Projection, 
    subject string) bool {
    
    for _, filter := range projection.FilterSubjects {
        if matchSubject(filter, subject) {
            return true
        }
    }
    return false
}

func matchSubject(pattern, subject string) bool {
    // Simplified subject matching - use nats.subjectMatches in production
    if pattern == ">" || pattern == subject {
        return true
    }
    // Add more sophisticated pattern matching as needed
    return false
}

func deserializeEventFromMessage(msg *nats.Msg) (Event, error) {
    eventType := msg.Header.Get("Event-Type")
    
    var event Event
    switch eventType {
    case "OrderCreated":
        event = &OrderCreated{}
    case "OrderShipped":
        event = &OrderShipped{}
    case "OrderCancelled":
        event = &OrderCancelled{}
    default:
        return nil, fmt.Errorf("unknown event type: %s", eventType)
    }
    
    if err := json.Unmarshal(msg.Data, event); err != nil {
        return nil, err
    }
    
    return event, nil
}

// Example usage
func ExampleCQRS() {
    nc, _ := nats.Connect("nats://localhost:4222")
    js, _ := nc.JetStream()
    
    // Create projection manager
    pm := NewProjectionManager(js)
    
    // Register projections
    orderSummary := NewOrderSummaryProjection()
    customerAnalytics := NewCustomerAnalyticsProjection()
    
    pm.RegisterProjection("event-store", orderSummary, 
        []string{"events.>.OrderCreated", "events.>.OrderShipped", "events.>.OrderCancelled"})
    pm.RegisterProjection("event-store", customerAnalytics, 
        []string{"events.>.OrderCreated"})
    
    // Start processing
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()
    
    if err := pm.StartProjections(ctx); err != nil {
        log.Fatalf("Failed to start projections: %v", err)
    }
    
    // Example queries
    time.Sleep(5 * time.Second) // Let some events process
    
    // Query order summary
    summary, err := orderSummary.GetOrderSummary("order-123")
    if err != nil {
        log.Printf("Order summary query failed: %v", err)
    } else {
        log.Printf("Order summary: %+v", summary)
    }
    
    // Query customer analytics
    analytics, err := customerAnalytics.GetCustomerAnalytics("customer-456")
    if err != nil {
        log.Printf("Customer analytics query failed: %v", err)
    } else {
        log.Printf("Customer analytics: %+v", analytics)
    }
}
```

## Guaranteed Delivery Mechanisms

JetStream provides multiple mechanisms to ensure message delivery even in failure scenarios.

### At-Least-Once and Exactly-Once Delivery

Implementing robust delivery guarantees:

```go
package delivery

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "log"
    "sync"
    "time"

    "github.com/nats-io/nats.go"
)

type DeliveryGuarantee int

const (
    AtMostOnce DeliveryGuarantee = iota
    AtLeastOnce
    ExactlyOnce
)

type ReliablePublisher struct {
    js              nats.JetStreamContext
    pendingAcks     map[string]*PendingMessage
    mu              sync.RWMutex
    retryInterval   time.Duration
    maxRetries      int
    ackTimeout      time.Duration
}

type PendingMessage struct {
    ID          string
    Subject     string
    Data        []byte
    Headers     nats.Header
    PublishedAt time.Time
    Retries     int
    AckReceived bool
}

func NewReliablePublisher(js nats.JetStreamContext) *ReliablePublisher {
    return &ReliablePublisher{
        js:            js,
        pendingAcks:   make(map[string]*PendingMessage),
        retryInterval: 5 * time.Second,
        maxRetries:    3,
        ackTimeout:    30 * time.Second,
    }
}

func (rp *ReliablePublisher) PublishWithGuarantee(subject string, data []byte, 
    headers nats.Header, guarantee DeliveryGuarantee) error {
    
    switch guarantee {
    case AtMostOnce:
        return rp.publishAtMostOnce(subject, data, headers)
    case AtLeastOnce:
        return rp.publishAtLeastOnce(subject, data, headers)
    case ExactlyOnce:
        return rp.publishExactlyOnce(subject, data, headers)
    default:
        return fmt.Errorf("unsupported delivery guarantee: %d", guarantee)
    }
}

func (rp *ReliablePublisher) publishAtMostOnce(subject string, data []byte, 
    headers nats.Header) error {
    
    // Fire and forget - no retries or acknowledgment tracking
    msg := &nats.Msg{
        Subject: subject,
        Data:    data,
        Header:  headers,
    }
    
    _, err := rp.js.PublishMsg(msg)
    return err
}

func (rp *ReliablePublisher) publishAtLeastOnce(subject string, data []byte, 
    headers nats.Header) error {
    
    messageID := rp.generateMessageID(data)
    
    msg := &nats.Msg{
        Subject: subject,
        Data:    data,
        Header:  headers,
    }
    
    if msg.Header == nil {
        msg.Header = make(nats.Header)
    }
    msg.Header.Set("Message-ID", messageID)
    
    // Track the message for retries
    rp.mu.Lock()
    rp.pendingAcks[messageID] = &PendingMessage{
        ID:          messageID,
        Subject:     subject,
        Data:        data,
        Headers:     headers,
        PublishedAt: time.Now(),
        Retries:     0,
        AckReceived: false,
    }
    rp.mu.Unlock()
    
    // Publish with acknowledgment tracking
    ack, err := rp.js.PublishMsg(msg)
    if err != nil {
        rp.removePendingMessage(messageID)
        return fmt.Errorf("failed to publish message: %w", err)
    }
    
    log.Printf("Published message %s (stream seq: %d)", messageID, ack.Sequence)
    
    // Start retry mechanism in background
    go rp.monitorAcknowledgment(messageID)
    
    return nil
}

func (rp *ReliablePublisher) publishExactlyOnce(subject string, data []byte, 
    headers nats.Header) error {
    
    messageID := rp.generateMessageID(data)
    
    msg := &nats.Msg{
        Subject: subject,
        Data:    data,
        Header:  headers,
    }
    
    if msg.Header == nil {
        msg.Header = make(nats.Header)
    }
    msg.Header.Set("Message-ID", messageID)
    
    // Use JetStream's built-in deduplication
    ack, err := rp.js.PublishMsg(msg, nats.MsgId(messageID))
    if err != nil {
        return fmt.Errorf("failed to publish message: %w", err)
    }
    
    // Check if message was deduplicated
    if ack.Duplicate {
        log.Printf("Message %s was deduplicated", messageID)
    } else {
        log.Printf("Published unique message %s (stream seq: %d)", 
            messageID, ack.Sequence)
    }
    
    return nil
}

func (rp *ReliablePublisher) generateMessageID(data []byte) string {
    hash := sha256.Sum256(data)
    return hex.EncodeToString(hash[:])[:16] // Use first 16 chars
}

func (rp *ReliablePublisher) monitorAcknowledgment(messageID string) {
    ticker := time.NewTicker(rp.retryInterval)
    defer ticker.Stop()
    
    timeout := time.After(rp.ackTimeout)
    
    for {
        select {
        case <-timeout:
            log.Printf("Acknowledgment timeout for message %s", messageID)
            rp.removePendingMessage(messageID)
            return
            
        case <-ticker.C:
            rp.mu.RLock()
            pending, exists := rp.pendingAcks[messageID]
            rp.mu.RUnlock()
            
            if !exists {
                return // Message was acknowledged or removed
            }
            
            if pending.AckReceived {
                rp.removePendingMessage(messageID)
                return
            }
            
            // Retry if max retries not reached
            if pending.Retries < rp.maxRetries {
                rp.retryMessage(pending)
            } else {
                log.Printf("Max retries exceeded for message %s", messageID)
                rp.removePendingMessage(messageID)
                return
            }
        }
    }
}

func (rp *ReliablePublisher) retryMessage(pending *PendingMessage) {
    rp.mu.Lock()
    pending.Retries++
    rp.mu.Unlock()
    
    msg := &nats.Msg{
        Subject: pending.Subject,
        Data:    pending.Data,
        Header:  pending.Headers,
    }
    
    ack, err := rp.js.PublishMsg(msg)
    if err != nil {
        log.Printf("Failed to retry message %s: %v", pending.ID, err)
        return
    }
    
    log.Printf("Retried message %s (attempt %d, stream seq: %d)", 
        pending.ID, pending.Retries, ack.Sequence)
}

func (rp *ReliablePublisher) removePendingMessage(messageID string) {
    rp.mu.Lock()
    delete(rp.pendingAcks, messageID)
    rp.mu.Unlock()
}

// Idempotent consumer for exactly-once processing
type IdempotentConsumer struct {
    js              nats.JetStreamContext
    subscription    *nats.Subscription
    processedMsgs   map[string]bool
    mu              sync.RWMutex
    handler         MessageHandler
}

type MessageHandler interface {
    ProcessMessage(msg *nats.Msg) error
}

func NewIdempotentConsumer(js nats.JetStreamContext, 
    streamName, consumerName string, handler MessageHandler) (*IdempotentConsumer, error) {
    
    // Create or get existing consumer
    consumerConfig := &nats.ConsumerConfig{
        Durable:           consumerName,
        DeliverPolicy:     nats.DeliverAllPolicy,
        AckPolicy:         nats.AckExplicitPolicy,
        MaxDeliver:        3,
        AckWait:           30 * time.Second,
        BackOff:           []time.Duration{1 * time.Second, 5 * time.Second, 10 * time.Second},
        MaxRequestBatch:   10,
        MaxRequestExpires: 5 * time.Second,
    }
    
    _, err := js.AddConsumer(streamName, consumerConfig)
    if err != nil {
        return nil, fmt.Errorf("failed to create consumer: %w", err)
    }
    
    sub, err := js.PullSubscribe("", consumerName)
    if err != nil {
        return nil, fmt.Errorf("failed to create subscription: %w", err)
    }
    
    return &IdempotentConsumer{
        js:            js,
        subscription:  sub,
        processedMsgs: make(map[string]bool),
        handler:       handler,
    }, nil
}

func (ic *IdempotentConsumer) Start(ctx context.Context) error {
    go func() {
        defer ic.subscription.Unsubscribe()
        
        for {
            select {
            case <-ctx.Done():
                log.Println("Stopping idempotent consumer")
                return
            default:
                ic.processBatch()
            }
        }
    }()
    
    return nil
}

func (ic *IdempotentConsumer) processBatch() {
    msgs, err := ic.subscription.Fetch(10, nats.MaxWait(1*time.Second))
    if err != nil {
        if err != nats.ErrTimeout {
            log.Printf("Error fetching messages: %v", err)
        }
        return
    }
    
    for _, msg := range msgs {
        if err := ic.processMessage(msg); err != nil {
            log.Printf("Error processing message: %v", err)
            msg.Nak()
        } else {
            msg.Ack()
        }
    }
}

func (ic *IdempotentConsumer) processMessage(msg *nats.Msg) error {
    messageID := msg.Header.Get("Message-ID")
    if messageID == "" {
        // Generate ID from message content for non-ID'd messages
        messageID = ic.generateMessageID(msg.Data)
    }
    
    // Check if already processed
    ic.mu.RLock()
    alreadyProcessed := ic.processedMsgs[messageID]
    ic.mu.RUnlock()
    
    if alreadyProcessed {
        log.Printf("Skipping already processed message %s", messageID)
        return nil // Skip processing but ack the message
    }
    
    // Process the message
    if err := ic.handler.ProcessMessage(msg); err != nil {
        return fmt.Errorf("handler failed: %w", err)
    }
    
    // Mark as processed
    ic.mu.Lock()
    ic.processedMsgs[messageID] = true
    ic.mu.Unlock()
    
    log.Printf("Successfully processed message %s", messageID)
    return nil
}

func (ic *IdempotentConsumer) generateMessageID(data []byte) string {
    hash := sha256.Sum256(data)
    return hex.EncodeToString(hash[:])[:16]
}

// Circuit breaker for fault tolerance
type CircuitBreaker struct {
    maxFailures      int
    resetTimeout     time.Duration
    failureCount     int
    lastFailureTime  time.Time
    state           CircuitState
    mu              sync.RWMutex
}

type CircuitState int

const (
    CircuitClosed CircuitState = iota
    CircuitOpen
    CircuitHalfOpen
)

func NewCircuitBreaker(maxFailures int, resetTimeout time.Duration) *CircuitBreaker {
    return &CircuitBreaker{
        maxFailures:  maxFailures,
        resetTimeout: resetTimeout,
        state:       CircuitClosed,
    }
}

func (cb *CircuitBreaker) Execute(fn func() error) error {
    cb.mu.Lock()
    defer cb.mu.Unlock()
    
    switch cb.state {
    case CircuitOpen:
        if time.Since(cb.lastFailureTime) > cb.resetTimeout {
            cb.state = CircuitHalfOpen
            cb.failureCount = 0
        } else {
            return fmt.Errorf("circuit breaker is open")
        }
    }
    
    err := fn()
    
    if err != nil {
        cb.failureCount++
        cb.lastFailureTime = time.Now()
        
        if cb.failureCount >= cb.maxFailures {
            cb.state = CircuitOpen
        }
        
        return err
    }
    
    // Success - reset circuit
    cb.failureCount = 0
    cb.state = CircuitClosed
    
    return nil
}

// Example usage with circuit breaker
type ResilientMessageHandler struct {
    circuitBreaker *CircuitBreaker
    actualHandler  MessageHandler
}

func NewResilientMessageHandler(handler MessageHandler) *ResilientMessageHandler {
    return &ResilientMessageHandler{
        circuitBreaker: NewCircuitBreaker(5, 30*time.Second),
        actualHandler:  handler,
    }
}

func (rmh *ResilientMessageHandler) ProcessMessage(msg *nats.Msg) error {
    return rmh.circuitBreaker.Execute(func() error {
        return rmh.actualHandler.ProcessMessage(msg)
    })
}
```

## Clustering and High Availability

Setting up NATS JetStream clusters for production resilience.

### JetStream Cluster Configuration

Configuring a highly available JetStream cluster:

```yaml
# NATS Server Configuration for HA Cluster
server_name: nats-server-1
port: 4222
http_port: 8222

# Cluster configuration
cluster: {
  name: production-cluster
  port: 6222
  
  # Cluster routes for discovery
  routes: [
    nats://nats-server-1:6222
    nats://nats-server-2:6222
    nats://nats-server-3:6222
  ]
  
  # Cluster authentication
  authorization: {
    user: cluster_user
    password: secure_cluster_password
    timeout: 2
  }
  
  # Connection pooling
  pool_size: 10
  accounts: $NATS_ACCOUNTS_FILE
}

# JetStream configuration
jetstream: {
  # Storage directory (use persistent volume in K8s)
  store_dir: "/data/jetstream"
  
  # Memory and storage limits
  max_memory_store: 1GB
  max_file_store: 100GB
  
  # Domain for multi-tenancy
  domain: "production"
  
  # Unique server ID for the cluster
  unique_tag: "server:nats-server-1,zone:us-east-1a,rack:rack1"
}

# Monitoring and metrics
monitoring: {
  http_port: 8222
  https_port: 8223
}

# Logging
log_file: "/var/log/nats/nats-server.log"
logtime: true
log_size_limit: 100MB
max_traced_msg_len: 1024

# TLS Configuration
tls: {
  cert_file: "/etc/nats/server-cert.pem"
  key_file: "/etc/nats/server-key.pem"
  ca_file: "/etc/nats/ca.pem"
  verify: true
  verify_and_map: true
  timeout: 2
}

# Connection limits and timeouts
max_connections: 64K
max_subscriptions: 0
max_pending: 64MB
max_payload: 8MB

# Slow consumer handling
write_deadline: "10s"
max_closed_clients: 10000

# Accounts and security
accounts: $NATS_ACCOUNTS_FILE
system_account: SYS
```

Kubernetes deployment for the cluster:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: nats-jetstream
  namespace: nats-system
spec:
  serviceName: nats-jetstream
  replicas: 3
  selector:
    matchLabels:
      app: nats-jetstream
  template:
    metadata:
      labels:
        app: nats-jetstream
    spec:
      terminationGracePeriodSeconds: 60
      securityContext:
        fsGroup: 1000
        runAsUser: 1000
        runAsNonRoot: true
      containers:
      - name: nats
        image: nats:2.10-alpine
        ports:
        - containerPort: 4222
          name: client
        - containerPort: 6222
          name: cluster
        - containerPort: 8222
          name: monitor
        command:
        - "nats-server"
        - "--config"
        - "/etc/nats-config/nats.conf"
        
        # Resource limits for production
        resources:
          requests:
            cpu: 1000m
            memory: 2Gi
          limits:
            cpu: 2000m
            memory: 4Gi
            
        # Health checks
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8222
          initialDelaySeconds: 10
          timeoutSeconds: 5
          periodSeconds: 30
          failureThreshold: 3
          
        readinessProbe:
          httpGet:
            path: /healthz?js-enabled-only=true
            port: 8222
          initialDelaySeconds: 10
          timeoutSeconds: 5
          periodSeconds: 10
          failureThreshold: 3
        
        # Volume mounts
        volumeMounts:
        - name: config-volume
          mountPath: /etc/nats-config
        - name: jetstream-storage
          mountPath: /data/jetstream
        - name: tls-certs
          mountPath: /etc/nats/certs
        
        # Environment variables
        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: SERVER_NAME
          value: $(POD_NAME)
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
              
        # Lifecycle hooks for graceful shutdown
        lifecycle:
          preStop:
            exec:
              command:
              - nats-server
              - --signal
              - quit
      
      volumes:
      - name: config-volume
        configMap:
          name: nats-config
      - name: tls-certs
        secret:
          secretName: nats-tls-certs
          
  # Persistent volume claims for JetStream storage
  volumeClaimTemplates:
  - metadata:
      name: jetstream-storage
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 100Gi
---
apiVersion: v1
kind: Service
metadata:
  name: nats-jetstream
  namespace: nats-system
spec:
  clusterIP: None
  selector:
    app: nats-jetstream
  ports:
  - name: client
    port: 4222
  - name: cluster
    port: 6222
  - name: monitor
    port: 8222
---
apiVersion: v1
kind: Service
metadata:
  name: nats-jetstream-lb
  namespace: nats-system
spec:
  type: LoadBalancer
  selector:
    app: nats-jetstream
  ports:
  - name: client
    port: 4222
    targetPort: 4222
```

### Disaster Recovery and Backup Strategies

Implementing comprehensive backup and recovery:

```go
package backup

import (
    "archive/tar"
    "compress/gzip"
    "context"
    "fmt"
    "io"
    "os"
    "path/filepath"
    "time"

    "github.com/nats-io/nats.go"
)

type BackupManager struct {
    js           nats.JetStreamContext
    storageDir   string
    backupDir    string
    retention    time.Duration
}

type BackupMetadata struct {
    Timestamp    time.Time           `json:"timestamp"`
    Streams      []StreamBackup      `json:"streams"`
    Consumers    []ConsumerBackup    `json:"consumers"`
    ClusterInfo  ClusterInfo         `json:"cluster_info"`
}

type StreamBackup struct {
    Name     string                 `json:"name"`
    Config   *nats.StreamConfig     `json:"config"`
    State    *nats.StreamState      `json:"state"`
    Messages []BackedUpMessage      `json:"messages,omitempty"`
}

type ConsumerBackup struct {
    StreamName string                 `json:"stream_name"`
    Name       string                 `json:"name"`
    Config     *nats.ConsumerConfig   `json:"config"`
    Info       *nats.ConsumerInfo     `json:"info"`
}

type BackedUpMessage struct {
    Subject   string              `json:"subject"`
    Data      []byte              `json:"data"`
    Header    map[string][]string `json:"header,omitempty"`
    Sequence  uint64              `json:"sequence"`
    Timestamp time.Time           `json:"timestamp"`
}

type ClusterInfo struct {
    Leader   string   `json:"leader"`
    Replicas []string `json:"replicas"`
}

func NewBackupManager(js nats.JetStreamContext, storageDir, backupDir string) *BackupManager {
    return &BackupManager{
        js:         js,
        storageDir: storageDir,
        backupDir:  backupDir,
        retention:  7 * 24 * time.Hour, // 7 days
    }
}

func (bm *BackupManager) CreateFullBackup(ctx context.Context) error {
    timestamp := time.Now()
    backupName := fmt.Sprintf("jetstream-backup-%s", 
        timestamp.Format("2006-01-02-15-04-05"))
    backupPath := filepath.Join(bm.backupDir, backupName)
    
    if err := os.MkdirAll(backupPath, 0755); err != nil {
        return fmt.Errorf("failed to create backup directory: %w", err)
    }
    
    metadata := &BackupMetadata{
        Timestamp: timestamp,
    }
    
    // Backup streams
    if err := bm.backupStreams(ctx, backupPath, metadata); err != nil {
        return fmt.Errorf("failed to backup streams: %w", err)
    }
    
    // Backup consumers
    if err := bm.backupConsumers(ctx, backupPath, metadata); err != nil {
        return fmt.Errorf("failed to backup consumers: %w", err)
    }
    
    // Backup cluster info
    if err := bm.backupClusterInfo(ctx, metadata); err != nil {
        return fmt.Errorf("failed to backup cluster info: %w", err)
    }
    
    // Save metadata
    if err := bm.saveMetadata(backupPath, metadata); err != nil {
        return fmt.Errorf("failed to save metadata: %w", err)
    }
    
    // Create compressed archive
    archivePath := backupPath + ".tar.gz"
    if err := bm.createArchive(backupPath, archivePath); err != nil {
        return fmt.Errorf("failed to create archive: %w", err)
    }
    
    // Clean up uncompressed backup
    if err := os.RemoveAll(backupPath); err != nil {
        log.Printf("Warning: failed to clean up backup directory: %v", err)
    }
    
    log.Printf("Backup completed: %s", archivePath)
    return nil
}

func (bm *BackupManager) backupStreams(ctx context.Context, backupPath string, 
    metadata *BackupMetadata) error {
    
    // List all streams
    streams := bm.js.StreamNames()
    
    for stream := range streams {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }
        
        streamInfo, err := bm.js.StreamInfo(stream)
        if err != nil {
            return fmt.Errorf("failed to get stream info for %s: %w", stream, err)
        }
        
        streamBackup := StreamBackup{
            Name:   stream,
            Config: &streamInfo.Config,
            State:  &streamInfo.State,
        }
        
        // Backup messages (optional, for smaller streams)
        if streamInfo.State.Msgs < 10000 { // Only backup small streams
            messages, err := bm.backupStreamMessages(ctx, stream)
            if err != nil {
                return fmt.Errorf("failed to backup messages for %s: %w", stream, err)
            }
            streamBackup.Messages = messages
        }
        
        metadata.Streams = append(metadata.Streams, streamBackup)
    }
    
    return nil
}

func (bm *BackupManager) backupStreamMessages(ctx context.Context, streamName string) ([]BackedUpMessage, error) {
    var messages []BackedUpMessage
    
    // Create temporary consumer to read all messages
    consumerConfig := &nats.ConsumerConfig{
        DeliverPolicy: nats.DeliverAllPolicy,
        AckPolicy:     nats.AckNonePolicy,
        ReplayPolicy:  nats.ReplayInstantPolicy,
    }
    
    sub, err := bm.js.PullSubscribe("", "", nats.BindStream(streamName), 
        nats.ConsumerConfig(*consumerConfig))
    if err != nil {
        return nil, fmt.Errorf("failed to create backup subscription: %w", err)
    }
    defer sub.Unsubscribe()
    
    for {
        select {
        case <-ctx.Done():
            return messages, ctx.Err()
        default:
        }
        
        msgs, err := sub.Fetch(100, nats.MaxWait(1*time.Second))
        if err != nil {
            if err == nats.ErrTimeout {
                break // No more messages
            }
            return nil, fmt.Errorf("failed to fetch messages: %w", err)
        }
        
        if len(msgs) == 0 {
            break
        }
        
        for _, msg := range msgs {
            meta, err := msg.Metadata()
            if err != nil {
                continue
            }
            
            backedMsg := BackedUpMessage{
                Subject:   msg.Subject,
                Data:      msg.Data,
                Sequence:  meta.Sequence.Stream,
                Timestamp: meta.Timestamp,
            }
            
            if msg.Header != nil {
                backedMsg.Header = map[string][]string(msg.Header)
            }
            
            messages = append(messages, backedMsg)
        }
    }
    
    return messages, nil
}

func (bm *BackupManager) RestoreFromBackup(ctx context.Context, backupPath string) error {
    // Extract archive
    extractedPath := backupPath[:len(backupPath)-7] // Remove .tar.gz
    if err := bm.extractArchive(backupPath, extractedPath); err != nil {
        return fmt.Errorf("failed to extract archive: %w", err)
    }
    defer os.RemoveAll(extractedPath)
    
    // Load metadata
    metadata, err := bm.loadMetadata(extractedPath)
    if err != nil {
        return fmt.Errorf("failed to load metadata: %w", err)
    }
    
    // Restore streams
    for _, streamBackup := range metadata.Streams {
        if err := bm.restoreStream(ctx, streamBackup); err != nil {
            return fmt.Errorf("failed to restore stream %s: %w", 
                streamBackup.Name, err)
        }
    }
    
    // Restore consumers
    for _, consumerBackup := range metadata.Consumers {
        if err := bm.restoreConsumer(ctx, consumerBackup); err != nil {
            return fmt.Errorf("failed to restore consumer %s: %w", 
                consumerBackup.Name, err)
        }
    }
    
    log.Printf("Restore completed from backup: %s", backupPath)
    return nil
}

func (bm *BackupManager) restoreStream(ctx context.Context, 
    streamBackup StreamBackup) error {
    
    // Create stream with backed up configuration
    _, err := bm.js.AddStream(streamBackup.Config)
    if err != nil {
        return fmt.Errorf("failed to create stream: %w", err)
    }
    
    // Restore messages if available
    if len(streamBackup.Messages) > 0 {
        for _, msg := range streamBackup.Messages {
            select {
            case <-ctx.Done():
                return ctx.Err()
            default:
            }
            
            natsMsg := &nats.Msg{
                Subject: msg.Subject,
                Data:    msg.Data,
            }
            
            if msg.Header != nil {
                natsMsg.Header = nats.Header(msg.Header)
            }
            
            _, err := bm.js.PublishMsg(natsMsg)
            if err != nil {
                log.Printf("Warning: failed to restore message seq %d: %v", 
                    msg.Sequence, err)
            }
        }
    }
    
    log.Printf("Restored stream: %s", streamBackup.Name)
    return nil
}

func (bm *BackupManager) ScheduleBackups(ctx context.Context, interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()
    
    for {
        select {
        case <-ctx.Done():
            log.Println("Stopping backup scheduler")
            return
        case <-ticker.C:
            log.Println("Starting scheduled backup")
            if err := bm.CreateFullBackup(ctx); err != nil {
                log.Printf("Scheduled backup failed: %v", err)
            }
            
            // Clean up old backups
            if err := bm.cleanupOldBackups(); err != nil {
                log.Printf("Failed to cleanup old backups: %v", err)
            }
        }
    }
}

func (bm *BackupManager) cleanupOldBackups() error {
    cutoff := time.Now().Add(-bm.retention)
    
    entries, err := os.ReadDir(bm.backupDir)
    if err != nil {
        return fmt.Errorf("failed to read backup directory: %w", err)
    }
    
    for _, entry := range entries {
        if entry.IsDir() {
            continue
        }
        
        info, err := entry.Info()
        if err != nil {
            continue
        }
        
        if info.ModTime().Before(cutoff) {
            backupPath := filepath.Join(bm.backupDir, entry.Name())
            if err := os.Remove(backupPath); err != nil {
                log.Printf("Failed to remove old backup %s: %v", backupPath, err)
            } else {
                log.Printf("Removed old backup: %s", backupPath)
            }
        }
    }
    
    return nil
}

func (bm *BackupManager) createArchive(source, target string) error {
    file, err := os.Create(target)
    if err != nil {
        return err
    }
    defer file.Close()
    
    gzipWriter := gzip.NewWriter(file)
    defer gzipWriter.Close()
    
    tarWriter := tar.NewWriter(gzipWriter)
    defer tarWriter.Close()
    
    return filepath.Walk(source, func(path string, info os.FileInfo, err error) error {
        if err != nil {
            return err
        }
        
        header, err := tar.FileInfoHeader(info, info.Name())
        if err != nil {
            return err
        }
        
        relPath, err := filepath.Rel(source, path)
        if err != nil {
            return err
        }
        header.Name = relPath
        
        if err := tarWriter.WriteHeader(header); err != nil {
            return err
        }
        
        if info.IsDir() {
            return nil
        }
        
        file, err := os.Open(path)
        if err != nil {
            return err
        }
        defer file.Close()
        
        _, err = io.Copy(tarWriter, file)
        return err
    })
}

// Example usage
func ExampleBackupRestore() {
    nc, _ := nats.Connect("nats://localhost:4222")
    js, _ := nc.JetStream()
    
    backupManager := NewBackupManager(js, "/data/jetstream", "/backups")
    
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()
    
    // Schedule daily backups
    go backupManager.ScheduleBackups(ctx, 24*time.Hour)
    
    // Create immediate backup
    if err := backupManager.CreateFullBackup(ctx); err != nil {
        log.Fatalf("Backup failed: %v", err)
    }
    
    // Example restore (in disaster recovery scenario)
    // backupPath := "/backups/jetstream-backup-2024-01-15-10-30-00.tar.gz"
    // if err := backupManager.RestoreFromBackup(ctx, backupPath); err != nil {
    //     log.Fatalf("Restore failed: %v", err)
    // }
}
```

## Integration with Microservices

Building robust microservice communication patterns with JetStream.

### Service-to-Service Communication Patterns

Implementing reliable communication patterns:

```go
package microservices

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "time"

    "github.com/nats-io/nats.go"
)

// Service interface for microservices
type Service interface {
    Start(ctx context.Context) error
    Stop(ctx context.Context) error
    Health() HealthStatus
}

type HealthStatus struct {
    Status    string            `json:"status"`
    Timestamp time.Time         `json:"timestamp"`
    Details   map[string]string `json:"details"`
}

// Base microservice with JetStream integration
type BaseService struct {
    name         string
    js           nats.JetStreamContext
    nc           *nats.Conn
    subscriptions []*nats.Subscription
    handlers     map[string]MessageHandler
    metrics      *ServiceMetrics
}

type ServiceMetrics struct {
    MessagesProcessed   int64     `json:"messages_processed"`
    MessagesPublished   int64     `json:"messages_published"`
    ErrorCount         int64     `json:"error_count"`
    LastActivity       time.Time `json:"last_activity"`
    AverageProcessTime time.Duration `json:"average_process_time"`
}

func NewBaseService(name string, natsURL string) (*BaseService, error) {
    nc, err := nats.Connect(natsURL,
        nats.RetryOnFailedConnect(true),
        nats.MaxReconnects(5),
        nats.ReconnectWait(2*time.Second),
    )
    if err != nil {
        return nil, fmt.Errorf("failed to connect to NATS: %w", err)
    }
    
    js, err := nc.JetStream()
    if err != nil {
        return nil, fmt.Errorf("failed to create JetStream context: %w", err)
    }
    
    return &BaseService{
        name:     name,
        js:       js,
        nc:       nc,
        handlers: make(map[string]MessageHandler),
        metrics:  &ServiceMetrics{},
    }, nil
}

// Request-Response pattern with timeout
func (bs *BaseService) Request(subject string, data []byte, timeout time.Duration) (*nats.Msg, error) {
    request := &ServiceRequest{
        ID:        generateRequestID(),
        Timestamp: time.Now(),
        Service:   bs.name,
        Data:      data,
    }
    
    requestData, err := json.Marshal(request)
    if err != nil {
        return nil, fmt.Errorf("failed to marshal request: %w", err)
    }
    
    msg, err := bs.nc.Request(subject, requestData, timeout)
    if err != nil {
        return nil, fmt.Errorf("request failed: %w", err)
    }
    
    bs.metrics.MessagesPublished++
    return msg, nil
}

// Publish-Subscribe pattern with guaranteed delivery
func (bs *BaseService) PublishEvent(subject string, event interface{}) error {
    eventData, err := json.Marshal(event)
    if err != nil {
        return fmt.Errorf("failed to marshal event: %w", err)
    }
    
    eventEnvelope := &EventEnvelope{
        ID:        generateEventID(),
        Type:      fmt.Sprintf("%T", event),
        Source:    bs.name,
        Subject:   subject,
        Time:      time.Now(),
        Data:      eventData,
    }
    
    envelopeData, err := json.Marshal(eventEnvelope)
    if err != nil {
        return fmt.Errorf("failed to marshal event envelope: %w", err)
    }
    
    _, err = bs.js.Publish(subject, envelopeData)
    if err != nil {
        return fmt.Errorf("failed to publish event: %w", err)
    }
    
    bs.metrics.MessagesPublished++
    log.Printf("Published event %s to %s", eventEnvelope.ID, subject)
    return nil
}

// Subscribe to events with error handling and retry
func (bs *BaseService) SubscribeToEvents(streamName, consumerName string, 
    subjects []string, handler MessageHandler) error {
    
    // Create or update consumer
    consumerConfig := &nats.ConsumerConfig{
        Durable:           consumerName,
        DeliverPolicy:     nats.DeliverAllPolicy,
        AckPolicy:         nats.AckExplicitPolicy,
        MaxDeliver:        3,
        AckWait:           30 * time.Second,
        BackOff:           []time.Duration{1*time.Second, 5*time.Second, 10*time.Second},
        FilterSubject:     subjects[0], // TODO: support multiple subjects
        MaxRequestBatch:   10,
        MaxRequestExpires: 5 * time.Second,
    }
    
    _, err := bs.js.AddConsumer(streamName, consumerConfig)
    if err != nil {
        return fmt.Errorf("failed to create consumer: %w", err)
    }
    
    sub, err := bs.js.PullSubscribe("", consumerName)
    if err != nil {
        return fmt.Errorf("failed to create subscription: %w", err)
    }
    
    bs.subscriptions = append(bs.subscriptions, sub)
    
    // Start processing messages
    go bs.processMessages(sub, handler)
    
    log.Printf("Subscribed to stream %s with consumer %s", streamName, consumerName)
    return nil
}

func (bs *BaseService) processMessages(sub *nats.Subscription, handler MessageHandler) {
    for {
        msgs, err := sub.Fetch(10, nats.MaxWait(1*time.Second))
        if err != nil {
            if err != nats.ErrTimeout {
                log.Printf("Error fetching messages: %v", err)
            }
            continue
        }
        
        for _, msg := range msgs {
            start := time.Now()
            
            if err := bs.handleMessage(msg, handler); err != nil {
                log.Printf("Error handling message: %v", err)
                bs.metrics.ErrorCount++
                msg.Nak()
            } else {
                msg.Ack()
                bs.metrics.MessagesProcessed++
                
                // Update average processing time
                duration := time.Since(start)
                bs.metrics.AverageProcessTime = 
                    (bs.metrics.AverageProcessTime + duration) / 2
            }
            
            bs.metrics.LastActivity = time.Now()
        }
    }
}

func (bs *BaseService) handleMessage(msg *nats.Msg, handler MessageHandler) error {
    var envelope EventEnvelope
    if err := json.Unmarshal(msg.Data, &envelope); err != nil {
        return fmt.Errorf("failed to unmarshal event envelope: %w", err)
    }
    
    return handler.HandleEvent(&envelope)
}

// Saga pattern for distributed transactions
type SagaOrchestrator struct {
    *BaseService
    sagas map[string]*SagaInstance
    mu    sync.RWMutex
}

type SagaInstance struct {
    ID          string                 `json:"id"`
    Type        string                 `json:"type"`
    State       SagaState              `json:"state"`
    Steps       []SagaStep             `json:"steps"`
    CurrentStep int                    `json:"current_step"`
    Context     map[string]interface{} `json:"context"`
    CreatedAt   time.Time              `json:"created_at"`
    UpdatedAt   time.Time              `json:"updated_at"`
}

type SagaState string

const (
    SagaStarted   SagaState = "started"
    SagaRunning   SagaState = "running"
    SagaCompleted SagaState = "completed"
    SagaFailed    SagaState = "failed"
    SagaAborted   SagaState = "aborted"
)

type SagaStep struct {
    Name            string        `json:"name"`
    Command         string        `json:"command"`
    CompensateCommand string      `json:"compensate_command"`
    Timeout         time.Duration `json:"timeout"`
    RetryCount      int           `json:"retry_count"`
    MaxRetries      int           `json:"max_retries"`
    Status          StepStatus    `json:"status"`
}

type StepStatus string

const (
    StepPending    StepStatus = "pending"
    StepRunning    StepStatus = "running"
    StepCompleted  StepStatus = "completed"
    StepFailed     StepStatus = "failed"
    StepCompensated StepStatus = "compensated"
)

func NewSagaOrchestrator(name string, natsURL string) (*SagaOrchestrator, error) {
    baseService, err := NewBaseService(name, natsURL)
    if err != nil {
        return nil, err
    }
    
    return &SagaOrchestrator{
        BaseService: baseService,
        sagas:       make(map[string]*SagaInstance),
    }, nil
}

func (so *SagaOrchestrator) StartSaga(sagaType string, steps []SagaStep, 
    context map[string]interface{}) (string, error) {
    
    sagaID := generateSagaID()
    
    saga := &SagaInstance{
        ID:          sagaID,
        Type:        sagaType,
        State:       SagaStarted,
        Steps:       steps,
        CurrentStep: 0,
        Context:     context,
        CreatedAt:   time.Now(),
        UpdatedAt:   time.Now(),
    }
    
    so.mu.Lock()
    so.sagas[sagaID] = saga
    so.mu.Unlock()
    
    // Publish saga started event
    event := SagaStartedEvent{
        SagaID:   sagaID,
        SagaType: sagaType,
        Context:  context,
    }
    
    if err := so.PublishEvent("sagas.started", event); err != nil {
        return "", fmt.Errorf("failed to publish saga started event: %w", err)
    }
    
    // Start executing steps
    go so.executeSaga(sagaID)
    
    log.Printf("Started saga %s of type %s", sagaID, sagaType)
    return sagaID, nil
}

func (so *SagaOrchestrator) executeSaga(sagaID string) {
    so.mu.RLock()
    saga, exists := so.sagas[sagaID]
    so.mu.RUnlock()
    
    if !exists {
        log.Printf("Saga not found: %s", sagaID)
        return
    }
    
    saga.State = SagaRunning
    
    for i := saga.CurrentStep; i < len(saga.Steps); i++ {
        step := &saga.Steps[i]
        step.Status = StepRunning
        saga.CurrentStep = i
        saga.UpdatedAt = time.Now()
        
        if err := so.executeStep(saga, step); err != nil {
            log.Printf("Step %s failed in saga %s: %v", step.Name, sagaID, err)
            step.Status = StepFailed
            
            if step.RetryCount < step.MaxRetries {
                step.RetryCount++
                log.Printf("Retrying step %s (attempt %d)", step.Name, step.RetryCount)
                i-- // Retry the same step
                continue
            }
            
            // Start compensation
            go so.compensateSaga(sagaID, i)
            return
        }
        
        step.Status = StepCompleted
        log.Printf("Completed step %s in saga %s", step.Name, sagaID)
    }
    
    // All steps completed successfully
    saga.State = SagaCompleted
    saga.UpdatedAt = time.Now()
    
    // Publish saga completed event
    event := SagaCompletedEvent{
        SagaID:   sagaID,
        SagaType: saga.Type,
        Context:  saga.Context,
    }
    
    so.PublishEvent("sagas.completed", event)
    log.Printf("Saga %s completed successfully", sagaID)
}

func (so *SagaOrchestrator) executeStep(saga *SagaInstance, step *SagaStep) error {
    command := StepCommand{
        SagaID:     saga.ID,
        StepName:   step.Name,
        Command:    step.Command,
        Context:    saga.Context,
        Timestamp:  time.Now(),
    }
    
    response, err := so.Request(step.Command, mustMarshal(command), step.Timeout)
    if err != nil {
        return fmt.Errorf("command execution failed: %w", err)
    }
    
    var result StepResult
    if err := json.Unmarshal(response.Data, &result); err != nil {
        return fmt.Errorf("failed to unmarshal step result: %w", err)
    }
    
    if !result.Success {
        return fmt.Errorf("step failed: %s", result.Error)
    }
    
    // Update saga context with step results
    for k, v := range result.Context {
        saga.Context[k] = v
    }
    
    return nil
}

func (so *SagaOrchestrator) compensateSaga(sagaID string, failedStepIndex int) {
    so.mu.RLock()
    saga, exists := so.sagas[sagaID]
    so.mu.RUnlock()
    
    if !exists {
        log.Printf("Saga not found for compensation: %s", sagaID)
        return
    }
    
    saga.State = SagaFailed
    
    // Execute compensation commands in reverse order
    for i := failedStepIndex - 1; i >= 0; i-- {
        step := &saga.Steps[i]
        
        if step.Status != StepCompleted {
            continue
        }
        
        if step.CompensateCommand == "" {
            log.Printf("No compensation command for step %s", step.Name)
            continue
        }
        
        log.Printf("Compensating step %s in saga %s", step.Name, sagaID)
        
        command := StepCommand{
            SagaID:     sagaID,
            StepName:   step.Name,
            Command:    step.CompensateCommand,
            Context:    saga.Context,
            Timestamp:  time.Now(),
        }
        
        _, err := so.Request(step.CompensateCommand, mustMarshal(command), step.Timeout)
        if err != nil {
            log.Printf("Compensation failed for step %s: %v", step.Name, err)
            saga.State = SagaAborted
            break
        }
        
        step.Status = StepCompensated
    }
    
    saga.UpdatedAt = time.Now()
    
    // Publish saga failed event
    event := SagaFailedEvent{
        SagaID:      sagaID,
        SagaType:    saga.Type,
        FailedStep:  saga.Steps[failedStepIndex].Name,
        Context:     saga.Context,
    }
    
    so.PublishEvent("sagas.failed", event)
    log.Printf("Saga %s compensation completed", sagaID)
}

// Event types for saga orchestration
type SagaStartedEvent struct {
    SagaID   string                 `json:"saga_id"`
    SagaType string                 `json:"saga_type"`
    Context  map[string]interface{} `json:"context"`
}

type SagaCompletedEvent struct {
    SagaID   string                 `json:"saga_id"`
    SagaType string                 `json:"saga_type"`
    Context  map[string]interface{} `json:"context"`
}

type SagaFailedEvent struct {
    SagaID     string                 `json:"saga_id"`
    SagaType   string                 `json:"saga_type"`
    FailedStep string                 `json:"failed_step"`
    Context    map[string]interface{} `json:"context"`
}

type StepCommand struct {
    SagaID    string                 `json:"saga_id"`
    StepName  string                 `json:"step_name"`
    Command   string                 `json:"command"`
    Context   map[string]interface{} `json:"context"`
    Timestamp time.Time              `json:"timestamp"`
}

type StepResult struct {
    Success bool                   `json:"success"`
    Error   string                 `json:"error,omitempty"`
    Context map[string]interface{} `json:"context,omitempty"`
}

// Example order processing saga
func ExampleOrderProcessingSaga() {
    orchestrator, _ := NewSagaOrchestrator("order-orchestrator", "nats://localhost:4222")
    
    steps := []SagaStep{
        {
            Name:               "reserve-inventory",
            Command:            "inventory.reserve",
            CompensateCommand:  "inventory.release",
            Timeout:            30 * time.Second,
            MaxRetries:         3,
        },
        {
            Name:               "process-payment",
            Command:            "payment.process",
            CompensateCommand:  "payment.refund",
            Timeout:            60 * time.Second,
            MaxRetries:         2,
        },
        {
            Name:               "ship-order",
            Command:            "shipping.ship",
            CompensateCommand:  "shipping.cancel",
            Timeout:            120 * time.Second,
            MaxRetries:         1,
        },
    }
    
    context := map[string]interface{}{
        "order_id":    "order-123",
        "customer_id": "customer-456",
        "items":       []string{"item1", "item2"},
        "amount":      99.99,
    }
    
    sagaID, err := orchestrator.StartSaga("order-processing", steps, context)
    if err != nil {
        log.Fatalf("Failed to start saga: %v", err)
    }
    
    log.Printf("Started order processing saga: %s", sagaID)
}

func mustMarshal(v interface{}) []byte {
    data, err := json.Marshal(v)
    if err != nil {
        panic(err)
    }
    return data
}

func generateRequestID() string {
    return fmt.Sprintf("req_%d", time.Now().UnixNano())
}

func generateSagaID() string {
    return fmt.Sprintf("saga_%d", time.Now().UnixNano())
}
```

## Performance Optimization

Optimizing NATS JetStream for maximum throughput and minimal latency.

### Benchmarking and Profiling

Comprehensive performance testing framework:

```go
package performance

import (
    "context"
    "fmt"
    "log"
    "runtime"
    "sync"
    "sync/atomic"
    "time"

    "github.com/nats-io/nats.go"
)

type BenchmarkConfig struct {
    Publishers      int
    Consumers       int
    MessageSize     int
    MessageCount    int64
    Duration        time.Duration
    StreamName      string
    Subject         string
    BatchSize       int
    UseCompression  bool
    ReplicationFactor int
}

type BenchmarkResult struct {
    Config              BenchmarkConfig   `json:"config"`
    PublishRate         float64           `json:"publish_rate_msgs_per_sec"`
    ConsumeRate         float64           `json:"consume_rate_msgs_per_sec"`
    AverageLatency      time.Duration     `json:"average_latency"`
    P95Latency          time.Duration     `json:"p95_latency"`
    P99Latency          time.Duration     `json:"p99_latency"`
    TotalMessages       int64             `json:"total_messages"`
    ErrorCount          int64             `json:"error_count"`
    ThroughputMBps      float64           `json:"throughput_mbps"`
    CPUUsage            float64           `json:"cpu_usage_percent"`
    MemoryUsage         int64             `json:"memory_usage_bytes"`
    Duration            time.Duration     `json:"actual_duration"`
}

type LatencyTracker struct {
    samples []time.Duration
    mu      sync.RWMutex
}

func (lt *LatencyTracker) Record(latency time.Duration) {
    lt.mu.Lock()
    lt.samples = append(lt.samples, latency)
    lt.mu.Unlock()
}

func (lt *LatencyTracker) GetPercentile(percentile float64) time.Duration {
    lt.mu.RLock()
    defer lt.mu.RUnlock()
    
    if len(lt.samples) == 0 {
        return 0
    }
    
    // Simple percentile calculation (in production, use proper sorting)
    index := int(float64(len(lt.samples)) * percentile / 100.0)
    if index >= len(lt.samples) {
        index = len(lt.samples) - 1
    }
    
    return lt.samples[index]
}

func (lt *LatencyTracker) GetAverage() time.Duration {
    lt.mu.RLock()
    defer lt.mu.RUnlock()
    
    if len(lt.samples) == 0 {
        return 0
    }
    
    var total time.Duration
    for _, sample := range lt.samples {
        total += sample
    }
    
    return total / time.Duration(len(lt.samples))
}

type JetStreamBenchmark struct {
    js          nats.JetStreamContext
    nc          *nats.Conn
    config      BenchmarkConfig
    latencyTracker *LatencyTracker
    
    publishedCount int64
    consumedCount  int64
    errorCount     int64
    
    startTime time.Time
    endTime   time.Time
}

func NewJetStreamBenchmark(natsURL string, config BenchmarkConfig) (*JetStreamBenchmark, error) {
    // Configure NATS connection for performance
    opts := []nats.Option{
        nats.ReconnectWait(2 * time.Second),
        nats.MaxReconnects(5),
        nats.ReconnectBufSize(16 * 1024 * 1024), // 16MB buffer
        nats.DrainTimeout(30 * time.Second),
        nats.ClosedHandler(func(nc *nats.Conn) {
            log.Printf("NATS connection closed")
        }),
    }
    
    nc, err := nats.Connect(natsURL, opts...)
    if err != nil {
        return nil, fmt.Errorf("failed to connect to NATS: %w", err)
    }
    
    js, err := nc.JetStream()
    if err != nil {
        return nil, fmt.Errorf("failed to create JetStream context: %w", err)
    }
    
    return &JetStreamBenchmark{
        js:             js,
        nc:             nc,
        config:         config,
        latencyTracker: &LatencyTracker{},
    }, nil
}

func (jsb *JetStreamBenchmark) RunBenchmark(ctx context.Context) (*BenchmarkResult, error) {
    // Setup stream for benchmark
    if err := jsb.setupStream(); err != nil {
        return nil, fmt.Errorf("failed to setup stream: %w", err)
    }
    
    jsb.startTime = time.Now()
    
    // Start publishers
    publisherCtx, publisherCancel := context.WithCancel(ctx)
    publisherWg := &sync.WaitGroup{}
    
    for i := 0; i < jsb.config.Publishers; i++ {
        publisherWg.Add(1)
        go jsb.runPublisher(publisherCtx, publisherWg, i)
    }
    
    // Start consumers
    consumerCtx, consumerCancel := context.WithCancel(ctx)
    consumerWg := &sync.WaitGroup{}
    
    for i := 0; i < jsb.config.Consumers; i++ {
        consumerWg.Add(1)
        go jsb.runConsumer(consumerCtx, consumerWg, i)
    }
    
    // Wait for benchmark completion
    timer := time.NewTimer(jsb.config.Duration)
    defer timer.Stop()
    
    select {
    case <-timer.C:
        log.Println("Benchmark duration completed")
    case <-ctx.Done():
        log.Println("Benchmark cancelled")
    }
    
    // Stop publishers and consumers
    publisherCancel()
    consumerCancel()
    
    publisherWg.Wait()
    consumerWg.Wait()
    
    jsb.endTime = time.Now()
    
    return jsb.calculateResults(), nil
}

func (jsb *JetStreamBenchmark) setupStream() error {
    streamConfig := &nats.StreamConfig{
        Name:              jsb.config.StreamName,
        Subjects:          []string{jsb.config.Subject},
        Storage:           nats.FileStorage,
        Replicas:          jsb.config.ReplicationFactor,
        MaxMsgs:           -1,
        MaxBytes:          -1,
        MaxAge:            24 * time.Hour,
        MaxMsgSize:        int32(jsb.config.MessageSize * 2),
        NoAck:             false,
        Discard:           nats.DiscardOld,
        DuplicateWindow:   2 * time.Minute,
    }
    
    if jsb.config.UseCompression {
        streamConfig.Compression = nats.S2Compression
    }
    
    // Delete existing stream if it exists
    jsb.js.DeleteStream(jsb.config.StreamName)
    
    _, err := jsb.js.AddStream(streamConfig)
    return err
}

func (jsb *JetStreamBenchmark) runPublisher(ctx context.Context, wg *sync.WaitGroup, id int) {
    defer wg.Done()
    
    // Generate message payload
    payload := make([]byte, jsb.config.MessageSize)
    for i := range payload {
        payload[i] = byte(i % 256)
    }
    
    ticker := time.NewTicker(time.Millisecond) // Adjust for desired rate
    defer ticker.Stop()
    
    batch := make([]*nats.Msg, 0, jsb.config.BatchSize)
    
    for {
        select {
        case <-ctx.Done():
            // Publish remaining batch
            if len(batch) > 0 {
                jsb.publishBatch(batch)
            }
            return
        case <-ticker.C:
            msg := &nats.Msg{
                Subject: jsb.config.Subject,
                Data:    payload,
                Header:  nats.Header{},
            }
            
            // Add timestamp for latency measurement
            msg.Header.Set("Publish-Time", 
                fmt.Sprintf("%d", time.Now().UnixNano()))
            msg.Header.Set("Publisher-ID", fmt.Sprintf("%d", id))
            
            batch = append(batch, msg)
            
            if len(batch) >= jsb.config.BatchSize {
                jsb.publishBatch(batch)
                batch = batch[:0] // Reset slice
            }
        }
    }
}

func (jsb *JetStreamBenchmark) publishBatch(batch []*nats.Msg) {
    for _, msg := range batch {
        _, err := jsb.js.PublishMsg(msg)
        if err != nil {
            atomic.AddInt64(&jsb.errorCount, 1)
            log.Printf("Publish error: %v", err)
        } else {
            atomic.AddInt64(&jsb.publishedCount, 1)
        }
    }
}

func (jsb *JetStreamBenchmark) runConsumer(ctx context.Context, wg *sync.WaitGroup, id int) {
    defer wg.Done()
    
    consumerName := fmt.Sprintf("benchmark-consumer-%d", id)
    
    // Create consumer
    consumerConfig := &nats.ConsumerConfig{
        Durable:           consumerName,
        DeliverPolicy:     nats.DeliverAllPolicy,
        AckPolicy:         nats.AckExplicitPolicy,
        MaxDeliver:        1,
        AckWait:           5 * time.Second,
        MaxRequestBatch:   jsb.config.BatchSize,
        MaxRequestExpires: 1 * time.Second,
    }
    
    _, err := jsb.js.AddConsumer(jsb.config.StreamName, consumerConfig)
    if err != nil {
        log.Printf("Failed to create consumer: %v", err)
        return
    }
    
    sub, err := jsb.js.PullSubscribe("", consumerName)
    if err != nil {
        log.Printf("Failed to create subscription: %v", err)
        return
    }
    defer sub.Unsubscribe()
    
    for {
        select {
        case <-ctx.Done():
            return
        default:
        }
        
        msgs, err := sub.Fetch(jsb.config.BatchSize, nats.MaxWait(100*time.Millisecond))
        if err != nil {
            if err != nats.ErrTimeout {
                atomic.AddInt64(&jsb.errorCount, 1)
            }
            continue
        }
        
        for _, msg := range msgs {
            // Calculate latency
            publishTimeStr := msg.Header.Get("Publish-Time")
            if publishTimeStr != "" {
                var publishTime int64
                if _, err := fmt.Sscanf(publishTimeStr, "%d", &publishTime); err == nil {
                    latency := time.Since(time.Unix(0, publishTime))
                    jsb.latencyTracker.Record(latency)
                }
            }
            
            msg.Ack()
            atomic.AddInt64(&jsb.consumedCount, 1)
        }
    }
}

func (jsb *JetStreamBenchmark) calculateResults() *BenchmarkResult {
    duration := jsb.endTime.Sub(jsb.startTime)
    publishedCount := atomic.LoadInt64(&jsb.publishedCount)
    consumedCount := atomic.LoadInt64(&jsb.consumedCount)
    errorCount := atomic.LoadInt64(&jsb.errorCount)
    
    publishRate := float64(publishedCount) / duration.Seconds()
    consumeRate := float64(consumedCount) / duration.Seconds()
    
    throughputBytes := float64(consumedCount * int64(jsb.config.MessageSize))
    throughputMBps := (throughputBytes / duration.Seconds()) / (1024 * 1024)
    
    // Get memory stats
    var m runtime.MemStats
    runtime.ReadMemStats(&m)
    
    return &BenchmarkResult{
        Config:         jsb.config,
        PublishRate:    publishRate,
        ConsumeRate:    consumeRate,
        AverageLatency: jsb.latencyTracker.GetAverage(),
        P95Latency:     jsb.latencyTracker.GetPercentile(95),
        P99Latency:     jsb.latencyTracker.GetPercentile(99),
        TotalMessages:  publishedCount,
        ErrorCount:     errorCount,
        ThroughputMBps: throughputMBps,
        MemoryUsage:    int64(m.Alloc),
        Duration:       duration,
    }
}

// Performance optimization recommendations
func (jsb *JetStreamBenchmark) GenerateOptimizationReport(result *BenchmarkResult) string {
    report := fmt.Sprintf(`
JetStream Performance Benchmark Report
=====================================

Configuration:
- Publishers: %d
- Consumers: %d
- Message Size: %d bytes
- Replication Factor: %d
- Compression: %v

Results:
- Publish Rate: %.2f msgs/sec
- Consume Rate: %.2f msgs/sec
- Throughput: %.2f MB/s
- Average Latency: %v
- P95 Latency: %v
- P99 Latency: %v
- Error Rate: %.2f%%

Optimization Recommendations:
`, 
        result.Config.Publishers,
        result.Config.Consumers,
        result.Config.MessageSize,
        result.Config.ReplicationFactor,
        result.Config.UseCompression,
        result.PublishRate,
        result.ConsumeRate,
        result.ThroughputMBps,
        result.AverageLatency,
        result.P95Latency,
        result.P99Latency,
        float64(result.ErrorCount)/float64(result.TotalMessages)*100,
    )
    
    // Generate specific recommendations
    if result.PublishRate < 1000 {
        report += "- Consider increasing batch size for publishers\n"
        report += "- Optimize message serialization\n"
        report += "- Check network latency between clients and NATS\n"
    }
    
    if result.AverageLatency > 10*time.Millisecond {
        report += "- Consider using memory storage for low-latency scenarios\n"
        report += "- Reduce replication factor if data loss is acceptable\n"
        report += "- Optimize consumer acknowledgment strategy\n"
    }
    
    if result.ThroughputMBps < 100 {
        report += "- Enable compression for large messages\n"
        report += "- Use larger message batches\n"
        report += "- Consider message aggregation patterns\n"
    }
    
    if result.Config.ReplicationFactor > 1 && result.PublishRate < 5000 {
        report += "- High replication factor may be limiting throughput\n"
        report += "- Consider async replication for non-critical data\n"
    }
    
    return report
}

// Example benchmark execution
func ExampleBenchmark() {
    config := BenchmarkConfig{
        Publishers:        5,
        Consumers:         3,
        MessageSize:       1024,
        Duration:          60 * time.Second,
        StreamName:        "benchmark-stream",
        Subject:           "benchmark.test",
        BatchSize:         10,
        UseCompression:    true,
        ReplicationFactor: 3,
    }
    
    benchmark, err := NewJetStreamBenchmark("nats://localhost:4222", config)
    if err != nil {
        log.Fatalf("Failed to create benchmark: %v", err)
    }
    
    ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
    defer cancel()
    
    result, err := benchmark.RunBenchmark(ctx)
    if err != nil {
        log.Fatalf("Benchmark failed: %v", err)
    }
    
    report := benchmark.GenerateOptimizationReport(result)
    fmt.Println(report)
    
    // Save results for comparison
    resultJSON, _ := json.MarshalIndent(result, "", "  ")
    fmt.Printf("Detailed Results:\n%s\n", resultJSON)
}
```

## Conclusion

NATS JetStream provides a powerful foundation for building modern event-driven architectures. Its unique combination of simplicity, performance, and reliability makes it an excellent choice for microservices communication, real-time data processing, and distributed system coordination.

Key takeaways from this comprehensive guide:

1. **Architecture Flexibility**: JetStream's stream and consumer model provides the flexibility to implement various messaging patterns from simple pub-sub to complex event sourcing and CQRS architectures.

2. **Guaranteed Delivery**: Multiple delivery guarantees (at-most-once, at-least-once, exactly-once) enable you to choose the right trade-off between performance and reliability for each use case.

3. **High Availability**: Built-in clustering, replication, and backup capabilities ensure your event streaming infrastructure can handle production demands with minimal downtime.

4. **Performance Optimization**: Through careful tuning of configuration parameters, batching strategies, and resource allocation, JetStream can achieve exceptional throughput and low latency.

5. **Microservices Integration**: Rich patterns for service-to-service communication, including request-response, pub-sub, and distributed transactions via sagas, simplify building resilient distributed systems.

Best practices for production deployment:
- Start with simple configurations and optimize based on actual performance requirements
- Implement comprehensive monitoring and alerting for early issue detection
- Use proper backup and disaster recovery procedures
- Consider message schema evolution and backward compatibility
- Plan for capacity growth and implement proper resource management

As event-driven architectures continue to evolve, NATS JetStream positions itself as a mature, scalable solution that can grow with your organization's needs while maintaining operational simplicity.