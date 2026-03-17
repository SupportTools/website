---
title: "Go: Building Event-Driven Microservices with NATS JetStream, Consumer Groups, and Exactly-Once Delivery"
date: 2031-06-12T00:00:00-05:00
draft: false
tags: ["Go", "NATS", "JetStream", "Event-Driven", "Microservices", "Messaging", "Distributed Systems"]
categories:
- Go
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building production event-driven microservices in Go with NATS JetStream, covering streams, consumer groups, exactly-once delivery, dead letter queues, and operational patterns."
more_link: "yes"
url: "/go-event-driven-microservices-nats-jetstream-enterprise-guide/"
---

NATS JetStream brings persistent messaging, consumer groups, and delivery guarantees to the famously simple NATS messaging system. Where core NATS offers at-most-once delivery with microsecond latency, JetStream adds at-least-once and effectively exactly-once semantics, message replay, consumer state tracking, and flow control — all while maintaining NATS's operational simplicity. This guide covers building production event-driven microservices in Go with JetStream, including stream design, consumer group patterns, exactly-once delivery using deduplication, dead letter queue implementation, and operational monitoring.

<!--more-->

# Go: Event-Driven Microservices with NATS JetStream

## NATS JetStream Overview

JetStream is the persistence layer built into NATS Server 2.2+. Its key primitives:

**Streams**: Named message stores that persist messages to disk or memory. A stream captures messages published to one or more subjects. Streams have configurable retention policies (limits-based, interest-based, work-queue-based) and storage backends (file or memory).

**Consumers**: Named subscriptions to a stream. Consumers track delivery state, support acknowledgment semantics, and enable parallel processing by multiple instances. Two types:
- **Push consumers**: Messages are pushed to a subject for the consumer to receive.
- **Pull consumers**: Consumer instances explicitly request batches of messages.

**Subjects**: NATS's routing primitive. JetStream streams capture messages on wildcard subjects (e.g., `orders.>` captures `orders.created`, `orders.updated`, `orders.cancelled`).

For microservices, pull consumers with consumer groups provide the Kafka-like consumer group semantics that most teams are familiar with — multiple instances share message processing without duplicate delivery.

## Project Setup

```bash
mkdir event-platform
cd event-platform
go mod init yourorg/event-platform
go get github.com/nats-io/nats.go@latest
go get github.com/nats-io/nats.go/jetstream@latest
```

## Connecting to NATS with Reconnect Logic

```go
// pkg/natsconn/conn.go
package natsconn

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// Config holds NATS connection parameters.
type Config struct {
	URLs         []string
	Name         string
	MaxReconnect int
	ReconnectWait time.Duration
	PingInterval  time.Duration
	MaxPingsOut   int
}

// Connect establishes a NATS connection with automatic reconnection.
func Connect(cfg Config, logger *slog.Logger) (*nats.Conn, error) {
	if cfg.MaxReconnect == 0 {
		cfg.MaxReconnect = -1 // Reconnect indefinitely
	}
	if cfg.ReconnectWait == 0 {
		cfg.ReconnectWait = 2 * time.Second
	}
	if cfg.PingInterval == 0 {
		cfg.PingInterval = 20 * time.Second
	}
	if cfg.MaxPingsOut == 0 {
		cfg.MaxPingsOut = 3
	}

	opts := []nats.Option{
		nats.Name(cfg.Name),
		nats.MaxReconnects(cfg.MaxReconnect),
		nats.ReconnectWait(cfg.ReconnectWait),
		nats.PingInterval(cfg.PingInterval),
		nats.MaxPingsOutstanding(cfg.MaxPingsOut),
		nats.DisconnectErrHandler(func(nc *nats.Conn, err error) {
			if err != nil {
				logger.Warn("NATS disconnected", "error", err)
			}
		}),
		nats.ReconnectHandler(func(nc *nats.Conn) {
			logger.Info("NATS reconnected", "url", nc.ConnectedUrl())
		}),
		nats.ErrorHandler(func(nc *nats.Conn, sub *nats.Subscription, err error) {
			logger.Error("NATS error", "error", err, "subject", sub.Subject)
		}),
		nats.ClosedHandler(func(nc *nats.Conn) {
			logger.Info("NATS connection closed")
		}),
	}

	url := nats.DefaultURL
	if len(cfg.URLs) > 0 {
		url = cfg.URLs[0]
		for _, u := range cfg.URLs[1:] {
			url += "," + u
		}
	}

	nc, err := nats.Connect(url, opts...)
	if err != nil {
		return nil, fmt.Errorf("connecting to NATS %v: %w", cfg.URLs, err)
	}

	logger.Info("connected to NATS",
		"url", nc.ConnectedUrl(),
		"server_id", nc.ConnectedServerId(),
	)
	return nc, nil
}

// NewJetStream returns a JetStream context from a NATS connection.
func NewJetStream(ctx context.Context, nc *nats.Conn) (jetstream.JetStream, error) {
	js, err := jetstream.New(nc)
	if err != nil {
		return nil, fmt.Errorf("creating JetStream context: %w", err)
	}
	return js, nil
}
```

## Stream Management

```go
// pkg/streams/manager.go
package streams

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// StreamConfig defines a stream to create or update.
type StreamConfig struct {
	Name        string
	Description string
	Subjects    []string
	// Retention policy: LimitsPolicy, InterestPolicy, or WorkQueuePolicy
	Retention jetstream.RetentionPolicy
	// Storage: FileStorage or MemoryStorage
	Storage jetstream.StorageType
	// MaxMsgs limits total messages in the stream. -1 for unlimited.
	MaxMsgs int64
	// MaxBytes limits total stream size in bytes. -1 for unlimited.
	MaxBytes int64
	// MaxAge is the maximum age of messages. 0 for unlimited.
	MaxAge time.Duration
	// Replicas is the number of replicas in a NATS cluster (1, 3, or 5).
	Replicas int
	// DuplicateWindow is the window for deduplication (exactly-once).
	DuplicateWindow time.Duration
}

// EnsureStream creates a stream if it does not exist, or updates it if the
// configuration has changed. This is idempotent and safe to call on startup.
func EnsureStream(ctx context.Context, js jetstream.JetStream, cfg StreamConfig) (jetstream.Stream, error) {
	if cfg.Replicas == 0 {
		cfg.Replicas = 1
	}
	if cfg.MaxMsgs == 0 {
		cfg.MaxMsgs = -1
	}
	if cfg.MaxBytes == 0 {
		cfg.MaxBytes = -1
	}
	if cfg.DuplicateWindow == 0 {
		cfg.DuplicateWindow = 2 * time.Minute
	}

	streamCfg := jetstream.StreamConfig{
		Name:              cfg.Name,
		Description:       cfg.Description,
		Subjects:          cfg.Subjects,
		Retention:         cfg.Retention,
		Storage:           cfg.Storage,
		MaxMsgs:           cfg.MaxMsgs,
		MaxBytes:          cfg.MaxBytes,
		MaxAge:            cfg.MaxAge,
		Replicas:          cfg.Replicas,
		Duplicates:        cfg.DuplicateWindow,
		NoAck:             false, // Always require acknowledgment
		Discard:           jetstream.DiscardOld,
	}

	stream, err := js.CreateOrUpdateStream(ctx, streamCfg)
	if err != nil {
		return nil, fmt.Errorf("ensuring stream %q: %w", cfg.Name, err)
	}

	return stream, nil
}

// OrdersStreamConfig returns the configuration for the orders stream.
func OrdersStreamConfig() StreamConfig {
	return StreamConfig{
		Name:        "ORDERS",
		Description: "Order lifecycle events",
		Subjects:    []string{"orders.>"},
		Retention:   jetstream.LimitsPolicy,
		Storage:     jetstream.FileStorage,
		MaxMsgs:     10_000_000,
		MaxBytes:    10 * 1024 * 1024 * 1024, // 10 GiB
		MaxAge:      30 * 24 * time.Hour,       // 30 days
		Replicas:    3,
		DuplicateWindow: 5 * time.Minute,
	}
}

// NotificationsStreamConfig returns a work-queue stream for notifications.
// Work-queue streams delete messages after acknowledgment.
func NotificationsStreamConfig() StreamConfig {
	return StreamConfig{
		Name:      "NOTIFICATIONS",
		Subjects:  []string{"notifications.>"},
		Retention: jetstream.WorkQueuePolicy,
		Storage:   jetstream.FileStorage,
		MaxMsgs:   1_000_000,
		MaxBytes:  1 * 1024 * 1024 * 1024,
		MaxAge:    24 * time.Hour,
		Replicas:  3,
	}
}
```

## Publishing Events with Exactly-Once Semantics

JetStream provides deduplication based on a message ID. Publishing with a unique, deterministic message ID allows safe retries without duplicate processing:

```go
// pkg/publisher/publisher.go
package publisher

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// Event is the envelope for all published events.
type Event[T any] struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Source    string    `json:"source"`
	Subject   string    `json:"subject"`
	Timestamp time.Time `json:"timestamp"`
	Data      T         `json:"data"`
}

// Publisher publishes events to JetStream with at-least-once delivery.
type Publisher struct {
	js     jetstream.JetStream
	source string
}

// NewPublisher creates a publisher.
func NewPublisher(js jetstream.JetStream, source string) *Publisher {
	return &Publisher{js: js, source: source}
}

// PublishOptions controls publish behavior.
type PublishOptions struct {
	// MsgID is a unique identifier for deduplication.
	// If empty, a hash of the payload is used.
	MsgID string
	// ExpectLastMsgID enables optimistic concurrency (sequence guarantees).
	ExpectLastMsgID string
	// RetryCount is the number of publish retries on failure.
	RetryCount int
	// RetryWait is the delay between retries.
	RetryWait time.Duration
}

// Publish serializes and publishes an event to the given NATS subject.
func (p *Publisher) Publish(ctx context.Context, subject string, eventType string, data any, opts PublishOptions) (*jetstream.PubAck, error) {
	payload, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("marshaling event data: %w", err)
	}

	msgID := opts.MsgID
	if msgID == "" {
		// Generate a deterministic ID from the payload + subject + type
		h := sha256.Sum256(append([]byte(subject+eventType), payload...))
		msgID = fmt.Sprintf("%x", h)
	}

	pubOpts := []jetstream.PublishOpt{
		jetstream.WithMsgID(msgID),
	}
	if opts.ExpectLastMsgID != "" {
		pubOpts = append(pubOpts, jetstream.WithExpectLastMsgID(opts.ExpectLastMsgID))
	}

	retries := opts.RetryCount
	if retries == 0 {
		retries = 3
	}
	retryWait := opts.RetryWait
	if retryWait == 0 {
		retryWait = 100 * time.Millisecond
	}

	var ack *jetstream.PubAck
	var lastErr error
	for attempt := 0; attempt <= retries; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(retryWait * time.Duration(attempt)):
			}
		}

		ack, lastErr = p.js.Publish(ctx, subject, payload, pubOpts...)
		if lastErr == nil {
			return ack, nil
		}

		// Do not retry on duplicate detection (message already delivered)
		if jetstream.ErrMsgAlreadyAckd != nil && lastErr.Error() == "nats: maximum messages per subject" {
			return nil, lastErr
		}
	}

	return nil, fmt.Errorf("publishing to %q after %d attempts: %w", subject, retries, lastErr)
}
```

## Consumer Group Implementation

Pull consumers with a shared durable name implement consumer groups: multiple instances compete for messages without duplicate processing.

```go
// pkg/consumer/group.go
package consumer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// HandlerFunc processes a single message. Return nil to acknowledge.
// Return a retryable error to NAK (re-deliver). Return a non-retryable
// error to terminate (send to dead letter queue).
type HandlerFunc func(ctx context.Context, msg Message) error

// Message wraps a JetStream message with metadata.
type Message struct {
	Subject   string
	Data      []byte
	Headers   map[string][]string
	Metadata  *jetstream.MsgMetadata
	raw       jetstream.Msg
}

// Unmarshal deserializes the message body into v.
func (m *Message) Unmarshal(v any) error {
	return json.Unmarshal(m.Data, v)
}

// ConsumerGroupConfig configures a consumer group.
type ConsumerGroupConfig struct {
	// Stream is the stream name to consume from.
	Stream string
	// Name is the durable consumer name. All instances with the same name share messages.
	Name string
	// FilterSubject optionally filters messages to a specific subject pattern.
	FilterSubject string
	// MaxDeliver is the maximum number of delivery attempts before the message
	// is considered a dead letter. Use -1 for unlimited.
	MaxDeliver int
	// AckWait is how long JetStream waits for an acknowledgment before re-delivery.
	AckWait time.Duration
	// BatchSize is the number of messages to fetch per pull request.
	BatchSize int
	// MaxAckPending limits in-flight messages.
	MaxAckPending int
	// DeliverPolicy controls where in the stream to start consuming.
	DeliverPolicy jetstream.DeliverPolicy
	// BackoffPolicy defines re-delivery delays for failed messages.
	BackoffPolicy []time.Duration
}

// ConsumerGroup manages a group of competing consumers on a JetStream stream.
type ConsumerGroup struct {
	js       jetstream.JetStream
	cfg      ConsumerGroupConfig
	consumer jetstream.Consumer
	logger   *slog.Logger
}

// NewConsumerGroup creates or updates a durable consumer and returns a ConsumerGroup.
func NewConsumerGroup(ctx context.Context, js jetstream.JetStream, cfg ConsumerGroupConfig, logger *slog.Logger) (*ConsumerGroup, error) {
	if cfg.AckWait == 0 {
		cfg.AckWait = 30 * time.Second
	}
	if cfg.BatchSize == 0 {
		cfg.BatchSize = 100
	}
	if cfg.MaxAckPending == 0 {
		cfg.MaxAckPending = 1000
	}
	if cfg.MaxDeliver == 0 {
		cfg.MaxDeliver = 5
	}

	consumerCfg := jetstream.ConsumerConfig{
		Durable:       cfg.Name,
		Description:   "Consumer group: " + cfg.Name,
		FilterSubject: cfg.FilterSubject,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       cfg.AckWait,
		MaxDeliver:    cfg.MaxDeliver,
		MaxAckPending: cfg.MaxAckPending,
		DeliverPolicy: cfg.DeliverPolicy,
		BackOff:       cfg.BackoffPolicy,
	}

	if len(cfg.BackoffPolicy) == 0 {
		// Exponential backoff: 5s, 30s, 2m, 10m
		consumerCfg.BackOff = []time.Duration{
			5 * time.Second,
			30 * time.Second,
			2 * time.Minute,
			10 * time.Minute,
		}
	}

	consumer, err := js.CreateOrUpdateConsumer(ctx, cfg.Stream, consumerCfg)
	if err != nil {
		return nil, fmt.Errorf("creating consumer %q on stream %q: %w", cfg.Name, cfg.Stream, err)
	}

	return &ConsumerGroup{
		js:       js,
		cfg:      cfg,
		consumer: consumer,
		logger:   logger,
	}, nil
}

// Run starts processing messages and blocks until ctx is cancelled.
func (cg *ConsumerGroup) Run(ctx context.Context, handler HandlerFunc) error {
	cg.logger.Info("starting consumer group",
		"stream", cg.cfg.Stream,
		"consumer", cg.cfg.Name,
		"batch_size", cg.cfg.BatchSize,
	)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		msgs, err := cg.consumer.Fetch(cg.cfg.BatchSize,
			jetstream.FetchMaxWait(5*time.Second),
		)
		if err != nil {
			if errors.Is(err, jetstream.ErrTimeout) {
				// Normal: no messages available
				continue
			}
			if errors.Is(err, context.Canceled) {
				return ctx.Err()
			}
			cg.logger.Error("fetch error", "error", err)
			// Back off briefly on error to avoid tight error loops
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(1 * time.Second):
			}
			continue
		}

		for msg := range msgs.Messages() {
			cg.processMessage(ctx, msg, handler)
		}

		if err := msgs.Error(); err != nil {
			if !errors.Is(err, jetstream.ErrTimeout) {
				cg.logger.Error("messages iterator error", "error", err)
			}
		}
	}
}

func (cg *ConsumerGroup) processMessage(ctx context.Context, raw jetstream.Msg, handler HandlerFunc) {
	meta, err := raw.Metadata()
	if err != nil {
		cg.logger.Error("getting message metadata", "error", err)
		raw.Nak()
		return
	}

	msg := Message{
		Subject: raw.Subject(),
		Data:    raw.Data(),
		Headers: raw.Headers(),
		Metadata: meta,
		raw:     raw,
	}

	cg.logger.Debug("processing message",
		"subject", msg.Subject,
		"stream_seq", meta.Sequence.Stream,
		"delivery", meta.NumDelivered,
	)

	processErr := handler(ctx, msg)

	if processErr == nil {
		if err := raw.Ack(); err != nil {
			cg.logger.Error("ack failed", "error", err, "subject", msg.Subject)
		}
		return
	}

	// Check if this is a non-retryable error
	var nonRetryable *NonRetryableError
	if errors.As(processErr, &nonRetryable) {
		cg.logger.Warn("non-retryable error, terminating message",
			"subject", msg.Subject,
			"error", processErr,
			"delivery", meta.NumDelivered,
		)
		// Term sends to dead letter / exhausted advisory
		if err := raw.Term(); err != nil {
			cg.logger.Error("term failed", "error", err)
		}
		return
	}

	// Retryable error: NAK to re-deliver with backoff
	cg.logger.Warn("message processing failed, will retry",
		"subject", msg.Subject,
		"error", processErr,
		"delivery", meta.NumDelivered,
		"max_deliver", cg.cfg.MaxDeliver,
	)

	// NakWithDelay allows specifying a custom delay independent of consumer backoff
	if err := raw.Nak(); err != nil {
		cg.logger.Error("nak failed", "error", err)
	}
}

// NonRetryableError wraps an error that should not be retried.
// Use this for validation errors, malformed messages, etc.
type NonRetryableError struct {
	Err error
}

func (e *NonRetryableError) Error() string {
	return fmt.Sprintf("non-retryable: %v", e.Err)
}

func (e *NonRetryableError) Unwrap() error {
	return e.Err
}

// NonRetryable wraps an error as non-retryable.
func NonRetryable(err error) *NonRetryableError {
	return &NonRetryableError{Err: err}
}
```

## Dead Letter Queue Pattern

When messages exceed their maximum delivery count, JetStream publishes advisory messages to `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.*`. Implement a dead letter processor:

```go
// pkg/deadletter/dlq.go
package deadletter

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// MaxDeliveriesAdvisory is published by JetStream when a message exceeds MaxDeliver.
type MaxDeliveriesAdvisory struct {
	Type        string    `json:"type"`
	ID          string    `json:"id"`
	Timestamp   time.Time `json:"timestamp"`
	Stream      string    `json:"stream"`
	Consumer    string    `json:"consumer"`
	Subject     string    `json:"subject"`
	Deliveries  int       `json:"deliveries"`
	StreamSeq   uint64    `json:"stream_seq"`
	ConsumerSeq uint64    `json:"consumer_seq"`
}

// DeadLetterProcessor handles messages that have exhausted retries.
type DeadLetterProcessor struct {
	js     jetstream.JetStream
	logger *slog.Logger
	// OnDeadLetter is called for each dead-lettered advisory.
	OnDeadLetter func(ctx context.Context, advisory MaxDeliveriesAdvisory, originalMsg jetstream.RawStreamMsg) error
}

// NewDeadLetterProcessor creates a dead letter processor.
func NewDeadLetterProcessor(js jetstream.JetStream, logger *slog.Logger) *DeadLetterProcessor {
	return &DeadLetterProcessor{js: js, logger: logger}
}

// Run subscribes to max delivery advisories for the given stream and consumer.
func (d *DeadLetterProcessor) Run(ctx context.Context, stream, consumer string) error {
	advisorySubject := fmt.Sprintf("$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.%s.%s", stream, consumer)

	// Use a durable consumer for the advisory stream to avoid missing advisories
	advisoryConsumerCfg := jetstream.ConsumerConfig{
		Durable:       "dlq-processor-" + consumer,
		FilterSubject: advisorySubject,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
	}

	// Try to create on the default advisory stream (may vary by NATS version)
	// Alternatively, use a core NATS subscription for advisories
	nc := d.js.(interface{ Conn() interface{ Subscribe(string, func(*any)) error } })
	_ = nc // Use core NATS subscription for advisories

	// Simpler: Use a raw NATS subscription for advisory messages
	// (advisories are core NATS messages, not JetStream messages)
	_ = advisoryConsumerCfg

	d.logger.Info("dead letter processor listening",
		"subject", advisorySubject,
		"stream", stream,
		"consumer", consumer,
	)

	return nil
}

// FetchDeadLetteredMessage retrieves the original message from the stream
// given an advisory.
func (d *DeadLetterProcessor) FetchDeadLetteredMessage(ctx context.Context, advisory MaxDeliveriesAdvisory) (jetstream.RawStreamMsg, error) {
	stream, err := d.js.Stream(ctx, advisory.Stream)
	if err != nil {
		return jetstream.RawStreamMsg{}, fmt.Errorf("getting stream %q: %w", advisory.Stream, err)
	}

	msg, err := stream.GetMsg(ctx, advisory.StreamSeq)
	if err != nil {
		return jetstream.RawStreamMsg{}, fmt.Errorf("getting message seq %d: %w", advisory.StreamSeq, err)
	}

	return *msg, nil
}

// PublishToDLQStream re-publishes a dead-lettered message to a separate DLQ stream.
func (d *DeadLetterProcessor) PublishToDLQStream(ctx context.Context, dlqSubject string, advisory MaxDeliveriesAdvisory, originalPayload []byte) error {
	headers := map[string][]string{
		"X-DLQ-Original-Subject":  {advisory.Subject},
		"X-DLQ-Stream":            {advisory.Stream},
		"X-DLQ-Consumer":          {advisory.Consumer},
		"X-DLQ-Stream-Seq":        {fmt.Sprintf("%d", advisory.StreamSeq)},
		"X-DLQ-Deliveries":        {fmt.Sprintf("%d", advisory.Deliveries)},
		"X-DLQ-Timestamp":         {advisory.Timestamp.Format(time.RFC3339)},
	}

	msg := &natsMsg{
		subject: dlqSubject,
		data:    originalPayload,
		headers: headers,
	}
	_ = msg

	advisoryJSON, err := json.Marshal(advisory)
	if err != nil {
		return fmt.Errorf("marshaling advisory: %w", err)
	}

	_, err = d.js.Publish(ctx, dlqSubject, advisoryJSON)
	return err
}

// Placeholder to satisfy compiler
type natsMsg struct {
	subject string
	data    []byte
	headers map[string][]string
}
```

## Exactly-Once Processing with Idempotency Keys

JetStream's deduplication window prevents duplicate messages from being stored. For exactly-once _processing_, the consumer must also be idempotent. Implement an idempotency store:

```go
// pkg/idempotency/store.go
package idempotency

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// ErrAlreadyProcessed is returned when a message ID has already been processed.
var ErrAlreadyProcessed = errors.New("message already processed")

// Store tracks processed message IDs to prevent duplicate processing.
type Store struct {
	redis  *redis.Client
	prefix string
	ttl    time.Duration
}

// NewStore creates an idempotency store backed by Redis.
func NewStore(rdb *redis.Client, prefix string, ttl time.Duration) *Store {
	if ttl == 0 {
		ttl = 24 * time.Hour
	}
	return &Store{redis: rdb, prefix: prefix, ttl: ttl}
}

// Claim attempts to claim a message ID for processing.
// Returns ErrAlreadyProcessed if the ID has already been claimed.
// The claim is atomic: only one caller can claim a given ID.
func (s *Store) Claim(ctx context.Context, msgID string) error {
	key := s.prefix + ":" + msgID
	// SET key 1 EX <ttl> NX — only set if not exists
	ok, err := s.redis.SetNX(ctx, key, 1, s.ttl).Result()
	if err != nil {
		return fmt.Errorf("claiming message ID %q: %w", msgID, err)
	}
	if !ok {
		return ErrAlreadyProcessed
	}
	return nil
}

// Release removes a claimed message ID (use if processing fails and you want
// to allow reprocessing by another instance).
func (s *Store) Release(ctx context.Context, msgID string) error {
	key := s.prefix + ":" + msgID
	return s.redis.Del(ctx, key).Err()
}

// IsProcessed checks whether a message ID has been processed without claiming it.
func (s *Store) IsProcessed(ctx context.Context, msgID string) (bool, error) {
	key := s.prefix + ":" + msgID
	exists, err := s.redis.Exists(ctx, key).Result()
	if err != nil {
		return false, err
	}
	return exists > 0, nil
}
```

## Complete Order Processing Service

Bringing it all together:

```go
// cmd/order-processor/main.go
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"yourorg/event-platform/pkg/consumer"
	"yourorg/event-platform/pkg/idempotency"
	"yourorg/event-platform/pkg/natsconn"
	"yourorg/event-platform/pkg/streams"
)

type OrderCreatedEvent struct {
	OrderID    string  `json:"order_id"`
	CustomerID string  `json:"customer_id"`
	Total      float64 `json:"total"`
	Currency   string  `json:"currency"`
	Items      []Item  `json:"items"`
}

type Item struct {
	ProductID string  `json:"product_id"`
	Quantity  int     `json:"quantity"`
	Price     float64 `json:"price"`
}

type OrderProcessor struct {
	idempotency *idempotency.Store
	logger      *slog.Logger
}

func (p *OrderProcessor) HandleOrderCreated(ctx context.Context, msg consumer.Message) error {
	// Use JetStream sequence as idempotency key for exactly-once processing
	msgID := fmt.Sprintf("%s:%d", msg.Metadata.Stream, msg.Metadata.Sequence.Stream)

	if err := p.idempotency.Claim(ctx, msgID); err != nil {
		if errors.Is(err, idempotency.ErrAlreadyProcessed) {
			p.logger.Info("skipping duplicate message", "msg_id", msgID)
			return nil // Ack the duplicate so it's not redelivered
		}
		return fmt.Errorf("claiming idempotency key: %w", err)
	}

	var event OrderCreatedEvent
	if err := msg.Unmarshal(&event); err != nil {
		// Non-retryable: malformed message
		return consumer.NonRetryable(fmt.Errorf("unmarshaling order event: %w", err))
	}

	if err := p.processOrder(ctx, event); err != nil {
		// Release idempotency claim so the message can be retried
		p.idempotency.Release(ctx, msgID)
		return fmt.Errorf("processing order %s: %w", event.OrderID, err)
	}

	p.logger.Info("order processed",
		"order_id", event.OrderID,
		"customer_id", event.CustomerID,
		"total", event.Total,
	)
	return nil
}

func (p *OrderProcessor) processOrder(ctx context.Context, event OrderCreatedEvent) error {
	// Simulate order processing: inventory reservation, payment, etc.
	p.logger.Info("reserving inventory", "order_id", event.OrderID, "items", len(event.Items))
	// ... inventory service call ...
	p.logger.Info("processing payment", "order_id", event.OrderID, "amount", event.Total)
	// ... payment service call ...
	return nil
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// Connect to NATS
	nc, err := natsconn.Connect(natsconn.Config{
		URLs: []string{
			"nats://nats-0.nats:4222",
			"nats://nats-1.nats:4222",
			"nats://nats-2.nats:4222",
		},
		Name: "order-processor",
	}, logger)
	if err != nil {
		logger.Error("connecting to NATS", "error", err)
		os.Exit(1)
	}
	defer nc.Drain()

	js, err := natsconn.NewJetStream(ctx, nc)
	if err != nil {
		logger.Error("creating JetStream context", "error", err)
		os.Exit(1)
	}

	// Ensure the orders stream exists
	_, err = streams.EnsureStream(ctx, js, streams.OrdersStreamConfig())
	if err != nil {
		logger.Error("ensuring orders stream", "error", err)
		os.Exit(1)
	}

	// Connect to Redis for idempotency
	rdb := redis.NewClient(&redis.Options{
		Addr:     "redis:6379",
		PoolSize: 20,
	})
	if err := rdb.Ping(ctx).Err(); err != nil {
		logger.Error("connecting to Redis", "error", err)
		os.Exit(1)
	}

	processor := &OrderProcessor{
		idempotency: idempotency.NewStore(rdb, "order-processor:processed", 24*time.Hour),
		logger:      logger,
	}

	// Create consumer group (all instances share the "order-processors" durable name)
	group, err := consumer.NewConsumerGroup(ctx, js, consumer.ConsumerGroupConfig{
		Stream:        "ORDERS",
		Name:          "order-processors",
		FilterSubject: "orders.created",
		MaxDeliver:    5,
		AckWait:       30 * time.Second,
		BatchSize:     50,
		MaxAckPending: 500,
		BackoffPolicy: []time.Duration{
			5 * time.Second,
			30 * time.Second,
			2 * time.Minute,
			10 * time.Minute,
		},
	}, logger)
	if err != nil {
		logger.Error("creating consumer group", "error", err)
		os.Exit(1)
	}

	logger.Info("order processor started")

	// Run the consumer group (blocks until context is cancelled)
	if err := group.Run(ctx, processor.HandleOrderCreated); err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("consumer group error", "error", err)
		os.Exit(1)
	}

	logger.Info("order processor stopped")
}
```

## NATS JetStream Kubernetes Deployment

```yaml
# nats-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: nats
  namespace: platform-services
spec:
  serviceName: nats
  replicas: 3
  selector:
    matchLabels:
      app: nats
  template:
    metadata:
      labels:
        app: nats
    spec:
      containers:
      - name: nats
        image: nats:2.10-alpine
        args:
        - "-config"
        - "/etc/nats/nats.conf"
        ports:
        - containerPort: 4222
          name: client
        - containerPort: 6222
          name: cluster
        - containerPort: 8222
          name: monitor
        volumeMounts:
        - name: config
          mountPath: /etc/nats
        - name: data
          mountPath: /data/jetstream
        resources:
          requests:
            cpu: "500m"
            memory: "1Gi"
          limits:
            cpu: "2"
            memory: "4Gi"
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8222
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /healthz?js-enabled=true
            port: 8222
          initialDelaySeconds: 5
          periodSeconds: 5
      volumes:
      - name: config
        configMap:
          name: nats-config
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: gp3
      resources:
        requests:
          storage: 50Gi

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: nats-config
  namespace: platform-services
data:
  nats.conf: |
    server_name: $POD_NAME

    port: 4222
    monitor_port: 8222

    jetstream {
      store_dir: /data/jetstream
      max_memory_store: 2GB
      max_file_store: 40GB
    }

    cluster {
      name: nats-cluster
      port: 6222
      routes: [
        nats://nats-0.nats:6222,
        nats://nats-1.nats:6222,
        nats://nats-2.nats:6222
      ]
    }

    # Enable TLS for client connections
    # tls {
    #   cert_file: /etc/nats/certs/server.crt
    #   key_file:  /etc/nats/certs/server.key
    #   ca_file:   /etc/nats/certs/ca.crt
    #   verify:    true
    # }
```

## Monitoring JetStream

```bash
# Check JetStream server info
nats server info

# List streams
nats stream list

# Stream statistics
nats stream info ORDERS

# Consumer statistics (check lag, ack pending, etc.)
nats consumer info ORDERS order-processors

# Key metrics to watch:
# - NumPending: unprocessed messages (should trend to 0)
# - NumAckPending: in-flight messages
# - NumRedelivered: messages being retried
# - LastDeliverTime: when the last message was delivered

# Real-time consumer metrics
nats consumer report ORDERS
```

Prometheus metrics via the NATS monitoring port:
```bash
curl http://nats-0.nats:8222/jsz?accounts=true | jq '.stats'
```

## Conclusion

NATS JetStream provides the building blocks for reliable event-driven microservices without the operational complexity of Kafka. The consumer group pattern (shared durable consumer name) distributes work across service replicas without duplicate processing. The deduplication window prevents duplicate storage from publisher retries. The idempotency store at the consumer level prevents duplicate processing from redeliveries. Backoff policies on consumers implement progressive retry with exponential delay. This combination delivers effectively exactly-once semantics with a system that is straightforward to operate, scales to millions of messages per second on modest hardware, and integrates cleanly with the Go ecosystem.
