---
title: "Go Kafka Consumer Group Patterns: Offset Management, Rebalancing, and Error Recovery"
date: 2028-05-08T00:00:00-05:00
draft: false
tags: ["Go", "Kafka", "Consumer Groups", "Sarama", "franz-go", "Messaging"]
categories: ["Go", "Distributed Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kafka consumer group implementation in Go, covering offset management strategies, rebalance protocols, error recovery patterns, and production-ready consumer implementations using both Sarama and franz-go."
more_link: "yes"
url: "/go-kafka-consumer-group-patterns-guide/"
---

Kafka consumer groups are the foundation of scalable event-driven systems in Go, but getting them right in production requires understanding offset management semantics, partition rebalancing protocols, and error recovery strategies that go well beyond basic examples. A consumer that drops messages on rebalance, fails to commit offsets atomically with database writes, or doesn't handle partition revocation gracefully will cause exactly the class of subtle bugs that take days to diagnose. This guide covers production-ready consumer group patterns using both Sarama and franz-go.

<!--more-->

# Go Kafka Consumer Group Patterns: Offset Management, Rebalancing, and Error Recovery

## Kafka Consumer Groups: Core Concepts

A consumer group allows multiple consumers to coordinate the consumption of a topic. Kafka guarantees that each partition is assigned to at most one consumer in the group at any time. This provides horizontal scalability: add more consumers and Kafka rebalances partitions across them.

The critical concepts for production consumers:

- **Offset**: The sequential ID of the next message to consume in a partition
- **Committed offset**: The offset stored in Kafka (topic `__consumer_offsets`) representing processed-and-safe-to-move-past messages
- **Consumer lag**: Difference between the latest offset in a partition and the committed offset
- **Rebalance**: The process of redistributing partitions when consumers join or leave the group

The contract is: commit offsets only after you have durably processed the message. This determines at-least-once vs exactly-once semantics.

## Sarama Consumer Group Implementation

Sarama (github.com/IBM/sarama) is the most mature Kafka client for Go with extensive configurability.

### Setting Up the Consumer Group

```go
package consumer

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/IBM/sarama"
)

// Config holds the consumer configuration
type Config struct {
	Brokers         []string
	GroupID         string
	Topics          []string
	KafkaVersion    sarama.KafkaVersion
	ProcessTimeout  time.Duration
	MaxRetries      int
	InitialOffset   int64 // sarama.OffsetNewest or sarama.OffsetOldest
}

// MessageProcessor defines the interface for processing Kafka messages
type MessageProcessor interface {
	Process(ctx context.Context, msg *sarama.ConsumerMessage) error
}

// ConsumerGroup wraps sarama's ConsumerGroup with production patterns
type ConsumerGroup struct {
	client    sarama.ConsumerGroup
	config    Config
	processor MessageProcessor
	metrics   *ConsumerMetrics
}

func NewConsumerGroup(cfg Config, processor MessageProcessor) (*ConsumerGroup, error) {
	saramaConfig := sarama.NewConfig()

	saramaConfig.Version = cfg.KafkaVersion
	if saramaConfig.Version == (sarama.KafkaVersion{}) {
		saramaConfig.Version = sarama.V3_5_0_0
	}

	// Consumer group configuration
	saramaConfig.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{
		sarama.NewBalanceStrategyCooperativeSticky(),
	}
	saramaConfig.Consumer.Group.Session.Timeout = 45 * time.Second
	saramaConfig.Consumer.Group.Heartbeat.Interval = 3 * time.Second
	saramaConfig.Consumer.MaxProcessingTime = cfg.ProcessTimeout

	// Offset management
	saramaConfig.Consumer.Offsets.Initial = cfg.InitialOffset
	if saramaConfig.Consumer.Offsets.Initial == 0 {
		saramaConfig.Consumer.Offsets.Initial = sarama.OffsetNewest
	}
	saramaConfig.Consumer.Offsets.AutoCommit.Enable = false  // Manual commit
	saramaConfig.Consumer.Offsets.Retry.Max = 5

	// Fetch configuration
	saramaConfig.Consumer.Fetch.Min = 1
	saramaConfig.Consumer.Fetch.Default = 1024 * 1024  // 1MB
	saramaConfig.Consumer.Fetch.Max = 10 * 1024 * 1024 // 10MB

	// Network configuration
	saramaConfig.Net.DialTimeout = 10 * time.Second
	saramaConfig.Net.ReadTimeout = 30 * time.Second
	saramaConfig.Net.WriteTimeout = 30 * time.Second
	saramaConfig.Net.MaxOpenRequests = 5

	// TLS (enable for production)
	// saramaConfig.Net.TLS.Enable = true
	// saramaConfig.Net.TLS.Config = tlsConfig

	// SASL/SCRAM authentication
	// saramaConfig.Net.SASL.Enable = true
	// saramaConfig.Net.SASL.Mechanism = sarama.SASLTypeSCRAMSHA512
	// saramaConfig.Net.SASL.User = os.Getenv("KAFKA_SASL_USER")
	// saramaConfig.Net.SASL.Password = os.Getenv("KAFKA_SASL_PASSWORD")

	client, err := sarama.NewConsumerGroup(cfg.Brokers, cfg.GroupID, saramaConfig)
	if err != nil {
		return nil, fmt.Errorf("creating consumer group: %w", err)
	}

	return &ConsumerGroup{
		client:    client,
		config:    cfg,
		processor: processor,
		metrics:   NewConsumerMetrics(cfg.GroupID),
	}, nil
}

// Run starts consuming messages until ctx is cancelled
func (cg *ConsumerGroup) Run(ctx context.Context) error {
	handler := &consumerGroupHandler{
		processor: cg.processor,
		config:    cg.config,
		metrics:   cg.metrics,
	}

	for {
		// Consume handles the rebalance automatically
		// This function returns when a rebalance occurs or ctx is cancelled
		if err := cg.client.Consume(ctx, cg.config.Topics, handler); err != nil {
			if errors.Is(err, sarama.ErrClosedConsumerGroup) {
				return nil
			}
			if ctx.Err() != nil {
				return nil
			}
			slog.Error("consumer group error",
				"error", err,
				"group", cg.config.GroupID,
			)

			// Brief pause before retrying to avoid tight loop on persistent errors
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(5 * time.Second):
			}
		}

		if ctx.Err() != nil {
			return nil
		}

		slog.Info("consumer group rebalanced",
			"group", cg.config.GroupID,
			"topics", cg.config.Topics,
		)
	}
}

func (cg *ConsumerGroup) Close() error {
	return cg.client.Close()
}
```

### ConsumerGroupHandler with Offset Management

The handler implements sarama.ConsumerGroupHandler and is where the actual processing logic lives:

```go
// consumerGroupHandler implements sarama.ConsumerGroupHandler
type consumerGroupHandler struct {
	processor MessageProcessor
	config    Config
	metrics   *ConsumerMetrics
	// Track in-flight messages per partition
	sessions  sync.Map // partition -> *partitionSession
}

type partitionSession struct {
	topic     string
	partition int32
	pending   sync.Map // offset -> struct{}
	mu        sync.Mutex
	highwater int64 // highest successfully processed offset
}

// Setup is called at the beginning of a new consumer session
// after a rebalance, before any messages are consumed
func (h *consumerGroupHandler) Setup(session sarama.ConsumerGroupSession) error {
	slog.Info("consumer session setup",
		"member_id", session.MemberID(),
		"generation_id", session.GenerationID(),
		"claims", session.Claims(),
	)

	// Initialize per-partition state for this session
	for topic, partitions := range session.Claims() {
		for _, partition := range partitions {
			key := fmt.Sprintf("%s-%d", topic, partition)
			h.sessions.Store(key, &partitionSession{
				topic:     topic,
				partition: partition,
			})
			h.metrics.PartitionAssigned(topic, partition)
		}
	}

	return nil
}

// Cleanup is called at the end of a consumer session
// Called before partitions are rebalanced away
func (h *consumerGroupHandler) Cleanup(session sarama.ConsumerGroupSession) error {
	slog.Info("consumer session cleanup",
		"member_id", session.MemberID(),
		"generation_id", session.GenerationID(),
	)

	// Record final offsets for all assigned partitions
	session.Claims()
	for topic, partitions := range session.Claims() {
		for _, partition := range partitions {
			key := fmt.Sprintf("%s-%d", topic, partition)
			if val, ok := h.sessions.Load(key); ok {
				ps := val.(*partitionSession)
				h.metrics.PartitionRevoked(topic, partition, ps.highwater)
			}
			h.sessions.Delete(key)
		}
	}

	return nil
}

// ConsumeClaim is called once per partition and processes messages
// It runs in its own goroutine per partition
func (h *consumerGroupHandler) ConsumeClaim(
	session sarama.ConsumerGroupSession,
	claim sarama.ConsumerGroupClaim,
) error {
	topic := claim.Topic()
	partition := claim.Partition()
	key := fmt.Sprintf("%s-%d", topic, partition)

	slog.Info("consuming partition",
		"topic", topic,
		"partition", partition,
		"initial_offset", claim.InitialOffset(),
	)

	// Process messages with retry and error handling
	for {
		select {
		case msg, ok := <-claim.Messages():
			if !ok {
				// Channel closed — partition revoked
				return nil
			}

			if err := h.processWithRetry(session, msg); err != nil {
				slog.Error("message processing failed permanently",
					"topic", msg.Topic,
					"partition", msg.Partition,
					"offset", msg.Offset,
					"error", err,
				)
				// Dead letter queue the message
				h.deadLetter(msg, err)
				// Commit the offset so we don't reprocess
				session.MarkMessage(msg, "")
			}

			// Update highwater mark
			if val, ok := h.sessions.Load(key); ok {
				ps := val.(*partitionSession)
				ps.mu.Lock()
				if msg.Offset > ps.highwater {
					ps.highwater = msg.Offset
				}
				ps.mu.Unlock()
			}

			h.metrics.MessageProcessed(topic, partition)

		case <-session.Context().Done():
			return nil
		}
	}
}

func (h *consumerGroupHandler) processWithRetry(
	session sarama.ConsumerGroupSession,
	msg *sarama.ConsumerMessage,
) error {
	ctx := session.Context()

	var lastErr error
	for attempt := 0; attempt <= h.config.MaxRetries; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(attempt*attempt) * 100 * time.Millisecond
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}

			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
			}

			slog.Warn("retrying message processing",
				"topic", msg.Topic,
				"partition", msg.Partition,
				"offset", msg.Offset,
				"attempt", attempt,
				"error", lastErr,
			)
		}

		processCtx, cancel := context.WithTimeout(ctx, h.config.ProcessTimeout)
		err := h.processor.Process(processCtx, msg)
		cancel()

		if err == nil {
			// Success — mark the message for offset commit
			session.MarkMessage(msg, "")
			return nil
		}

		lastErr = err

		// Check if error is retryable
		if isNonRetryable(err) {
			return fmt.Errorf("non-retryable error: %w", err)
		}
	}

	return fmt.Errorf("max retries exceeded: %w", lastErr)
}

func (h *consumerGroupHandler) deadLetter(msg *sarama.ConsumerMessage, err error) {
	slog.Warn("sending message to dead letter queue",
		"topic", msg.Topic,
		"partition", msg.Partition,
		"offset", msg.Offset,
		"error", err,
	)
	// Implementation: publish to a dead letter topic
}

func isNonRetryable(err error) bool {
	// Business logic errors should not be retried
	var nonRetryable *NonRetryableError
	return errors.As(err, &nonRetryable)
}

type NonRetryableError struct {
	Message string
}

func (e *NonRetryableError) Error() string {
	return e.Message
}
```

## franz-go: Modern Kafka Client

franz-go (github.com/twmb/franz-go) is a more modern Kafka client with a cleaner API, better performance, and first-class support for Kafka's newer cooperative sticky rebalancing protocol.

### franz-go Consumer Group

```go
package franzgo

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/sasl/scram"
)

type FranzConsumerConfig struct {
	Brokers    []string
	GroupID    string
	Topics     []string
	SASL       *SASLConfig
	TLS        bool
	MaxPollRecords int
}

type SASLConfig struct {
	Username  string
	Password  string
	Mechanism string // "SCRAM-SHA-512" or "SCRAM-SHA-256"
}

// Handler is called with each batch of records from a partition
type Handler func(ctx context.Context, records []*kgo.Record) error

// FranzConsumer provides a production-ready franz-go consumer
type FranzConsumer struct {
	client  *kgo.Client
	handler Handler
	config  FranzConsumerConfig
}

func NewFranzConsumer(cfg FranzConsumerConfig, handler Handler) (*FranzConsumer, error) {
	opts := []kgo.Opt{
		kgo.SeedBrokers(cfg.Brokers...),
		kgo.ConsumerGroup(cfg.GroupID),
		kgo.ConsumeTopics(cfg.Topics...),

		// Use cooperative-sticky rebalancing (KAFKA-8179)
		// This minimizes partition movement during rebalances
		kgo.Balancers(kgo.CooperativeStickyBalancer()),

		// Disable autocommit — we commit manually after processing
		kgo.DisableAutoCommit(),

		// Fetch configuration
		kgo.FetchMinBytes(1),
		kgo.FetchMaxBytes(50 * 1024 * 1024), // 50MB
		kgo.FetchMaxWait(500 * time.Millisecond),

		// Session management
		kgo.SessionTimeout(45 * time.Second),
		kgo.HeartbeatInterval(3 * time.Second),
		kgo.RebalanceTimeout(60 * time.Second),

		// Retry configuration
		kgo.RetryBackoffFn(func(tries int) time.Duration {
			if tries >= 10 {
				return 30 * time.Second
			}
			return time.Duration(tries*tries*100) * time.Millisecond
		}),

		// Hook for observability
		kgo.WithHooks(&consumerHooks{}),
	}

	if cfg.SASL != nil {
		var saslMechanism kgo.SASLMechanism
		switch cfg.SASL.Mechanism {
		case "SCRAM-SHA-512":
			saslMechanism = scram.Auth{
				User: cfg.SASL.Username,
				Pass: cfg.SASL.Password,
			}.AsSha512Mechanism()
		case "SCRAM-SHA-256":
			saslMechanism = scram.Auth{
				User: cfg.SASL.Username,
				Pass: cfg.SASL.Password,
			}.AsSha256Mechanism()
		default:
			return nil, fmt.Errorf("unsupported SASL mechanism: %s", cfg.SASL.Mechanism)
		}
		opts = append(opts, kgo.SASL(saslMechanism))
	}

	if cfg.TLS {
		opts = append(opts, kgo.DialTLS())
	}

	client, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, fmt.Errorf("creating franz-go client: %w", err)
	}

	return &FranzConsumer{
		client:  client,
		handler: handler,
		config:  cfg,
	}, nil
}

// Run processes messages until ctx is cancelled
func (c *FranzConsumer) Run(ctx context.Context) error {
	defer c.client.Close()

	for {
		// PollRecords fetches up to MaxPollRecords from all assigned partitions
		fetches := c.client.PollRecords(ctx, c.config.MaxPollRecords)

		if fetches.IsClientClosed() {
			return nil
		}

		if ctx.Err() != nil {
			return nil
		}

		// Handle fetch-level errors (e.g., broker unavailable)
		if errs := fetches.Errors(); len(errs) > 0 {
			for _, fetchErr := range errs {
				slog.Error("fetch error",
					"topic", fetchErr.Topic,
					"partition", fetchErr.Partition,
					"error", fetchErr.Err,
				)
				if kgo.IsRetriable(fetchErr.Err) {
					continue // Will retry on next poll
				}
				return fmt.Errorf("non-retryable fetch error on %s/%d: %w",
					fetchErr.Topic, fetchErr.Partition, fetchErr.Err)
			}
		}

		// Process records partition-by-partition for ordered processing
		// Use EachPartition to get records grouped by partition
		if err := c.processPartitionBatches(ctx, fetches); err != nil {
			return err
		}

		// Commit offsets after all processing is complete
		if err := c.commitOffsets(ctx); err != nil {
			slog.Error("offset commit failed", "error", err)
			// Don't return — we processed the messages, retry commit on next cycle
		}
	}
}

func (c *FranzConsumer) processPartitionBatches(ctx context.Context, fetches kgo.Fetches) error {
	var processingError error

	fetches.EachPartition(func(p kgo.FetchTopicPartition) {
		if processingError != nil {
			return // Skip further processing if we had an error
		}

		if len(p.Records) == 0 {
			return
		}

		slog.Debug("processing partition batch",
			"topic", p.Topic,
			"partition", p.Partition,
			"records", len(p.Records),
			"first_offset", p.Records[0].Offset,
			"last_offset", p.Records[len(p.Records)-1].Offset,
		)

		if err := c.handler(ctx, p.Records); err != nil {
			slog.Error("handler failed",
				"topic", p.Topic,
				"partition", p.Partition,
				"error", err,
			)
			processingError = err
		}
	})

	return processingError
}

func (c *FranzConsumer) commitOffsets(ctx context.Context) error {
	commitCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	return c.client.CommitUncommittedOffsets(commitCtx)
}

// consumerHooks implements kgo.HookPollRecordsFetched and other hooks for observability
type consumerHooks struct{}

func (h *consumerHooks) OnBrokerConnect(meta kgo.BrokerMetadata, dialDur time.Duration, conn interface{}, err error) {
	if err != nil {
		slog.Warn("broker connect failed",
			"broker", meta.NodeID,
			"host", meta.Host,
			"error", err,
		)
	}
}

func (h *consumerHooks) OnBrokerDisconnect(meta kgo.BrokerMetadata, conn interface{}) {
	slog.Info("broker disconnected",
		"broker", meta.NodeID,
		"host", meta.Host,
	)
}
```

## Exactly-Once Semantics with Transactional Commits

For use cases requiring exactly-once processing, commit offsets atomically with the processing result using database transactions:

```go
package exactlyonce

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/IBM/sarama"
)

// TransactionalProcessor processes messages with exactly-once semantics
// by committing offsets atomically with database writes
type TransactionalProcessor struct {
	db          *sql.DB
	offsetTable string
	groupID     string
}

// ProcessWithTransaction executes fn within a database transaction,
// committing the Kafka offset atomically with the database changes
func (p *TransactionalProcessor) ProcessWithTransaction(
	ctx context.Context,
	session sarama.ConsumerGroupSession,
	msg *sarama.ConsumerMessage,
	fn func(tx *sql.Tx) error,
) error {
	tx, err := p.db.BeginTx(ctx, &sql.TxOptions{
		Isolation: sql.LevelReadCommitted,
	})
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}

	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()

	// Check if this offset was already processed (idempotency)
	var processed bool
	err = tx.QueryRowContext(ctx,
		"SELECT EXISTS(SELECT 1 FROM kafka_offsets WHERE group_id=$1 AND topic=$2 AND partition=$3 AND offset_val>=$4)",
		p.groupID, msg.Topic, msg.Partition, msg.Offset,
	).Scan(&processed)
	if err != nil {
		return fmt.Errorf("checking offset: %w", err)
	}

	if processed {
		// Already processed — mark in Kafka and skip
		session.MarkMessage(msg, "")
		return tx.Commit()
	}

	// Execute the business logic
	if err = fn(tx); err != nil {
		return fmt.Errorf("processing message: %w", err)
	}

	// Record the offset in the same transaction
	_, err = tx.ExecContext(ctx,
		`INSERT INTO kafka_offsets (group_id, topic, partition, offset_val, processed_at)
		 VALUES ($1, $2, $3, $4, NOW())
		 ON CONFLICT (group_id, topic, partition)
		 DO UPDATE SET offset_val = $4, processed_at = NOW()
		 WHERE kafka_offsets.offset_val < $4`,
		p.groupID, msg.Topic, msg.Partition, msg.Offset,
	)
	if err != nil {
		return fmt.Errorf("recording offset: %w", err)
	}

	// Commit transaction
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("committing transaction: %w", err)
	}

	// Mark Kafka offset — this may fail but the database commit already happened
	// On next consumer startup, the database offset check will skip this message
	session.MarkMessage(msg, "")

	return nil
}

// Schema for the offset tracking table:
// CREATE TABLE kafka_offsets (
//   group_id    VARCHAR(255) NOT NULL,
//   topic       VARCHAR(255) NOT NULL,
//   partition   INTEGER NOT NULL,
//   offset_val  BIGINT NOT NULL,
//   processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
//   PRIMARY KEY (group_id, topic, partition)
// );
```

## Parallel Processing with Ordered Partitions

Process messages concurrently across partitions while maintaining per-partition order:

```go
package parallel

import (
	"context"
	"log/slog"
	"sync"

	"github.com/IBM/sarama"
)

// ParallelHandler processes partitions concurrently
// Messages within a partition are processed in order
type ParallelHandler struct {
	processor MessageProcessor
	config    Config
	workers   sync.Map // partition key -> worker chan
}

type partitionWorker struct {
	messages chan *sarama.ConsumerMessage
	session  sarama.ConsumerGroupSession
	done     chan struct{}
}

func (h *ParallelHandler) Setup(session sarama.ConsumerGroupSession) error {
	return nil
}

func (h *ParallelHandler) Cleanup(session sarama.ConsumerGroupSession) error {
	// Wait for all partition workers to drain
	h.workers.Range(func(key, value interface{}) bool {
		worker := value.(*partitionWorker)
		close(worker.messages)
		<-worker.done
		h.workers.Delete(key)
		return true
	})
	return nil
}

func (h *ParallelHandler) ConsumeClaim(
	session sarama.ConsumerGroupSession,
	claim sarama.ConsumerGroupClaim,
) error {
	key := fmt.Sprintf("%s-%d", claim.Topic(), claim.Partition())

	worker := &partitionWorker{
		messages: make(chan *sarama.ConsumerMessage, 100),
		session:  session,
		done:     make(chan struct{}),
	}

	h.workers.Store(key, worker)

	// Start partition worker goroutine
	go worker.run(session.Context(), h.processor, h.config)

	// Feed messages to worker
	for {
		select {
		case msg, ok := <-claim.Messages():
			if !ok {
				return nil
			}
			select {
			case worker.messages <- msg:
			case <-session.Context().Done():
				return nil
			}

		case <-session.Context().Done():
			return nil
		}
	}
}

func (w *partitionWorker) run(
	ctx context.Context,
	processor MessageProcessor,
	config Config,
) {
	defer close(w.done)

	for msg := range w.messages {
		if err := processor.Process(ctx, msg); err != nil {
			slog.Error("processing failed",
				"topic", msg.Topic,
				"partition", msg.Partition,
				"offset", msg.Offset,
				"error", err,
			)
			// Dead letter and mark regardless
		}
		w.session.MarkMessage(msg, "")
	}
}
```

## Consumer Lag Monitoring

Monitoring consumer lag is critical for detecting processing bottlenecks:

```go
package monitoring

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/IBM/sarama"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	consumerLag = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Namespace: "kafka",
			Subsystem: "consumer",
			Name:      "lag",
			Help:      "Current consumer lag by topic and partition",
		},
		[]string{"group", "topic", "partition"},
	)

	consumerLagSum = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Namespace: "kafka",
			Subsystem: "consumer",
			Name:      "lag_sum",
			Help:      "Total consumer lag across all partitions for a topic",
		},
		[]string{"group", "topic"},
	)
)

// LagMonitor continuously monitors consumer group lag
type LagMonitor struct {
	admin   sarama.ClusterAdmin
	client  sarama.Client
	groupID string
	topics  []string
}

func NewLagMonitor(brokers []string, groupID string, topics []string) (*LagMonitor, error) {
	config := sarama.NewConfig()
	config.Version = sarama.V3_5_0_0

	client, err := sarama.NewClient(brokers, config)
	if err != nil {
		return nil, fmt.Errorf("creating Sarama client: %w", err)
	}

	admin, err := sarama.NewClusterAdminFromClient(client)
	if err != nil {
		client.Close()
		return nil, fmt.Errorf("creating cluster admin: %w", err)
	}

	return &LagMonitor{
		admin:   admin,
		client:  client,
		groupID: groupID,
		topics:  topics,
	}, nil
}

// Run periodically collects and exports consumer lag metrics
func (m *LagMonitor) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := m.collectLag(); err != nil {
				slog.Warn("failed to collect consumer lag", "error", err)
			}
		}
	}
}

func (m *LagMonitor) collectLag() error {
	// Get current consumer group offsets
	groupOffsets, err := m.admin.ListConsumerGroupOffsets(m.groupID, nil)
	if err != nil {
		return fmt.Errorf("listing consumer group offsets: %w", err)
	}

	for _, topic := range m.topics {
		partitionOffsets, ok := groupOffsets.Blocks[topic]
		if !ok {
			continue
		}

		var topicLag int64

		for partition, block := range partitionOffsets {
			if block.Err != nil {
				continue
			}

			// Get the latest offset for this partition
			latestOffset, err := m.client.GetOffset(topic, partition, sarama.OffsetNewest)
			if err != nil {
				slog.Warn("failed to get partition offset",
					"topic", topic,
					"partition", partition,
					"error", err,
				)
				continue
			}

			committedOffset := block.Offset
			lag := latestOffset - committedOffset
			if lag < 0 {
				lag = 0
			}

			consumerLag.WithLabelValues(
				m.groupID,
				topic,
				fmt.Sprintf("%d", partition),
			).Set(float64(lag))

			topicLag += lag
		}

		consumerLagSum.WithLabelValues(m.groupID, topic).Set(float64(topicLag))

		if topicLag > 10000 {
			slog.Warn("high consumer lag detected",
				"group", m.groupID,
				"topic", topic,
				"lag", topicLag,
			)
		}
	}

	return nil
}
```

## Graceful Shutdown

Proper shutdown ensures in-flight messages are processed and offsets are committed:

```go
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	// Setup consumer...
	consumer, err := consumer.NewConsumerGroup(cfg, processor)
	if err != nil {
		slog.Error("failed to create consumer", "error", err)
		os.Exit(1)
	}

	// Create context that cancels on shutdown signals
	ctx, cancel := signal.NotifyContext(context.Background(),
		syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// Run consumer in background
	doneCh := make(chan error, 1)
	go func() {
		doneCh <- consumer.Run(ctx)
	}()

	// Wait for shutdown
	select {
	case err := <-doneCh:
		if err != nil {
			slog.Error("consumer exited with error", "error", err)
			os.Exit(1)
		}
		slog.Info("consumer exited cleanly")

	case <-ctx.Done():
		slog.Info("shutdown signal received, draining consumer")

		// Give the consumer time to finish in-flight processing
		drainTimeout := 30 * time.Second
		drainCtx, drainCancel := context.WithTimeout(
			context.Background(), drainTimeout)
		defer drainCancel()

		// Wait for consumer to finish
		select {
		case err := <-doneCh:
			if err != nil {
				slog.Error("consumer error during drain", "error", err)
			} else {
				slog.Info("consumer drained cleanly")
			}
		case <-drainCtx.Done():
			slog.Warn("drain timeout exceeded, forcing shutdown")
		}
	}

	if err := consumer.Close(); err != nil {
		slog.Error("error closing consumer", "error", err)
	}
}
```

## Cooperative Sticky Rebalancing

The cooperative sticky rebalancing protocol (KAFKA-8179) reduces disruption during rebalances by only revoking partitions that need to move, rather than revoking all partitions:

```go
// Sarama: use NewBalanceStrategyCooperativeSticky
saramaConfig.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{
	sarama.NewBalanceStrategyCooperativeSticky(),
}

// franz-go: use CooperativeStickyBalancer
opts = append(opts, kgo.Balancers(kgo.CooperativeStickyBalancer()))

// NOTE: All consumers in a group must use the same rebalance strategy
// When migrating from eager to cooperative rebalancing, use a rolling migration:
// 1. Deploy half the consumers with cooperative balancer + "RoundRobin" as fallback
// 2. Verify the new consumers join the group
// 3. Deploy remaining consumers with only cooperative balancer
```

## Testing Consumer Groups

```go
package consumer_test

import (
	"context"
	"testing"
	"time"

	"github.com/IBM/sarama"
	"github.com/IBM/sarama/mocks"
)

func TestConsumerGroupHandler_ProcessesMessages(t *testing.T) {
	// Use sarama's mock consumer for unit testing
	consumer := mocks.NewConsumer(t, nil)
	defer consumer.Close()

	// Set up mock partition consumer
	consumer.ExpectConsumePartition("my-topic", 0, sarama.OffsetNewest).
		YieldMessage(&sarama.ConsumerMessage{
			Topic:     "my-topic",
			Partition: 0,
			Offset:    0,
			Value:     []byte(`{"id": "test-123", "action": "create"}`),
		})

	// Test integration with testcontainers-go for real Kafka
	// ctx := context.Background()
	// container, err := kafkacontainer.RunContainer(ctx, ...)
}
```

## Conclusion

Production Kafka consumer groups in Go require careful attention to offset management semantics, rebalance protocol selection, and error recovery patterns. The choice between at-least-once and exactly-once semantics determines your architecture: at-least-once is simpler and sufficient when processing is idempotent, while exactly-once requires transactional commits that atomically record processing results and offsets.

Cooperative sticky rebalancing is the right default for most use cases — it reduces disruption and improves availability during rolling deployments. Manual offset commits with proper retry logic and dead-lettering ensure that processing failures don't cause unbounded reprocessing or message loss. Monitor consumer lag as your primary operational metric; sustained lag indicates your consumers can't keep up with the producer rate and is the first sign of capacity issues.
