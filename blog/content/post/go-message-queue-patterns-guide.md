---
title: "Message Queue Patterns in Go: Kafka, NATS, and RabbitMQ"
date: 2028-03-28T00:00:00-05:00
draft: false
tags: ["Go", "Kafka", "NATS", "RabbitMQ", "Messaging", "Distributed Systems", "Event Streaming"]
categories: ["Go", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production-grade messaging patterns in Go covering Kafka idempotent producers with sarama, consumer group rebalancing, NATS JetStream with acknowledgments, RabbitMQ publisher confirms, dead letter queues, and the outbox pattern for transactional publishing."
more_link: "yes"
url: "/go-message-queue-patterns-guide/"
---

Message queues are the connective tissue of distributed systems, but using them correctly in Go requires understanding their operational semantics at a deeper level than their documentation reveals. Kafka, NATS JetStream, and RabbitMQ solve similar problems with fundamentally different guarantees. This guide covers production-ready implementation patterns for all three, including the outbox pattern for achieving exactly-once semantics without distributed transactions.

<!--more-->

## Kafka with sarama

The IBM sarama library is the most widely used Kafka client for Go. Its API is low-level and flexible, which requires explicit configuration for production use.

### Idempotent Producer

An idempotent Kafka producer ensures that retried produces do not create duplicate records, even if the broker receives the same message multiple times:

```go
package kafka

import (
    "context"
    "crypto/tls"
    "fmt"
    "time"

    "github.com/IBM/sarama"
)

type ProducerConfig struct {
    Brokers         []string
    Topic           string
    CompressionType sarama.CompressionCodec
    BatchSize       int
    BatchTimeout    time.Duration
    MaxRetries      int
    TLSConfig       *tls.Config
}

func NewIdempotentProducer(cfg ProducerConfig) (sarama.SyncProducer, error) {
    saramaCfg := sarama.NewConfig()

    // Idempotency requires exactly-once semantics
    saramaCfg.Producer.Idempotent = true
    saramaCfg.Net.MaxOpenRequests = 1  // Required for idempotency

    // Acknowledgment: wait for all in-sync replicas
    saramaCfg.Producer.RequiredAcks = sarama.WaitForAll

    // Retry configuration
    saramaCfg.Producer.Retry.Max = cfg.MaxRetries
    saramaCfg.Producer.Retry.Backoff = 100 * time.Millisecond

    // Compression (Snappy offers best balance of speed and ratio)
    saramaCfg.Producer.Compression = cfg.CompressionType

    // Batching for throughput
    saramaCfg.Producer.Flush.MaxMessages = cfg.BatchSize
    saramaCfg.Producer.Flush.Frequency = cfg.BatchTimeout
    saramaCfg.Producer.Flush.Bytes = 1024 * 1024  // 1MB batch size limit

    // Return errors and successes for sync producer
    saramaCfg.Producer.Return.Successes = true
    saramaCfg.Producer.Return.Errors = true

    // Version must match the Kafka cluster version
    saramaCfg.Version = sarama.V3_5_0_0

    if cfg.TLSConfig != nil {
        saramaCfg.Net.TLS.Enable = true
        saramaCfg.Net.TLS.Config = cfg.TLSConfig
    }

    producer, err := sarama.NewSyncProducer(cfg.Brokers, saramaCfg)
    if err != nil {
        return nil, fmt.Errorf("create sync producer: %w", err)
    }

    return producer, nil
}

// Publisher wraps a Kafka producer with structured message sending.
type Publisher struct {
    producer sarama.SyncProducer
    topic    string
}

// Publish sends a message to Kafka, blocking until the broker acknowledges.
func (p *Publisher) Publish(ctx context.Context, key string, value []byte, headers map[string]string) (int32, int64, error) {
    msg := &sarama.ProducerMessage{
        Topic: p.topic,
        Key:   sarama.StringEncoder(key),
        Value: sarama.ByteEncoder(value),
        Headers: func() []sarama.RecordHeader {
            hdrs := make([]sarama.RecordHeader, 0, len(headers)+2)
            for k, v := range headers {
                hdrs = append(hdrs, sarama.RecordHeader{
                    Key:   []byte(k),
                    Value: []byte(v),
                })
            }
            // Always include timestamp and correlation ID
            hdrs = append(hdrs,
                sarama.RecordHeader{Key: []byte("published-at"), Value: []byte(time.Now().UTC().Format(time.RFC3339))},
            )
            return hdrs
        }(),
    }

    partition, offset, err := p.producer.SendMessage(msg)
    if err != nil {
        return 0, 0, fmt.Errorf("send message to topic %s: %w", p.topic, err)
    }

    return partition, offset, nil
}
```

### Consumer Group with Rebalancing

Consumer groups are the standard pattern for distributed Kafka consumption. The `ConsumeClaim` method runs in its own goroutine per partition per consumer:

```go
package kafka

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/IBM/sarama"
)

// MessageHandler processes a single Kafka message.
type MessageHandler func(ctx context.Context, msg *sarama.ConsumerMessage) error

// ConsumerGroup wraps sarama's consumer group with structured error handling.
type ConsumerGroup struct {
    client  sarama.ConsumerGroup
    handler *consumerGroupHandler
    topics  []string
    logger  *slog.Logger
}

type consumerGroupHandler struct {
    handler        MessageHandler
    logger         *slog.Logger
    rebalanceCount int64
}

// Setup is called at the beginning of each rebalance.
func (h *consumerGroupHandler) Setup(session sarama.ConsumerGroupSession) error {
    h.rebalanceCount++
    h.logger.Info("consumer group rebalance",
        "member_id", session.MemberID(),
        "generation_id", session.GenerationID(),
        "claims", session.Claims(),
        "rebalance_count", h.rebalanceCount,
    )
    return nil
}

// Cleanup is called at the end of each session.
func (h *consumerGroupHandler) Cleanup(session sarama.ConsumerGroupSession) error {
    h.logger.Info("consumer group session cleanup",
        "member_id", session.MemberID(),
    )
    return nil
}

// ConsumeClaim processes messages from a single partition.
func (h *consumerGroupHandler) ConsumeClaim(
    session sarama.ConsumerGroupSession,
    claim sarama.ConsumerGroupClaim,
) error {
    for {
        select {
        case msg, ok := <-claim.Messages():
            if !ok {
                return nil
            }

            start := time.Now()
            err := h.handler(session.Context(), msg)
            elapsed := time.Since(start)

            if err != nil {
                h.logger.Error("message handler failed",
                    "topic", msg.Topic,
                    "partition", msg.Partition,
                    "offset", msg.Offset,
                    "error", err,
                    "elapsed_ms", elapsed.Milliseconds(),
                )
                // Do not mark the message as processed on error
                // The consumer will reprocess from the last committed offset
                // after a rebalance or restart
                continue
            }

            // Mark message as processed — actual commit depends on auto-commit or manual
            session.MarkMessage(msg, "")

            h.logger.Debug("message processed",
                "topic", msg.Topic,
                "partition", msg.Partition,
                "offset", msg.Offset,
                "elapsed_ms", elapsed.Milliseconds(),
            )

        case <-session.Context().Done():
            return nil
        }
    }
}

func NewConsumerGroup(brokers []string, groupID string, topics []string,
    handler MessageHandler, logger *slog.Logger) (*ConsumerGroup, error) {

    cfg := sarama.NewConfig()
    cfg.Version = sarama.V3_5_0_0
    cfg.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{
        sarama.NewBalanceStrategySticky(),
        sarama.NewBalanceStrategyRoundRobin(),
    }
    cfg.Consumer.Offsets.Initial = sarama.OffsetOldest
    cfg.Consumer.Offsets.AutoCommit.Enable = true
    cfg.Consumer.Offsets.AutoCommit.Interval = 5 * time.Second

    client, err := sarama.NewConsumerGroup(brokers, groupID, cfg)
    if err != nil {
        return nil, fmt.Errorf("create consumer group: %w", err)
    }

    return &ConsumerGroup{
        client:  client,
        handler: &consumerGroupHandler{handler: handler, logger: logger},
        topics:  topics,
        logger:  logger,
    }, nil
}

// Run starts consuming messages until ctx is canceled.
func (cg *ConsumerGroup) Run(ctx context.Context) error {
    for {
        if err := cg.client.Consume(ctx, cg.topics, cg.handler); err != nil {
            if err == sarama.ErrClosedConsumerGroup {
                return nil
            }
            cg.logger.Error("consumer group error", "error", err)
            // Backoff before retrying
            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(5 * time.Second):
            }
        }

        if ctx.Err() != nil {
            return ctx.Err()
        }
    }
}
```

## NATS JetStream

NATS JetStream adds persistence and at-least-once delivery guarantees on top of NATS core messaging.

### JetStream Publisher with Acknowledgment

```go
package natsmq

import (
    "context"
    "fmt"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

type JetStreamPublisher struct {
    js     jetstream.JetStream
    stream string
}

func NewJetStreamPublisher(natsURL, streamName string, subjects []string) (*JetStreamPublisher, error) {
    nc, err := nats.Connect(natsURL,
        nats.MaxReconnects(-1),
        nats.ReconnectWait(2*time.Second),
        nats.DisconnectErrHandler(func(nc *nats.Conn, err error) {
            if err != nil {
                fmt.Printf("NATS disconnected: %v\n", err)
            }
        }),
        nats.ReconnectHandler(func(nc *nats.Conn) {
            fmt.Printf("NATS reconnected to %s\n", nc.ConnectedUrl())
        }),
    )
    if err != nil {
        return nil, fmt.Errorf("connect to nats: %w", err)
    }

    js, err := jetstream.New(nc)
    if err != nil {
        return nil, fmt.Errorf("create jetstream context: %w", err)
    }

    // Ensure stream exists (idempotent)
    _, err = js.CreateOrUpdateStream(context.Background(), jetstream.StreamConfig{
        Name:      streamName,
        Subjects:  subjects,
        Retention: jetstream.LimitsPolicy,
        MaxAge:    7 * 24 * time.Hour,  // 7 days retention
        MaxBytes:  10 * 1024 * 1024 * 1024,  // 10GB max
        Replicas:  3,
        Storage:   jetstream.FileStorage,
        // Discard old messages when limits are reached
        Discard: jetstream.DiscardOld,
    })
    if err != nil {
        return nil, fmt.Errorf("create/update stream %s: %w", streamName, err)
    }

    return &JetStreamPublisher{js: js, stream: streamName}, nil
}

// Publish sends a message and waits for server acknowledgment.
func (p *JetStreamPublisher) Publish(ctx context.Context, subject string, data []byte, headers map[string]string) (*jetstream.PubAck, error) {
    msg := &nats.Msg{
        Subject: subject,
        Data:    data,
        Header:  nats.Header{},
    }

    for k, v := range headers {
        msg.Header.Set(k, v)
    }
    msg.Header.Set("Published-At", time.Now().UTC().Format(time.RFC3339))

    // PublishMsg waits for the JetStream server to persist the message
    ack, err := p.js.PublishMsg(ctx, msg)
    if err != nil {
        return nil, fmt.Errorf("publish to subject %s: %w", subject, err)
    }

    return ack, nil
}
```

### JetStream Durable Consumer

```go
// Subscribe creates a durable push subscriber that delivers to a queue group.
func NewDurableConsumer(js jetstream.JetStream, streamName, consumerName, filterSubject string,
    handler func(jetstream.Msg)) (jetstream.ConsumeContext, error) {

    consumer, err := js.CreateOrUpdateConsumer(context.Background(), streamName, jetstream.ConsumerConfig{
        Name:          consumerName,
        Durable:       consumerName,
        FilterSubject: filterSubject,
        AckPolicy:     jetstream.AckExplicitPolicy,
        AckWait:       30 * time.Second,
        MaxDeliver:    5,
        MaxAckPending: 1000,
        DeliverPolicy: jetstream.DeliverNewPolicy,
        // Retry backoff: 1s, 5s, 30s on failure
        BackOff: []time.Duration{
            1 * time.Second,
            5 * time.Second,
            30 * time.Second,
        },
    })
    if err != nil {
        return nil, fmt.Errorf("create consumer %s: %w", consumerName, err)
    }

    return consumer.Consume(func(msg jetstream.Msg) {
        md, _ := msg.Metadata()

        ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
        defer cancel()

        _ = ctx // Pass to handler

        if err := func() error {
            handler(msg)
            return nil
        }(); err != nil {
            // Negative acknowledgment causes redelivery
            _ = msg.NakWithDelay(calculateBackoff(md.NumDelivered))
            return
        }

        // Positive acknowledgment removes from pending
        if err := msg.Ack(); err != nil {
            fmt.Printf("ack failed: %v\n", err)
        }
    })
}

func calculateBackoff(deliveryCount uint64) time.Duration {
    backoffs := []time.Duration{1 * time.Second, 5 * time.Second, 30 * time.Second, 5 * time.Minute}
    if int(deliveryCount) >= len(backoffs) {
        return backoffs[len(backoffs)-1]
    }
    return backoffs[deliveryCount]
}
```

### NATS Key-Value Store

JetStream includes a key-value store backed by a stream, suitable for distributed configuration and leader election:

```go
func NewKeyValueStore(js jetstream.JetStream, bucketName string, ttl time.Duration) (jetstream.KeyValue, error) {
    kv, err := js.CreateOrUpdateKeyValue(context.Background(), jetstream.KeyValueConfig{
        Bucket:  bucketName,
        TTL:     ttl,
        History: 5,  // Keep last 5 revisions for audit
        Storage: jetstream.FileStorage,
        Replicas: 3,
    })
    if err != nil {
        return nil, fmt.Errorf("create kv bucket %s: %w", bucketName, err)
    }
    return kv, nil
}

// Atomic compare-and-set using revision-based optimistic locking
func UpdateIfUnchanged(kv jetstream.KeyValue, key string, newValue []byte, expectedRevision uint64) error {
    _, err := kv.Update(context.Background(), key, newValue, expectedRevision)
    return err
}
```

## RabbitMQ with Publisher Confirms

### Connection with Reconnection

```go
package rabbitmq

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    amqp "github.com/rabbitmq/amqp091-go"
)

// Connection wraps an AMQP connection with automatic reconnection.
type Connection struct {
    url    string
    conn   *amqp.Connection
    logger *slog.Logger
    mu     sync.RWMutex
    closed chan struct{}
}

func NewConnection(url string, logger *slog.Logger) *Connection {
    c := &Connection{
        url:    url,
        logger: logger,
        closed: make(chan struct{}),
    }
    go c.reconnectLoop()
    return c
}

func (c *Connection) reconnectLoop() {
    for {
        select {
        case <-c.closed:
            return
        default:
        }

        conn, err := amqp.DialConfig(c.url, amqp.Config{
            Heartbeat: 10 * time.Second,
            Locale:    "en_US",
        })
        if err != nil {
            c.logger.Error("rabbitmq connect failed", "error", err)
            time.Sleep(5 * time.Second)
            continue
        }

        c.mu.Lock()
        c.conn = conn
        c.mu.Unlock()

        c.logger.Info("rabbitmq connected", "server", conn.RemoteAddr())

        // Block until connection closes
        closeErr := <-conn.NotifyClose(make(chan *amqp.Error, 1))
        c.logger.Warn("rabbitmq connection closed", "error", closeErr)
    }
}

func (c *Connection) Channel() (*amqp.Channel, error) {
    c.mu.RLock()
    conn := c.conn
    c.mu.RUnlock()

    if conn == nil || conn.IsClosed() {
        return nil, fmt.Errorf("connection not available")
    }
    return conn.Channel()
}
```

### Publisher with Confirms

Publisher confirms ensure that the broker has durably written the message before the publisher considers it sent:

```go
type Publisher struct {
    conn    *Connection
    channel *amqp.Channel
    confirms chan amqp.Confirmation
    logger  *slog.Logger
    mu      sync.Mutex
}

func NewPublisher(conn *Connection, logger *slog.Logger) (*Publisher, error) {
    ch, err := conn.Channel()
    if err != nil {
        return nil, fmt.Errorf("open channel: %w", err)
    }

    // Enable publisher confirms
    if err := ch.Confirm(false); err != nil {
        ch.Close()
        return nil, fmt.Errorf("enable confirms: %w", err)
    }

    confirms := ch.NotifyPublish(make(chan amqp.Confirmation, 100))

    return &Publisher{
        conn:     conn,
        channel:  ch,
        confirms: confirms,
        logger:   logger,
    }, nil
}

// Publish sends a message and waits for broker confirmation.
func (p *Publisher) Publish(ctx context.Context, exchange, routingKey string, body []byte) error {
    p.mu.Lock()
    defer p.mu.Unlock()

    err := p.channel.PublishWithContext(ctx,
        exchange,
        routingKey,
        true,   // mandatory: return if no queue matches
        false,  // immediate: not supported in newer RabbitMQ
        amqp.Publishing{
            ContentType:  "application/json",
            DeliveryMode: amqp.Persistent,  // Survive broker restart
            Body:         body,
            Timestamp:    time.Now(),
            Headers: amqp.Table{
                "x-published-by": "go-publisher",
            },
        },
    )
    if err != nil {
        return fmt.Errorf("publish: %w", err)
    }

    // Wait for acknowledgment with timeout
    select {
    case confirm, ok := <-p.confirms:
        if !ok {
            return fmt.Errorf("confirms channel closed")
        }
        if !confirm.Ack {
            return fmt.Errorf("broker nacked message (delivery tag: %d)", confirm.DeliveryTag)
        }
        return nil
    case <-ctx.Done():
        return fmt.Errorf("confirm wait: %w", ctx.Err())
    }
}
```

### Consumer with Prefetch

```go
type Consumer struct {
    channel *amqp.Channel
    queue   string
    logger  *slog.Logger
}

func NewConsumer(conn *Connection, queue string, prefetchCount int, logger *slog.Logger) (*Consumer, error) {
    ch, err := conn.Channel()
    if err != nil {
        return nil, fmt.Errorf("open channel: %w", err)
    }

    // Prefetch limits unacknowledged messages per consumer
    // Set to 1 for strict ordering; higher values for throughput
    if err := ch.Qos(prefetchCount, 0, false); err != nil {
        ch.Close()
        return nil, fmt.Errorf("set qos: %w", err)
    }

    // Declare queue as durable (survives broker restart)
    _, err = ch.QueueDeclare(queue,
        true,  // durable
        false, // auto-delete
        false, // exclusive
        false, // no-wait
        amqp.Table{
            "x-queue-type":      "quorum",  // Quorum queues for HA
            "x-dead-letter-exchange": queue + ".dlx",
            "x-message-ttl":     int64(24 * time.Hour / time.Millisecond),
        },
    )
    if err != nil {
        ch.Close()
        return nil, fmt.Errorf("declare queue %s: %w", queue, err)
    }

    return &Consumer{channel: ch, queue: queue, logger: logger}, nil
}

func (c *Consumer) Consume(ctx context.Context, handler func([]byte) error) error {
    deliveries, err := c.channel.Consume(
        c.queue,
        "",    // consumer tag (auto-generated)
        false, // auto-ack: disabled for manual ack
        false, // exclusive
        false, // no-local
        false, // no-wait
        nil,
    )
    if err != nil {
        return fmt.Errorf("start consuming: %w", err)
    }

    for {
        select {
        case <-ctx.Done():
            return nil
        case delivery, ok := <-deliveries:
            if !ok {
                return fmt.Errorf("delivery channel closed")
            }

            if err := handler(delivery.Body); err != nil {
                c.logger.Error("handler failed",
                    "delivery_tag", delivery.DeliveryTag,
                    "redelivered", delivery.Redelivered,
                    "error", err,
                )
                // Nack with requeue=false (send to DLX) after max retries
                requeue := !delivery.Redelivered
                _ = delivery.Nack(false, requeue)
                continue
            }

            _ = delivery.Ack(false)
        }
    }
}
```

### Dead Letter Queue Setup

```go
func setupDeadLetterQueue(ch *amqp.Channel, originalQueue string) error {
    dlxName := originalQueue + ".dlx"
    dlqName := originalQueue + ".dlq"

    // Declare dead letter exchange
    if err := ch.ExchangeDeclare(dlxName, "direct", true, false, false, false, nil); err != nil {
        return fmt.Errorf("declare dlx %s: %w", dlxName, err)
    }

    // Declare dead letter queue
    if _, err := ch.QueueDeclare(dlqName, true, false, false, false,
        amqp.Table{
            "x-queue-type": "quorum",
        },
    ); err != nil {
        return fmt.Errorf("declare dlq %s: %w", dlqName, err)
    }

    // Bind DLQ to DLX
    return ch.QueueBind(dlqName, originalQueue, dlxName, false, nil)
}
```

## Outbox Pattern for Transactional Publishing

The outbox pattern solves the dual-write problem: how to atomically update a database and publish a message. Without it, a process crash between the database commit and the message publish leaves the system in an inconsistent state.

### Schema

```sql
CREATE TABLE outbox_messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic       TEXT NOT NULL,
    key         TEXT,
    payload     JSONB NOT NULL,
    headers     JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    attempts    INT NOT NULL DEFAULT 0,
    last_error  TEXT,
    -- Partitioning key for worker distribution
    shard       INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_outbox_unpublished ON outbox_messages (shard, created_at)
    WHERE published_at IS NULL;
CREATE INDEX idx_outbox_published_cleanup ON outbox_messages (published_at)
    WHERE published_at IS NOT NULL;
```

### Transactional Write

```go
package outbox

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "math/rand"

    "github.com/google/uuid"
)

type OutboxMessage struct {
    ID      uuid.UUID
    Topic   string
    Key     string
    Payload interface{}
    Headers map[string]string
}

// WriteWithTx inserts an outbox message inside an existing database transaction.
// The caller is responsible for committing or rolling back the transaction.
func WriteWithTx(ctx context.Context, tx *sql.Tx, msg OutboxMessage) error {
    payloadJSON, err := json.Marshal(msg.Payload)
    if err != nil {
        return fmt.Errorf("marshal payload: %w", err)
    }

    headersJSON, err := json.Marshal(msg.Headers)
    if err != nil {
        return fmt.Errorf("marshal headers: %w", err)
    }

    shard := rand.Intn(16)

    _, err = tx.ExecContext(ctx, `
        INSERT INTO outbox_messages (id, topic, key, payload, headers, shard)
        VALUES ($1, $2, $3, $4, $5, $6)
    `, msg.ID, msg.Topic, msg.Key, payloadJSON, headersJSON, shard)

    return err
}

// Example of atomic order + outbox write
func CreateOrder(ctx context.Context, db *sql.DB, publisher *Publisher, order Order) error {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback()

    // Business operation
    if _, err := tx.ExecContext(ctx,
        `INSERT INTO orders (id, user_id, amount, status) VALUES ($1, $2, $3, $4)`,
        order.ID, order.UserID, order.Amount, "created",
    ); err != nil {
        return fmt.Errorf("insert order: %w", err)
    }

    // Outbox write — atomic with the order insert
    if err := WriteWithTx(ctx, tx, OutboxMessage{
        ID:    uuid.New(),
        Topic: "orders.created",
        Key:   order.ID.String(),
        Payload: map[string]interface{}{
            "order_id": order.ID,
            "user_id":  order.UserID,
            "amount":   order.Amount,
        },
        Headers: map[string]string{
            "event-type": "order.created",
            "version":    "1",
        },
    }); err != nil {
        return fmt.Errorf("write outbox: %w", err)
    }

    return tx.Commit()
}
```

### Outbox Relay Worker

```go
// Relay polls the outbox and publishes unpublished messages.
type Relay struct {
    db        *sql.DB
    publisher MessagePublisher
    shard     int
    batchSize int
    logger    *slog.Logger
}

func (r *Relay) Run(ctx context.Context) error {
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            if err := r.processOutbox(ctx); err != nil {
                r.logger.Error("outbox relay failed", "error", err)
            }
        }
    }
}

func (r *Relay) processOutbox(ctx context.Context) error {
    rows, err := r.db.QueryContext(ctx, `
        SELECT id, topic, key, payload, headers
        FROM outbox_messages
        WHERE published_at IS NULL
          AND shard = $1
          AND attempts < 5
        ORDER BY created_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
    `, r.shard, r.batchSize)
    if err != nil {
        return fmt.Errorf("query outbox: %w", err)
    }
    defer rows.Close()

    for rows.Next() {
        var id uuid.UUID
        var topic, key string
        var payload, headers json.RawMessage

        if err := rows.Scan(&id, &topic, &key, &payload, &headers); err != nil {
            return fmt.Errorf("scan row: %w", err)
        }

        var headerMap map[string]string
        _ = json.Unmarshal(headers, &headerMap)

        // Publish to the message broker
        publishErr := r.publisher.Publish(ctx, topic, key, payload, headerMap)

        if publishErr != nil {
            r.logger.Error("publish failed",
                "message_id", id,
                "topic", topic,
                "error", publishErr,
            )
            _, _ = r.db.ExecContext(ctx, `
                UPDATE outbox_messages
                SET attempts = attempts + 1, last_error = $2
                WHERE id = $1
            `, id, publishErr.Error())
            continue
        }

        // Mark as published
        _, err = r.db.ExecContext(ctx, `
            UPDATE outbox_messages
            SET published_at = NOW()
            WHERE id = $1
        `, id)
        if err != nil {
            r.logger.Error("mark published failed", "message_id", id, "error", err)
        }
    }

    return rows.Err()
}
```

## Message Schema Versioning

Schema evolution is inevitable. Use a versioned envelope to ensure consumers can handle both old and new message formats:

```go
package schema

import (
    "encoding/json"
    "fmt"
)

// Envelope wraps any message with schema metadata.
type Envelope struct {
    SchemaVersion int             `json:"schema_version"`
    EventType     string          `json:"event_type"`
    EventID       string          `json:"event_id"`
    OccurredAt    time.Time       `json:"occurred_at"`
    Payload       json.RawMessage `json:"payload"`
}

// Decode dispatches to the correct handler based on schema version.
func DecodeOrderCreated(data []byte) (interface{}, error) {
    var env Envelope
    if err := json.Unmarshal(data, &env); err != nil {
        return nil, fmt.Errorf("unmarshal envelope: %w", err)
    }

    switch env.SchemaVersion {
    case 1:
        var v1 OrderCreatedV1
        if err := json.Unmarshal(env.Payload, &v1); err != nil {
            return nil, fmt.Errorf("unmarshal v1: %w", err)
        }
        // Upcast v1 to current model
        return v1.ToCurrentVersion(), nil

    case 2:
        var v2 OrderCreatedV2
        if err := json.Unmarshal(env.Payload, &v2); err != nil {
            return nil, fmt.Errorf("unmarshal v2: %w", err)
        }
        return &v2, nil

    default:
        return nil, fmt.Errorf("unknown schema version: %d", env.SchemaVersion)
    }
}
```

## Summary

Kafka, NATS JetStream, and RabbitMQ each suit different reliability and throughput requirements. Kafka's idempotent producer with `WaitForAll` acknowledgment and consumer group rebalancing provides the strongest durability guarantees at high throughput. NATS JetStream provides similar durability with a simpler operational model and built-in key-value store. RabbitMQ's publisher confirms and quorum queues provide strong single-message guarantees with routing flexibility that streams lack.

The outbox pattern resolves the dual-write problem that trips up every team building event-driven microservices. The additional operational cost — a background relay process and a database table — is substantially lower than the cost of debugging inconsistent state caused by lost messages after partial failures.
