---
title: "Go Event-Driven Microservices: CloudEvents, Event Bus Patterns, and Schema Registry"
date: 2030-04-28T00:00:00-05:00
draft: false
tags: ["Go", "CloudEvents", "Event-Driven", "Kafka", "Schema Registry", "Microservices"]
categories: ["Go", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to building event-driven microservices in Go using the CloudEvents specification, schema registry integration with Confluent Schema Registry and AWS Glue, event versioning patterns, saga coordination, and Kafka consumer group management."
more_link: "yes"
url: "/go-event-driven-microservices-cloudevents-schema-registry/"
---

Event-driven architecture promises loose coupling and independent deployability, but it introduces a different class of operational problems: how do you know what events are flowing through your system? How do you evolve an event schema without breaking consumers? How do you coordinate transactions that span multiple services? These are problems that direct RPC calls never had to solve.

This guide builds a production-grade event-driven system in Go that addresses schema governance with a schema registry, versioned event evolution, and saga coordination for distributed transactions.

<!--more-->

# Go Event-Driven Microservices: CloudEvents, Event Bus Patterns, and Schema Registry

## Project Structure

```
event-platform/
├── go.mod
├── pkg/
│   ├── cloudevents/
│   │   ├── envelope.go        # CloudEvents envelope and validation
│   │   └── registry.go        # Schema registry client
│   ├── producer/
│   │   └── kafka_producer.go
│   ├── consumer/
│   │   └── kafka_consumer.go
│   └── saga/
│       ├── coordinator.go
│       └── step.go
├── events/
│   ├── order/
│   │   ├── v1/
│   │   │   └── order_created.go
│   │   └── v2/
│   │       └── order_created.go
│   └── payment/
│       └── v1/
│           └── payment_completed.go
└── services/
    ├── order-service/
    └── payment-service/
```

```bash
go mod init github.com/yourorg/event-platform

go get github.com/cloudevents/sdk-go/v2@latest
go get github.com/segmentio/kafka-go@latest
go get github.com/riferrei/srclient@latest  # Confluent Schema Registry client
go get google.golang.org/protobuf@latest
go get github.com/linkedin/goavro/v2@latest
```

## CloudEvents Specification Implementation

CloudEvents is a CNCF specification that defines a common envelope format for events. Using it provides interoperability with event routing infrastructure, cloud provider event systems (AWS EventBridge, Google Eventarc), and observability tools.

### Core CloudEvents Envelope

```go
// pkg/cloudevents/envelope.go
package cloudevents

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	cloudeventsv2 "github.com/cloudevents/sdk-go/v2"
	"github.com/cloudevents/sdk-go/v2/event"
	"github.com/google/uuid"
)

// EventType follows the reverse-DNS format: <org>.<service>.<entity>.<action>.<version>
type EventType string

const (
	OrderCreatedV1   EventType = "com.yourorg.orders.order.created.v1"
	OrderCreatedV2   EventType = "com.yourorg.orders.order.created.v2"
	OrderCancelledV1 EventType = "com.yourorg.orders.order.cancelled.v1"
	PaymentInitV1    EventType = "com.yourorg.payments.payment.initiated.v1"
	PaymentDoneV1    EventType = "com.yourorg.payments.payment.completed.v1"
	PaymentFailedV1  EventType = "com.yourorg.payments.payment.failed.v1"
)

// EventBuilder builds type-safe CloudEvents with required attributes
type EventBuilder struct {
	source      string
	subject     string
	eventType   EventType
	schemaURL   string
	data        interface{}
	extensions  map[string]interface{}
}

func NewEvent(source string, eventType EventType) *EventBuilder {
	return &EventBuilder{
		source:     source,
		eventType:  eventType,
		extensions: make(map[string]interface{}),
	}
}

func (b *EventBuilder) WithSubject(subject string) *EventBuilder {
	b.subject = subject
	return b
}

func (b *EventBuilder) WithSchema(schemaURL string) *EventBuilder {
	b.schemaURL = schemaURL
	return b
}

func (b *EventBuilder) WithData(data interface{}) *EventBuilder {
	b.data = data
	return b
}

func (b *EventBuilder) WithExtension(key string, value interface{}) *EventBuilder {
	b.extensions[key] = value
	return b
}

// WithCorrelation adds distributed tracing correlation
func (b *EventBuilder) WithCorrelation(correlationID, causationID string) *EventBuilder {
	b.extensions["correlationid"] = correlationID
	b.extensions["causationid"] = causationID
	return b
}

// WithPartitionKey sets Kafka partition key via extension
func (b *EventBuilder) WithPartitionKey(key string) *EventBuilder {
	b.extensions["partitionkey"] = key
	return b
}

func (b *EventBuilder) Build() (cloudeventsv2.Event, error) {
	e := cloudeventsv2.NewEvent()
	e.SetID(uuid.New().String())
	e.SetSource(b.source)
	e.SetType(string(b.eventType))
	e.SetTime(time.Now().UTC())
	e.SetSpecVersion("1.0")

	if b.subject != "" {
		e.SetSubject(b.subject)
	}
	if b.schemaURL != "" {
		e.SetDataSchema(b.schemaURL)
	}

	for k, v := range b.extensions {
		e.SetExtension(k, v)
	}

	if b.data != nil {
		if err := e.SetData(cloudeventsv2.ApplicationJSON, b.data); err != nil {
			return e, fmt.Errorf("set data: %w", err)
		}
	}

	return e, nil
}

// ValidateEvent checks that a received CloudEvent meets our requirements
func ValidateEvent(e cloudeventsv2.Event) error {
	if e.ID() == "" {
		return fmt.Errorf("missing event id")
	}
	if e.Source() == "" {
		return fmt.Errorf("missing event source")
	}
	if e.Type() == "" {
		return fmt.Errorf("missing event type")
	}
	if e.Time().IsZero() {
		return fmt.Errorf("missing event time")
	}
	return e.Validate()
}

// ExtractPartitionKey extracts the Kafka partition key from event extensions
func ExtractPartitionKey(e cloudeventsv2.Event) string {
	if key, ok := e.Extensions()["partitionkey"]; ok {
		return fmt.Sprintf("%v", key)
	}
	// Fall back to subject, then event ID
	if e.Subject() != "" {
		return e.Subject()
	}
	return e.ID()
}
```

### Event Schema Definitions

```go
// events/order/v1/order_created.go
package orderv1

import "time"

// OrderCreatedV1 is the data payload for order.created v1 events.
// FROZEN: This version is in production. Use v2 for new fields.
type OrderCreatedV1 struct {
	OrderID    string     `json:"order_id"`
	CustomerID string     `json:"customer_id"`
	Items      []ItemV1   `json:"items"`
	Total      MoneyV1    `json:"total"`
	CreatedAt  time.Time  `json:"created_at"`
}

type ItemV1 struct {
	SKU      string  `json:"sku"`
	Quantity int     `json:"quantity"`
	Price    MoneyV1 `json:"price"`
}

type MoneyV1 struct {
	AmountMicros int64  `json:"amount_micros"`
	Currency     string `json:"currency"`
}
```

```go
// events/order/v2/order_created.go
package orderv2

import "time"

// OrderCreatedV2 adds shipping address and channel fields.
// Consumers that only need v1 fields can read v2 events using the v1 struct
// (JSON unknown fields are ignored by default).
type OrderCreatedV2 struct {
	// All v1 fields preserved with same JSON tags
	OrderID    string    `json:"order_id"`
	CustomerID string    `json:"customer_id"`
	Items      []ItemV2  `json:"items"`
	Total      MoneyV2   `json:"total"`
	CreatedAt  time.Time `json:"created_at"`

	// New in v2
	ShippingAddress *AddressV2 `json:"shipping_address,omitempty"`
	Channel         string     `json:"channel,omitempty"`
	PromoCodes      []string   `json:"promo_codes,omitempty"`
}

type ItemV2 struct {
	SKU         string  `json:"sku"`
	Quantity    int     `json:"quantity"`
	Price       MoneyV2 `json:"price"`
	ProductName string  `json:"product_name,omitempty"` // New in v2
}

type MoneyV2 struct {
	AmountMicros int64  `json:"amount_micros"`
	Currency     string `json:"currency"`
}

type AddressV2 struct {
	Line1      string `json:"line1"`
	Line2      string `json:"line2,omitempty"`
	City       string `json:"city"`
	State      string `json:"state"`
	PostalCode string `json:"postal_code"`
	Country    string `json:"country"`
}
```

## Schema Registry Integration

### Confluent Schema Registry Client

```go
// pkg/cloudevents/registry.go
package cloudevents

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/riferrei/srclient"
)

// SchemaRegistryClient wraps the Confluent Schema Registry client
// with caching and schema evolution helpers.
type SchemaRegistryClient struct {
	client *srclient.SchemaRegistryClient
	cache  sync.Map // subject -> *CachedSchema
}

type CachedSchema struct {
	SchemaID int
	Schema   *srclient.Schema
	Version  int
}

func NewSchemaRegistryClient(url string) *SchemaRegistryClient {
	return &SchemaRegistryClient{
		client: srclient.CreateSchemaRegistryClient(url),
	}
}

// RegisterSchema registers or retrieves a schema for an event type.
// Subject naming convention: <topic>-value for value schemas
func (r *SchemaRegistryClient) RegisterSchema(
	ctx context.Context,
	subject string,
	schema string,
) (*CachedSchema, error) {
	// Check cache first
	if cached, ok := r.cache.Load(subject); ok {
		return cached.(*CachedSchema), nil
	}

	registeredSchema, err := r.client.CreateSchema(subject, schema, srclient.Json)
	if err != nil {
		return nil, fmt.Errorf("register schema for %s: %w", subject, err)
	}

	cached := &CachedSchema{
		SchemaID: registeredSchema.ID(),
		Schema:   registeredSchema,
		Version:  registeredSchema.Version(),
	}
	r.cache.Store(subject, cached)
	return cached, nil
}

// GetLatestSchema retrieves the latest schema for a subject
func (r *SchemaRegistryClient) GetLatestSchema(subject string) (*CachedSchema, error) {
	schema, err := r.client.GetLatestSchema(subject)
	if err != nil {
		return nil, fmt.Errorf("get latest schema for %s: %w", subject, err)
	}
	return &CachedSchema{
		SchemaID: schema.ID(),
		Schema:   schema,
		Version:  schema.Version(),
	}, nil
}

// ValidateAgainstRegistry validates event data against the registered schema
func (r *SchemaRegistryClient) ValidateAgainstRegistry(
	subject string,
	data []byte,
) error {
	schema, err := r.GetLatestSchema(subject)
	if err != nil {
		return fmt.Errorf("get schema: %w", err)
	}

	var parsed interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}

	if err := schema.Schema.Validate(parsed); err != nil {
		return fmt.Errorf("schema validation failed: %w", err)
	}
	return nil
}
```

### JSON Schema Registration

```go
// Register schemas on startup
func RegisterOrderSchemas(registry *cloudevents.SchemaRegistryClient) error {
	ctx := context.Background()

	orderCreatedV1Schema := `{
		"$schema": "http://json-schema.org/draft-07/schema#",
		"type": "object",
		"title": "OrderCreatedV1",
		"required": ["order_id", "customer_id", "items", "total", "created_at"],
		"properties": {
			"order_id": {"type": "string", "format": "uuid"},
			"customer_id": {"type": "string"},
			"items": {
				"type": "array",
				"items": {
					"type": "object",
					"required": ["sku", "quantity", "price"],
					"properties": {
						"sku": {"type": "string"},
						"quantity": {"type": "integer", "minimum": 1},
						"price": {"$ref": "#/definitions/money"}
					}
				}
			},
			"total": {"$ref": "#/definitions/money"},
			"created_at": {"type": "string", "format": "date-time"}
		},
		"definitions": {
			"money": {
				"type": "object",
				"required": ["amount_micros", "currency"],
				"properties": {
					"amount_micros": {"type": "integer"},
					"currency": {"type": "string", "pattern": "^[A-Z]{3}$"}
				}
			}
		}
	}`

	if _, err := registry.RegisterSchema(ctx,
		"orders.created.v1-value",
		orderCreatedV1Schema,
	); err != nil {
		return fmt.Errorf("register order created v1 schema: %w", err)
	}
	return nil
}
```

## Kafka Producer with CloudEvents

```go
// pkg/producer/kafka_producer.go
package producer

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	cloudeventsv2 "github.com/cloudevents/sdk-go/v2"
	"github.com/segmentio/kafka-go"

	ce "github.com/yourorg/event-platform/pkg/cloudevents"
)

type KafkaEventProducer struct {
	writers map[string]*kafka.Writer
	logger  *slog.Logger
}

func NewKafkaEventProducer(brokers []string, logger *slog.Logger) *KafkaEventProducer {
	return &KafkaEventProducer{
		writers: make(map[string]*kafka.Writer),
		logger:  logger,
	}
}

func (p *KafkaEventProducer) writerFor(topic string) *kafka.Writer {
	if w, ok := p.writers[topic]; ok {
		return w
	}

	w := &kafka.Writer{
		Addr:                   kafka.TCP([]string{"kafka-0.kafka-headless:9092", "kafka-1.kafka-headless:9092", "kafka-2.kafka-headless:9092"}...),
		Topic:                  topic,
		Balancer:               &kafka.Hash{},   // Partition by key for ordering
		RequiredAcks:           kafka.RequireAll, // Wait for all ISR replicas
		MaxAttempts:            5,
		WriteBackoffMin:        100 * time.Millisecond,
		WriteBackoffMax:        5 * time.Second,
		BatchSize:              100,
		BatchBytes:             1 << 20, // 1 MB
		BatchTimeout:           5 * time.Millisecond,
		ReadTimeout:            10 * time.Second,
		WriteTimeout:           10 * time.Second,
		Compression:            kafka.Snappy,
		AllowAutoTopicCreation: false, // Require explicit topic creation
	}

	p.writers[topic] = w
	return w
}

// Publish publishes a CloudEvent to a Kafka topic
func (p *KafkaEventProducer) Publish(
	ctx context.Context,
	topic string,
	event cloudeventsv2.Event,
) error {
	if err := ce.ValidateEvent(event); err != nil {
		return fmt.Errorf("invalid event: %w", err)
	}

	eventBytes, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	// Extract partition key
	partitionKey := ce.ExtractPartitionKey(event)

	msg := kafka.Message{
		Key:   []byte(partitionKey),
		Value: eventBytes,
		Headers: []kafka.Header{
			{Key: "ce_type", Value: []byte(event.Type())},
			{Key: "ce_source", Value: []byte(event.Source())},
			{Key: "ce_id", Value: []byte(event.ID())},
			{Key: "content-type", Value: []byte("application/cloudevents+json")},
		},
		Time: event.Time(),
	}

	writer := p.writerFor(topic)
	if err := writer.WriteMessages(ctx, msg); err != nil {
		p.logger.ErrorContext(ctx, "failed to publish event",
			"topic", topic,
			"event_type", event.Type(),
			"event_id", event.ID(),
			"error", err,
		)
		return fmt.Errorf("publish to %s: %w", topic, err)
	}

	p.logger.InfoContext(ctx, "event published",
		"topic", topic,
		"event_type", event.Type(),
		"event_id", event.ID(),
		"partition_key", partitionKey,
	)
	return nil
}

func (p *KafkaEventProducer) Close() error {
	var firstErr error
	for _, w := range p.writers {
		if err := w.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
```

## Kafka Consumer with Event Routing

```go
// pkg/consumer/kafka_consumer.go
package consumer

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	cloudeventsv2 "github.com/cloudevents/sdk-go/v2"
	"github.com/segmentio/kafka-go"

	ce "github.com/yourorg/event-platform/pkg/cloudevents"
)

// EventHandler processes a single CloudEvent
type EventHandler func(ctx context.Context, event cloudeventsv2.Event) error

// EventRouter routes events to handlers based on event type
type EventRouter struct {
	handlers    map[string]EventHandler
	middlewares []func(EventHandler) EventHandler
}

func NewEventRouter() *EventRouter {
	return &EventRouter{
		handlers: make(map[string]EventHandler),
	}
}

func (r *EventRouter) On(eventType string, handler EventHandler) *EventRouter {
	r.handlers[eventType] = handler
	return r
}

func (r *EventRouter) Use(middleware func(EventHandler) EventHandler) *EventRouter {
	r.middlewares = append(r.middlewares, middleware)
	return r
}

func (r *EventRouter) Handle(ctx context.Context, event cloudeventsv2.Event) error {
	handler, ok := r.handlers[event.Type()]
	if !ok {
		// Unrecognized event type — log and skip (do not error, topic may have other consumers)
		return nil
	}

	// Apply middleware chain
	for i := len(r.middlewares) - 1; i >= 0; i-- {
		handler = r.middlewares[i](handler)
	}

	return handler(ctx, event)
}

// KafkaConsumerGroup manages a Kafka consumer group with event routing
type KafkaConsumerGroup struct {
	reader *kafka.Reader
	router *EventRouter
	logger *slog.Logger
}

func NewKafkaConsumerGroup(
	brokers []string,
	topic string,
	groupID string,
	router *EventRouter,
	logger *slog.Logger,
) *KafkaConsumerGroup {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: brokers,
		Topic:   topic,
		GroupID: groupID,
		// Manual commit — commit only after successful processing
		CommitInterval: 0,
		// Start from latest for new consumer groups
		// Set to kafka.FirstOffset to replay all events
		StartOffset:    kafka.LastOffset,
		MaxWait:        500 * time.Millisecond,
		MinBytes:       1,
		MaxBytes:       10 << 20, // 10 MB
		RetentionTime:  7 * 24 * time.Hour,
		ReadBackoffMin: 100 * time.Millisecond,
		ReadBackoffMax: 10 * time.Second,
	})

	return &KafkaConsumerGroup{
		reader: reader,
		router: router,
		logger: logger,
	}
}

// Run starts consuming messages until the context is cancelled
func (c *KafkaConsumerGroup) Run(ctx context.Context) error {
	c.logger.InfoContext(ctx, "consumer group starting",
		"topic", c.reader.Config().Topic,
		"group", c.reader.Config().GroupID,
	)

	for {
		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				c.logger.InfoContext(ctx, "consumer shutting down")
				return nil
			}
			c.logger.ErrorContext(ctx, "fetch message failed", "error", err)
			// Back off briefly to avoid tight error loop
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(500 * time.Millisecond):
			}
			continue
		}

		var event cloudeventsv2.Event
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			c.logger.ErrorContext(ctx, "failed to unmarshal CloudEvent",
				"topic", msg.Topic,
				"partition", msg.Partition,
				"offset", msg.Offset,
				"error", err,
			)
			// Commit and skip malformed messages (send to DLQ in production)
			if err := c.reader.CommitMessages(ctx, msg); err != nil {
				c.logger.ErrorContext(ctx, "commit failed", "error", err)
			}
			continue
		}

		if err := ce.ValidateEvent(event); err != nil {
			c.logger.WarnContext(ctx, "invalid CloudEvent",
				"error", err,
				"event_type", event.Type(),
			)
			_ = c.reader.CommitMessages(ctx, msg)
			continue
		}

		// Process the event
		if err := c.router.Handle(ctx, event); err != nil {
			c.logger.ErrorContext(ctx, "event processing failed",
				"event_type", event.Type(),
				"event_id", event.ID(),
				"error", err,
			)
			// Do NOT commit — message will be redelivered
			// In production: implement exponential backoff and DLQ routing
			continue
		}

		// Commit only after successful processing
		if err := c.reader.CommitMessages(ctx, msg); err != nil {
			c.logger.ErrorContext(ctx, "commit failed", "error", err)
		}
	}
}

func (c *KafkaConsumerGroup) Close() error {
	return c.reader.Close()
}
```

## Event-Driven Saga Coordination

Sagas coordinate multi-step distributed transactions by publishing events and listening for responses, with explicit compensation steps for failures.

```go
// pkg/saga/coordinator.go
package saga

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	cloudeventsv2 "github.com/cloudevents/sdk-go/v2"

	ce "github.com/yourorg/event-platform/pkg/cloudevents"
	"github.com/yourorg/event-platform/pkg/producer"
)

// SagaStep defines one step in a saga
type SagaStep struct {
	Name      string
	Execute   func(ctx context.Context, data interface{}) (cloudeventsv2.Event, error)
	Compensate func(ctx context.Context, data interface{}) (cloudeventsv2.Event, error)
}

// SagaState tracks the progress of a saga instance
type SagaState struct {
	SagaID          string
	CompletedSteps  []string
	Status          SagaStatus
	CorrelationData interface{}
	UpdatedAt       time.Time
}

type SagaStatus string

const (
	SagaStatusRunning     SagaStatus = "running"
	SagaStatusCompleted   SagaStatus = "completed"
	SagaStatusFailed      SagaStatus = "failed"
	SagaStatusCompensating SagaStatus = "compensating"
)

// SagaStateStore persists saga state (use Redis or a database in production)
type SagaStateStore interface {
	Save(ctx context.Context, state SagaState) error
	Load(ctx context.Context, sagaID string) (*SagaState, error)
}

// OrderSagaCoordinator orchestrates the order placement saga:
// 1. Reserve inventory
// 2. Process payment
// 3. Confirm order
// Compensations: cancel reservation, refund payment, cancel order
type OrderSagaCoordinator struct {
	steps    []SagaStep
	producer *producer.KafkaEventProducer
	store    SagaStateStore
	logger   *slog.Logger

	// Pending sagas waiting for async responses
	pending sync.Map // sagaID -> chan SagaResponse
}

type SagaResponse struct {
	SagaID  string
	StepName string
	Success bool
	Data    interface{}
	Err     error
}

func NewOrderSagaCoordinator(
	p *producer.KafkaEventProducer,
	store SagaStateStore,
	logger *slog.Logger,
) *OrderSagaCoordinator {
	c := &OrderSagaCoordinator{
		producer: p,
		store:    store,
		logger:   logger,
	}

	c.steps = []SagaStep{
		{
			Name:    "reserve-inventory",
			Execute: c.reserveInventory,
			Compensate: c.releaseInventory,
		},
		{
			Name:    "process-payment",
			Execute: c.processPayment,
			Compensate: c.refundPayment,
		},
		{
			Name:    "confirm-order",
			Execute: c.confirmOrder,
			Compensate: c.cancelOrder,
		},
	}

	return c
}

// Execute runs the order saga for a given order
func (c *OrderSagaCoordinator) Execute(ctx context.Context, sagaID string, orderData interface{}) error {
	state := SagaState{
		SagaID:          sagaID,
		Status:          SagaStatusRunning,
		CorrelationData: orderData,
		UpdatedAt:       time.Now(),
	}
	if err := c.store.Save(ctx, state); err != nil {
		return fmt.Errorf("save initial saga state: %w", err)
	}

	// Execute steps sequentially
	for i, step := range c.steps {
		c.logger.InfoContext(ctx, "executing saga step",
			"saga_id", sagaID,
			"step", step.Name,
			"index", i,
		)

		event, err := step.Execute(ctx, orderData)
		if err != nil {
			c.logger.ErrorContext(ctx, "saga step failed",
				"saga_id", sagaID,
				"step", step.Name,
				"error", err,
			)
			// Trigger compensation
			return c.compensate(ctx, &state, i-1, orderData)
		}

		// Publish the event
		if err := c.producer.Publish(ctx, topicForEvent(event.Type()), event); err != nil {
			return c.compensate(ctx, &state, i-1, orderData)
		}

		state.CompletedSteps = append(state.CompletedSteps, step.Name)
		state.UpdatedAt = time.Now()
		if err := c.store.Save(ctx, state); err != nil {
			c.logger.ErrorContext(ctx, "failed to save saga state", "error", err)
		}
	}

	state.Status = SagaStatusCompleted
	state.UpdatedAt = time.Now()
	return c.store.Save(ctx, state)
}

func (c *OrderSagaCoordinator) compensate(
	ctx context.Context,
	state *SagaState,
	lastCompletedIndex int,
	data interface{},
) error {
	state.Status = SagaStatusCompensating
	state.UpdatedAt = time.Now()
	_ = c.store.Save(ctx, *state)

	// Compensate in reverse order
	for i := lastCompletedIndex; i >= 0; i-- {
		step := c.steps[i]
		c.logger.InfoContext(ctx, "compensating saga step",
			"saga_id", state.SagaID,
			"step", step.Name,
		)

		event, err := step.Compensate(ctx, data)
		if err != nil {
			c.logger.ErrorContext(ctx, "compensation failed",
				"saga_id", state.SagaID,
				"step", step.Name,
				"error", err,
			)
			// Log but continue compensating remaining steps
			continue
		}

		if err := c.producer.Publish(ctx, topicForEvent(event.Type()), event); err != nil {
			c.logger.ErrorContext(ctx, "failed to publish compensation event",
				"saga_id", state.SagaID,
				"step", step.Name,
				"error", err,
			)
		}
	}

	state.Status = SagaStatusFailed
	state.UpdatedAt = time.Now()
	return c.store.Save(ctx, *state)
}

func (c *OrderSagaCoordinator) reserveInventory(ctx context.Context, data interface{}) (cloudeventsv2.Event, error) {
	event, err := ce.NewEvent(
		"com.yourorg.orders",
		ce.EventType("com.yourorg.inventory.reservation.requested.v1"),
	).
		WithData(data).
		WithCorrelation("", "").
		Build()
	return event, err
}

func (c *OrderSagaCoordinator) releaseInventory(ctx context.Context, data interface{}) (cloudeventsv2.Event, error) {
	event, err := ce.NewEvent(
		"com.yourorg.orders",
		ce.EventType("com.yourorg.inventory.reservation.released.v1"),
	).
		WithData(data).
		Build()
	return event, err
}

func (c *OrderSagaCoordinator) processPayment(ctx context.Context, data interface{}) (cloudeventsv2.Event, error) {
	event, err := ce.NewEvent(
		"com.yourorg.orders",
		ce.PaymentInitV1,
	).
		WithData(data).
		Build()
	return event, err
}

func (c *OrderSagaCoordinator) refundPayment(ctx context.Context, data interface{}) (cloudeventsv2.Event, error) {
	event, err := ce.NewEvent(
		"com.yourorg.orders",
		ce.EventType("com.yourorg.payments.payment.refunded.v1"),
	).
		WithData(data).
		Build()
	return event, err
}

func (c *OrderSagaCoordinator) confirmOrder(ctx context.Context, data interface{}) (cloudeventsv2.Event, error) {
	event, err := ce.NewEvent(
		"com.yourorg.orders",
		ce.EventType("com.yourorg.orders.order.confirmed.v1"),
	).
		WithData(data).
		Build()
	return event, err
}

func (c *OrderSagaCoordinator) cancelOrder(ctx context.Context, data interface{}) (cloudeventsv2.Event, error) {
	event, err := ce.NewEvent(
		"com.yourorg.orders",
		ce.EventType("com.yourorg.orders.order.cancelled.v1"),
	).
		WithData(data).
		Build()
	return event, err
}

func topicForEvent(eventType string) string {
	// Map event types to Kafka topics
	topicMap := map[string]string{
		"com.yourorg.inventory.reservation.requested.v1": "inventory-commands",
		"com.yourorg.inventory.reservation.released.v1":  "inventory-commands",
		"com.yourorg.payments.payment.initiated.v1":       "payment-commands",
		"com.yourorg.payments.payment.refunded.v1":        "payment-commands",
		"com.yourorg.orders.order.confirmed.v1":           "order-events",
		"com.yourorg.orders.order.cancelled.v1":           "order-events",
	}
	if topic, ok := topicMap[eventType]; ok {
		return topic
	}
	return "unknown-events"
}
```

## Consumer Group Patterns

### Competing Consumers for Parallel Processing

```go
// services/payment-service/main.go
package main

import (
	"context"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"log/slog"

	"github.com/yourorg/event-platform/pkg/consumer"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	brokers := []string{
		"kafka-0.kafka-headless:9092",
		"kafka-1.kafka-headless:9092",
		"kafka-2.kafka-headless:9092",
	}

	// Multiple consumer groups can read the same topic independently
	// Each consumer group gets its own offset tracking

	router := consumer.NewEventRouter().
		On("com.yourorg.payments.payment.initiated.v1", handlePaymentInitiated).
		On("com.yourorg.payments.payment.refunded.v1", handlePaymentRefund).
		Use(loggingMiddleware(logger)).
		Use(metricsMiddleware())

	// Create consumer group with group ID scoped to this service
	// groupID must be unique per logical consumer (not per replica)
	cg := consumer.NewKafkaConsumerGroup(
		brokers,
		"payment-commands",
		"payment-service-v1",  // All replicas share this group ID
		router,
		logger,
	)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := cg.Run(ctx); err != nil {
			logger.Error("consumer group error", "error", err)
		}
	}()

	wg.Wait()
	_ = cg.Close()
}
```

## Key Takeaways

- Use CloudEvents as your event envelope format — it provides a standard structure that works with cloud-native event routing infrastructure and makes event introspection consistent across all services.
- Name event types using reverse-DNS with explicit versions: `com.yourorg.service.entity.action.v1` — this makes schema evolution explicit and avoids ambiguity when consuming mixed-version event streams.
- Schema registries enforce forward and backward compatibility at publish time; register schemas on startup and fail fast if a new event type violates compatibility rules.
- Always use `omitempty` for new fields added in schema evolution — existing consumers that have been compiled against older schemas will ignore unknown fields in JSON, but struct-tagged consumers need `omitempty` to not serialize zero-value fields.
- Sagas provide distributed transaction coordination without distributed locks; compensating transactions must be idempotent because they may be retried.
- Consumer groups in Kafka provide competing consumer semantics — all replicas of a service share one group ID, ensuring each message is processed exactly once within the group. Different services use different group IDs to independently consume the same topic.
- Commit Kafka offsets only after successful processing — this is the primary mechanism for at-least-once delivery semantics, and deferring the commit means failed messages are retried automatically.
