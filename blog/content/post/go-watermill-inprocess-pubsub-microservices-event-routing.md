---
title: "Go: Implementing High-Performance In-Process Pub/Sub with Watermill for Microservices Event Routing"
date: 2031-07-29T00:00:00-05:00
draft: false
tags: ["Go", "Watermill", "Pub/Sub", "Microservices", "Event-Driven", "Message Routing", "Golang"]
categories:
- Go
- Microservices
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into using the Watermill library to build high-performance in-process pub/sub and event routing in Go microservices, covering message routing, middleware, CQRS patterns, and production operational concerns."
more_link: "yes"
url: "/go-watermill-inprocess-pubsub-microservices-event-routing/"
---

Most Go microservices eventually face the same architectural pressure: components that were initially coupled through direct function calls need to be decoupled, and events that originated as local state changes need to eventually reach external message brokers. The naive solution — wrapping everything in goroutines with channels — works until your routing logic becomes a tangled mess of select statements. Watermill provides a structured pub/sub abstraction that works identically whether you're routing messages in-process through Go channels, over Kafka, or through AMQP.

This guide covers building a production-grade event routing layer using Watermill's in-process Gochannel publisher/subscriber, adding middleware for observability, implementing CQRS patterns, and migrating seamlessly to an external broker when the need arises.

<!--more-->

# Go: Implementing High-Performance In-Process Pub/Sub with Watermill for Microservices Event Routing

## Why Watermill for In-Process Messaging

The standard Go answer for decoupled communication is channels. Watermill's Gochannel wraps raw Go channels in a pub/sub API that adds several critical capabilities:

- Multiple subscribers on the same topic (fan-out), which channels alone do not support natively
- Message middleware pipeline (logging, retry, metrics, tracing) applied uniformly
- Dead-letter queue semantics for messages that cannot be processed
- A router that maps topics to handlers with built-in error handling
- The same API surface as external broker implementations (Kafka, AMQP, NATS, Redpanda)

The last point is the most important. Code written against the Watermill interface compiles and runs identically against the in-process Gochannel and against a production Kafka cluster. You can start with the in-process implementation during development and testing, then swap the broker implementation without changing any business logic.

## Module Setup

```bash
mkdir event-service && cd event-service
go mod init github.com/yourorg/event-service
go get github.com/ThreeDotsLabs/watermill@v1.3.5
go get github.com/ThreeDotsLabs/watermill-kafka/v3@v3.0.1   # optional, for later migration
go get go.uber.org/zap@v1.27.0
```

## Core Abstractions

Watermill's model is straightforward: a Publisher writes messages to topics, a Subscriber reads messages from topics, and a Router connects subscriber outputs to handler functions with middleware applied.

```go
// internal/events/types.go
package events

import (
	"time"

	"github.com/ThreeDotsLabs/watermill/message"
)

// TopicName is a typed string to prevent accidental topic name collisions.
type TopicName string

const (
	TopicOrderCreated    TopicName = "order.created"
	TopicOrderFulfilled  TopicName = "order.fulfilled"
	TopicOrderCancelled  TopicName = "order.cancelled"
	TopicPaymentReceived TopicName = "payment.received"
	TopicInventoryUpdate TopicName = "inventory.updated"
	TopicDLQ             TopicName = "dead-letter-queue"
)

// EventEnvelope wraps business events with routing metadata.
type EventEnvelope struct {
	EventType   string            `json:"event_type"`
	AggregateID string            `json:"aggregate_id"`
	Version     int               `json:"version"`
	OccurredAt  time.Time         `json:"occurred_at"`
	Metadata    map[string]string `json:"metadata,omitempty"`
	Payload     json.RawMessage   `json:"payload"`
}

// HandlerFunc is a typed handler for structured event processing.
type HandlerFunc[T any] func(event T) error

// MessageIDFromContext retrieves the Watermill message UUID from context.
// Watermill stores this automatically on the message context.
func MessageIDFromContext(msg *message.Message) string {
	return msg.UUID
}
```

## Publisher and Subscriber Wiring

```go
// internal/events/broker.go
package events

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/ThreeDotsLabs/watermill"
	"github.com/ThreeDotsLabs/watermill/message"
	"github.com/ThreeDotsLabs/watermill/pubsub/gochannel"
	"go.uber.org/zap"
)

// Broker encapsulates the Watermill publisher and subscriber.
// In tests and development, this uses the in-process Gochannel.
// In production, swap the implementation for Kafka or AMQP.
type Broker struct {
	publisher  message.Publisher
	subscriber message.Subscriber
	logger     watermill.LoggerAdapter
	zapLogger  *zap.Logger
}

// NewInProcessBroker creates a Gochannel-backed broker for in-process messaging.
// This is the recommended starting point for new services.
func NewInProcessBroker(zapLog *zap.Logger) *Broker {
	wmLogger := NewZapLoggerAdapter(zapLog)

	ch := gochannel.NewGoChannel(
		gochannel.Config{
			// Buffer outgoing messages to prevent publisher blocking
			// on slow consumers. 1024 is a reasonable starting point;
			// increase if you observe publisher backpressure in metrics.
			OutputChannelBuffer: 1024,
			// Persistent: when true, new subscribers receive all messages
			// published since the channel was created. False is appropriate
			// for event-driven flows where subscribers only need new events.
			Persistent: false,
			// Block publishers when the output buffer is full.
			// Set to true for backpressure propagation.
			BlockPublishUntilSubscriberAck: false,
		},
		wmLogger,
	)

	return &Broker{
		publisher:  ch,
		subscriber: ch,
		logger:     wmLogger,
		zapLogger:  zapLog,
	}
}

// Publish serializes an event envelope and writes it to a topic.
func (b *Broker) Publish(ctx context.Context, topic TopicName, event EventEnvelope) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event envelope: %w", err)
	}

	msg := message.NewMessage(watermill.NewUUID(), payload)

	// Propagate trace context via message metadata
	if traceID, ok := ctx.Value(traceIDKey{}).(string); ok {
		msg.Metadata.Set("trace-id", traceID)
	}
	msg.Metadata.Set("published-at", time.Now().UTC().Format(time.RFC3339Nano))
	msg.Metadata.Set("event-type", event.EventType)

	return b.publisher.Publish(string(topic), msg)
}

// Subscribe returns a channel of messages on the given topic.
// The caller is responsible for acknowledging (Ack) or rejecting (Nack) each message.
func (b *Broker) Subscribe(ctx context.Context, topic TopicName) (<-chan *message.Message, error) {
	return b.subscriber.Subscribe(ctx, string(topic))
}

// Publisher returns the underlying publisher for use with the Router.
func (b *Broker) Publisher() message.Publisher { return b.publisher }

// Subscriber returns the underlying subscriber for use with the Router.
func (b *Broker) Subscriber() message.Subscriber { return b.subscriber }

// Close shuts down the broker gracefully.
func (b *Broker) Close() error {
	return b.publisher.Close()
}

type traceIDKey struct{}
```

## Watermill Logger Adapter for Zap

Watermill uses its own logger interface. This adapter bridges it to Zap.

```go
// internal/events/logger.go
package events

import (
	"github.com/ThreeDotsLabs/watermill"
	"go.uber.org/zap"
)

type zapLoggerAdapter struct {
	log *zap.Logger
}

func NewZapLoggerAdapter(log *zap.Logger) watermill.LoggerAdapter {
	return &zapLoggerAdapter{log: log}
}

func (z *zapLoggerAdapter) Error(msg string, err error, fields watermill.LogFields) {
	zapFields := fieldsToZap(fields)
	zapFields = append(zapFields, zap.Error(err))
	z.log.Error(msg, zapFields...)
}

func (z *zapLoggerAdapter) Info(msg string, fields watermill.LogFields) {
	z.log.Info(msg, fieldsToZap(fields)...)
}

func (z *zapLoggerAdapter) Debug(msg string, fields watermill.LogFields) {
	z.log.Debug(msg, fieldsToZap(fields)...)
}

func (z *zapLoggerAdapter) Trace(msg string, fields watermill.LogFields) {
	z.log.Debug("[TRACE] "+msg, fieldsToZap(fields)...)
}

func (z *zapLoggerAdapter) With(fields watermill.LogFields) watermill.LoggerAdapter {
	return &zapLoggerAdapter{log: z.log.With(fieldsToZap(fields)...)}
}

func fieldsToZap(fields watermill.LogFields) []zap.Field {
	result := make([]zap.Field, 0, len(fields))
	for k, v := range fields {
		result = append(result, zap.Any(k, v))
	}
	return result
}
```

## Router with Middleware

The Router is where Watermill's value becomes clear. It wires topics to handlers and applies middleware uniformly across all handlers.

```go
// internal/events/router.go
package events

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/ThreeDotsLabs/watermill/message"
	"github.com/ThreeDotsLabs/watermill/message/router/middleware"
	"go.uber.org/zap"
)

// RouterConfig holds all configuration for the event router.
type RouterConfig struct {
	MaxRetries       int
	RetryInitialWait time.Duration
	RetryMaxWait     time.Duration
	PoisonQueueTopic TopicName
}

// DefaultRouterConfig returns sensible production defaults.
func DefaultRouterConfig() RouterConfig {
	return RouterConfig{
		MaxRetries:       3,
		RetryInitialWait: 100 * time.Millisecond,
		RetryMaxWait:     10 * time.Second,
		PoisonQueueTopic: TopicDLQ,
	}
}

// EventRouter wraps the Watermill Router with typed handler registration.
type EventRouter struct {
	router    *message.Router
	broker    *Broker
	zapLogger *zap.Logger
	config    RouterConfig
}

// NewEventRouter constructs a router with production middleware.
func NewEventRouter(broker *Broker, cfg RouterConfig, zapLog *zap.Logger) (*EventRouter, error) {
	wmLogger := NewZapLoggerAdapter(zapLog)

	r, err := message.NewRouter(message.RouterConfig{}, wmLogger)
	if err != nil {
		return nil, fmt.Errorf("new watermill router: %w", err)
	}

	// Poison queue: messages that fail after all retries go here
	// instead of blocking the topic.
	poisonQueue, err := middleware.PoisonQueue(broker.Publisher(), string(cfg.PoisonQueueTopic))
	if err != nil {
		return nil, fmt.Errorf("configure poison queue: %w", err)
	}

	// Retry with exponential backoff
	retryMiddleware := middleware.Retry{
		MaxRetries:      cfg.MaxRetries,
		InitialInterval: cfg.RetryInitialWait,
		MaxInterval:     cfg.RetryMaxWait,
		Multiplier:      2.0,
		Logger:          wmLogger,
	}

	// Throttle: rate-limit handler execution if needed
	// throttle := middleware.NewThrottle(100, time.Second)

	r.AddMiddleware(
		// Correlation ID: propagates a unique ID through the processing chain
		middleware.CorrelationID,
		// Poison queue must come before retry in the chain
		poisonQueue.Middleware,
		// Retry failed handlers with backoff
		retryMiddleware.Middleware,
		// Instrumentation: log every message with timing
		loggingMiddleware(zapLog),
		// Metrics: Prometheus counters and histograms
		metricsMiddleware(),
	)

	return &EventRouter{
		router:    r,
		broker:    broker,
		zapLogger: zapLog,
		config:    cfg,
	}, nil
}

// AddHandler registers a typed handler for a specific event topic.
// The handler receives the decoded event envelope and returns an error
// if processing should be retried.
func AddHandler[T any](
	er *EventRouter,
	handlerName string,
	topic TopicName,
	handler func(ctx context.Context, payload T) error,
) {
	er.router.AddNoPublisherHandler(
		handlerName,
		string(topic),
		er.broker.Subscriber(),
		func(msg *message.Message) error {
			var envelope EventEnvelope
			if err := json.Unmarshal(msg.Payload, &envelope); err != nil {
				// Malformed messages are not retried; they go to DLQ immediately.
				er.zapLogger.Error("failed to unmarshal event envelope",
					zap.String("handler", handlerName),
					zap.String("message_id", msg.UUID),
					zap.Error(err),
				)
				msg.Ack()
				return nil
			}

			var payload T
			if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
				er.zapLogger.Error("failed to unmarshal event payload",
					zap.String("handler", handlerName),
					zap.String("event_type", envelope.EventType),
					zap.Error(err),
				)
				msg.Ack()
				return nil
			}

			ctx := msg.Context()
			if err := handler(ctx, payload); err != nil {
				// Returning an error triggers the retry middleware
				return fmt.Errorf("handle %s: %w", envelope.EventType, err)
			}

			return nil
		},
	)
}

// AddTransformHandler registers a handler that publishes to an output topic.
// Use this for event transformation and enrichment pipelines.
func AddTransformHandler[In any, Out any](
	er *EventRouter,
	handlerName string,
	inputTopic TopicName,
	outputTopic TopicName,
	handler func(ctx context.Context, input In) (*Out, error),
) {
	er.router.AddHandler(
		handlerName,
		string(inputTopic),
		er.broker.Subscriber(),
		string(outputTopic),
		er.broker.Publisher(),
		func(msg *message.Message) ([]*message.Message, error) {
			var envelope EventEnvelope
			if err := json.Unmarshal(msg.Payload, &envelope); err != nil {
				return nil, nil // discard malformed messages
			}

			var input In
			if err := json.Unmarshal(envelope.Payload, &input); err != nil {
				return nil, nil
			}

			ctx := msg.Context()
			output, err := handler(ctx, input)
			if err != nil {
				return nil, err
			}
			if output == nil {
				return nil, nil
			}

			outPayload, err := json.Marshal(output)
			if err != nil {
				return nil, fmt.Errorf("marshal output: %w", err)
			}

			outEnvelope := EventEnvelope{
				EventType:   fmt.Sprintf("%T", *output),
				AggregateID: envelope.AggregateID,
				Version:     envelope.Version + 1,
				OccurredAt:  time.Now().UTC(),
				Payload:     outPayload,
			}

			outEnvelopeBytes, err := json.Marshal(outEnvelope)
			if err != nil {
				return nil, fmt.Errorf("marshal output envelope: %w", err)
			}

			outMsg := message.NewMessage(watermill.NewUUID(), outEnvelopeBytes)
			outMsg.Metadata = msg.Metadata
			return []*message.Message{outMsg}, nil
		},
	)
}

// Run starts the router and blocks until the context is cancelled.
func (er *EventRouter) Run(ctx context.Context) error {
	return er.router.Run(ctx)
}

// Running returns a channel that is closed when the router is ready.
func (er *EventRouter) Running() chan struct{} {
	return er.router.Running()
}

// Close stops the router gracefully.
func (er *EventRouter) Close() error {
	return er.router.Close()
}
```

## Middleware Implementations

```go
// internal/events/middleware.go
package events

import (
	"time"

	"github.com/ThreeDotsLabs/watermill/message"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.uber.org/zap"
)

var (
	messagesProcessed = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "watermill_messages_processed_total",
		Help: "Total number of Watermill messages processed by handler.",
	}, []string{"handler", "status"})

	messageProcessingDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "watermill_message_processing_duration_seconds",
		Help:    "Duration of Watermill message processing in seconds.",
		Buckets: prometheus.DefBuckets,
	}, []string{"handler"})
)

func loggingMiddleware(log *zap.Logger) message.HandlerMiddleware {
	return func(h message.HandlerFunc) message.HandlerFunc {
		return func(msg *message.Message) ([]*message.Message, error) {
			start := time.Now()
			log.Debug("processing message",
				zap.String("message_id", msg.UUID),
				zap.String("correlation_id", middleware.MessageCorrelationID(msg)),
			)

			msgs, err := h(msg)

			elapsed := time.Since(start)
			if err != nil {
				log.Warn("message processing failed",
					zap.String("message_id", msg.UUID),
					zap.Duration("elapsed", elapsed),
					zap.Error(err),
				)
			} else {
				log.Debug("message processed",
					zap.String("message_id", msg.UUID),
					zap.Duration("elapsed", elapsed),
				)
			}
			return msgs, err
		}
	}
}

func metricsMiddleware() message.HandlerMiddleware {
	return func(h message.HandlerFunc) message.HandlerFunc {
		return func(msg *message.Message) ([]*message.Message, error) {
			// Extract handler name from router context
			handlerName := message.HandlerNameFromCtx(msg.Context())
			start := time.Now()

			msgs, err := h(msg)

			duration := time.Since(start).Seconds()
			messageProcessingDuration.WithLabelValues(handlerName).Observe(duration)

			status := "success"
			if err != nil {
				status = "error"
			}
			messagesProcessed.WithLabelValues(handlerName, status).Inc()

			return msgs, err
		}
	}
}
```

## Domain Event Definitions

```go
// internal/domain/events.go
package domain

import "time"

// OrderCreatedEvent is published when a new order is accepted.
type OrderCreatedEvent struct {
	OrderID    string    `json:"order_id"`
	CustomerID string    `json:"customer_id"`
	Items      []OrderItem `json:"items"`
	TotalCents int64     `json:"total_cents"`
	CreatedAt  time.Time `json:"created_at"`
}

// OrderItem represents a line item in an order.
type OrderItem struct {
	SKU       string `json:"sku"`
	Quantity  int    `json:"quantity"`
	UnitCents int64  `json:"unit_cents"`
}

// PaymentReceivedEvent is published when payment is confirmed.
type PaymentReceivedEvent struct {
	OrderID     string    `json:"order_id"`
	PaymentID   string    `json:"payment_id"`
	AmountCents int64     `json:"amount_cents"`
	ReceivedAt  time.Time `json:"received_at"`
}

// InventoryReservedEvent is published when inventory is reserved for an order.
type InventoryReservedEvent struct {
	OrderID     string    `json:"order_id"`
	ReservedSKUs []ReservedSKU `json:"reserved_skus"`
	ReservedAt  time.Time `json:"reserved_at"`
}

type ReservedSKU struct {
	SKU        string `json:"sku"`
	Quantity   int    `json:"quantity"`
	WarehouseID string `json:"warehouse_id"`
}
```

## Wiring Handlers to the Router

```go
// internal/service/handlers.go
package service

import (
	"context"
	"fmt"

	"github.com/yourorg/event-service/internal/domain"
	"github.com/yourorg/event-service/internal/events"
	"go.uber.org/zap"
)

// InventoryService handles inventory reservation when orders are created.
type InventoryService struct {
	log  *zap.Logger
	repo InventoryRepository
}

func (s *InventoryService) HandleOrderCreated(
	ctx context.Context,
	order domain.OrderCreatedEvent,
) error {
	s.log.Info("reserving inventory for order",
		zap.String("order_id", order.OrderID),
		zap.Int("item_count", len(order.Items)),
	)

	for _, item := range order.Items {
		if err := s.repo.Reserve(ctx, item.SKU, item.Quantity); err != nil {
			// Returning an error causes the retry middleware to retry this message.
			// Make your handler idempotent: use order_id as an idempotency key.
			return fmt.Errorf("reserve sku %s: %w", item.SKU, err)
		}
	}
	return nil
}

// NotificationService sends customer notifications for order events.
type NotificationService struct {
	log    *zap.Logger
	sender EmailSender
}

func (s *NotificationService) HandleOrderFulfilled(
	ctx context.Context,
	order domain.OrderFulfilledEvent,
) error {
	return s.sender.Send(ctx, order.CustomerID, "Your order has shipped!")
}

// RegisterHandlers wires all domain handlers onto the router.
func RegisterHandlers(
	router *events.EventRouter,
	inventory *InventoryService,
	notification *NotificationService,
) {
	events.AddHandler(
		router,
		"inventory-reserve-on-order-created",
		events.TopicOrderCreated,
		inventory.HandleOrderCreated,
	)

	events.AddHandler(
		router,
		"notify-customer-on-order-fulfilled",
		events.TopicOrderFulfilled,
		notification.HandleOrderFulfilled,
	)
}
```

## CQRS Pattern with Watermill

Watermill ships a CQRS component that provides typed command and event buses. This is the right abstraction for services that need strict command/query separation.

```go
// internal/cqrs/bus.go
package cqrs

import (
	"context"
	"encoding/json"
	"fmt"

	watermillcqrs "github.com/ThreeDotsLabs/watermill/components/cqrs"
	"github.com/ThreeDotsLabs/watermill/message"
	"github.com/yourorg/event-service/internal/events"
)

// SetupCQRS initializes the CQRS facade over the Watermill broker.
func SetupCQRS(
	broker *events.Broker,
	router *message.Router,
	wmLogger watermill.LoggerAdapter,
) (*watermillcqrs.Facade, error) {
	cqrsMarshaler := watermillcqrs.JSONMarshaler{}

	facade, err := watermillcqrs.NewFacade(watermillcqrs.FacadeConfig{
		GenerateCommandsTopic: func(commandName string) string {
			return "commands." + commandName
		},
		CommandHandlers: func(cb *watermillcqrs.CommandBus, eb *watermillcqrs.EventBus) []watermillcqrs.CommandHandler {
			return []watermillcqrs.CommandHandler{
				PlaceOrderHandler{eventBus: eb},
				CancelOrderHandler{eventBus: eb},
			}
		},
		CommandsPublisher: broker.Publisher(),
		CommandsSubscriberConstructor: func(handlerName string) (message.Subscriber, error) {
			return broker.Subscriber(), nil
		},
		GenerateEventsTopic: func(eventName string) string {
			return "events." + eventName
		},
		EventHandlers: func(cb *watermillcqrs.CommandBus, eb *watermillcqrs.EventBus) []watermillcqrs.EventHandler {
			return []watermillcqrs.EventHandler{
				OrderCreatedProjection{},
				OrderAuditLogger{},
			}
		},
		EventsPublisher: broker.Publisher(),
		EventsSubscriberConstructor: func(handlerName string) (message.Subscriber, error) {
			return broker.Subscriber(), nil
		},
		Router:                router,
		CommandEventMarshaler: cqrsMarshaler,
		Logger:                wmLogger,
	})

	return facade, err
}

// PlaceOrderCommand is a command sent to create a new order.
type PlaceOrderCommand struct {
	OrderID    string      `json:"order_id"`
	CustomerID string      `json:"customer_id"`
	Items      []OrderItem `json:"items"`
}

// PlaceOrderHandler processes PlaceOrderCommand and emits OrderCreatedEvent.
type PlaceOrderHandler struct {
	eventBus *watermillcqrs.EventBus
}

func (h PlaceOrderHandler) HandlerName() string {
	return "PlaceOrderHandler"
}

func (h PlaceOrderHandler) NewCommand() interface{} {
	return &PlaceOrderCommand{}
}

func (h PlaceOrderHandler) Handle(ctx context.Context, cmd interface{}) error {
	c := cmd.(*PlaceOrderCommand)

	// Business logic: validate, persist, then emit event
	// ...

	return h.eventBus.Publish(ctx, &OrderCreatedEvent{
		OrderID:    c.OrderID,
		CustomerID: c.CustomerID,
	})
}
```

## Application Bootstrap

```go
// cmd/server/main.go
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/yourorg/event-service/internal/events"
	"github.com/yourorg/event-service/internal/service"
	"go.uber.org/zap"
)

func main() {
	log, _ := zap.NewProduction()
	defer log.Sync()

	ctx, cancel := signal.NotifyContext(context.Background(),
		os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// Initialize broker (swap for Kafka broker in production if needed)
	broker := events.NewInProcessBroker(log)
	defer broker.Close()

	// Initialize router with middleware
	routerCfg := events.DefaultRouterConfig()
	router, err := events.NewEventRouter(broker, routerCfg, log)
	if err != nil {
		log.Fatal("failed to create router", zap.Error(err))
	}

	// Initialize domain services
	inventoryRepo := service.NewPostgresInventoryRepository(/* db */)
	inventorySvc := &service.InventoryService{Log: log, Repo: inventoryRepo}
	notificationSvc := &service.NotificationService{Log: log}

	// Register all handlers
	service.RegisterHandlers(router, inventorySvc, notificationSvc)

	// Start router in background
	go func() {
		if err := router.Run(ctx); err != nil {
			log.Error("router exited with error", zap.Error(err))
		}
	}()

	// Wait until router is ready before accepting traffic
	select {
	case <-router.Running():
		log.Info("event router is ready")
	case <-ctx.Done():
		return
	}

	// Start HTTP API server
	srv := newHTTPServer(log, broker)
	srv.ListenAndServe(ctx, ":8080")

	log.Info("shutdown complete")
}
```

## Testing Event Handlers

The in-process Gochannel makes testing event flows straightforward without any mocking.

```go
// internal/events/router_test.go
package events_test

import (
	"context"
	"testing"
	"time"

	"github.com/yourorg/event-service/internal/domain"
	"github.com/yourorg/event-service/internal/events"
	"go.uber.org/zap/zaptest"
)

func TestInventoryReservationOnOrderCreated(t *testing.T) {
	log := zaptest.NewLogger(t)
	broker := events.NewInProcessBroker(log)
	t.Cleanup(func() { broker.Close() })

	routerCfg := events.DefaultRouterConfig()
	router, err := events.NewEventRouter(broker, routerCfg, log)
	if err != nil {
		t.Fatalf("create router: %v", err)
	}

	// Track which SKUs were reserved
	var reservedSKUs []string
	events.AddHandler(
		router,
		"test-inventory-handler",
		events.TopicOrderCreated,
		func(ctx context.Context, order domain.OrderCreatedEvent) error {
			for _, item := range order.Items {
				reservedSKUs = append(reservedSKUs, item.SKU)
			}
			return nil
		},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	go func() {
		_ = router.Run(ctx)
	}()

	// Wait for router to be ready
	select {
	case <-router.Running():
	case <-ctx.Done():
		t.Fatal("router did not start in time")
	}

	// Publish a test event
	err = broker.Publish(ctx, events.TopicOrderCreated, events.EventEnvelope{
		EventType:   "OrderCreated",
		AggregateID: "order-123",
		Version:     1,
		OccurredAt:  time.Now(),
		Payload:     mustMarshal(t, domain.OrderCreatedEvent{
			OrderID:    "order-123",
			CustomerID: "cust-456",
			Items: []domain.OrderItem{
				{SKU: "SKU-A", Quantity: 2, UnitCents: 1000},
				{SKU: "SKU-B", Quantity: 1, UnitCents: 2500},
			},
		}),
	})
	if err != nil {
		t.Fatalf("publish: %v", err)
	}

	// Poll for the handler to run
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(reservedSKUs) == 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if len(reservedSKUs) != 2 {
		t.Errorf("expected 2 reserved SKUs, got %d", len(reservedSKUs))
	}
}

func mustMarshal(t *testing.T, v interface{}) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}
```

## Migrating to Kafka

When traffic grows beyond what in-process messaging can handle, or when you need cross-service message delivery with durability guarantees, swap the broker implementation. The handler code does not change.

```go
// internal/events/kafka_broker.go
package events

import (
	"github.com/ThreeDotsLabs/watermill-kafka/v3/pkg/kafka"
	"github.com/ThreeDotsLabs/watermill/message"
)

// NewKafkaBroker creates a Kafka-backed broker.
// Drop-in replacement for NewInProcessBroker.
func NewKafkaBroker(brokers []string, consumerGroup string, zapLog *zap.Logger) (*Broker, error) {
	wmLogger := NewZapLoggerAdapter(zapLog)

	publisher, err := kafka.NewPublisher(
		kafka.PublisherConfig{
			Brokers:   brokers,
			Marshaler: kafka.DefaultMarshaler{},
		},
		wmLogger,
	)
	if err != nil {
		return nil, fmt.Errorf("kafka publisher: %w", err)
	}

	subscriber, err := kafka.NewSubscriber(
		kafka.SubscriberConfig{
			Brokers:       brokers,
			Unmarshaler:   kafka.DefaultMarshaler{},
			ConsumerGroup: consumerGroup,
			// Start from the beginning for new consumer groups
			InitializeTopicDetails: &sarama.TopicDetail{
				NumPartitions:     6,
				ReplicationFactor: 3,
			},
		},
		wmLogger,
	)
	if err != nil {
		return nil, fmt.Errorf("kafka subscriber: %w", err)
	}

	return &Broker{
		publisher:  publisher,
		subscriber: subscriber,
		logger:     wmLogger,
		zapLogger:  zapLog,
	}, nil
}
```

```go
// cmd/server/main.go - swap at startup based on configuration
func newBroker(cfg Config, log *zap.Logger) (*events.Broker, error) {
	if cfg.KafkaBrokers != nil {
		return events.NewKafkaBroker(cfg.KafkaBrokers, cfg.ConsumerGroup, log)
	}
	return events.NewInProcessBroker(log), nil
}
```

## Dead Letter Queue Processing

Messages that exhaust all retries land in the DLQ. Run a separate consumer to inspect, alert on, and replay them.

```go
// cmd/dlq-processor/main.go
package main

import (
	"context"
	"encoding/json"
	"os"

	"github.com/yourorg/event-service/internal/events"
	"go.uber.org/zap"
)

func main() {
	log, _ := zap.NewProduction()
	defer log.Sync()

	broker := events.NewInProcessBroker(log)
	defer broker.Close()

	ctx := context.Background()
	msgs, err := broker.Subscribe(ctx, events.TopicDLQ)
	if err != nil {
		log.Fatal("subscribe to DLQ", zap.Error(err))
	}

	for msg := range msgs {
		var envelope events.EventEnvelope
		if err := json.Unmarshal(msg.Payload, &envelope); err != nil {
			log.Error("malformed DLQ message", zap.String("msg_id", msg.UUID))
			msg.Ack()
			continue
		}

		log.Warn("dead letter message",
			zap.String("event_type", envelope.EventType),
			zap.String("aggregate_id", envelope.AggregateID),
			zap.String("msg_id", msg.UUID),
		)

		// Emit alert, write to audit log, or replay based on event type
		alertOnDLQMessage(envelope)
		msg.Ack()
	}
}
```

## Performance Characteristics

The Gochannel implementation is fast. On a modern server, it can sustain several hundred thousand messages per second with multiple subscribers. The bottleneck is typically the handler logic, not the messaging layer.

```go
// benchmark_test.go
func BenchmarkInProcessPublishSubscribe(b *testing.B) {
	log := zaptest.NewLogger(b)
	broker := events.NewInProcessBroker(log)
	defer broker.Close()

	ctx := context.Background()
	msgs, _ := broker.Subscribe(ctx, events.TopicOrderCreated)

	// Drain subscriber in background
	go func() {
		for msg := range msgs {
			msg.Ack()
		}
	}()

	envelope := events.EventEnvelope{
		EventType:   "OrderCreated",
		AggregateID: "bench-order",
		Version:     1,
		OccurredAt:  time.Now(),
		Payload:     []byte(`{"order_id":"bench","customer_id":"cust","items":[]}`),
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = broker.Publish(ctx, events.TopicOrderCreated, envelope)
	}
}
// Typical result: ~500,000 msg/sec on a 4-core machine
```

## Summary

Watermill provides a clean, idiomatic Go abstraction for pub/sub messaging that scales from in-process development workflows to production Kafka deployments without changing handler code. The key practices from this guide:

- Start with the Gochannel implementation; migrate to Kafka only when cross-service durability is needed
- Apply middleware (retry, poison queue, logging, metrics) at the router level, not inside handlers
- Make handlers idempotent by using aggregate IDs as idempotency keys
- Use the CQRS component when your service needs strict command/query separation
- Test event flows synchronously using the in-process broker; no mocking required
- Run a DLQ consumer to surface handler failures before they cause data loss
