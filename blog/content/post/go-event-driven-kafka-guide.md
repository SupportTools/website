---
title: "Go Event-Driven Architecture: Kafka Consumer Groups, Exactly-Once Delivery"
date: 2027-09-13T00:00:00-05:00
draft: false
tags: ["Go", "Kafka", "Event-Driven", "Microservices"]
categories:
- Go
- Backend
author: "Matthew Mattox - mmattox@support.tools"
description: "Go Kafka integration with confluent-kafka-go and segmentio/kafka-go: consumer group management, exactly-once semantics, Avro schema evolution, dead letter queues, and consumer lag monitoring."
more_link: "yes"
url: "/go-event-driven-kafka-guide/"
---

Event-driven architecture built on Apache Kafka provides durable, replayable message streams that decouple producers from consumers and enable independent scaling. However, the gap between a working consumer and a production-grade consumer is substantial: offset management, rebalance handling, schema evolution, exactly-once delivery, dead letter queues, and consumer lag alerting all require explicit engineering. This guide covers the full production Kafka stack for Go services.

<!--more-->

## Section 1: Library Selection

Two primary Go Kafka libraries serve different needs:

| Feature | confluent-kafka-go | segmentio/kafka-go |
|---|---|---|
| Underlying implementation | librdkafka (C) | Pure Go |
| Schema Registry | Native support | Third-party |
| Transactions (EOS) | Full support | Limited |
| Cross-compilation | Requires CGO | Trivial |
| Performance | Higher | Slightly lower |
| Deployment complexity | Higher (C dep) | Lower |

Use `confluent-kafka-go` when exactly-once semantics or the Confluent Schema Registry are required. Use `segmentio/kafka-go` for simpler deployments where CGO is a burden.

```bash
# confluent-kafka-go
go get github.com/confluentinc/confluent-kafka-go/v2@v2.5.0

# segmentio/kafka-go (used for consumer group examples below)
go get github.com/segmentio/kafka-go@v0.4.47

# Schema registry client
go get github.com/linkedin/goavro/v2@v2.13.0
```

## Section 2: Consumer Group Configuration

A production consumer group configuration requires careful thought about offset reset policy, session timeouts, and fetch sizes:

```go
package kafka

import (
    "context"
    "fmt"
    "time"

    "github.com/segmentio/kafka-go"
)

// ConsumerConfig holds all tunable consumer parameters.
type ConsumerConfig struct {
    Brokers        []string
    Topic          string
    GroupID        string
    MinBytes       int
    MaxBytes       int
    MaxWait        time.Duration
    CommitInterval time.Duration
    StartOffset    int64 // kafka.FirstOffset or kafka.LastOffset
    SessionTimeout time.Duration
    HeartbeatInterval time.Duration
}

// DefaultConsumerConfig returns production-ready defaults.
func DefaultConsumerConfig(brokers []string, topic, groupID string) ConsumerConfig {
    return ConsumerConfig{
        Brokers:           brokers,
        Topic:             topic,
        GroupID:           groupID,
        MinBytes:          1,        // return immediately when any data is available
        MaxBytes:          10 << 20, // 10 MB per fetch
        MaxWait:           500 * time.Millisecond,
        CommitInterval:    time.Second,
        StartOffset:       kafka.FirstOffset,
        SessionTimeout:    30 * time.Second,
        HeartbeatInterval: 3 * time.Second,
    }
}

// NewReader creates a configured kafka.Reader.
func NewReader(cfg ConsumerConfig) *kafka.Reader {
    return kafka.NewReader(kafka.ReaderConfig{
        Brokers:        cfg.Brokers,
        Topic:          cfg.Topic,
        GroupID:        cfg.GroupID,
        MinBytes:       cfg.MinBytes,
        MaxBytes:       cfg.MaxBytes,
        MaxWait:        cfg.MaxWait,
        CommitInterval: cfg.CommitInterval,
        StartOffset:    cfg.StartOffset,
        Dialer: &kafka.Dialer{
            Timeout:   10 * time.Second,
            DualStack: true,
        },
        Logger:      kafka.LoggerFunc(func(msg string, args ...interface{}) {}),
        ErrorLogger: kafka.LoggerFunc(func(msg string, args ...interface{}) {}),
    })
}
```

## Section 3: Consumer Group Manager

A production consumer loop handles rebalance events, back-pressure, and graceful shutdown:

```go
package kafka

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/segmentio/kafka-go"
)

// MessageHandler processes a single Kafka message.
type MessageHandler func(ctx context.Context, msg kafka.Message) error

// Consumer manages the consumer loop with error handling and metrics.
type Consumer struct {
    reader  *kafka.Reader
    handler MessageHandler
    logger  *slog.Logger
    dlq     *kafka.Writer // dead letter queue writer, may be nil
    maxRetries int
}

// NewConsumer creates a Consumer.
func NewConsumer(
    cfg ConsumerConfig,
    handler MessageHandler,
    logger *slog.Logger,
    dlqWriter *kafka.Writer,
) *Consumer {
    return &Consumer{
        reader:     NewReader(cfg),
        handler:    handler,
        logger:     logger,
        dlq:        dlqWriter,
        maxRetries: 3,
    }
}

// Run starts the consumer loop and blocks until ctx is cancelled.
func (c *Consumer) Run(ctx context.Context) error {
    defer c.reader.Close()
    for {
        msg, err := c.reader.FetchMessage(ctx)
        if err != nil {
            if ctx.Err() != nil {
                return nil // graceful shutdown
            }
            c.logger.Error("fetch message failed",
                slog.String("error", err.Error()))
            time.Sleep(time.Second) // back off on fetch errors
            continue
        }

        c.processWithRetry(ctx, msg)
    }
}

func (c *Consumer) processWithRetry(ctx context.Context, msg kafka.Message) {
    var lastErr error
    for attempt := 1; attempt <= c.maxRetries; attempt++ {
        if err := c.handler(ctx, msg); err != nil {
            lastErr = err
            delay := time.Duration(attempt*attempt) * 100 * time.Millisecond
            c.logger.Warn("handler failed, retrying",
                slog.Int("attempt", attempt),
                slog.String("error", err.Error()),
                slog.Duration("backoff", delay),
            )
            select {
            case <-ctx.Done():
                return
            case <-time.After(delay):
            }
            continue
        }
        // Success: commit the offset.
        if err := c.reader.CommitMessages(ctx, msg); err != nil {
            c.logger.Error("commit failed", slog.String("error", err.Error()))
        }
        return
    }

    // All retries exhausted: send to DLQ.
    c.logger.Error("message processing failed after retries, sending to DLQ",
        slog.String("topic", msg.Topic),
        slog.Int("partition", msg.Partition),
        slog.Int64("offset", msg.Offset),
        slog.String("error", lastErr.Error()),
    )
    c.sendToDLQ(ctx, msg, lastErr)
    // Commit to avoid infinite reprocessing.
    _ = c.reader.CommitMessages(ctx, msg)
}

func (c *Consumer) sendToDLQ(ctx context.Context, msg kafka.Message, processingErr error) {
    if c.dlq == nil {
        return
    }
    dlqMsg := kafka.Message{
        Key:   msg.Key,
        Value: msg.Value,
        Headers: append(msg.Headers,
            kafka.Header{Key: "dlq-original-topic", Value: []byte(msg.Topic)},
            kafka.Header{Key: "dlq-original-partition",
                Value: []byte(fmt.Sprintf("%d", msg.Partition))},
            kafka.Header{Key: "dlq-original-offset",
                Value: []byte(fmt.Sprintf("%d", msg.Offset))},
            kafka.Header{Key: "dlq-error", Value: []byte(processingErr.Error())},
            kafka.Header{Key: "dlq-timestamp",
                Value: []byte(time.Now().UTC().Format(time.RFC3339))},
        ),
    }
    if err := c.dlq.WriteMessages(ctx, dlqMsg); err != nil {
        c.logger.Error("DLQ write failed", slog.String("error", err.Error()))
    }
}
```

## Section 4: Dead Letter Queue Setup

```go
package kafka

// NewDLQWriter creates a Kafka writer for the dead letter queue topic.
func NewDLQWriter(brokers []string, dlqTopic string) *kafka.Writer {
    return &kafka.Writer{
        Addr:         kafka.TCP(brokers...),
        Topic:        dlqTopic,
        Balancer:     &kafka.LeastBytes{},
        RequiredAcks: kafka.RequireAll,
        BatchSize:    1,     // immediate write for DLQ messages
        Async:        false, // synchronous for reliability
        MaxAttempts:  5,
        WriteTimeout: 10 * time.Second,
    }
}
```

DLQ topic naming convention: `{original-topic}.dlq` or `{original-topic}.dead-letter`.

## Section 5: Exactly-Once Semantics with confluent-kafka-go

Exactly-once semantics (EOS) require transactional producers and consumer offset management within the same transaction:

```go
package kafka

import (
    "context"
    "fmt"

    confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

// TransactionalProducer wraps a confluent producer configured for EOS.
type TransactionalProducer struct {
    producer *confluent.Producer
}

// NewTransactionalProducer creates a producer with exactly-once guarantees.
func NewTransactionalProducer(brokers, transactionalID string) (*TransactionalProducer, error) {
    p, err := confluent.NewProducer(&confluent.ConfigMap{
        "bootstrap.servers":                     brokers,
        "transactional.id":                      transactionalID,
        "enable.idempotence":                    true,
        "acks":                                  "all",
        "max.in.flight.requests.per.connection": 5,
        "retries":                               2147483647,
        "delivery.timeout.ms":                   300000,
    })
    if err != nil {
        return nil, fmt.Errorf("create producer: %w", err)
    }

    if err := p.InitTransactions(context.Background()); err != nil {
        return nil, fmt.Errorf("init transactions: %w", err)
    }

    return &TransactionalProducer{producer: p}, nil
}

// ProcessAndPublish reads a message, processes it, and publishes the
// output atomically with the consumed offset commit.
func (tp *TransactionalProducer) ProcessAndPublish(
    ctx context.Context,
    consumer *confluent.Consumer,
    inputMsg *confluent.Message,
    outputTopic string,
    outputValue []byte,
) error {
    if err := tp.producer.BeginTransaction(); err != nil {
        return fmt.Errorf("begin transaction: %w", err)
    }

    // Produce the output message.
    delivery := make(chan confluent.Event, 1)
    err := tp.producer.Produce(&confluent.Message{
        TopicPartition: confluent.TopicPartition{
            Topic:     &outputTopic,
            Partition: confluent.PartitionAny,
        },
        Value: outputValue,
    }, delivery)
    if err != nil {
        _ = tp.producer.AbortTransaction(ctx)
        return fmt.Errorf("produce: %w", err)
    }

    // Wait for delivery confirmation.
    e := <-delivery
    m, ok := e.(*confluent.Message)
    if !ok || m.TopicPartition.Error != nil {
        _ = tp.producer.AbortTransaction(ctx)
        return fmt.Errorf("delivery error: %v", m.TopicPartition.Error)
    }

    // Send consumed offsets to the transaction.
    groupMeta, err := consumer.GetConsumerGroupMetadata()
    if err != nil {
        _ = tp.producer.AbortTransaction(ctx)
        return fmt.Errorf("get consumer group metadata: %w", err)
    }

    offsets := confluent.TopicPartitions{confluent.TopicPartition{
        Topic:     inputMsg.TopicPartition.Topic,
        Partition: inputMsg.TopicPartition.Partition,
        Offset:    inputMsg.TopicPartition.Offset + 1,
    }}
    if err := tp.producer.SendOffsetsToTransaction(ctx, offsets, groupMeta); err != nil {
        _ = tp.producer.AbortTransaction(ctx)
        return fmt.Errorf("send offsets to transaction: %w", err)
    }

    if err := tp.producer.CommitTransaction(ctx); err != nil {
        return fmt.Errorf("commit transaction: %w", err)
    }
    return nil
}
```

## Section 6: Avro Schema Evolution with Schema Registry

```go
package schema

import (
    "encoding/binary"
    "encoding/json"
    "fmt"

    "github.com/linkedin/goavro/v2"
    srclient "github.com/riferrei/srclient"
)

const magicByte = 0x0

// AvroEncoder encodes messages with Confluent wire format:
// [magic_byte][schema_id_4_bytes][avro_payload]
type AvroEncoder struct {
    schemaRegistryClient *srclient.SchemaRegistryClient
    subject              string
    schemaID             int
    codec                *goavro.Codec
}

// NewAvroEncoder creates an encoder for a specific subject (topic-value).
func NewAvroEncoder(registryURL, topic string, schema string) (*AvroEncoder, error) {
    client := srclient.CreateSchemaRegistryClient(registryURL)
    subject := topic + "-value"

    registered, err := client.CreateSchema(subject, schema, srclient.Avro)
    if err != nil {
        return nil, fmt.Errorf("register schema: %w", err)
    }

    codec, err := goavro.NewCodec(schema)
    if err != nil {
        return nil, fmt.Errorf("create codec: %w", err)
    }

    return &AvroEncoder{
        schemaRegistryClient: client,
        subject:              subject,
        schemaID:             registered.ID(),
        codec:                codec,
    }, nil
}

// Encode serialises a native Go map into Confluent Avro wire format.
func (e *AvroEncoder) Encode(native map[string]interface{}) ([]byte, error) {
    avroBytes, err := e.codec.BinaryFromNative(nil, native)
    if err != nil {
        return nil, fmt.Errorf("avro encode: %w", err)
    }

    // Confluent wire format header: 0x00 + 4-byte schema ID.
    msg := make([]byte, 5+len(avroBytes))
    msg[0] = magicByte
    binary.BigEndian.PutUint32(msg[1:5], uint32(e.schemaID))
    copy(msg[5:], avroBytes)
    return msg, nil
}

// Decode deserialises a Confluent Avro wire-format message.
func (e *AvroEncoder) Decode(msg []byte) (map[string]interface{}, error) {
    if len(msg) < 5 || msg[0] != magicByte {
        return nil, fmt.Errorf("invalid confluent wire format")
    }

    schemaID := int(binary.BigEndian.Uint32(msg[1:5]))
    schema, err := e.schemaRegistryClient.GetSchema(schemaID)
    if err != nil {
        return nil, fmt.Errorf("get schema %d: %w", schemaID, err)
    }

    codec, err := goavro.NewCodec(schema.Schema())
    if err != nil {
        return nil, fmt.Errorf("create codec for schema %d: %w", schemaID, err)
    }

    native, _, err := codec.NativeFromBinary(msg[5:])
    if err != nil {
        return nil, fmt.Errorf("avro decode: %w", err)
    }
    result, ok := native.(map[string]interface{})
    if !ok {
        return nil, fmt.Errorf("decoded value is not a map")
    }
    return result, nil
}
```

### Schema Evolution Rules

```text
BACKWARD compatible (new schema can read old messages):
  - Add field with default value
  - Remove field without default

FORWARD compatible (old schema can read new messages):
  - Add field without default
  - Remove field with default

FULL compatible (both backward and forward):
  - Add field with default value

BREAKING changes (never do without coordinated deployment):
  - Rename field
  - Change field type
  - Remove required field
```

## Section 7: Producer Patterns

```go
package kafka

// Writer wraps kafka.Writer with a topic-aware interface.
type Writer struct {
    w *kafka.Writer
}

// NewWriter creates a reliable async writer.
func NewWriter(brokers []string, topic string) *Writer {
    return &Writer{
        w: &kafka.Writer{
            Addr:                   kafka.TCP(brokers...),
            Topic:                  topic,
            Balancer:               &kafka.Hash{}, // consistent hashing by key
            RequiredAcks:           kafka.RequireAll,
            BatchSize:              100,
            BatchTimeout:           10 * time.Millisecond,
            Async:                  false,
            MaxAttempts:            5,
            WriteTimeout:           10 * time.Second,
            AllowAutoTopicCreation: false,
        },
    }
}

// Publish sends a message with the given key and value.
func (w *Writer) Publish(ctx context.Context, key, value []byte) error {
    return w.w.WriteMessages(ctx, kafka.Message{
        Key:   key,
        Value: value,
        Headers: []kafka.Header{
            {Key: "content-type", Value: []byte("application/json")},
            {Key: "producer-service", Value: []byte("myapp")},
        },
    })
}

// PublishBatch sends multiple messages in a single batch.
func (w *Writer) PublishBatch(ctx context.Context, msgs []kafka.Message) error {
    return w.w.WriteMessages(ctx, msgs...)
}

// Close flushes pending messages and closes the writer.
func (w *Writer) Close() error {
    return w.w.Close()
}
```

## Section 8: Consumer Lag Monitoring

Monitor consumer lag to detect processing bottlenecks before they cause user-visible delays:

```go
package monitoring

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/segmentio/kafka-go"
)

var consumerLag = promauto.NewGaugeVec(
    prometheus.GaugeOpts{
        Name: "kafka_consumer_lag",
        Help: "Number of messages behind the latest offset per partition.",
    },
    []string{"topic", "partition", "consumer_group"},
)

// LagMonitor periodically measures and reports consumer lag.
type LagMonitor struct {
    brokers     []string
    topic       string
    groupID     []string
    interval    time.Duration
}

func NewLagMonitor(brokers []string, topic string, groupIDs []string, interval time.Duration) *LagMonitor {
    return &LagMonitor{
        brokers:  brokers,
        topic:    topic,
        groupID:  groupIDs,
        interval: interval,
    }
}

func (m *LagMonitor) Run(ctx context.Context) {
    ticker := time.NewTicker(m.interval)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            m.measure(ctx)
        }
    }
}

func (m *LagMonitor) measure(ctx context.Context) {
    conn, err := kafka.DialContext(ctx, "tcp", m.brokers[0])
    if err != nil {
        return
    }
    defer conn.Close()

    partitions, err := conn.ReadPartitions(m.topic)
    if err != nil {
        return
    }

    for _, p := range partitions {
        c, err := kafka.DialLeader(ctx, "tcp", m.brokers[0], m.topic, p.ID)
        if err != nil {
            continue
        }
        lastOffset, err := c.ReadLastOffset()
        c.Close()
        if err != nil {
            continue
        }

        for _, groupID := range m.groupID {
            reader := kafka.NewReader(kafka.ReaderConfig{
                Brokers: m.brokers,
                Topic:   m.topic,
                GroupID: groupID,
            })
            // kafka-go doesn't expose committed offsets directly;
            // use the Kafka admin API for production lag measurement.
            _ = reader
            _ = lastOffset
            // In practice, use sarama admin or confluent admin client
            // to fetch committed offsets for the consumer group.
        }
    }
}
```

For production lag monitoring, use the Kafka exporter (Prometheus) or Burrow rather than implementing it in the application itself:

```yaml
# kafka-exporter deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kafka-exporter
spec:
  template:
    spec:
      containers:
      - name: kafka-exporter
        image: danielqsj/kafka-exporter:latest
        args:
        - --kafka.server=kafka-broker-0.kafka.svc.cluster.local:9092
        - --kafka.server=kafka-broker-1.kafka.svc.cluster.local:9092
        - --group.filter=myapp-.*
        ports:
        - containerPort: 9308
          name: metrics
```

Prometheus alerting rule for consumer lag:

```yaml
groups:
- name: kafka
  rules:
  - alert: KafkaConsumerGroupLag
    expr: kafka_consumergroup_lag > 10000
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Consumer group {{ $labels.consumergroup }} is lagging"
      description: "Lag is {{ $value }} messages on topic {{ $labels.topic }}"
```

## Section 9: Partitioning Strategy

Choose the partitioning key based on ordering requirements:

```go
// Order events must be processed in order per customer.
// Use customer_id as the key so all events for a customer
// land on the same partition.
func publishOrderEvent(w *Writer, event OrderEvent) error {
    data, _ := json.Marshal(event)
    return w.Publish(context.Background(),
        []byte(event.CustomerID), // partition key
        data,
    )
}

// Payment events must be idempotent; use payment_id as key
// so duplicate events (from producer retries) land on the same
// partition and can be deduplicated by the consumer.
func publishPaymentEvent(w *Writer, event PaymentEvent) error {
    data, _ := json.Marshal(event)
    return w.Publish(context.Background(),
        []byte(event.PaymentID),
        data,
    )
}
```

## Section 10: Consumer Group Rebalance Handling

```go
// Implement kafka.GroupHandler for explicit rebalance control.
type rebalanceHandler struct {
    logger *slog.Logger
}

func (h *rebalanceHandler) Setup(session sarama.ConsumerGroupSession) error {
    h.logger.Info("consumer group rebalance started",
        slog.Any("claims", session.Claims()))
    return nil
}

func (h *rebalanceHandler) Cleanup(session sarama.ConsumerGroupSession) error {
    h.logger.Info("consumer group rebalance finished")
    return nil
}

func (h *rebalanceHandler) ConsumeClaim(
    session sarama.ConsumerGroupSession,
    claim sarama.ConsumerGroupClaim,
) error {
    for {
        select {
        case msg, ok := <-claim.Messages():
            if !ok {
                return nil
            }
            // Process message...
            session.MarkMessage(msg, "")
        case <-session.Context().Done():
            return nil
        }
    }
}
```
