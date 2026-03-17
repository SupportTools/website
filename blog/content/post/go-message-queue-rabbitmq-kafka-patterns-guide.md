---
title: "Go Messaging Patterns: RabbitMQ and Kafka for Reliable Event Processing"
date: 2028-10-04T00:00:00-05:00
draft: false
tags: ["Go", "RabbitMQ", "Kafka", "Messaging", "Event-Driven"]
categories:
- Go
- Messaging
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Go patterns for RabbitMQ with dead letter queues and publisher confirms, Kafka with idempotent producers and consumer groups, outbox pattern implementation, and guidance on choosing between the two."
more_link: "yes"
url: "/go-message-queue-rabbitmq-kafka-patterns-guide/"
---

Reliable event-driven architectures require more than just connecting to a message broker. You need publisher confirms, dead letter queues for poison messages, consumer prefetch control to prevent overwhelming slow workers, idempotent delivery for exactly-once semantics, and the outbox pattern to avoid dual-write problems. This guide covers production-grade Go implementations for both RabbitMQ and Apache Kafka, with practical guidance on when to choose each.

<!--more-->

# Go Messaging Patterns: RabbitMQ and Kafka for Reliable Event Processing

## Choosing Between RabbitMQ and Kafka

Before writing code, choose the right tool:

| Concern | RabbitMQ | Kafka |
|---|---|---|
| Message routing | Flexible (exchanges, bindings, headers) | Topic-based partitions only |
| Message ordering | Per-queue | Per-partition (strict) |
| Consumer model | Push (broker pushes to consumer) | Pull (consumer polls) |
| Message retention | Deleted on ACK | Retained by time/size (default 7 days) |
| Replay | Not supported | Core feature |
| Throughput | 20k-100k msgs/sec | 1M+ msgs/sec |
| Operations | Simpler | More complex (ZooKeeper/KRaft, partition rebalancing) |
| Best for | Task queues, RPC, complex routing | Event streaming, audit logs, analytics |

**Use RabbitMQ** when: you need message acknowledgment-based deletion, complex routing patterns, or request/reply RPC.

**Use Kafka** when: you need replay capability, very high throughput, ordered partitioned streams, or multiple independent consumer groups reading the same events.

## RabbitMQ: Production Patterns with amqp091-go

### Dependency Setup

```bash
go get github.com/rabbitmq/amqp091-go@v1.9.0
go get go.uber.org/zap@v1.26.0
```

### Connection Manager with Reconnection

RabbitMQ connections and channels can drop. A robust client wraps these with automatic reconnection:

```go
// pkg/rabbitmq/connection.go
package rabbitmq

import (
	"fmt"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"go.uber.org/zap"
)

// ConnectionManager maintains a single AMQP connection with auto-reconnection.
type ConnectionManager struct {
	url         string
	conn        *amqp.Connection
	mu          sync.RWMutex
	log         *zap.Logger
	reconnectCh chan struct{}
	closedCh    chan *amqp.Error
}

// NewConnectionManager creates and connects a ConnectionManager.
func NewConnectionManager(url string, log *zap.Logger) (*ConnectionManager, error) {
	cm := &ConnectionManager{
		url:         url,
		log:         log,
		reconnectCh: make(chan struct{}, 1),
	}
	if err := cm.connect(); err != nil {
		return nil, err
	}
	go cm.reconnectLoop()
	return cm, nil
}

func (cm *ConnectionManager) connect() error {
	cfg := amqp.Config{
		Heartbeat: 30 * time.Second,
		Locale:    "en_US",
	}
	conn, err := amqp.DialConfig(cm.url, cfg)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}

	cm.mu.Lock()
	cm.conn = conn
	cm.mu.Unlock()

	// Watch for connection errors
	closedCh := make(chan *amqp.Error, 1)
	conn.NotifyClose(closedCh)

	go func() {
		err := <-closedCh
		if err != nil {
			cm.log.Warn("AMQP connection closed, reconnecting", zap.Error(err))
			cm.reconnectCh <- struct{}{}
		}
	}()

	cm.log.Info("AMQP connection established")
	return nil
}

func (cm *ConnectionManager) reconnectLoop() {
	for range cm.reconnectCh {
		backoff := 1 * time.Second
		for {
			cm.log.Info("attempting AMQP reconnect", zap.Duration("backoff", backoff))
			time.Sleep(backoff)
			if err := cm.connect(); err == nil {
				cm.log.Info("AMQP reconnect succeeded")
				break
			} else {
				cm.log.Error("AMQP reconnect failed", zap.Error(err))
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
		}
	}
}

// Channel returns a new AMQP channel from the current connection.
func (cm *ConnectionManager) Channel() (*amqp.Channel, error) {
	cm.mu.RLock()
	conn := cm.conn
	cm.mu.RUnlock()
	if conn == nil || conn.IsClosed() {
		return nil, fmt.Errorf("connection not available")
	}
	return conn.Channel()
}

// Close closes the underlying AMQP connection.
func (cm *ConnectionManager) Close() error {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	if cm.conn != nil && !cm.conn.IsClosed() {
		return cm.conn.Close()
	}
	return nil
}
```

### Exchange and Queue Topology

```go
// pkg/rabbitmq/topology.go
package rabbitmq

import (
	"fmt"
	amqp "github.com/rabbitmq/amqp091-go"
)

// TopologyConfig defines the exchange/queue layout.
type TopologyConfig struct {
	ExchangeName string
	ExchangeType string // direct, fanout, topic, headers
	QueueName    string
	RoutingKey   string
	DLXName      string // Dead letter exchange
	DLQName      string // Dead letter queue
}

// DeclareTopology creates exchanges and queues with dead letter configuration.
func DeclareTopology(ch *amqp.Channel, cfg TopologyConfig) error {
	// Declare dead letter exchange
	if err := ch.ExchangeDeclare(
		cfg.DLXName,
		"fanout",
		true,  // durable
		false, // auto-delete
		false, // internal
		false, // no-wait
		nil,
	); err != nil {
		return fmt.Errorf("declare DLX %q: %w", cfg.DLXName, err)
	}

	// Declare dead letter queue
	_, err := ch.QueueDeclare(
		cfg.DLQName,
		true,  // durable
		false, // auto-delete
		false, // exclusive
		false, // no-wait
		amqp.Table{
			"x-message-ttl": int32(7 * 24 * 60 * 60 * 1000), // 7 days in ms
		},
	)
	if err != nil {
		return fmt.Errorf("declare DLQ %q: %w", cfg.DLQName, err)
	}

	// Bind DLQ to DLX
	if err := ch.QueueBind(cfg.DLQName, "#", cfg.DLXName, false, nil); err != nil {
		return fmt.Errorf("bind DLQ: %w", err)
	}

	// Declare main exchange
	if err := ch.ExchangeDeclare(
		cfg.ExchangeName,
		cfg.ExchangeType,
		true, false, false, false, nil,
	); err != nil {
		return fmt.Errorf("declare exchange %q: %w", cfg.ExchangeName, err)
	}

	// Declare main queue with DLX routing
	_, err = ch.QueueDeclare(
		cfg.QueueName,
		true, false, false, false,
		amqp.Table{
			"x-dead-letter-exchange": cfg.DLXName,
			"x-max-priority":         int32(10), // Priority queue support
		},
	)
	if err != nil {
		return fmt.Errorf("declare queue %q: %w", cfg.QueueName, err)
	}

	// Bind main queue to exchange
	if err := ch.QueueBind(
		cfg.QueueName, cfg.RoutingKey, cfg.ExchangeName, false, nil,
	); err != nil {
		return fmt.Errorf("bind queue: %w", err)
	}

	return nil
}
```

### Publisher with Confirms

Publisher confirms ensure the broker has persisted the message to disk before the publish call returns:

```go
// pkg/rabbitmq/publisher.go
package rabbitmq

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"go.uber.org/zap"
)

// Publisher publishes messages with confirmation.
type Publisher struct {
	cm          *ConnectionManager
	exchangeName string
	log         *zap.Logger
}

// NewPublisher creates a Publisher.
func NewPublisher(cm *ConnectionManager, exchangeName string, log *zap.Logger) *Publisher {
	return &Publisher{cm: cm, exchangeName: exchangeName, log: log}
}

// Publish publishes a message and waits for broker confirmation.
func (p *Publisher) Publish(ctx context.Context, routingKey string, body interface{}) error {
	ch, err := p.cm.Channel()
	if err != nil {
		return fmt.Errorf("channel: %w", err)
	}
	defer ch.Close()

	// Enable publisher confirms on this channel
	if err := ch.Confirm(false); err != nil {
		return fmt.Errorf("confirm mode: %w", err)
	}

	confirms := ch.NotifyPublish(make(chan amqp.Confirmation, 1))

	data, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	msg := amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Persistent,
		Timestamp:    time.Now().UTC(),
		MessageId:    generateMessageID(), // UUID v4
		Body:         data,
	}

	if err := ch.PublishWithContext(ctx,
		p.exchangeName, routingKey,
		true,  // mandatory: return if no queue matches
		false, // immediate: deprecated in newer RabbitMQ
		msg,
	); err != nil {
		return fmt.Errorf("publish: %w", err)
	}

	// Wait for broker confirmation
	select {
	case confirm := <-confirms:
		if !confirm.Ack {
			return fmt.Errorf("message nacked by broker (delivery tag: %d)", confirm.DeliveryTag)
		}
		p.log.Debug("message confirmed", zap.Uint64("tag", confirm.DeliveryTag))
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(10 * time.Second):
		return fmt.Errorf("confirmation timeout")
	}
}

// BatchPublish publishes multiple messages in a single channel transaction.
func (p *Publisher) BatchPublish(ctx context.Context, routingKey string, messages []interface{}) error {
	ch, err := p.cm.Channel()
	if err != nil {
		return fmt.Errorf("channel: %w", err)
	}
	defer ch.Close()

	if err := ch.Confirm(false); err != nil {
		return fmt.Errorf("confirm mode: %w", err)
	}
	confirms := ch.NotifyPublish(make(chan amqp.Confirmation, len(messages)))

	for _, body := range messages {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal: %w", err)
		}
		if err := ch.PublishWithContext(ctx, p.exchangeName, routingKey, true, false, amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent,
			Timestamp:    time.Now().UTC(),
			MessageId:    generateMessageID(),
			Body:         data,
		}); err != nil {
			return fmt.Errorf("publish: %w", err)
		}
	}

	// Wait for all confirmations
	acked := 0
	for acked < len(messages) {
		select {
		case confirm := <-confirms:
			if !confirm.Ack {
				return fmt.Errorf("batch nack at delivery tag %d", confirm.DeliveryTag)
			}
			acked++
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(30 * time.Second):
			return fmt.Errorf("batch confirmation timeout after %d/%d acks", acked, len(messages))
		}
	}

	return nil
}
```

### Consumer with Prefetch and Dead Letter Handling

```go
// pkg/rabbitmq/consumer.go
package rabbitmq

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"go.uber.org/zap"
)

// MessageHandler processes a single message.
// Return an error to nack the message (it will be retried or dead-lettered).
type MessageHandler func(ctx context.Context, body []byte) error

// Consumer subscribes to a queue with prefetch control.
type Consumer struct {
	cm        *ConnectionManager
	queueName string
	prefetch  int
	log       *zap.Logger
}

// NewConsumer creates a Consumer.
func NewConsumer(cm *ConnectionManager, queueName string, prefetch int, log *zap.Logger) *Consumer {
	return &Consumer{
		cm:        cm,
		queueName: queueName,
		prefetch:  prefetch,
		log:       log,
	}
}

// Consume starts consuming messages and calls handler for each one.
// This function blocks until ctx is cancelled.
func (c *Consumer) Consume(ctx context.Context, handler MessageHandler) error {
	for {
		if err := c.consumeOnce(ctx, handler); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			c.log.Error("consumer error, retrying", zap.Error(err))
			select {
			case <-time.After(5 * time.Second):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
}

func (c *Consumer) consumeOnce(ctx context.Context, handler MessageHandler) error {
	ch, err := c.cm.Channel()
	if err != nil {
		return fmt.Errorf("channel: %w", err)
	}
	defer ch.Close()

	// Control how many unacknowledged messages the broker sends at once
	if err := ch.Qos(c.prefetch, 0, false); err != nil {
		return fmt.Errorf("qos: %w", err)
	}

	deliveries, err := ch.ConsumeWithContext(ctx,
		c.queueName,
		"",    // consumer tag (auto-generated)
		false, // auto-ack (we ack manually)
		false, // exclusive
		false, // no-local
		false, // no-wait
		nil,
	)
	if err != nil {
		return fmt.Errorf("consume: %w", err)
	}

	c.log.Info("consuming messages", zap.String("queue", c.queueName))

	for {
		select {
		case delivery, ok := <-deliveries:
			if !ok {
				return fmt.Errorf("delivery channel closed")
			}
			c.processDelivery(ctx, delivery, handler)
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (c *Consumer) processDelivery(ctx context.Context, d amqp.Delivery, handler MessageHandler) {
	start := time.Now()
	retryCount := int32(0)
	if v, ok := d.Headers["x-death"]; ok {
		if deaths, ok := v.([]interface{}); ok && len(deaths) > 0 {
			if death, ok := deaths[0].(amqp.Table); ok {
				if count, ok := death["count"].(int64); ok {
					retryCount = int32(count)
				}
			}
		}
	}

	err := handler(ctx, d.Body)
	latency := time.Since(start)

	if err != nil {
		c.log.Error("handler error",
			zap.Error(err),
			zap.Int32("retry_count", retryCount),
			zap.Duration("latency", latency),
		)

		// Nack with requeue=false sends to DLX after max retries
		if retryCount >= 3 {
			c.log.Warn("max retries exceeded, dead-lettering", zap.String("message_id", d.MessageId))
			_ = d.Nack(false, false)
		} else {
			_ = d.Nack(false, true) // requeue for retry
		}
		return
	}

	c.log.Debug("message processed",
		zap.String("message_id", d.MessageId),
		zap.Duration("latency", latency),
	)
	_ = d.Ack(false)
}
```

## Kafka: Production Patterns with kafka-go

### Dependencies

```bash
go get github.com/segmentio/kafka-go@v0.4.47
```

### Idempotent Producer

```go
// pkg/kafka/producer.go
package kafka

import (
	"context"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
	"go.uber.org/zap"
)

// ProducerConfig configures the Kafka producer.
type ProducerConfig struct {
	Brokers       []string
	Topic         string
	BatchSize     int
	BatchTimeout  time.Duration
	RequiredAcks  kafka.RequiredAcks
	Compression   kafka.Compression
}

// DefaultProducerConfig returns sensible production defaults.
func DefaultProducerConfig(brokers []string, topic string) ProducerConfig {
	return ProducerConfig{
		Brokers:      brokers,
		Topic:        topic,
		BatchSize:    100,
		BatchTimeout: 10 * time.Millisecond,
		RequiredAcks: kafka.RequireAll, // Leader + all ISR replicas
		Compression:  kafka.Snappy,
	}
}

// Producer wraps kafka.Writer with structured logging and metrics.
type Producer struct {
	writer *kafka.Writer
	log    *zap.Logger
}

// NewProducer creates a Producer.
func NewProducer(cfg ProducerConfig, log *zap.Logger) *Producer {
	w := &kafka.Writer{
		Addr:         kafka.TCP(cfg.Brokers...),
		Topic:        cfg.Topic,
		Balancer:     &kafka.Hash{}, // Partition by key hash for ordering
		BatchSize:    cfg.BatchSize,
		BatchTimeout: cfg.BatchTimeout,
		RequiredAcks: cfg.RequiredAcks,
		Compression:  cfg.Compression,
		// Idempotent delivery: exactly-once within a single producer session
		// Requires RequiredAcks=RequireAll and Kafka 0.11+
		AllowAutoTopicCreation: false,
		ErrorLogger:            kafka.LoggerFunc(func(msg string, a ...interface{}) {
			log.Error(fmt.Sprintf(msg, a...))
		}),
	}

	return &Producer{writer: w, log: log}
}

// Publish sends a single message with the given key.
func (p *Producer) Publish(ctx context.Context, key string, value []byte) error {
	msg := kafka.Message{
		Key:   []byte(key),
		Value: value,
		Headers: []kafka.Header{
			{Key: "produced_at", Value: []byte(time.Now().UTC().Format(time.RFC3339))},
		},
	}

	if err := p.writer.WriteMessages(ctx, msg); err != nil {
		return fmt.Errorf("write message: %w", err)
	}

	return nil
}

// PublishBatch sends multiple messages in a single batch for throughput.
func (p *Producer) PublishBatch(ctx context.Context, messages []kafka.Message) error {
	if len(messages) == 0 {
		return nil
	}

	if err := p.writer.WriteMessages(ctx, messages...); err != nil {
		return fmt.Errorf("write batch of %d messages: %w", len(messages), err)
	}

	return nil
}

// Stats returns current producer statistics.
func (p *Producer) Stats() kafka.WriterStats {
	return p.writer.Stats()
}

// Close flushes pending messages and closes the writer.
func (p *Producer) Close() error {
	return p.writer.Close()
}
```

### Consumer Group with Offset Management

```go
// pkg/kafka/consumer.go
package kafka

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
	"go.uber.org/zap"
)

// ConsumerConfig configures the Kafka consumer group.
type ConsumerConfig struct {
	Brokers        []string
	Topic          string
	GroupID        string
	MinBytes       int
	MaxBytes       int
	MaxWait        time.Duration
	StartOffset    int64
	CommitInterval time.Duration
}

// DefaultConsumerConfig returns sensible production defaults.
func DefaultConsumerConfig(brokers []string, topic, groupID string) ConsumerConfig {
	return ConsumerConfig{
		Brokers:        brokers,
		Topic:          topic,
		GroupID:        groupID,
		MinBytes:       10e3,              // 10 KB minimum fetch
		MaxBytes:       10e6,              // 10 MB maximum fetch
		MaxWait:        500 * time.Millisecond,
		StartOffset:    kafka.LastOffset,  // Start from latest on new consumer group
		CommitInterval: time.Second,       // Auto-commit every second
	}
}

// MessageProcessor processes a Kafka message.
type MessageProcessor func(ctx context.Context, msg kafka.Message) error

// Consumer manages a Kafka consumer group.
type Consumer struct {
	reader *kafka.Reader
	log    *zap.Logger
}

// NewConsumer creates a Consumer.
func NewConsumer(cfg ConsumerConfig, log *zap.Logger) *Consumer {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        cfg.Brokers,
		Topic:          cfg.Topic,
		GroupID:        cfg.GroupID,
		MinBytes:       cfg.MinBytes,
		MaxBytes:       cfg.MaxBytes,
		MaxWait:        cfg.MaxWait,
		StartOffset:    cfg.StartOffset,
		CommitInterval: cfg.CommitInterval,
		Logger: kafka.LoggerFunc(func(msg string, a ...interface{}) {
			log.Debug(fmt.Sprintf(msg, a...))
		}),
		ErrorLogger: kafka.LoggerFunc(func(msg string, a ...interface{}) {
			log.Error(fmt.Sprintf(msg, a...))
		}),
	})

	return &Consumer{reader: r, log: log}
}

// Consume starts consuming and processing messages.
// Uses explicit commit for at-least-once delivery.
func (c *Consumer) Consume(ctx context.Context, processor MessageProcessor) error {
	for {
		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return err
			}
			c.log.Error("fetch message error", zap.Error(err))
			continue
		}

		c.log.Debug("processing message",
			zap.String("topic", msg.Topic),
			zap.Int("partition", msg.Partition),
			zap.Int64("offset", msg.Offset),
			zap.Int("size", len(msg.Value)),
		)

		if err := processor(ctx, msg); err != nil {
			c.log.Error("message processing failed",
				zap.Error(err),
				zap.Int64("offset", msg.Offset),
				zap.Int("partition", msg.Partition),
			)
			// Do NOT commit offset on processing failure
			// This message will be redelivered after restart
			// For a dead letter pattern, publish to a DLT here
			continue
		}

		// Commit offset after successful processing
		if err := c.reader.CommitMessages(ctx, msg); err != nil {
			c.log.Error("commit failed", zap.Error(err))
		}
	}
}

// ConsumeBatch processes messages in batches for higher throughput.
func (c *Consumer) ConsumeBatch(ctx context.Context, batchSize int, processor func(context.Context, []kafka.Message) error) error {
	for {
		var batch []kafka.Message
		deadline := time.Now().Add(500 * time.Millisecond)
		batchCtx, cancel := context.WithDeadline(ctx, deadline)

		for len(batch) < batchSize {
			msg, err := c.reader.FetchMessage(batchCtx)
			if err != nil {
				cancel()
				if errors.Is(err, context.DeadlineExceeded) {
					break // Process partial batch
				}
				if errors.Is(err, context.Canceled) {
					return err
				}
				c.log.Error("fetch error", zap.Error(err))
				break
			}
			batch = append(batch, msg)
		}
		cancel()

		if len(batch) == 0 {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			continue
		}

		if err := processor(ctx, batch); err != nil {
			c.log.Error("batch processing failed", zap.Error(err), zap.Int("batch_size", len(batch)))
			continue
		}

		// Commit the last message in the batch (implies all preceding)
		last := batch[len(batch)-1]
		if err := c.reader.CommitMessages(ctx, last); err != nil {
			c.log.Error("batch commit failed", zap.Error(err))
		}
	}
}

// Stats returns current consumer statistics.
func (c *Consumer) Stats() kafka.ReaderStats {
	return c.reader.Stats()
}

// Close closes the consumer.
func (c *Consumer) Close() error {
	return c.reader.Close()
}
```

### Offset Management and Consumer Group Administration

```go
// pkg/kafka/admin.go
package kafka

import (
	"context"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
)

// CreateTopic creates a Kafka topic with the given configuration.
func CreateTopic(ctx context.Context, broker, topic string, partitions, replicationFactor int) error {
	conn, err := kafka.DialContext(ctx, "tcp", broker)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	return conn.CreateTopics(kafka.TopicConfig{
		Topic:             topic,
		NumPartitions:     partitions,
		ReplicationFactor: replicationFactor,
		ConfigEntries: []kafka.ConfigEntry{
			{ConfigName: "retention.ms", ConfigValue: fmt.Sprintf("%d", 7*24*int(time.Hour.Milliseconds()))},
			{ConfigName: "cleanup.policy", ConfigValue: "delete"},
			{ConfigName: "compression.type", ConfigValue: "snappy"},
			{ConfigName: "min.insync.replicas", ConfigValue: "2"},
		},
	})
}

// GetConsumerGroupOffsets returns the current offsets for a consumer group.
func GetConsumerGroupOffsets(ctx context.Context, broker, groupID, topic string) (map[int]int64, error) {
	conn, err := kafka.DialLeader(ctx, "tcp", broker, topic, 0)
	if err != nil {
		return nil, fmt.Errorf("dial leader: %w", err)
	}
	defer conn.Close()

	partitions, err := conn.ReadPartitions(topic)
	if err != nil {
		return nil, fmt.Errorf("read partitions: %w", err)
	}

	offsets := make(map[int]int64, len(partitions))
	for _, p := range partitions {
		r := kafka.NewReader(kafka.ReaderConfig{
			Brokers: []string{broker},
			Topic:   topic,
			GroupID: groupID,
		})
		defer r.Close()

		stats := r.Stats()
		offsets[p.ID] = stats.Offset
	}

	return offsets, nil
}
```

## Outbox Pattern Implementation

The outbox pattern prevents dual-write problems: instead of writing to the database AND publishing to the message broker in the same operation (which can fail halfway), you write only to the database (outbox table), then a separate process publishes from there.

```go
// pkg/outbox/outbox.go
package outbox

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	_ "github.com/lib/pq"
	"go.uber.org/zap"
)

// OutboxMessage represents a pending outbox message.
type OutboxMessage struct {
	ID          string
	Topic       string
	Key         string
	Payload     []byte
	CreatedAt   time.Time
	ProcessedAt *time.Time
}

// Store provides outbox message persistence.
type Store struct {
	db  *sql.DB
	log *zap.Logger
}

// NewStore creates an outbox Store using an existing database connection.
func NewStore(db *sql.DB, log *zap.Logger) *Store {
	return &Store{db: db, log: log}
}

// CreateSchema creates the outbox table if it does not exist.
func (s *Store) CreateSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS outbox_messages (
			id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			topic        TEXT NOT NULL,
			key          TEXT NOT NULL,
			payload      JSONB NOT NULL,
			created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			processed_at TIMESTAMPTZ
		);
		CREATE INDEX IF NOT EXISTS idx_outbox_unprocessed
			ON outbox_messages (created_at)
			WHERE processed_at IS NULL;
	`)
	return err
}

// Append adds a message to the outbox within the given transaction.
// Call this in the same transaction as your business logic write.
func (s *Store) Append(ctx context.Context, tx *sql.Tx, topic, key string, payload interface{}) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO outbox_messages (id, topic, key, payload)
		VALUES ($1, $2, $3, $4)
	`, uuid.New().String(), topic, key, data)

	return err
}

// Publisher is a function that publishes an outbox message.
type Publisher func(ctx context.Context, topic, key string, payload []byte) error

// Relay polls the outbox table and publishes pending messages.
func (s *Store) Relay(ctx context.Context, publish Publisher, batchSize int) error {
	for {
		if err := s.relayBatch(ctx, publish, batchSize); err != nil {
			s.log.Error("relay batch error", zap.Error(err))
		}

		select {
		case <-time.After(100 * time.Millisecond):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (s *Store) relayBatch(ctx context.Context, publish Publisher, batchSize int) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// Lock rows for update to prevent concurrent relay instances from double-publishing
	rows, err := tx.QueryContext(ctx, `
		SELECT id, topic, key, payload
		FROM outbox_messages
		WHERE processed_at IS NULL
		ORDER BY created_at ASC
		LIMIT $1
		FOR UPDATE SKIP LOCKED
	`, batchSize)
	if err != nil {
		return fmt.Errorf("query outbox: %w", err)
	}
	defer rows.Close()

	var messages []OutboxMessage
	for rows.Next() {
		var m OutboxMessage
		if err := rows.Scan(&m.ID, &m.Topic, &m.Key, &m.Payload); err != nil {
			return fmt.Errorf("scan: %w", err)
		}
		messages = append(messages, m)
	}

	if err := rows.Err(); err != nil {
		return fmt.Errorf("rows error: %w", err)
	}

	if len(messages) == 0 {
		return tx.Commit()
	}

	// Publish all messages
	for _, m := range messages {
		if err := publish(ctx, m.Topic, m.Key, m.Payload); err != nil {
			return fmt.Errorf("publish message %s: %w", m.ID, err)
		}
	}

	// Mark as processed only after successful publish
	ids := make([]string, len(messages))
	for i, m := range messages {
		ids[i] = m.ID
	}

	_, err = tx.ExecContext(ctx, `
		UPDATE outbox_messages
		SET processed_at = NOW()
		WHERE id = ANY($1::uuid[])
	`, ids)
	if err != nil {
		return fmt.Errorf("mark processed: %w", err)
	}

	s.log.Debug("relayed messages", zap.Int("count", len(messages)))
	return tx.Commit()
}
```

### Using the Outbox Pattern in a Service

```go
// Example: order service using outbox pattern
func (s *OrderService) CreateOrder(ctx context.Context, order Order) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// 1. Insert the order into the main table
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO orders (id, customer_id, total, status)
		VALUES ($1, $2, $3, 'pending')
	`, order.ID, order.CustomerID, order.Total); err != nil {
		return fmt.Errorf("insert order: %w", err)
	}

	// 2. Append event to outbox within the SAME transaction
	if err := s.outbox.Append(ctx, tx, "orders.created", order.ID.String(), map[string]interface{}{
		"order_id":    order.ID,
		"customer_id": order.CustomerID,
		"total":       order.Total,
		"created_at":  time.Now().UTC(),
	}); err != nil {
		return fmt.Errorf("append outbox: %w", err)
	}

	// 3. Commit atomically - both the order and the outbox entry succeed or fail together
	return tx.Commit()
}
```

## Dead Letter Topic Pattern for Kafka

```go
// pkg/kafka/dlt.go
package kafka

import (
	"context"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
)

// DLTWriter writes failed messages to a dead letter topic.
type DLTWriter struct {
	writer *kafka.Writer
}

// NewDLTWriter creates a DLT writer for the given topic.
func NewDLTWriter(brokers []string, originalTopic string) *DLTWriter {
	dltTopic := originalTopic + ".dlt"
	return &DLTWriter{
		writer: &kafka.Writer{
			Addr:         kafka.TCP(brokers...),
			Topic:        dltTopic,
			RequiredAcks: kafka.RequireAll,
		},
	}
}

// Send writes a failed message to the DLT with failure metadata.
func (d *DLTWriter) Send(ctx context.Context, original kafka.Message, reason error) error {
	headers := append(original.Headers,
		kafka.Header{Key: "dlt-original-topic", Value: []byte(original.Topic)},
		kafka.Header{Key: "dlt-original-partition", Value: []byte(fmt.Sprintf("%d", original.Partition))},
		kafka.Header{Key: "dlt-original-offset", Value: []byte(fmt.Sprintf("%d", original.Offset))},
		kafka.Header{Key: "dlt-failure-reason", Value: []byte(reason.Error())},
		kafka.Header{Key: "dlt-failed-at", Value: []byte(time.Now().UTC().Format(time.RFC3339))},
	)

	return d.writer.WriteMessages(ctx, kafka.Message{
		Key:     original.Key,
		Value:   original.Value,
		Headers: headers,
	})
}

// Close closes the DLT writer.
func (d *DLTWriter) Close() error {
	return d.writer.Close()
}
```

## Wiring Everything Together

```go
// cmd/worker/main.go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/segmentio/kafka-go"
	"go.uber.org/zap"

	kafkapkg "github.com/yourorg/app/pkg/kafka"
)

type OrderEvent struct {
	OrderID    string  `json:"order_id"`
	CustomerID string  `json:"customer_id"`
	Total      float64 `json:"total"`
}

func main() {
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	brokers := []string{"kafka-0.kafka.svc.cluster.local:9092"}
	topic := "orders.created"

	consumer := kafkapkg.NewConsumer(
		kafkapkg.DefaultConsumerConfig(brokers, topic, "order-processor"),
		logger,
	)
	defer consumer.Close()

	dlt := kafkapkg.NewDLTWriter(brokers, topic)
	defer dlt.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	processor := func(ctx context.Context, msg kafka.Message) error {
		var event OrderEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			// Non-retryable: bad message format
			if dltErr := dlt.Send(ctx, msg, err); dltErr != nil {
				logger.Error("DLT send failed", zap.Error(dltErr))
			}
			return nil // Return nil to commit offset and not loop forever
		}

		logger.Info("processing order",
			zap.String("order_id", event.OrderID),
			zap.Float64("total", event.Total),
		)

		if err := processOrder(ctx, event); err != nil {
			return fmt.Errorf("process order %s: %w", event.OrderID, err)
		}

		return nil
	}

	log.Println("Starting Kafka consumer...")
	if err := consumer.Consume(ctx, processor); err != nil {
		logger.Info("consumer stopped", zap.Error(err))
	}
}

func processOrder(ctx context.Context, event OrderEvent) error {
	// Business logic here
	return nil
}
```

## Summary

RabbitMQ with publisher confirms and dead letter queues is the right choice for task queues where messages are consumed and deleted, complex routing is needed, or you need built-in TTL and priority queues. Kafka is the right choice when you need message replay, multiple independent consumers reading the same stream, very high throughput, or ordered partitioned event streams.

In both cases, the outbox pattern eliminates the dual-write problem that causes message loss or duplication when business logic and message publishing are combined. Writing to the outbox within the same database transaction as your business logic write guarantees that either both succeed or neither does, and the relay process handles publishing with retry semantics.
