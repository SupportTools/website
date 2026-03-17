---
title: "Go Async Processing: NATS JetStream, Message Deduplication, and Consumer Groups"
date: 2030-01-27T00:00:00-05:00
draft: false
tags: ["Go", "NATS", "JetStream", "Messaging", "Async", "Kafka", "Microservices"]
categories: ["Go", "Messaging", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production NATS JetStream usage in Go: stream configuration, durable consumers, exactly-once delivery, pull vs push consumers, message deduplication, consumer groups, and Prometheus monitoring."
more_link: "yes"
url: "/go-async-processing-nats-jetstream-consumer-groups/"
---

NATS JetStream brings persistence, delivery guarantees, and consumer tracking to NATS — the high-performance messaging system designed for cloud-native infrastructure. While Apache Kafka dominates the heavy-throughput event streaming space, JetStream fills a critical niche: when you need sub-millisecond latency, simple operational deployment, and built-in Go-first tooling without the JVM overhead and ZooKeeper complexity.

JetStream adds durable message streams, exactly-once semantics, pull and push consumers, consumer groups, key-value storage, and object storage to the base NATS protocol. This guide covers production-grade JetStream usage in Go, including stream design, exactly-once processing, consumer group patterns, monitoring, and failure handling.

<!--more-->

## JetStream Architecture Fundamentals

JetStream is the persistence layer built into the NATS server. Key concepts:

- **Stream**: Append-only log of messages on a set of subjects. Configurable retention (limits, interest, work queue).
- **Consumer**: A named cursor into a stream. Tracks which messages have been delivered and acknowledged.
- **Durable Consumer**: A consumer that persists its state across client disconnections.
- **Pull Consumer**: Client explicitly requests messages. Enables batch processing and backpressure.
- **Push Consumer**: Server pushes messages to a client subject. Lower latency, less control.
- **Consumer Group**: Multiple consumers on the same durable consumer share the workload (exclusive/round-robin).
- **Ack Policy**: `None`, `All`, `Explicit` — controls acknowledgment granularity.

### JetStream vs Kafka for Go Services

| Feature | NATS JetStream | Apache Kafka |
|---|---|---|
| Latency (p99) | ~0.5ms | ~5ms |
| Go client quality | Native, official | kafka-go / Sarama |
| Operational complexity | Low (single binary) | High (ZK or KRaft) |
| Throughput | ~10M msg/s | ~100M msg/s |
| Exactly-once | Yes (per-consumer) | Yes (idempotent producer + transactions) |
| Cluster setup | RAFT-based, simple | Complex partition management |
| Schema registry | No (external) | Yes (Confluent) |

## NATS Server Setup for Production

### Docker Compose for Development

```yaml
# docker-compose.yaml
version: "3.8"
services:
  nats:
    image: nats:2.10-alpine
    command:
      - "-js"                          # Enable JetStream
      - "-sd=/data"                    # Store directory
      - "--cluster_name=c1"
      - "--cluster=nats://0.0.0.0:6222"
      - "--routes=nats://nats-2:6222,nats://nats-3:6222"
      - "--server_name=n1"
      - "-m=8222"                      # Monitoring port
    ports:
      - "4222:4222"
      - "8222:8222"
    volumes:
      - nats-data:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8222/healthz"]
      interval: 10s
      timeout: 5s
      retries: 3

  nats-2:
    image: nats:2.10-alpine
    command:
      - "-js"
      - "-sd=/data"
      - "--cluster_name=c1"
      - "--cluster=nats://0.0.0.0:6222"
      - "--routes=nats://nats:6222,nats://nats-3:6222"
      - "--server_name=n2"
    volumes:
      - nats-data-2:/data

  nats-3:
    image: nats:2.10-alpine
    command:
      - "-js"
      - "-sd=/data"
      - "--cluster_name=c1"
      - "--cluster=nats://0.0.0.0:6222"
      - "--routes=nats://nats:6222,nats://nats-2:6222"
      - "--server_name=n3"
    volumes:
      - nats-data-3:/data

volumes:
  nats-data:
  nats-data-2:
  nats-data-3:
```

### Production Server Configuration (nats.conf)

```hcl
# nats.conf
server_name: $SERVER_NAME
listen: 0.0.0.0:4222
http: 0.0.0.0:8222

jetstream {
  store_dir: /data/jetstream
  max_memory_store: 1GB
  max_file_store: 50GB
}

cluster {
  name: production-cluster
  listen: 0.0.0.0:6222
  routes: [
    nats://nats-0.nats.svc.cluster.local:6222
    nats://nats-1.nats.svc.cluster.local:6222
    nats://nats-2.nats.svc.cluster.local:6222
  ]
}

accounts {
  $SYS {
    users: [{ user: sys, password: $SYS_PASSWORD }]
  }
  APP {
    jetstream: enabled
    users: [{ user: app, password: $APP_PASSWORD }]
    limits {
      max_connections: 1000
      max_subscriptions: 10000
    }
  }
}
```

## Go JetStream Client Setup

```go
// pkg/messaging/client.go
package messaging

import (
	"context"
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"go.uber.org/zap"
)

// Config holds NATS connection configuration.
type Config struct {
	URLs        []string
	Username    string
	Password    string
	MaxReconnect int
	ReconnectWait time.Duration
	Timeout     time.Duration
}

// Client wraps the NATS connection and JetStream context.
type Client struct {
	nc     *nats.Conn
	js     jetstream.JetStream
	logger *zap.Logger
}

// NewClient establishes a NATS connection with JetStream enabled.
func NewClient(cfg Config, logger *zap.Logger) (*Client, error) {
	opts := []nats.Option{
		nats.Name("go-service"),
		nats.Timeout(cfg.Timeout),
		nats.MaxReconnects(cfg.MaxReconnect),
		nats.ReconnectWait(cfg.ReconnectWait),
		nats.UserInfo(cfg.Username, cfg.Password),
		nats.DisconnectErrHandler(func(nc *nats.Conn, err error) {
			logger.Warn("NATS disconnected", zap.Error(err))
		}),
		nats.ReconnectHandler(func(nc *nats.Conn) {
			logger.Info("NATS reconnected", zap.String("url", nc.ConnectedUrl()))
		}),
		nats.ErrorHandler(func(nc *nats.Conn, sub *nats.Subscription, err error) {
			logger.Error("NATS async error", zap.Error(err),
				zap.String("subject", func() string {
					if sub != nil { return sub.Subject }
					return ""
				}()),
			)
		}),
		nats.ClosedHandler(func(nc *nats.Conn) {
			logger.Warn("NATS connection closed permanently")
		}),
	}

	servers := nats.GetCustomDialer()
	_ = servers

	nc, err := nats.Connect(
		fmt.Sprintf("nats://%s", cfg.URLs[0]),
		opts...,
	)
	if err != nil {
		return nil, fmt.Errorf("connecting to NATS: %w", err)
	}

	// Enable JetStream (new API)
	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		return nil, fmt.Errorf("creating JetStream context: %w", err)
	}

	logger.Info("NATS connected",
		zap.String("server", nc.ConnectedUrl()),
		zap.String("server_id", nc.ConnectedServerId()),
	)

	return &Client{nc: nc, js: js, logger: logger}, nil
}

// Close cleanly shuts down the NATS connection.
func (c *Client) Close() {
	c.nc.Drain()
	c.nc.Close()
}

// JetStream returns the JetStream interface for stream/consumer operations.
func (c *Client) JetStream() jetstream.JetStream {
	return c.js
}
```

## Stream Configuration and Management

```go
// pkg/messaging/stream.go
package messaging

import (
	"context"
	"fmt"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	"go.uber.org/zap"
)

// StreamConfig defines a JetStream stream configuration.
type StreamConfig struct {
	Name        string
	Subjects    []string
	Retention   jetstream.RetentionPolicy
	MaxAge      time.Duration
	MaxBytes    int64
	MaxMsgs     int64
	MaxMsgSize  int32
	Replicas    int
	DenyDelete  bool
	DenyPurge   bool
	Description string
}

// StreamManager manages JetStream stream lifecycle.
type StreamManager struct {
	js     jetstream.JetStream
	logger *zap.Logger
}

// NewStreamManager creates a new stream manager.
func NewStreamManager(js jetstream.JetStream, logger *zap.Logger) *StreamManager {
	return &StreamManager{js: js, logger: logger}
}

// EnsureStream creates or updates a stream to match the provided configuration.
func (m *StreamManager) EnsureStream(ctx context.Context, cfg StreamConfig) (jetstream.Stream, error) {
	natsConfig := jetstream.StreamConfig{
		Name:        cfg.Name,
		Description: cfg.Description,
		Subjects:    cfg.Subjects,
		Retention:   cfg.Retention,
		MaxAge:      cfg.MaxAge,
		MaxBytes:    cfg.MaxBytes,
		MaxMsgs:     cfg.MaxMsgs,
		MaxMsgSize:  cfg.MaxMsgSize,
		Replicas:    cfg.Replicas,
		DenyDelete:  cfg.DenyDelete,
		DenyPurge:   cfg.DenyPurge,
		Storage:     jetstream.FileStorage,
		Discard:     jetstream.DiscardOld,
		// Enable deduplication window (Nats-Msg-Id header dedup)
		Duplicates: 5 * time.Minute,
		// Compression for large streams
		Compression: jetstream.S2Compression,
		// Mirror subjects to allow multi-cluster federation
		AllowRollup: false,
	}

	// Try to update existing stream first
	stream, err := m.js.UpdateStream(ctx, natsConfig)
	if err != nil {
		// Stream doesn't exist, create it
		stream, err = m.js.CreateStream(ctx, natsConfig)
		if err != nil {
			return nil, fmt.Errorf("creating stream %s: %w", cfg.Name, err)
		}
		m.logger.Info("stream created", zap.String("name", cfg.Name))
	} else {
		m.logger.Info("stream updated", zap.String("name", cfg.Name))
	}

	info, _ := stream.Info(ctx)
	m.logger.Debug("stream info",
		zap.String("name", cfg.Name),
		zap.Uint64("messages", info.State.Msgs),
		zap.Int64("bytes", int64(info.State.Bytes)),
	)

	return stream, nil
}

// SetupOrderProcessingStream configures the stream for order processing.
func SetupOrderProcessingStream(ctx context.Context, sm *StreamManager) (jetstream.Stream, error) {
	return sm.EnsureStream(ctx, StreamConfig{
		Name:        "ORDERS",
		Description: "Order processing events",
		Subjects:    []string{"orders.>"},   // Wildcard: orders.created, orders.updated, etc.
		Retention:   jetstream.LimitsPolicy, // Retain based on size/age
		MaxAge:      7 * 24 * time.Hour,     // 7 days
		MaxBytes:    10 * 1024 * 1024 * 1024, // 10 GB
		MaxMsgs:     -1,                      // Unlimited message count
		MaxMsgSize:  1 * 1024 * 1024,         // 1 MB max per message
		Replicas:    3,                        // Replicated across 3 nodes
		DenyDelete:  true,                     // Immutable audit trail
		DenyPurge:   true,
	})
}

// SetupWorkQueueStream configures a work queue (each message consumed once).
func SetupWorkQueueStream(ctx context.Context, sm *StreamManager) (jetstream.Stream, error) {
	return sm.EnsureStream(ctx, StreamConfig{
		Name:      "TASKS",
		Subjects:  []string{"tasks.*"},
		Retention: jetstream.WorkQueuePolicy, // Ack = delete
		MaxAge:    24 * time.Hour,
		MaxBytes:  1 * 1024 * 1024 * 1024, // 1 GB
		Replicas:  3,
	})
}
```

## Publishing with Deduplication

JetStream deduplication uses the `Nats-Msg-Id` header to prevent duplicate processing within the stream's dedup window:

```go
// pkg/messaging/publisher.go
package messaging

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go/jetstream"
	"go.uber.org/zap"
)

// Publisher publishes messages to JetStream streams.
type Publisher struct {
	js     jetstream.JetStream
	logger *zap.Logger
}

// NewPublisher creates a new JetStream publisher.
func NewPublisher(js jetstream.JetStream, logger *zap.Logger) *Publisher {
	return &Publisher{js: js, logger: logger}
}

// PublishOptions configures message publishing behavior.
type PublishOptions struct {
	// MsgID is used for exactly-once deduplication. If empty, a UUID is generated.
	MsgID string
	// ExpectedLastMsgID enables optimistic concurrency control.
	ExpectedLastMsgID string
	// ExpectedStream ensures the message lands in a specific stream.
	ExpectedStream string
	// Timeout for the publish ack.
	Timeout time.Duration
}

// OrderEvent represents an order domain event.
type OrderEvent struct {
	OrderID   string                 `json:"order_id"`
	EventType string                 `json:"event_type"`
	Timestamp time.Time              `json:"timestamp"`
	Data      map[string]interface{} `json:"data"`
	TraceID   string                 `json:"trace_id"`
}

// PublishOrder publishes an order event with exactly-once deduplication.
func (p *Publisher) PublishOrder(ctx context.Context, event OrderEvent, opts PublishOptions) error {
	if opts.MsgID == "" {
		// Deterministic ID: if the same event is retried, dedup prevents double-processing
		opts.MsgID = fmt.Sprintf("order-%s-%s", event.OrderID, event.EventType)
	}
	if opts.Timeout == 0 {
		opts.Timeout = 5 * time.Second
	}

	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshaling event: %w", err)
	}

	subject := fmt.Sprintf("orders.%s", event.EventType)

	publishOpts := []jetstream.PublishOpt{
		jetstream.WithMsgID(opts.MsgID),
		jetstream.WithExpectStream(func() string {
			if opts.ExpectedStream != "" {
				return opts.ExpectedStream
			}
			return "ORDERS"
		}()),
	}

	if opts.ExpectedLastMsgID != "" {
		publishOpts = append(publishOpts, jetstream.WithExpectLastMsgID(opts.ExpectedLastMsgID))
	}

	ctx, cancel := context.WithTimeout(ctx, opts.Timeout)
	defer cancel()

	ack, err := p.js.Publish(ctx, subject, data, publishOpts...)
	if err != nil {
		// Check for deduplication (not an error, just a duplicate)
		if jetstream.ErrMsgAlreadyAckd == err {
			p.logger.Debug("duplicate message ignored", zap.String("msg_id", opts.MsgID))
			return nil
		}
		return fmt.Errorf("publishing to %s: %w", subject, err)
	}

	p.logger.Debug("message published",
		zap.String("subject", subject),
		zap.String("msg_id", opts.MsgID),
		zap.Uint64("seq", ack.Sequence),
		zap.Bool("duplicate", ack.Duplicate),
		zap.String("stream", ack.Stream),
	)

	return nil
}

// PublishBatch publishes multiple messages atomically using async publish.
func (p *Publisher) PublishBatch(ctx context.Context, events []OrderEvent) error {
	type result struct {
		future jetstream.PubAckFuture
		event  OrderEvent
	}

	futures := make([]result, 0, len(events))

	for _, event := range events {
		data, err := json.Marshal(event)
		if err != nil {
			return fmt.Errorf("marshaling event %s: %w", event.OrderID, err)
		}

		msgID := fmt.Sprintf("order-%s-%s-%d", event.OrderID, event.EventType, event.Timestamp.UnixNano())
		subject := fmt.Sprintf("orders.%s", event.EventType)

		future, err := p.js.PublishAsync(subject, data,
			jetstream.WithMsgID(msgID),
		)
		if err != nil {
			return fmt.Errorf("async publish: %w", err)
		}
		futures = append(futures, result{future: future, event: event})
	}

	// Wait for all acks with timeout
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	select {
	case <-p.js.PublishAsyncComplete():
		// All published
	case <-ctx.Done():
		return fmt.Errorf("batch publish timeout: %w", ctx.Err())
	}

	// Check individual results
	for _, r := range futures {
		select {
		case ack := <-r.future.Ok():
			p.logger.Debug("batch ack",
				zap.String("order", r.event.OrderID),
				zap.Uint64("seq", ack.Sequence),
			)
		case err := <-r.future.Err():
			return fmt.Errorf("publish failed for order %s: %w", r.event.OrderID, err)
		}
	}

	return nil
}
```

## Pull Consumer Implementation

Pull consumers give the application control over message fetch rate, enabling backpressure:

```go
// pkg/messaging/consumer.go
package messaging

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	"go.uber.org/zap"
)

// ConsumerConfig defines a durable pull consumer.
type ConsumerConfig struct {
	// Name is the durable consumer name (persists across reconnections).
	Name string
	// Stream is the stream to consume from.
	Stream string
	// FilterSubject restricts the consumer to specific subjects.
	FilterSubjects []string
	// MaxDeliver is max delivery attempts before moving to DLQ (dead letter).
	MaxDeliver int
	// AckWait is how long server waits for ack before redelivery.
	AckWait time.Duration
	// MaxAckPending is max in-flight unacked messages.
	MaxAckPending int
	// BackOff is per-attempt backoff durations for redelivery.
	BackOff []time.Duration
	// BatchSize is how many messages to fetch per pull request.
	BatchSize int
}

// DefaultConsumerConfig returns sensible production defaults.
func DefaultConsumerConfig(name, stream string) ConsumerConfig {
	return ConsumerConfig{
		Name:          name,
		Stream:        stream,
		MaxDeliver:    5,
		AckWait:       30 * time.Second,
		MaxAckPending: 100,
		BackOff: []time.Duration{
			1 * time.Second,
			5 * time.Second,
			30 * time.Second,
			2 * time.Minute,
			10 * time.Minute,
		},
		BatchSize: 10,
	}
}

// PullConsumer manages a durable pull consumer.
type PullConsumer struct {
	consumer jetstream.Consumer
	cfg      ConsumerConfig
	logger   *zap.Logger
	metrics  *ConsumerMetrics
}

// NewPullConsumer creates or binds to a durable pull consumer.
func NewPullConsumer(ctx context.Context, js jetstream.JetStream, cfg ConsumerConfig, logger *zap.Logger) (*PullConsumer, error) {
	jsCfg := jetstream.ConsumerConfig{
		Name:           cfg.Name,
		Durable:        cfg.Name,
		FilterSubjects: cfg.FilterSubjects,
		AckPolicy:      jetstream.AckExplicitPolicy,
		AckWait:        cfg.AckWait,
		MaxDeliver:     cfg.MaxDeliver,
		MaxAckPending:  cfg.MaxAckPending,
		BackOff:        cfg.BackOff,
		DeliverPolicy:  jetstream.DeliverAllPolicy,
		ReplayPolicy:   jetstream.ReplayInstantPolicy,
		// Metadata for observability
		Description: fmt.Sprintf("Durable pull consumer: %s", cfg.Name),
	}

	stream, err := js.Stream(ctx, cfg.Stream)
	if err != nil {
		return nil, fmt.Errorf("getting stream %s: %w", cfg.Stream, err)
	}

	consumer, err := stream.CreateOrUpdateConsumer(ctx, jsCfg)
	if err != nil {
		return nil, fmt.Errorf("creating consumer %s: %w", cfg.Name, err)
	}

	info, _ := consumer.Info(ctx)
	logger.Info("consumer ready",
		zap.String("name", cfg.Name),
		zap.String("stream", cfg.Stream),
		zap.Uint64("num_pending", info.NumPending),
		zap.Int("num_waiting", info.NumWaiting),
	)

	return &PullConsumer{
		consumer: consumer,
		cfg:      cfg,
		logger:   logger,
		metrics:  NewConsumerMetrics(cfg.Name),
	}, nil
}

// MessageHandler processes a single message. Return error to nack.
type MessageHandler func(ctx context.Context, msg jetstream.Msg) error

// ProcessMessages runs a pull-based consumer loop.
func (c *PullConsumer) ProcessMessages(ctx context.Context, handler MessageHandler) error {
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		// Fetch batch of messages with timeout
		msgs, err := c.consumer.Fetch(c.cfg.BatchSize,
			jetstream.FetchMaxWait(2*time.Second),
		)
		if err != nil {
			if err == jetstream.ErrNoMessages || err == context.DeadlineExceeded {
				continue // No messages available, retry
			}
			c.logger.Warn("fetch error", zap.Error(err))
			// Brief backoff on connection errors
			select {
			case <-time.After(100 * time.Millisecond):
			case <-ctx.Done():
				return ctx.Err()
			}
			continue
		}

		for msg := range msgs.Messages() {
			c.processMessage(ctx, msg, handler)
		}

		if err := msgs.Error(); err != nil {
			c.logger.Warn("message batch error", zap.Error(err))
		}
	}
}

func (c *PullConsumer) processMessage(ctx context.Context, msg jetstream.Msg, handler MessageHandler) {
	start := time.Now()
	meta, _ := msg.Metadata()

	c.logger.Debug("processing message",
		zap.String("subject", msg.Subject()),
		zap.Uint64("seq", func() uint64 {
			if meta != nil { return meta.Sequence.Stream }
			return 0
		}()),
		zap.Uint64("delivered", func() uint64 {
			if meta != nil { return meta.NumDelivered }
			return 0
		}()),
	)

	// Create a timeout context for handler
	handlerCtx, cancel := context.WithTimeout(ctx, c.cfg.AckWait-2*time.Second)
	defer cancel()

	err := handler(handlerCtx, msg)
	duration := time.Since(start)
	c.metrics.ProcessingDuration.Observe(duration.Seconds())

	if err != nil {
		c.metrics.ErrorsTotal.Inc()
		c.logger.Warn("handler error, nacking",
			zap.Error(err),
			zap.String("subject", msg.Subject()),
			zap.Duration("duration", duration),
		)
		// Nack with delay — triggers backoff redelivery
		if err := msg.NakWithDelay(c.nextBackoff(meta)); err != nil {
			c.logger.Error("nack failed", zap.Error(err))
		}
		return
	}

	c.metrics.ProcessedTotal.Inc()
	if err := msg.Ack(); err != nil {
		c.logger.Error("ack failed", zap.Error(err))
	}
}

func (c *PullConsumer) nextBackoff(meta *jetstream.MsgMetadata) time.Duration {
	if meta == nil || len(c.cfg.BackOff) == 0 {
		return 5 * time.Second
	}
	idx := int(meta.NumDelivered) - 1
	if idx >= len(c.cfg.BackOff) {
		idx = len(c.cfg.BackOff) - 1
	}
	return c.cfg.BackOff[idx]
}
```

## Push Consumer (Event-Driven)

Push consumers are efficient for low-latency event-driven architectures:

```go
// pkg/messaging/push_consumer.go
package messaging

import (
	"context"
	"fmt"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	"go.uber.org/zap"
)

// PushConsumer subscribes to messages pushed by the server.
type PushConsumer struct {
	consumeCtx jetstream.ConsumeContext
	logger     *zap.Logger
}

// NewPushConsumer creates a push-based consumer with ordered delivery.
// Use for single-instance, low-latency scenarios.
func NewPushConsumer(ctx context.Context, js jetstream.JetStream, streamName, consumerName string, handler MessageHandler, logger *zap.Logger) (*PushConsumer, error) {
	stream, err := js.Stream(ctx, streamName)
	if err != nil {
		return nil, fmt.Errorf("getting stream: %w", err)
	}

	consumer, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Name:           consumerName,
		Durable:        consumerName,
		AckPolicy:      jetstream.AckExplicitPolicy,
		AckWait:        30 * time.Second,
		MaxAckPending:  100,
		MaxDeliver:     5,
		DeliverPolicy:  jetstream.DeliverAllPolicy,
		FilterSubject:  "orders.>",
	})
	if err != nil {
		return nil, fmt.Errorf("creating consumer: %w", err)
	}

	// Start consuming — messages are pushed via goroutine
	consumeCtx, err := consumer.Consume(func(msg jetstream.Msg) {
		if err := handler(ctx, msg); err != nil {
			logger.Error("handler error", zap.Error(err), zap.String("subject", msg.Subject()))
			_ = msg.NakWithDelay(5 * time.Second)
			return
		}
		_ = msg.Ack()
	},
		jetstream.ConsumeErrHandler(func(consumeCtx jetstream.ConsumeContext, err error) {
			logger.Error("consume error", zap.Error(err))
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("starting consume: %w", err)
	}

	logger.Info("push consumer started",
		zap.String("stream", streamName),
		zap.String("consumer", consumerName),
	)

	return &PushConsumer{consumeCtx: consumeCtx, logger: logger}, nil
}

// Stop stops the push consumer cleanly.
func (c *PushConsumer) Stop() {
	c.consumeCtx.Stop()
}
```

## Consumer Groups (Competing Consumers)

Multiple instances consuming from the same durable consumer form a consumer group — messages are distributed round-robin:

```go
// pkg/messaging/worker_pool.go
package messaging

import (
	"context"
	"fmt"
	"sync"

	"go.uber.org/zap"
	"golang.org/x/sync/errgroup"
)

// WorkerPool runs multiple pull consumer workers for parallel processing.
type WorkerPool struct {
	consumer *PullConsumer
	workers  int
	handler  MessageHandler
	logger   *zap.Logger
}

// NewWorkerPool creates a worker pool for parallel message processing.
// All workers bind to the SAME durable consumer — messages are distributed.
func NewWorkerPool(consumer *PullConsumer, workers int, handler MessageHandler, logger *zap.Logger) *WorkerPool {
	return &WorkerPool{
		consumer: consumer,
		workers:  workers,
		handler:  handler,
		logger:   logger,
	}
}

// Run starts all workers and blocks until context is cancelled.
func (p *WorkerPool) Run(ctx context.Context) error {
	g, ctx := errgroup.WithContext(ctx)

	for i := 0; i < p.workers; i++ {
		workerID := i
		g.Go(func() error {
			p.logger.Info("worker started", zap.Int("worker_id", workerID))
			err := p.consumer.ProcessMessages(ctx, p.handler)
			p.logger.Info("worker stopped", zap.Int("worker_id", workerID), zap.Error(err))
			if err == context.Canceled {
				return nil
			}
			return fmt.Errorf("worker %d: %w", workerID, err)
		})
	}

	return g.Wait()
}
```

### Using the Worker Pool

```go
// main.go excerpt
func setupOrderProcessor(ctx context.Context, client *messaging.Client, logger *zap.Logger) error {
	js := client.JetStream()
	sm := messaging.NewStreamManager(js, logger)

	// Ensure stream exists
	if _, err := messaging.SetupOrderProcessingStream(ctx, sm); err != nil {
		return err
	}

	// Create consumer config
	cfg := messaging.DefaultConsumerConfig("order-processor-group", "ORDERS")
	cfg.FilterSubjects = []string{"orders.created", "orders.updated"}
	cfg.BatchSize = 20

	consumer, err := messaging.NewPullConsumer(ctx, js, cfg, logger)
	if err != nil {
		return err
	}

	// Handler function
	handler := func(ctx context.Context, msg jetstream.Msg) error {
		var event messaging.OrderEvent
		if err := json.Unmarshal(msg.Data(), &event); err != nil {
			// Bad message format — ack to avoid requeue loop
			logger.Error("invalid message format", zap.Error(err))
			return nil // Ack bad messages to prevent infinite requeue
		}

		logger.Info("processing order",
			zap.String("order_id", event.OrderID),
			zap.String("event_type", event.EventType),
		)

		// Business logic here
		if err := processOrder(ctx, event); err != nil {
			// Return error to trigger backoff-based redelivery
			return fmt.Errorf("processing order %s: %w", event.OrderID, err)
		}

		return nil
	}

	// 5 parallel workers sharing the same consumer
	pool := messaging.NewWorkerPool(consumer, 5, handler, logger)
	return pool.Run(ctx)
}
```

## Key-Value Store (JetStream KV)

JetStream provides a key-value store built on top of streams:

```go
// pkg/messaging/kv.go
package messaging

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// KVStore wraps the JetStream KV bucket.
type KVStore struct {
	kv jetstream.KeyValue
}

// NewKVStore creates or binds to a KV bucket.
func NewKVStore(ctx context.Context, js jetstream.JetStream, bucket string, ttl time.Duration) (*KVStore, error) {
	kv, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
		Bucket:      bucket,
		Description: fmt.Sprintf("KV store: %s", bucket),
		TTL:         ttl,
		History:     5,          // Keep 5 versions per key
		MaxBytes:    512 * 1024 * 1024, // 512 MB
		Replicas:    3,
		Storage:     jetstream.FileStorage,
	})
	if err != nil {
		return nil, fmt.Errorf("creating KV bucket %s: %w", bucket, err)
	}
	return &KVStore{kv: kv}, nil
}

// SetJSON serializes a value and stores it with optimistic locking.
func (s *KVStore) SetJSON(ctx context.Context, key string, value interface{}) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshaling value: %w", err)
	}
	if _, err := s.kv.Put(ctx, key, data); err != nil {
		return fmt.Errorf("putting key %s: %w", key, err)
	}
	return nil
}

// GetJSON retrieves and deserializes a value.
func (s *KVStore) GetJSON(ctx context.Context, key string, dest interface{}) (uint64, error) {
	entry, err := s.kv.Get(ctx, key)
	if err != nil {
		if err == jetstream.ErrKeyNotFound {
			return 0, err
		}
		return 0, fmt.Errorf("getting key %s: %w", key, err)
	}
	if err := json.Unmarshal(entry.Value(), dest); err != nil {
		return 0, fmt.Errorf("unmarshaling value: %w", err)
	}
	return entry.Revision(), nil
}

// UpdateJSON updates a key with optimistic concurrency control.
func (s *KVStore) UpdateJSON(ctx context.Context, key string, value interface{}, lastRevision uint64) (uint64, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return 0, fmt.Errorf("marshaling value: %w", err)
	}
	rev, err := s.kv.Update(ctx, key, data, lastRevision)
	if err != nil {
		return 0, fmt.Errorf("updating key %s (revision conflict?): %w", key, err)
	}
	return rev, nil
}
```

## Prometheus Metrics

```go
// pkg/messaging/metrics.go
package messaging

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// ConsumerMetrics holds Prometheus metrics for a consumer.
type ConsumerMetrics struct {
	ProcessedTotal     prometheus.Counter
	ErrorsTotal        prometheus.Counter
	ProcessingDuration prometheus.Histogram
	PendingMessages    prometheus.Gauge
	RedeliveredTotal   prometheus.Counter
}

// NewConsumerMetrics creates Prometheus metrics for a consumer.
func NewConsumerMetrics(consumerName string) *ConsumerMetrics {
	labels := prometheus.Labels{"consumer": consumerName}
	return &ConsumerMetrics{
		ProcessedTotal: promauto.NewCounter(prometheus.CounterOpts{
			Name:        "nats_consumer_messages_processed_total",
			Help:        "Total messages successfully processed.",
			ConstLabels: labels,
		}),
		ErrorsTotal: promauto.NewCounter(prometheus.CounterOpts{
			Name:        "nats_consumer_errors_total",
			Help:        "Total message processing errors.",
			ConstLabels: labels,
		}),
		ProcessingDuration: promauto.NewHistogram(prometheus.HistogramOpts{
			Name:        "nats_consumer_processing_duration_seconds",
			Help:        "Time spent processing each message.",
			ConstLabels: labels,
			Buckets:     []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
		}),
		PendingMessages: promauto.NewGauge(prometheus.GaugeOpts{
			Name:        "nats_consumer_pending_messages",
			Help:        "Current number of pending messages in consumer.",
			ConstLabels: labels,
		}),
		RedeliveredTotal: promauto.NewCounter(prometheus.CounterOpts{
			Name:        "nats_consumer_redelivered_total",
			Help:        "Total redelivered messages (retries).",
			ConstLabels: labels,
		}),
	}
}

// Publisher metrics
var (
	PublishedTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "nats_publisher_messages_total",
		Help: "Total messages published.",
	}, []string{"subject", "status"})

	PublishDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "nats_publisher_duration_seconds",
		Help:    "Time to publish and receive ack.",
		Buckets: []float64{.0001, .0005, .001, .005, .01, .025, .05, .1},
	}, []string{"subject"})

	DuplicateMessages = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "nats_duplicate_messages_total",
		Help: "Total deduplicated messages rejected.",
	}, []string{"stream"})
)
```

## Dead Letter Queue Pattern

```go
// pkg/messaging/dlq.go
package messaging

import (
	"context"
	"fmt"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	"go.uber.org/zap"
)

// SetupDLQ creates a dead letter queue for messages that exceeded MaxDeliver.
// In NATS, configure the consumer to republish to a DLQ subject on final failure.
func SetupDLQ(ctx context.Context, js jetstream.JetStream, logger *zap.Logger) error {
	// Create DLQ stream
	_, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:        "ORDERS_DLQ",
		Description: "Dead letter queue for failed order messages",
		Subjects:    []string{"orders.dlq.>"},
		Retention:   jetstream.LimitsPolicy,
		MaxAge:      30 * 24 * time.Hour, // 30 days for investigation
		Replicas:    3,
		Storage:     jetstream.FileStorage,
	})
	if err != nil {
		return fmt.Errorf("creating DLQ stream: %w", err)
	}

	// Create consumer on main stream that uses DeadLetterSubject (NATS 2.10+)
	_, err = js.CreateOrUpdateConsumer(ctx, "ORDERS", jetstream.ConsumerConfig{
		Name:         "orders-processor-with-dlq",
		Durable:      "orders-processor-with-dlq",
		AckPolicy:    jetstream.AckExplicitPolicy,
		MaxDeliver:   5,
		AckWait:      30 * time.Second,
		BackOff:      []time.Duration{1 * time.Second, 5 * time.Second, 30 * time.Second, 2 * time.Minute},
	})
	if err != nil {
		return fmt.Errorf("creating consumer with DLQ: %w", err)
	}

	logger.Info("DLQ configured for ORDERS stream")
	return nil
}

// DLQProcessor processes dead letter messages for alerting and investigation.
func DLQProcessor(ctx context.Context, js jetstream.JetStream, logger *zap.Logger) error {
	stream, err := js.Stream(ctx, "ORDERS_DLQ")
	if err != nil {
		return err
	}

	consumer, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Name:         "dlq-monitor",
		Durable:      "dlq-monitor",
		AckPolicy:    jetstream.AckExplicitPolicy,
		DeliverPolicy: jetstream.DeliverAllPolicy,
	})
	if err != nil {
		return err
	}

	_, err = consumer.Consume(func(msg jetstream.Msg) {
		meta, _ := msg.Metadata()
		logger.Error("DLQ message",
			zap.String("subject", msg.Subject()),
			zap.Uint64("num_delivered", func() uint64 {
				if meta != nil { return meta.NumDelivered }
				return 0
			}()),
			zap.ByteString("data_preview", msg.Data()[:min(len(msg.Data()), 200)]),
		)
		// Alert to Slack/PagerDuty here
		// Store to investigation database
		_ = msg.Ack()
	})
	return err
}

func min(a, b int) int {
	if a < b { return a }
	return b
}
```

## Integration Testing

```go
// pkg/messaging/integration_test.go
//go:build integration
// +build integration

package messaging_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

func TestPublishAndConsume(t *testing.T) {
	logger := zaptest.NewLogger(t)
	client, err := messaging.NewClient(messaging.Config{
		URLs:    []string{"localhost:4222"},
		Timeout: 5 * time.Second,
	}, logger)
	require.NoError(t, err)
	defer client.Close()

	ctx := context.Background()
	js := client.JetStream()
	sm := messaging.NewStreamManager(js, logger)

	// Create test stream
	streamName := "TEST-" + t.Name()
	_, err = sm.EnsureStream(ctx, messaging.StreamConfig{
		Name:      streamName,
		Subjects:  []string{"test." + t.Name() + ".>"},
		MaxMsgs:   100,
		Retention: jetstream.WorkQueuePolicy,
		Replicas:  1,
	})
	require.NoError(t, err)
	defer js.DeleteStream(ctx, streamName)

	// Create consumer
	consumerCfg := messaging.DefaultConsumerConfig("test-consumer", streamName)
	consumerCfg.FilterSubjects = []string{"test." + t.Name() + ".created"}
	consumer, err := messaging.NewPullConsumer(ctx, js, consumerCfg, logger)
	require.NoError(t, err)

	// Publish message
	pub := messaging.NewPublisher(js, logger)
	event := messaging.OrderEvent{
		OrderID:   "TEST-001",
		EventType: "created",
		Timestamp: time.Now(),
		Data:      map[string]interface{}{"amount": 99.99},
	}
	err = pub.PublishOrder(ctx, event, messaging.PublishOptions{
		MsgID:          "test-unique-id-001",
		ExpectedStream: streamName,
	})
	require.NoError(t, err)

	// Consume and verify
	received := make(chan messaging.OrderEvent, 1)
	handlerCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	go func() {
		consumer.ProcessMessages(handlerCtx, func(ctx context.Context, msg jetstream.Msg) error {
			var e messaging.OrderEvent
			json.Unmarshal(msg.Data(), &e)
			received <- e
			return nil
		})
	}()

	select {
	case e := <-received:
		assert.Equal(t, "TEST-001", e.OrderID)
		assert.Equal(t, "created", e.EventType)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for message")
	}

	// Test deduplication — publish same MsgID again
	err = pub.PublishOrder(ctx, event, messaging.PublishOptions{
		MsgID:          "test-unique-id-001", // Same ID
		ExpectedStream: streamName,
	})
	require.NoError(t, err)

	// Verify no second message arrives
	select {
	case <-received:
		t.Fatal("duplicate message should not have been delivered")
	case <-time.After(2 * time.Second):
		// Correct: no duplicate
	}
}
```

## Key Takeaways

Production NATS JetStream usage in Go requires understanding the interplay between durability, ordering, and throughput:

1. **Durable consumers are non-negotiable in production**: Only durable consumers persist their position across restarts. Ephemeral consumers lose state and reprocess everything on reconnection.

2. **Message IDs for exactly-once publishing**: Set `Nats-Msg-Id` on every publish with a deterministic ID. The stream's deduplication window prevents double-processing on publisher retries.

3. **Pull consumers for backpressure-sensitive workloads**: Unlike Kafka where the broker controls flow, pull consumers let the Go application control how many messages it processes concurrently. Use `Fetch(batchSize)` to implement natural backpressure.

4. **BackOff configuration on consumers**: Without `BackOff`, a failing message redelivers at the `AckWait` interval — potentially flooding your handler. Configure exponential backoff to progressively back off failing messages.

5. **Worker pools share consumers automatically**: Multiple goroutines calling `Fetch()` on the same durable consumer create a natural consumer group — NATS distributes messages across all active fetchers.

6. **KV store for distributed state**: JetStream's KV with `Update(key, value, revision)` provides optimistic concurrency control, making it suitable for distributed leader election and configuration management.

7. **Monitor consumer lag**: `NumPending` in consumer info is the lag metric. Alert when it grows beyond expected thresholds to detect processing bottlenecks early.
