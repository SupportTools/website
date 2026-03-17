---
title: "Go Kafka Consumer Groups: Partition Assignment and Lag Monitoring"
date: 2029-08-28T00:00:00-05:00
draft: false
tags: ["Go", "Kafka", "Consumer Groups", "Prometheus", "Observability", "sarama", "confluent-kafka-go"]
categories: ["Go", "Kafka", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into Kafka consumer groups in Go covering sarama vs confluent-kafka-go library selection, consumer group rebalance protocols, partition assignment strategies, lag monitoring with Prometheus, and exactly-once semantics implementation."
more_link: "yes"
url: "/go-kafka-consumer-groups-partition-assignment-lag-monitoring/"
---

Kafka consumer groups are deceptively simple in concept but demanding in practice. Partition rebalancing, lag accumulation, offset management, and exactly-once delivery guarantees each introduce subtle failure modes that manifest under production load. This guide covers the full operational picture of Kafka consumer groups in Go, from library selection through production-grade lag monitoring.

<!--more-->

# Go Kafka Consumer Groups: Partition Assignment and Lag Monitoring

## Section 1: Library Selection — sarama vs confluent-kafka-go

The two dominant Kafka client libraries for Go are Shopify's `sarama` and Confluent's `confluent-kafka-go`. Each has distinct trade-offs that affect architecture decisions.

### sarama

`sarama` is a pure Go implementation. It has no CGO dependency and compiles to a single static binary, making it ideal for minimal container images and cross-compilation. The library exposes fine-grained control over the protocol, which is valuable for building administrative tooling or custom offset management.

```go
// go.mod
module github.com/myorg/consumer

go 1.22

require (
    github.com/IBM/sarama v1.43.0  // IBM fork of the original shopify/sarama
    github.com/prometheus/client_golang v1.19.0
    go.uber.org/zap v1.27.0
)
```

**Strengths**: Static binary, pure Go, rich administrative API, active IBM maintenance.
**Weaknesses**: Higher CPU overhead for TLS, lacks native librdkafka optimizations, complex configuration surface.

### confluent-kafka-go

`confluent-kafka-go` wraps the `librdkafka` C library via CGO. This gives it excellent throughput characteristics and automatic support for every Kafka protocol feature as soon as librdkafka adds it.

```go
// go.mod (confluent)
module github.com/myorg/consumer

go 1.22

require (
    github.com/confluentinc/confluent-kafka-go/v2 v2.5.0
    github.com/prometheus/client_golang v1.19.0
)
```

**Strengths**: Best-in-class throughput, librdkafka feature parity, Confluent Schema Registry integration, production proven at Confluent scale.
**Weaknesses**: CGO dependency breaks static builds, larger binary/image footprint, requires librdkafka shared library in container.

### Decision Matrix

| Criteria | sarama | confluent-kafka-go |
|---|---|---|
| Static binary | Yes | No (CGO) |
| Cross-compilation | Yes | Limited |
| Throughput | Good | Excellent |
| TLS overhead | Higher | Lower |
| Schema Registry | Community library | Official support |
| Admin API | Comprehensive | Good |
| Exactly-once | Manual | Native |
| Container size | Small | Larger |

For most enterprise Go services, `sarama` is the right default choice. Use `confluent-kafka-go` when you need Schema Registry integration, maximum throughput, or are already using the Confluent Platform.

## Section 2: Consumer Group Protocol

### How Kafka Consumer Groups Work

When a consumer group starts, one consumer is elected as the **group coordinator**. The coordinator manages group membership and triggers rebalances when members join, leave, or heartbeat timeouts occur.

The rebalance protocol has two phases:
1. **JoinGroup**: All members report their subscribed topics. The coordinator elects a leader and sends the full membership list.
2. **SyncGroup**: The leader runs the partition assignment algorithm and sends assignments to the coordinator, which distributes them to all members.

```
Consumer A            Consumer B            Coordinator (Broker)
    |                     |                        |
    |--- JoinGroup ------->|                        |
    |                     |--- JoinGroup ---------->|
    |                     |                        |
    |<-- JoinGroup Resp (leader) ------------------|
    |<-- JoinGroup Resp --|                        |
    |                     |                        |
    |--- SyncGroup (assignments) ----------------->|
    |                     |--- SyncGroup ---------->|
    |                     |                        |
    |<-- SyncGroup Resp (partitions) --------------|
    |<-- SyncGroup Resp --|                        |
```

### Partition Assignment Strategies

Kafka supports three built-in partition assignment strategies:

- **Range**: Assigns consecutive partition ranges to consumers, sorted by consumer ID. Can lead to uneven distribution.
- **RoundRobin**: Distributes partitions evenly across consumers. Better balance for equal-weight consumers.
- **Sticky**: Minimizes partition movement during rebalances by retaining existing assignments where possible. Ideal for stateful consumers.
- **CooperativeSticky** (incremental rebalancing): Avoids the "stop the world" rebalance by allowing consumers to continue processing unaffected partitions during rebalance.

## Section 3: sarama Consumer Group Implementation

### Production-Ready Consumer Group

```go
// consumer/consumer.go
package consumer

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/IBM/sarama"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "go.uber.org/zap"
)

var (
    messagesProcessed = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "kafka_consumer_messages_processed_total",
            Help: "Total number of Kafka messages processed",
        },
        []string{"topic", "partition", "status"},
    )

    messageProcessingDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "kafka_consumer_message_processing_duration_seconds",
            Help:    "Duration of message processing",
            Buckets: prometheus.ExponentialBuckets(0.001, 2, 15),
        },
        []string{"topic"},
    )

    rebalanceTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "kafka_consumer_rebalance_total",
            Help: "Total number of consumer group rebalances",
        },
        []string{"group", "type"},
    )

    partitionsAssigned = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "kafka_consumer_partitions_assigned",
            Help: "Number of partitions currently assigned to this consumer",
        },
        []string{"group", "topic"},
    )
)

// MessageHandler is a function type that processes a single Kafka message.
type MessageHandler func(ctx context.Context, msg *sarama.ConsumerMessage) error

// Config holds consumer group configuration.
type Config struct {
    Brokers          []string
    GroupID          string
    Topics           []string
    KafkaVersion     sarama.KafkaVersion
    InitialOffset    int64 // sarama.OffsetNewest or sarama.OffsetOldest
    MaxRetries       int
    RetryBackoff     time.Duration
    SessionTimeout   time.Duration
    HeartbeatTimeout time.Duration
    // RebalanceStrategy: "sticky", "roundrobin", "range", "cooperative-sticky"
    RebalanceStrategy string
    TLSEnabled       bool
    SASLEnabled      bool
    SASLUser         string
    SASLPasswordRef  string // Secret reference, not plaintext
}

// Consumer wraps a sarama ConsumerGroup with production features.
type Consumer struct {
    client  sarama.ConsumerGroup
    config  Config
    handler MessageHandler
    logger  *zap.Logger
    wg      sync.WaitGroup
    cancel  context.CancelFunc
}

// New creates a new Consumer.
func New(cfg Config, handler MessageHandler, logger *zap.Logger) (*Consumer, error) {
    saramaConfig, err := buildSaramaConfig(cfg)
    if err != nil {
        return nil, fmt.Errorf("building sarama config: %w", err)
    }

    client, err := sarama.NewConsumerGroup(cfg.Brokers, cfg.GroupID, saramaConfig)
    if err != nil {
        return nil, fmt.Errorf("creating consumer group: %w", err)
    }

    return &Consumer{
        client:  client,
        config:  cfg,
        handler: handler,
        logger:  logger,
    }, nil
}

func buildSaramaConfig(cfg Config) (*sarama.Config, error) {
    c := sarama.NewConfig()
    c.Version = cfg.KafkaVersion
    if c.Version == (sarama.KafkaVersion{}) {
        c.Version = sarama.V3_6_0_0
    }

    // Consumer group settings
    c.Consumer.Group.Session.Timeout = cfg.SessionTimeout
    if c.Consumer.Group.Session.Timeout == 0 {
        c.Consumer.Group.Session.Timeout = 30 * time.Second
    }
    c.Consumer.Group.Heartbeat.Interval = cfg.HeartbeatTimeout
    if c.Consumer.Group.Heartbeat.Interval == 0 {
        c.Consumer.Group.Heartbeat.Interval = 10 * time.Second
    }

    // Partition assignment strategy
    switch cfg.RebalanceStrategy {
    case "sticky":
        c.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{
            sarama.NewBalanceStrategySticky(),
        }
    case "roundrobin":
        c.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{
            sarama.NewBalanceStrategyRoundRobin(),
        }
    case "range", "":
        c.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{
            sarama.NewBalanceStrategyRange(),
        }
    default:
        return nil, fmt.Errorf("unknown rebalance strategy: %s", cfg.RebalanceStrategy)
    }

    // Offset management
    c.Consumer.Offsets.Initial = cfg.InitialOffset
    if c.Consumer.Offsets.Initial == 0 {
        c.Consumer.Offsets.Initial = sarama.OffsetNewest
    }
    c.Consumer.Offsets.AutoCommit.Enable = false // We commit manually for reliability
    c.Consumer.Offsets.Retry.Max = 3

    // Fetch settings
    c.Consumer.Fetch.Default = 1024 * 1024  // 1 MiB
    c.Consumer.Fetch.Max = 10 * 1024 * 1024 // 10 MiB
    c.Consumer.MaxWaitTime = 500 * time.Millisecond
    c.Consumer.MaxProcessingTime = 100 * time.Millisecond

    // Return errors to the Errors channel
    c.Consumer.Return.Errors = true

    return c, nil
}

// Start begins consuming messages from the configured topics.
func (c *Consumer) Start(ctx context.Context) {
    ctx, c.cancel = context.WithCancel(ctx)
    handler := &groupHandler{
        consumer: c,
        logger:   c.logger,
    }

    c.wg.Add(1)
    go func() {
        defer c.wg.Done()
        for {
            if ctx.Err() != nil {
                return
            }
            if err := c.client.Consume(ctx, c.config.Topics, handler); err != nil {
                if ctx.Err() != nil {
                    return
                }
                c.logger.Error("Consumer group error, restarting",
                    zap.Error(err),
                    zap.String("group", c.config.GroupID),
                )
                // Backoff before restarting
                select {
                case <-time.After(5 * time.Second):
                case <-ctx.Done():
                    return
                }
            }
        }
    }()

    // Handle errors from the consumer group
    c.wg.Add(1)
    go func() {
        defer c.wg.Done()
        for {
            select {
            case err, ok := <-c.client.Errors():
                if !ok {
                    return
                }
                c.logger.Error("Kafka consumer error",
                    zap.Error(err),
                    zap.String("group", c.config.GroupID),
                )
            case <-ctx.Done():
                return
            }
        }
    }()
}

// Stop gracefully shuts down the consumer.
func (c *Consumer) Stop() error {
    c.cancel()
    c.wg.Wait()
    return c.client.Close()
}

// groupHandler implements sarama.ConsumerGroupHandler.
type groupHandler struct {
    consumer *Consumer
    logger   *zap.Logger
    session  sarama.ConsumerGroupSession
    mu       sync.RWMutex
}

// Setup is called at the beginning of a new session, before ConsumeClaim.
func (h *groupHandler) Setup(session sarama.ConsumerGroupSession) error {
    h.mu.Lock()
    h.session = session
    h.mu.Unlock()

    rebalanceTotal.WithLabelValues(h.consumer.config.GroupID, "setup").Inc()

    // Log and track partition assignments
    for topic, partitions := range session.Claims() {
        h.logger.Info("Partitions assigned",
            zap.String("topic", topic),
            zap.Int32s("partitions", partitions),
            zap.String("member_id", session.MemberID()),
        )
        partitionsAssigned.WithLabelValues(
            h.consumer.config.GroupID, topic,
        ).Set(float64(len(partitions)))
    }
    return nil
}

// Cleanup is called at the end of a session, once all ConsumeClaim goroutines have exited.
func (h *groupHandler) Cleanup(session sarama.ConsumerGroupSession) error {
    rebalanceTotal.WithLabelValues(h.consumer.config.GroupID, "cleanup").Inc()

    for topic := range session.Claims() {
        partitionsAssigned.WithLabelValues(
            h.consumer.config.GroupID, topic,
        ).Set(0)
    }
    return nil
}

// ConsumeClaim starts a consumer loop of ConsumerGroupClaim's Messages().
func (h *groupHandler) ConsumeClaim(
    session sarama.ConsumerGroupSession,
    claim sarama.ConsumerGroupClaim,
) error {
    topic := claim.Topic()
    partition := claim.Partition()

    h.logger.Info("Starting to consume",
        zap.String("topic", topic),
        zap.Int32("partition", partition),
        zap.Int64("initial_offset", claim.InitialOffset()),
    )

    for {
        select {
        case msg, ok := <-claim.Messages():
            if !ok {
                h.logger.Info("Message channel closed",
                    zap.String("topic", topic),
                    zap.Int32("partition", partition),
                )
                return nil
            }
            if err := h.processMessage(session, msg); err != nil {
                h.logger.Error("Failed to process message",
                    zap.Error(err),
                    zap.String("topic", topic),
                    zap.Int32("partition", partition),
                    zap.Int64("offset", msg.Offset),
                )
                // Decision: continue (at-least-once) or return error (stop partition)
                // For idempotent handlers, continue; for critical failures, return error.
                messagesProcessed.WithLabelValues(topic, fmt.Sprintf("%d", partition), "error").Inc()
                continue
            }

            // Mark the message as processed (manual commit)
            session.MarkMessage(msg, "")
            messagesProcessed.WithLabelValues(topic, fmt.Sprintf("%d", partition), "success").Inc()

        case <-session.Context().Done():
            return nil
        }
    }
}

func (h *groupHandler) processMessage(
    session sarama.ConsumerGroupSession,
    msg *sarama.ConsumerMessage,
) error {
    start := time.Now()
    ctx := session.Context()

    // Retry logic with exponential backoff
    var lastErr error
    for attempt := 0; attempt <= h.consumer.config.MaxRetries; attempt++ {
        if attempt > 0 {
            backoff := time.Duration(attempt) * h.consumer.config.RetryBackoff
            select {
            case <-time.After(backoff):
            case <-ctx.Done():
                return ctx.Err()
            }
        }

        if err := h.consumer.handler(ctx, msg); err != nil {
            lastErr = err
            h.logger.Warn("Message processing failed, will retry",
                zap.Error(err),
                zap.Int("attempt", attempt+1),
                zap.Int("max_retries", h.consumer.config.MaxRetries),
            )
            continue
        }

        messageProcessingDuration.WithLabelValues(msg.Topic).Observe(
            time.Since(start).Seconds(),
        )
        return nil
    }

    return fmt.Errorf("message processing failed after %d retries: %w",
        h.consumer.config.MaxRetries, lastErr)
}
```

## Section 4: Consumer Lag Monitoring with Prometheus

Consumer lag is the most critical operational metric for Kafka consumers. It represents the number of messages waiting to be processed and directly correlates to processing latency experienced by downstream systems.

### Lag Exporter Implementation

```go
// lagmonitor/monitor.go
package lagmonitor

import (
    "context"
    "fmt"
    "time"

    "github.com/IBM/sarama"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "go.uber.org/zap"
)

var (
    consumerGroupLag = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "kafka_consumer_group_lag",
            Help: "Consumer group lag per partition (current offset - latest offset)",
        },
        []string{"group", "topic", "partition"},
    )

    consumerGroupCurrentOffset = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "kafka_consumer_group_current_offset",
            Help: "Current committed offset for the consumer group",
        },
        []string{"group", "topic", "partition"},
    )

    topicLatestOffset = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "kafka_topic_latest_offset",
            Help: "Latest (end) offset for each topic partition",
        },
        []string{"topic", "partition"},
    )

    totalConsumerGroupLag = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "kafka_consumer_group_total_lag",
            Help: "Total lag summed across all partitions for a consumer group and topic",
        },
        []string{"group", "topic"},
    )
)

// LagMonitor continuously measures and exposes consumer group lag metrics.
type LagMonitor struct {
    brokers  []string
    groups   []string
    interval time.Duration
    logger   *zap.Logger
    client   sarama.Client
    admin    sarama.ClusterAdmin
}

// NewLagMonitor creates a lag monitor that polls at the given interval.
func NewLagMonitor(brokers, groups []string, interval time.Duration, logger *zap.Logger) (*LagMonitor, error) {
    cfg := sarama.NewConfig()
    cfg.Version = sarama.V3_6_0_0
    cfg.ClientID = "kafka-lag-monitor"

    client, err := sarama.NewClient(brokers, cfg)
    if err != nil {
        return nil, fmt.Errorf("creating sarama client: %w", err)
    }

    admin, err := sarama.NewClusterAdminFromClient(client)
    if err != nil {
        client.Close()
        return nil, fmt.Errorf("creating cluster admin: %w", err)
    }

    return &LagMonitor{
        brokers:  brokers,
        groups:   groups,
        interval: interval,
        logger:   logger,
        client:   client,
        admin:    admin,
    }, nil
}

// Run starts the lag monitoring loop.
func (m *LagMonitor) Run(ctx context.Context) {
    ticker := time.NewTicker(m.interval)
    defer ticker.Stop()

    // Initial collection
    m.collectLag()

    for {
        select {
        case <-ticker.C:
            m.collectLag()
        case <-ctx.Done():
            return
        }
    }
}

func (m *LagMonitor) collectLag() {
    for _, group := range m.groups {
        if err := m.collectGroupLag(group); err != nil {
            m.logger.Error("Failed to collect lag for group",
                zap.String("group", group),
                zap.Error(err),
            )
        }
    }
}

func (m *LagMonitor) collectGroupLag(group string) error {
    // Refresh metadata to get current broker assignments
    if err := m.client.RefreshMetadata(); err != nil {
        return fmt.Errorf("refreshing metadata: %w", err)
    }

    // Get all topics
    topics, err := m.client.Topics()
    if err != nil {
        return fmt.Errorf("listing topics: %w", err)
    }

    // Get committed offsets for this consumer group across all topics
    committedOffsets, err := m.admin.ListConsumerGroupOffsets(group, nil)
    if err != nil {
        return fmt.Errorf("listing consumer group offsets for %s: %w", group, err)
    }

    // For each topic this group is consuming, calculate lag
    for topic, partitionOffsets := range committedOffsets.Blocks {
        // Skip internal topics
        if len(topic) > 0 && topic[0] == '_' {
            continue
        }

        var totalTopicLag int64

        for partition, block := range partitionOffsets {
            if block.Err != sarama.ErrNoError {
                m.logger.Warn("Error in offset block",
                    zap.String("group", group),
                    zap.String("topic", topic),
                    zap.Int32("partition", partition),
                    zap.Error(block.Err),
                )
                continue
            }

            // Get the latest (end) offset from the broker
            latestOffset, err := m.client.GetOffset(topic, partition, sarama.OffsetNewest)
            if err != nil {
                m.logger.Warn("Failed to get latest offset",
                    zap.String("topic", topic),
                    zap.Int32("partition", partition),
                    zap.Error(err),
                )
                continue
            }

            committedOffset := block.Offset
            lag := latestOffset - committedOffset
            if lag < 0 {
                lag = 0
            }
            totalTopicLag += lag

            partitionStr := fmt.Sprintf("%d", partition)

            consumerGroupLag.WithLabelValues(group, topic, partitionStr).Set(float64(lag))
            consumerGroupCurrentOffset.WithLabelValues(group, topic, partitionStr).Set(float64(committedOffset))
            topicLatestOffset.WithLabelValues(topic, partitionStr).Set(float64(latestOffset))
        }

        totalConsumerGroupLag.WithLabelValues(group, topic).Set(float64(totalTopicLag))
    }

    // Check for topics in the topic list not yet consumed
    _ = topics

    return nil
}

// Close releases resources held by the monitor.
func (m *LagMonitor) Close() error {
    m.admin.Close()
    return m.client.Close()
}
```

### Prometheus Alerting Rules for Consumer Lag

```yaml
# kafka-lag-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kafka-consumer-lag-alerts
  namespace: monitoring
spec:
  groups:
    - name: kafka.consumer.lag
      interval: 30s
      rules:
        - alert: KafkaConsumerHighLag
          expr: |
            kafka_consumer_group_total_lag{group!~".*test.*"} > 100000
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Kafka consumer group {{ $labels.group }} has high lag on {{ $labels.topic }}"
            description: "Consumer group {{ $labels.group }} has {{ $value }} messages of lag on topic {{ $labels.topic }}"

        - alert: KafkaConsumerCriticalLag
          expr: |
            kafka_consumer_group_total_lag{group!~".*test.*"} > 1000000
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Critical lag: consumer group {{ $labels.group }} is severely behind"
            description: "Consumer group {{ $labels.group }} has {{ $value | humanize }} messages of lag on topic {{ $labels.topic }}. Immediate investigation required."

        - alert: KafkaConsumerLagGrowing
          expr: |
            rate(kafka_consumer_group_total_lag[10m]) > 1000
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Kafka consumer lag is growing for group {{ $labels.group }}"
            description: "Consumer lag is increasing at {{ $value | humanize }}/s for group {{ $labels.group }}"

        - alert: KafkaConsumerGroupNoProgress
          expr: |
            increase(kafka_consumer_messages_processed_total[10m]) == 0
            and
            kafka_consumer_group_total_lag > 0
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "Kafka consumer group {{ $labels.group }} has stopped processing"
            description: "No messages processed in 10 minutes despite positive lag"
```

## Section 5: Rebalance Listener and Stateful Consumer

For stateful consumers (e.g., those maintaining in-memory aggregations), rebalances require flushing state before partitions are revoked.

```go
// stateful/handler.go
package stateful

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/IBM/sarama"
    "go.uber.org/zap"
)

// PartitionState holds state for a single partition.
type PartitionState struct {
    mu           sync.Mutex
    aggregations map[string]int64
    lastFlush    time.Time
    pendingMsgs  int64
}

// StatefulHandler implements sarama.ConsumerGroupHandler with state management.
type StatefulHandler struct {
    logger     *zap.Logger
    stateStore map[int32]*PartitionState
    stateMu    sync.RWMutex
    flushFunc  func(ctx context.Context, partition int32, state map[string]int64) error
}

// NewStatefulHandler creates a handler that flushes partition state on rebalance.
func NewStatefulHandler(
    flushFunc func(ctx context.Context, partition int32, state map[string]int64) error,
    logger *zap.Logger,
) *StatefulHandler {
    return &StatefulHandler{
        logger:     logger,
        stateStore: make(map[int32]*PartitionState),
        flushFunc:  flushFunc,
    }
}

func (h *StatefulHandler) Setup(session sarama.ConsumerGroupSession) error {
    h.logger.Info("Rebalance started - setup",
        zap.String("member_id", session.MemberID()),
        zap.Int32("generation_id", session.GenerationID()),
    )

    // Initialize state for newly assigned partitions
    h.stateMu.Lock()
    defer h.stateMu.Unlock()

    for _, partitions := range session.Claims() {
        for _, partition := range partitions {
            if _, exists := h.stateStore[partition]; !exists {
                h.stateStore[partition] = &PartitionState{
                    aggregations: make(map[string]int64),
                    lastFlush:    time.Now(),
                }
            }
        }
    }
    return nil
}

func (h *StatefulHandler) Cleanup(session sarama.ConsumerGroupSession) error {
    h.logger.Info("Rebalance started - cleanup, flushing partition state",
        zap.String("member_id", session.MemberID()),
    )

    // Flush state for all partitions being revoked before the rebalance completes
    h.stateMu.Lock()
    defer h.stateMu.Unlock()

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    var flushErrors []error
    for partition, state := range h.stateStore {
        state.mu.Lock()
        if len(state.aggregations) > 0 {
            if err := h.flushFunc(ctx, partition, state.aggregations); err != nil {
                flushErrors = append(flushErrors, fmt.Errorf(
                    "flushing partition %d: %w", partition, err,
                ))
            } else {
                state.aggregations = make(map[string]int64)
                state.lastFlush = time.Now()
                state.pendingMsgs = 0
            }
        }
        state.mu.Unlock()
    }

    // Clear state store - will be rebuilt in next Setup call
    h.stateStore = make(map[int32]*PartitionState)

    if len(flushErrors) > 0 {
        return fmt.Errorf("flush errors during cleanup: %v", flushErrors)
    }
    return nil
}

func (h *StatefulHandler) ConsumeClaim(
    session sarama.ConsumerGroupSession,
    claim sarama.ConsumerGroupClaim,
) error {
    for {
        select {
        case msg, ok := <-claim.Messages():
            if !ok {
                return nil
            }

            if err := h.aggregate(claim.Partition(), msg); err != nil {
                h.logger.Error("Aggregation failed",
                    zap.Error(err),
                    zap.Int32("partition", claim.Partition()),
                )
                continue
            }

            // Flush periodically or when batch size threshold is reached
            h.stateMu.RLock()
            state := h.stateStore[claim.Partition()]
            h.stateMu.RUnlock()

            if state != nil {
                state.mu.Lock()
                shouldFlush := state.pendingMsgs >= 1000 ||
                    time.Since(state.lastFlush) > 30*time.Second
                state.mu.Unlock()

                if shouldFlush {
                    if err := h.flushPartition(session.Context(), claim.Partition()); err != nil {
                        h.logger.Error("Flush failed",
                            zap.Error(err),
                            zap.Int32("partition", claim.Partition()),
                        )
                    }
                }
            }

            session.MarkMessage(msg, "")

        case <-session.Context().Done():
            // Flush remaining state before this partition is potentially reassigned
            h.flushPartition(context.Background(), claim.Partition())
            return nil
        }
    }
}

func (h *StatefulHandler) aggregate(partition int32, msg *sarama.ConsumerMessage) error {
    h.stateMu.RLock()
    state := h.stateStore[partition]
    h.stateMu.RUnlock()

    if state == nil {
        return fmt.Errorf("no state found for partition %d", partition)
    }

    state.mu.Lock()
    defer state.mu.Unlock()

    // Example: count messages by key
    key := string(msg.Key)
    state.aggregations[key]++
    state.pendingMsgs++
    return nil
}

func (h *StatefulHandler) flushPartition(ctx context.Context, partition int32) error {
    h.stateMu.RLock()
    state := h.stateStore[partition]
    h.stateMu.RUnlock()

    if state == nil {
        return nil
    }

    state.mu.Lock()
    defer state.mu.Unlock()

    if len(state.aggregations) == 0 {
        return nil
    }

    if err := h.flushFunc(ctx, partition, state.aggregations); err != nil {
        return err
    }

    state.aggregations = make(map[string]int64)
    state.lastFlush = time.Now()
    state.pendingMsgs = 0
    return nil
}
```

## Section 6: Exactly-Once Semantics

True exactly-once semantics in Kafka requires transactional producers paired with read-committed consumers. With `sarama`, this requires careful offset management and idempotent producers.

```go
// exactlyonce/processor.go
package exactlyonce

import (
    "context"
    "fmt"

    "github.com/IBM/sarama"
    "go.uber.org/zap"
)

// TransactionalProcessor reads from one topic, transforms, and writes
// to another topic with exactly-once semantics.
type TransactionalProcessor struct {
    consumer sarama.ConsumerGroup
    producer sarama.SyncProducer
    logger   *zap.Logger
    inTopic  string
    outTopic string
}

func NewTransactionalProcessor(
    brokers []string,
    groupID string,
    inTopic, outTopic string,
    transactionalID string,
    logger *zap.Logger,
) (*TransactionalProcessor, error) {
    // Consumer config: read only committed messages
    consumerCfg := sarama.NewConfig()
    consumerCfg.Version = sarama.V3_6_0_0
    consumerCfg.Consumer.IsolationLevel = sarama.ReadCommitted
    consumerCfg.Consumer.Offsets.AutoCommit.Enable = false

    consumer, err := sarama.NewConsumerGroup(brokers, groupID, consumerCfg)
    if err != nil {
        return nil, fmt.Errorf("creating consumer: %w", err)
    }

    // Producer config: transactional idempotent producer
    producerCfg := sarama.NewConfig()
    producerCfg.Version = sarama.V3_6_0_0
    producerCfg.Producer.Idempotent = true
    producerCfg.Producer.Transaction.ID = transactionalID
    producerCfg.Producer.Transaction.Retry.Max = 5
    producerCfg.Producer.RequiredAcks = sarama.WaitForAll
    producerCfg.Net.MaxOpenRequests = 1 // Required for idempotent producer

    producer, err := sarama.NewSyncProducer(brokers, producerCfg)
    if err != nil {
        consumer.Close()
        return nil, fmt.Errorf("creating transactional producer: %w", err)
    }

    return &TransactionalProcessor{
        consumer: consumer,
        producer: producer,
        logger:   logger,
        inTopic:  inTopic,
        outTopic: outTopic,
    }, nil
}

// eoHandler implements the transactional consume-transform-produce loop.
type eoHandler struct {
    tp *TransactionalProcessor
}

func (h *eoHandler) Setup(sarama.ConsumerGroupSession) error   { return nil }
func (h *eoHandler) Cleanup(sarama.ConsumerGroupSession) error { return nil }

func (h *eoHandler) ConsumeClaim(
    session sarama.ConsumerGroupSession,
    claim sarama.ConsumerGroupClaim,
) error {
    for {
        select {
        case msg, ok := <-claim.Messages():
            if !ok {
                return nil
            }

            // Step 1: Begin transaction
            if err := h.tp.producer.BeginTxn(); err != nil {
                return fmt.Errorf("beginning transaction: %w", err)
            }

            // Step 2: Process message and produce to output topic
            outputMsg := h.transform(msg)
            if _, _, err := h.tp.producer.SendMessage(outputMsg); err != nil {
                // Abort transaction on processing failure
                h.tp.producer.AbortTxn()
                return fmt.Errorf("sending message in transaction: %w", err)
            }

            // Step 3: Add consumer group offset to the transaction
            // This atomically commits the output AND the input offset
            offsets := make(map[string][]*sarama.PartitionOffsetMetadata)
            offsets[claim.Topic()] = []*sarama.PartitionOffsetMetadata{
                {
                    Partition: claim.Partition(),
                    Offset:    msg.Offset + 1,
                    Metadata:  nil,
                },
            }
            if err := h.tp.producer.AddOffsetsToTxn(
                offsets, session.MemberID(),
            ); err != nil {
                h.tp.producer.AbortTxn()
                return fmt.Errorf("adding offsets to transaction: %w", err)
            }

            // Step 4: Commit transaction
            if err := h.tp.producer.CommitTxn(); err != nil {
                return fmt.Errorf("committing transaction: %w", err)
            }

            // Mark message (offset tracking only, not auto-commit)
            session.MarkMessage(msg, "")

        case <-session.Context().Done():
            return nil
        }
    }
}

func (h *eoHandler) transform(msg *sarama.ConsumerMessage) *sarama.ProducerMessage {
    // Example transformation: uppercase the value
    transformed := make([]byte, len(msg.Value))
    for i, b := range msg.Value {
        if b >= 'a' && b <= 'z' {
            transformed[i] = b - 32
        } else {
            transformed[i] = b
        }
    }
    return &sarama.ProducerMessage{
        Topic: h.tp.outTopic,
        Key:   sarama.ByteEncoder(msg.Key),
        Value: sarama.ByteEncoder(transformed),
    }
}

// Run starts the transactional processor.
func (tp *TransactionalProcessor) Run(ctx context.Context) error {
    handler := &eoHandler{tp: tp}
    for {
        if ctx.Err() != nil {
            return ctx.Err()
        }
        if err := tp.consumer.Consume(ctx, []string{tp.inTopic}, handler); err != nil {
            tp.logger.Error("Consumer group error", zap.Error(err))
        }
    }
}
```

## Section 7: High-Throughput Consumer Configuration

### Batch Processing for Maximum Throughput

```go
// batch/consumer.go
package batch

import (
    "context"
    "time"

    "github.com/IBM/sarama"
    "go.uber.org/zap"
)

const (
    defaultBatchSize    = 500
    defaultBatchTimeout = 100 * time.Millisecond
)

// BatchHandler accumulates messages and processes them in batches.
type BatchHandler struct {
    processFunc func(ctx context.Context, msgs []*sarama.ConsumerMessage) error
    batchSize   int
    timeout     time.Duration
    logger      *zap.Logger
}

func (h *BatchHandler) Setup(sarama.ConsumerGroupSession) error   { return nil }
func (h *BatchHandler) Cleanup(sarama.ConsumerGroupSession) error { return nil }

func (h *BatchHandler) ConsumeClaim(
    session sarama.ConsumerGroupSession,
    claim sarama.ConsumerGroupClaim,
) error {
    batch := make([]*sarama.ConsumerMessage, 0, h.batchSize)
    timer := time.NewTimer(h.timeout)
    defer timer.Stop()

    flush := func() error {
        if len(batch) == 0 {
            return nil
        }
        if err := h.processFunc(session.Context(), batch); err != nil {
            return err
        }
        // Mark all messages in the batch
        for _, msg := range batch {
            session.MarkMessage(msg, "")
        }
        batch = batch[:0]
        return nil
    }

    for {
        select {
        case msg, ok := <-claim.Messages():
            if !ok {
                return flush()
            }
            batch = append(batch, msg)
            if len(batch) >= h.batchSize {
                if !timer.Stop() {
                    select {
                    case <-timer.C:
                    default:
                    }
                }
                if err := flush(); err != nil {
                    return err
                }
                timer.Reset(h.timeout)
            }

        case <-timer.C:
            if err := flush(); err != nil {
                return err
            }
            timer.Reset(h.timeout)

        case <-session.Context().Done():
            return flush()
        }
    }
}
```

## Section 8: Operational Runbook

### Diagnosing High Consumer Lag

```bash
# 1. Check consumer group status
kafka-consumer-groups.sh \
  --bootstrap-server kafka:9092 \
  --describe \
  --group my-consumer-group

# Output shows LAG column - any partition with significant lag needs investigation

# 2. Check if consumer is making progress
watch -n 5 'kafka-consumer-groups.sh \
  --bootstrap-server kafka:9092 \
  --describe \
  --group my-consumer-group | grep -v "^$"'

# 3. Check partition leader health
kafka-topics.sh \
  --bootstrap-server kafka:9092 \
  --describe \
  --topic my-topic

# 4. Check consumer pod resource usage
kubectl top pods -n myapp -l app=kafka-consumer

# 5. Check for rebalancing (consumer group instability)
kubectl logs -n myapp -l app=kafka-consumer --since=10m | \
  grep -E "Rebalance|Setup|Cleanup|rebalance"

# 6. Reset consumer group offset (use with caution)
kafka-consumer-groups.sh \
  --bootstrap-server kafka:9092 \
  --group my-consumer-group \
  --topic my-topic \
  --reset-offsets \
  --to-latest \
  --execute

# 7. Reset to specific timestamp
kafka-consumer-groups.sh \
  --bootstrap-server kafka:9092 \
  --group my-consumer-group \
  --topic my-topic \
  --reset-offsets \
  --to-datetime 2029-08-28T00:00:00.000 \
  --execute
```

### Scaling Consumer Groups

```yaml
# hpa-kafka-consumer.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: kafka-consumer-scaledobject
  namespace: myapp
spec:
  scaleTargetRef:
    name: kafka-consumer-deployment
  minReplicaCount: 2
  maxReplicaCount: 20  # Should not exceed number of partitions
  pollingInterval: 30
  cooldownPeriod: 300
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka.kafka.svc.cluster.local:9092
        consumerGroup: my-consumer-group
        topic: my-topic
        lagThreshold: "10000"
        activationLagThreshold: "100"
        offsetResetPolicy: latest
```

## Conclusion

Building production-grade Kafka consumers in Go requires understanding the protocol deeply enough to make informed decisions about rebalance strategies, offset management, and error handling. The stateful rebalance listener pattern is critical for any consumer that maintains in-memory state. Lag monitoring through Prometheus transforms an opaque background process into an observable, alertable metric that feeds directly into SLO calculations.

For new projects, start with `sarama` and the sticky rebalance strategy. Add the lag exporter from Section 4 from day one — visibility into lag growth catches architectural problems early. Graduate to batch processing (Section 7) once you have baseline metrics showing where processing time is spent.
