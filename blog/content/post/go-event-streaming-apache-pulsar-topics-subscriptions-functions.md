---
title: "Go Event Streaming with Apache Pulsar: Topics, Subscriptions, and Functions"
date: 2029-11-16T00:00:00-05:00
draft: false
tags: ["Go", "Apache Pulsar", "Event Streaming", "Messaging", "Distributed Systems"]
categories: ["Go", "Distributed Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Apache Pulsar with Go: client setup, subscription modes (exclusive/shared/failover/key_shared), Pulsar Functions, schema registry, and geo-replication for production event streaming."
more_link: "yes"
url: "/go-event-streaming-apache-pulsar-topics-subscriptions-functions/"
---

Apache Pulsar has established itself as a compelling alternative to Kafka for organizations that need multi-tenancy, built-in geo-replication, and a unified messaging and streaming model. Its architecture — separating the serving layer (brokers) from the storage layer (BookKeeper) — enables independent scaling and simplifies operations. This guide covers building production-grade event streaming systems in Go using the official Pulsar Go client, covering all four subscription modes, Pulsar Functions for lightweight stream processing, schema enforcement, and geo-replication configuration.

<!--more-->

# Go Event Streaming with Apache Pulsar: Topics, Subscriptions, and Functions

## Pulsar Architecture Overview

Before diving into Go code, understanding Pulsar's layered architecture is critical for making correct design decisions.

### Components

**Brokers**: Stateless serving layer. Brokers handle producer/consumer connections, enforce access control, and coordinate message acknowledgment. Because brokers are stateless, scaling is as simple as adding more broker instances.

**BookKeeper (Bookie nodes)**: Persistent storage layer. Bookies store message data in a distributed log (ledger). Pulsar writes each message to a configurable number of bookies (write quorum), with a configurable acknowledgment quorum. This architecture enables data durability independent of broker availability.

**ZooKeeper**: Coordinates broker discovery, topic ownership, and cluster metadata. ZooKeeper (or the newer KIP-500-style metadata store) is the coordination plane.

**Pulsar Proxy**: Optional stateless proxy that clients can connect to instead of brokers directly, simplifying network topology in Kubernetes or multi-tenant environments.

### Topic Naming

Pulsar uses a three-level naming hierarchy:

```
persistent://tenant/namespace/topic-name
non-persistent://tenant/namespace/topic-name

# Examples:
persistent://fintech/payments/transactions
persistent://fintech/payments/transactions-dlq
non-persistent://analytics/realtime/clickstream

# Partitioned topic (Pulsar manages partitions internally)
persistent://fintech/payments/transactions-partition-0
persistent://fintech/payments/transactions-partition-1
```

## Setting Up the Go Client

```bash
go get github.com/apache/pulsar-client-go/pulsar@latest
```

### Client Configuration

```go
package main

import (
    "context"
    "crypto/tls"
    "log"
    "time"

    "github.com/apache/pulsar-client-go/pulsar"
)

func NewPulsarClient() (pulsar.Client, error) {
    client, err := pulsar.NewClient(pulsar.ClientOptions{
        URL: "pulsar+ssl://pulsar-broker.prod.internal:6651",

        // TLS configuration
        TLSConfig: &tls.Config{
            InsecureSkipVerify: false,
        },
        TLSTrustCertsFilePath: "/etc/pulsar/certs/ca.crt",

        // JWT authentication (common in production)
        Authentication: pulsar.NewAuthenticationToken(
            func() (string, error) {
                // Token refresh function — read from secrets manager
                return readTokenFromVault("/secret/pulsar/jwt-token")
            },
        ),

        // Connection settings
        ConnectionTimeout:    10 * time.Second,
        OperationTimeout:     30 * time.Second,
        MaxConnectionsPerBroker: 1,

        // Logging
        Logger: pulsar.NewLoggerWithLogrus(log.New(
            log.Writer(), "[pulsar] ", log.LstdFlags,
        )),
    })

    return client, err
}

// For local development
func NewLocalPulsarClient() (pulsar.Client, error) {
    return pulsar.NewClient(pulsar.ClientOptions{
        URL:              "pulsar://localhost:6650",
        OperationTimeout: 30 * time.Second,
        ConnectionTimeout: 30 * time.Second,
    })
}
```

## Producers: Publishing Messages

### Basic Producer

```go
package messaging

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/apache/pulsar-client-go/pulsar"
)

type TransactionEvent struct {
    ID          string    `json:"id"`
    UserID      string    `json:"user_id"`
    Amount      float64   `json:"amount"`
    Currency    string    `json:"currency"`
    MerchantID  string    `json:"merchant_id"`
    Timestamp   time.Time `json:"timestamp"`
    Status      string    `json:"status"`
}

type TransactionProducer struct {
    producer pulsar.Producer
}

func NewTransactionProducer(client pulsar.Client) (*TransactionProducer, error) {
    producer, err := client.CreateProducer(pulsar.ProducerOptions{
        Topic: "persistent://fintech/payments/transactions",

        // Producer name — must be unique across all producers for this topic
        // If not set, Pulsar generates one automatically
        Name: "transactions-producer-v2",

        // Routing mode for partitioned topics
        MessageRouter: nil, // Use default routing (round-robin)

        // Batching: group messages for higher throughput
        BatchingEnabled:          true,
        BatchingMaxMessages:      1000,
        BatchingMaxPublishDelay:  10 * time.Millisecond,
        BatchingMaxSize:          128 * 1024, // 128KB max batch size

        // Compression
        CompressionType: pulsar.LZ4,

        // Send timeout
        SendTimeout: 30 * time.Second,

        // Message properties — applied to all messages from this producer
        Properties: map[string]string{
            "producer-version": "2.0",
            "region":           "us-east-1",
        },

        // Block if the send queue is full (backpressure)
        BlockIfQueueFull: true,
        MaxPendingMessages: 1000,
    })

    if err != nil {
        return nil, fmt.Errorf("creating transaction producer: %w", err)
    }

    return &TransactionProducer{producer: producer}, nil
}

// PublishSync publishes synchronously and returns the message ID
func (p *TransactionProducer) PublishSync(
    ctx context.Context,
    event *TransactionEvent,
) (pulsar.MessageID, error) {
    payload, err := json.Marshal(event)
    if err != nil {
        return nil, fmt.Errorf("marshaling event: %w", err)
    }

    msgID, err := p.producer.Send(ctx, &pulsar.ProducerMessage{
        Payload: payload,

        // Routing key — determines which partition receives the message
        // Using UserID ensures all events for a user go to the same partition
        Key: event.UserID,

        // Per-message properties
        Properties: map[string]string{
            "event-type": "transaction",
            "version":    "1",
        },

        // Event time (separate from publish time)
        EventTime: event.Timestamp,

        // Sequence ID for deduplication (optional)
        // SequenceID: &event.SequenceNumber,
    })

    return msgID, err
}

// PublishAsync publishes without blocking
func (p *TransactionProducer) PublishAsync(
    ctx context.Context,
    event *TransactionEvent,
    callback func(msgID pulsar.MessageID, msg *pulsar.ProducerMessage, err error),
) error {
    payload, err := json.Marshal(event)
    if err != nil {
        return fmt.Errorf("marshaling event: %w", err)
    }

    p.producer.SendAsync(ctx, &pulsar.ProducerMessage{
        Payload:   payload,
        Key:       event.UserID,
        EventTime: event.Timestamp,
    }, callback)

    return nil
}

func (p *TransactionProducer) Close() {
    p.producer.Close()
}
```

## Subscription Modes: The Core Pulsar Differentiator

Pulsar's four subscription modes give architects a level of messaging flexibility that Kafka alone cannot match. Understanding when to use each mode is critical.

### Exclusive Subscription

Only one consumer can be active at a time. If a second consumer tries to subscribe with the same subscription name, it gets an error. This is the default mode and maps to traditional queue semantics where a single consumer must process messages in order.

**Use case**: Single-consumer ordered processing, leader election-style processing, strict serial state machines.

```go
func NewExclusiveConsumer(client pulsar.Client) (pulsar.Consumer, error) {
    return client.Subscribe(pulsar.ConsumerOptions{
        Topic:            "persistent://fintech/payments/transactions",
        SubscriptionName: "payment-processor-exclusive",
        Type:             pulsar.Exclusive,  // Default

        // Start consuming from the earliest unacked message
        SubscriptionInitialPosition: pulsar.SubscriptionPositionEarliest,

        // Prefetch limit — how many messages to buffer in consumer
        ReceiverQueueSize: 100,

        // Negative acknowledgment redelivery delay
        NackRedeliveryDelay: 30 * time.Second,

        // Dead letter policy
        DLQ: &pulsar.DLQPolicy{
            MaxDeliveries:   3,
            DeadLetterTopic: "persistent://fintech/payments/transactions-dlq",
        },
    })
}

func ProcessExclusive(consumer pulsar.Consumer) {
    ctx := context.Background()
    for {
        msg, err := consumer.Receive(ctx)
        if err != nil {
            log.Printf("receive error: %v", err)
            continue
        }

        var event TransactionEvent
        if err := json.Unmarshal(msg.Payload(), &event); err != nil {
            log.Printf("unmarshal error: %v, nacking", err)
            consumer.Nack(msg) // Trigger redelivery
            continue
        }

        if err := processTransaction(&event); err != nil {
            log.Printf("processing error: %v, nacking", err)
            consumer.Nack(msg)
            continue
        }

        consumer.Ack(msg)
    }
}
```

### Shared (Round-Robin) Subscription

Multiple consumers share the same subscription. Messages are distributed round-robin across active consumers. Any consumer can acknowledge any message — messages are not ordered within the subscription.

**Use case**: High-throughput parallel processing where order does not matter, worker pools, background job processing.

```go
func NewSharedConsumer(client pulsar.Client, consumerName string) (pulsar.Consumer, error) {
    return client.Subscribe(pulsar.ConsumerOptions{
        Topic:            "persistent://fintech/payments/transactions",
        SubscriptionName: "fraud-detection-shared",
        Type:             pulsar.Shared,

        // Multiple consumers can subscribe simultaneously
        // Each consumer processes a subset of messages

        ReceiverQueueSize: 500, // Larger queue for parallel processing
        NackRedeliveryDelay: 60 * time.Second,

        DLQ: &pulsar.DLQPolicy{
            MaxDeliveries:   5,
            DeadLetterTopic: "persistent://fintech/payments/fraud-dlq",
        },
    })
}

// Shared subscription worker pool pattern
func RunSharedWorkerPool(client pulsar.Client, workerCount int) {
    var wg sync.WaitGroup

    for i := 0; i < workerCount; i++ {
        wg.Add(1)
        workerID := i

        go func() {
            defer wg.Done()

            consumer, err := NewSharedConsumer(client, fmt.Sprintf("worker-%d", workerID))
            if err != nil {
                log.Printf("worker %d: failed to create consumer: %v", workerID, err)
                return
            }
            defer consumer.Close()

            for {
                msg, err := consumer.Receive(context.Background())
                if err != nil {
                    log.Printf("worker %d: receive error: %v", workerID, err)
                    return
                }

                // Each worker processes independently
                if err := processMessage(msg); err != nil {
                    consumer.Nack(msg)
                } else {
                    consumer.Ack(msg)
                }
            }
        }()
    }

    wg.Wait()
}
```

### Failover Subscription

One consumer is the "master" and receives all messages. If the master disconnects, Pulsar promotes another consumer. Messages are ordered within the subscription as long as the master is active.

**Use case**: High-availability ordered processing. You want exactly one consumer active with automatic failover, similar to Kafka consumer groups on a single partition.

```go
func NewFailoverConsumer(client pulsar.Client, priority int) (pulsar.Consumer, error) {
    return client.Subscribe(pulsar.ConsumerOptions{
        Topic:            "persistent://fintech/payments/transactions",
        SubscriptionName: "audit-log-failover",
        Type:             pulsar.Failover,

        // Priority determines which consumer becomes master
        // Lower priority value = preferred master
        // Consumer with priority 0 becomes master; priority 1 is standby
        PriorityLevel: priority,

        ReceiverQueueSize: 200,
    })
}

// Deploy two instances: one with priority 0 (active), one with priority 1 (standby)
func main() {
    client, _ := NewPulsarClient()
    defer client.Close()

    // Determine priority from environment or configuration
    priority := 0 // 0 = preferred master, 1 = standby

    consumer, err := NewFailoverConsumer(client, priority)
    if err != nil {
        log.Fatalf("creating failover consumer: %v", err)
    }
    defer consumer.Close()

    log.Printf("starting failover consumer with priority %d", priority)
    ProcessExclusive(consumer) // Same processing logic as exclusive
}
```

### Key_Shared Subscription

Messages with the same key always go to the same consumer. Unlike Shared mode (round-robin), key_shared provides ordering guarantees per key while still allowing parallel processing across different keys. This is the most powerful and most complex subscription mode.

**Use case**: Ordered processing per entity (per-user, per-account, per-device) with horizontal scaling. This maps to Kafka partition-per-key semantics but with more flexible consumer management.

```go
func NewKeySharedConsumer(
    client pulsar.Client,
    consumerID string,
) (pulsar.Consumer, error) {
    return client.Subscribe(pulsar.ConsumerOptions{
        Topic:            "persistent://fintech/payments/transactions",
        SubscriptionName: "user-state-machine-key-shared",
        Type:             pulsar.KeyShared,

        // Key-shared policy: auto-split (default) or sticky
        // Auto-split: Pulsar automatically distributes keys across consumers
        // Sticky: Each consumer declares which key ranges it handles
        KeySharedPolicy: &pulsar.KeySharedPolicy{
            Mode: pulsar.KeySharedPolicyModeAutoSplit,
        },

        ReceiverQueueSize: 1000,
    })
}

// Key_Shared ensures all messages for a given UserID go to the same consumer
// This allows per-user state machines without distributed locking
type UserStateMachine struct {
    state map[string]*UserState // keyed by UserID — safe, single consumer per key
    mu    sync.Mutex            // only needed if consumer.Receive is called concurrently
}

func (sm *UserStateMachine) Process(client pulsar.Client) {
    consumer, err := NewKeySharedConsumer(client, "state-machine-1")
    if err != nil {
        log.Fatalf("creating key_shared consumer: %v", err)
    }
    defer consumer.Close()

    for {
        msg, err := consumer.Receive(context.Background())
        if err != nil {
            log.Printf("receive error: %v", err)
            return
        }

        userID := msg.Key() // This is the routing key we set on publish

        var event TransactionEvent
        if err := json.Unmarshal(msg.Payload(), &event); err != nil {
            consumer.Nack(msg)
            continue
        }

        // Safe: only this consumer sees messages for this userID
        // No distributed locking needed for per-user state
        sm.mu.Lock()
        state := sm.getOrCreateState(userID)
        err = sm.applyEvent(state, &event)
        sm.mu.Unlock()

        if err != nil {
            consumer.Nack(msg)
        } else {
            consumer.Ack(msg)
        }
    }
}
```

### Subscription Mode Comparison

| Mode | Ordering | Parallelism | Failover | Use Case |
|------|----------|-------------|----------|----------|
| Exclusive | Global | No | Manual | Strict serial processing |
| Failover | Global | No | Automatic | HA serial processing |
| Shared | None | Yes | N/A (any consumer) | Worker pools |
| Key_Shared | Per-key | Per-key parallel | Automatic rebalance | Stateful per-entity |

## Reader API: Replaying from Any Position

Unlike consumers (which track subscription state), readers allow arbitrary replay without affecting subscription cursors:

```go
func NewTransactionReader(
    client pulsar.Client,
    startMessageID pulsar.MessageID,
) (pulsar.Reader, error) {
    return client.CreateReader(pulsar.ReaderOptions{
        Topic:          "persistent://fintech/payments/transactions",
        StartMessageID: startMessageID,
        // Options: pulsar.EarliestMessageID()  — replay from beginning
        //          pulsar.LatestMessageID()    — read only new messages
        //          specific MessageID          — resume from checkpoint

        ReceiverQueueSize: 100,
        ReaderName:        "audit-replayer",
    })
}

func ReplayTransactions(client pulsar.Client, from time.Time) error {
    // Seek to a specific time
    reader, err := client.CreateReader(pulsar.ReaderOptions{
        Topic:                   "persistent://fintech/payments/transactions",
        StartMessageID:          pulsar.EarliestMessageID(),
        StartMessageIDInclusive: true,
    })
    if err != nil {
        return err
    }
    defer reader.Close()

    // Seek to time
    if err := reader.SeekByTime(from); err != nil {
        return fmt.Errorf("seeking to time %v: %w", from, err)
    }

    ctx := context.Background()
    for reader.HasNext() {
        msg, err := reader.Next(ctx)
        if err != nil {
            return fmt.Errorf("reading message: %w", err)
        }

        var event TransactionEvent
        if err := json.Unmarshal(msg.Payload(), &event); err != nil {
            log.Printf("skipping malformed message %s: %v", msg.ID(), err)
            continue
        }

        if err := auditRecord(&event); err != nil {
            return fmt.Errorf("auditing event %s: %w", event.ID, err)
        }
    }

    return nil
}
```

## Schema Registry

Pulsar's built-in schema registry enforces message structure, preventing producers from publishing incompatible payloads.

### JSON Schema

```go
package schema

import (
    "github.com/apache/pulsar-client-go/pulsar"
)

type PaymentEvent struct {
    ID         string  `json:"id"`
    Amount     float64 `json:"amount"`
    Currency   string  `json:"currency"`
    MerchantID string  `json:"merchant_id"`
}

func NewSchemaProducer(client pulsar.Client) (pulsar.Producer, error) {
    // Pulsar will enforce this schema on all messages
    jsonSchema := pulsar.NewJSONSchema(PaymentEvent{}, nil)

    return client.CreateProducer(pulsar.ProducerOptions{
        Topic:  "persistent://fintech/payments/events",
        Schema: jsonSchema,
    })
}

func PublishWithSchema(producer pulsar.Producer, event *PaymentEvent) error {
    ctx := context.Background()
    _, err := producer.Send(ctx, &pulsar.ProducerMessage{
        Value: event, // Pass struct directly — schema handles serialization
    })
    return err
}

func NewSchemaConsumer(client pulsar.Client) (pulsar.Consumer, error) {
    jsonSchema := pulsar.NewJSONSchema(PaymentEvent{}, nil)

    return client.Subscribe(pulsar.ConsumerOptions{
        Topic:            "persistent://fintech/payments/events",
        SubscriptionName: "payment-handler",
        Type:             pulsar.Shared,
        Schema:           jsonSchema,
    })
}

func ConsumeWithSchema(consumer pulsar.Consumer) {
    for {
        msg, err := consumer.Receive(context.Background())
        if err != nil {
            log.Printf("receive error: %v", err)
            return
        }

        var event PaymentEvent
        if err := msg.GetSchemaValue(&event); err != nil {
            log.Printf("schema deserialization error: %v", err)
            consumer.Nack(msg)
            continue
        }

        log.Printf("received payment: id=%s amount=%.2f %s",
            event.ID, event.Amount, event.Currency)
        consumer.Ack(msg)
    }
}
```

### Avro Schema

```go
const avroSchema = `{
    "type": "record",
    "name": "PaymentEvent",
    "namespace": "com.fintech.payments",
    "fields": [
        {"name": "id", "type": "string"},
        {"name": "amount", "type": "double"},
        {"name": "currency", "type": "string"},
        {"name": "merchant_id", "type": "string"},
        {"name": "timestamp", "type": "long", "logicalType": "timestamp-millis"}
    ]
}`

func NewAvroProducer(client pulsar.Client) (pulsar.Producer, error) {
    avSchema := pulsar.NewAvroSchema(avroSchema, nil)

    return client.CreateProducer(pulsar.ProducerOptions{
        Topic:  "persistent://fintech/payments/avro-events",
        Schema: avSchema,
    })
}
```

### Schema Evolution and Compatibility

```bash
# Configure schema compatibility strategy via pulsar-admin CLI

# BACKWARD: New schema can read old data (add fields with defaults, remove fields)
pulsar-admin schemas compatibility \
  --strategy BACKWARD \
  persistent://fintech/payments/events

# FORWARD: Old schema can read new data
# FULL: Both backward and forward compatible
# ALWAYS_COMPATIBLE: No compatibility checking
# ALWAYS_INCOMPATIBLE: All schema changes rejected

# Check schema compatibility before deploying new producer
pulsar-admin schemas compatibility \
  --filename /path/to/new-schema.json \
  persistent://fintech/payments/events
```

## Pulsar Functions: Serverless Stream Processing

Pulsar Functions are lightweight, stateful compute processes that run within the Pulsar cluster itself. They consume from input topics, perform computation, and optionally publish to output topics.

### Writing a Pulsar Function in Go

```go
// functions/fraud_detector.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "math"

    "github.com/apache/pulsar/pulsar-function-go/pf"
)

type TransactionInput struct {
    ID         string  `json:"id"`
    UserID     string  `json:"user_id"`
    Amount     float64 `json:"amount"`
    MerchantID string  `json:"merchant_id"`
}

type FraudAlert struct {
    TransactionID string  `json:"transaction_id"`
    UserID        string  `json:"user_id"`
    Amount        float64 `json:"amount"`
    RiskScore     float64 `json:"risk_score"`
    Reason        string  `json:"reason"`
}

// FraudDetector is the Pulsar Function implementation
type FraudDetector struct{}

func (fd *FraudDetector) Process(ctx pf.FunctionContext, input []byte) interface{} {
    var tx TransactionInput
    if err := json.Unmarshal(input, &tx); err != nil {
        // Log error but return nil (no output message)
        ctx.GetLogger().Errorf("unmarshal error: %v", err)
        return nil
    }

    riskScore := fd.calculateRiskScore(ctx, &tx)

    if riskScore > 0.7 {
        alert := FraudAlert{
            TransactionID: tx.ID,
            UserID:        tx.UserID,
            Amount:        tx.Amount,
            RiskScore:     riskScore,
            Reason:        fd.getReason(riskScore, &tx),
        }

        alertJSON, _ := json.Marshal(&alert)

        // Publish to a different topic (output topic configured in function deployment)
        ctx.GetLogger().Infof("fraud alert: txID=%s score=%.2f", tx.ID, riskScore)

        return alertJSON
    }

    return nil // No output for non-fraudulent transactions
}

func (fd *FraudDetector) calculateRiskScore(
    ctx pf.FunctionContext,
    tx *TransactionInput,
) float64 {
    score := 0.0

    // Large amount check
    if tx.Amount > 10000 {
        score += 0.4
    } else if tx.Amount > 5000 {
        score += 0.2
    }

    // Velocity check using function state (per-user counter)
    stateStore := ctx.GetStateStore()
    key := fmt.Sprintf("tx_count_1h_%s", tx.UserID)
    count, _ := stateStore.GetCounter(key)

    if count > 10 {
        score += 0.5
    } else if count > 5 {
        score += 0.2
    }

    // Increment counter (TTL managed externally or by function logic)
    stateStore.IncrCounter(key, 1)

    return math.Min(score, 1.0)
}

func (fd *FraudDetector) getReason(score float64, tx *TransactionInput) string {
    if tx.Amount > 10000 {
        return "high_value_transaction"
    }
    return "velocity_exceeded"
}

func main() {
    pf.Start(&FraudDetector{})
}
```

### Deploying Pulsar Functions

```bash
# Build Go function binary
GOOS=linux GOARCH=amd64 go build -o fraud-detector ./functions/

# Deploy via pulsar-admin CLI
pulsar-admin functions create \
  --name fraud-detector \
  --go fraud-detector \
  --inputs persistent://fintech/payments/transactions \
  --output persistent://fintech/payments/fraud-alerts \
  --tenant fintech \
  --namespace payments \
  --parallelism 4 \
  --max-message-retries 3 \
  --dead-letter-topic persistent://fintech/payments/fraud-dlq \
  --log-topic persistent://fintech/payments/fraud-logs \
  --processing-guarantees ATLEAST_ONCE

# Update a running function
pulsar-admin functions update \
  --name fraud-detector \
  --parallelism 8

# Get function status
pulsar-admin functions status --name fraud-detector

# Get function stats
pulsar-admin functions stats --name fraud-detector
```

### Function Processing Guarantees

```bash
# ATLEAST_ONCE: Message may be processed multiple times
# Appropriate when processing is idempotent

# ATMOST_ONCE: Message may be dropped, never duplicated
# Appropriate for metrics/analytics where loss is acceptable

# EFFECTIVELY_ONCE: Pulsar guarantees exactly-once semantics
# Requires stateful sources and sinks, highest overhead
pulsar-admin functions create \
  --name payment-aggregator \
  --processing-guarantees EFFECTIVELY_ONCE \
  --inputs persistent://fintech/payments/transactions \
  --output persistent://fintech/payments/aggregates
```

## Geo-Replication

Pulsar's native geo-replication replicates messages across clusters automatically, without application-level logic.

### Configuring Geo-Replication

```bash
# Step 1: Create clusters in each region
pulsar-admin clusters create us-east-1 \
  --broker-url pulsar://pulsar-us-east.internal:6650 \
  --url http://pulsar-us-east.internal:8080

pulsar-admin clusters create eu-west-1 \
  --broker-url pulsar://pulsar-eu-west.internal:6650 \
  --url http://pulsar-eu-west.internal:8080

pulsar-admin clusters create ap-southeast-1 \
  --broker-url pulsar://pulsar-ap-southeast.internal:6650 \
  --url http://pulsar-ap-southeast.internal:8080

# Step 2: Create a tenant that spans all clusters
pulsar-admin tenants create fintech \
  --allowed-clusters us-east-1,eu-west-1,ap-southeast-1

# Step 3: Create a namespace with replication enabled
pulsar-admin namespaces create fintech/payments \
  --clusters us-east-1,eu-west-1,ap-southeast-1

# Step 4: Topics in this namespace are automatically replicated
# No code changes needed in producers or consumers
```

### Selective Replication

```go
// Control replication per-message
producer.Send(ctx, &pulsar.ProducerMessage{
    Payload: payload,
    ReplicationClusters: []string{
        "us-east-1",
        "eu-west-1",
        // NOT ap-southeast-1 — this message won't replicate there
    },
})

// Disable replication for a specific message
producer.Send(ctx, &pulsar.ProducerMessage{
    Payload:             payload,
    DisableReplication:  true,
})
```

### Geo-Replication Monitoring

```bash
# Check replication backlog per cluster
pulsar-admin topics stats \
  persistent://fintech/payments/transactions

# Output includes replication section:
# "replication": {
#   "eu-west-1": {
#     "replicationBacklog": 1234,
#     "replicationDelayInSeconds": 0.3,
#     "connected": true
#   }
# }

# Monitor replication lag with Prometheus
# Metric: pulsar_replication_backlog
# Metric: pulsar_replication_delay_in_seconds
```

## Dead Letter Queue Pattern

```go
package dlq

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "time"

    "github.com/apache/pulsar-client-go/pulsar"
)

type DLQMessage struct {
    OriginalTopic string            `json:"original_topic"`
    MessageID     string            `json:"message_id"`
    Payload       []byte            `json:"payload"`
    Properties    map[string]string `json:"properties"`
    FailureReason string            `json:"failure_reason"`
    FailedAt      time.Time         `json:"failed_at"`
    RetryCount    int               `json:"retry_count"`
}

func NewConsumerWithDLQ(client pulsar.Client) (pulsar.Consumer, error) {
    return client.Subscribe(pulsar.ConsumerOptions{
        Topic:            "persistent://fintech/payments/transactions",
        SubscriptionName: "payment-processor",
        Type:             pulsar.Shared,
        ReceiverQueueSize: 200,
        NackRedeliveryDelay: 30 * time.Second,

        // After MaxDeliveries nacks, message moves to DeadLetterTopic
        DLQ: &pulsar.DLQPolicy{
            MaxDeliveries:           5,
            DeadLetterTopic:         "persistent://fintech/payments/transactions-dlq",
            // RetryLetterTopic optionally routes to a retry topic first
            RetryLetterTopic: "persistent://fintech/payments/transactions-retry",
        },
    })
}

// DLQ consumer for manual inspection and replay
func ConsumeDLQ(client pulsar.Client) {
    consumer, err := client.Subscribe(pulsar.ConsumerOptions{
        Topic:            "persistent://fintech/payments/transactions-dlq",
        SubscriptionName: "dlq-inspector",
        Type:             pulsar.Exclusive,
    })
    if err != nil {
        log.Fatalf("creating DLQ consumer: %v", err)
    }
    defer consumer.Close()

    for {
        msg, err := consumer.Receive(context.Background())
        if err != nil {
            log.Printf("DLQ receive error: %v", err)
            return
        }

        // Log for manual inspection
        log.Printf("DLQ message: id=%s properties=%v payload=%s",
            msg.ID(), msg.Properties(), string(msg.Payload()))

        // Optionally republish to main topic after investigation
        // or simply acknowledge to discard

        consumer.Ack(msg)
    }
}
```

## Production Configuration Tips

### Pulsar Broker Tuning (broker.conf)

```properties
# broker.conf — key production settings

# Message retention (keep 7 days even if all subscriptions caught up)
defaultRetentionTimeInMinutes=10080
defaultRetentionSizeInMB=102400

# Replication
replicationProducerQueueSize=1000
replicationConnectionsPerBroker=4

# Storage
managedLedgerMaxEntriesPerLedger=50000
managedLedgerMaxSizePerLedgerMb=2048

# Compaction (for key-based topics)
brokerServiceCompactionThresholdInBytes=67108864

# Rate limiting
dispatchThrottlingRatePerTopicInMsg=50000
dispatchThrottlingRatePerTopicInByte=10485760
```

### Go Client Best Practices

```go
// Always close producers and consumers
defer producer.Close()
defer consumer.Close()
defer client.Close()

// Use context with timeout for Send operations
ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
defer cancel()
msgID, err := producer.Send(ctx, msg)

// Handle redelivery for idempotent consumers
func processWithDedup(msg pulsar.Message, store DeduplicationStore) error {
    msgIDStr := msg.ID().String()
    if store.AlreadyProcessed(msgIDStr) {
        log.Printf("skipping duplicate message %s", msgIDStr)
        return nil // Ack it to remove from redelivery queue
    }

    if err := process(msg); err != nil {
        return err
    }

    store.MarkProcessed(msgIDStr)
    return nil
}
```

## Summary

Apache Pulsar's combination of multi-tenancy, flexible subscription modes, built-in schema enforcement, native geo-replication, and serverless functions makes it a powerful platform for enterprise event streaming. The Go client provides idiomatic access to all these capabilities. Key decisions to make when designing Pulsar-based systems: choose the right subscription mode based on ordering and parallelism requirements, enforce schemas from day one, configure DLQ policies for all production consumers, and leverage Pulsar Functions for lightweight stream transformations before reaching for a heavy Flink or Spark deployment.
