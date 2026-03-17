---
title: "Go Event-Driven Architecture: NATS JetStream for Durable Messaging"
date: 2029-08-01T00:00:00-05:00
draft: false
tags: ["Go", "NATS", "JetStream", "Event-Driven", "Messaging", "Architecture", "Kubernetes"]
categories: ["Go", "Architecture", "Messaging"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to building event-driven Go applications with NATS JetStream: stream and consumer configuration, push and pull consumers, consumer groups, message acknowledgment patterns, and at-least-once delivery guarantees."
more_link: "yes"
url: "/go-event-driven-architecture-nats-jetstream-durable-messaging/"
---

NATS JetStream is the persistence and streaming layer built into NATS Server 2.2+. Unlike core NATS (which is fire-and-forget pub/sub), JetStream persists messages, supports consumer replay, and provides at-least-once delivery guarantees. For Go services that need reliable asynchronous communication without the operational complexity of Kafka or RabbitMQ, JetStream hits a compelling middle ground: simple to operate, fast (millions of messages per second), and cloud-native with Kubernetes operator support. This guide covers building production-grade event-driven systems in Go using JetStream.

<!--more-->

# Go Event-Driven Architecture: NATS JetStream for Durable Messaging

## JetStream Architecture

### Streams and Consumers

JetStream is organized around two core primitives:

**Streams** are the persistent storage units. A stream captures messages published to a set of subjects and retains them according to configured retention policies (limits-based, interest-based, or work-queue).

**Consumers** are the read pointers into a stream. Multiple consumers can exist on the same stream, each independently tracking their position. JetStream supports two consumer types:
- **Push consumers**: JetStream proactively delivers messages to a subject or queue group
- **Pull consumers**: Clients explicitly request messages in batches

```
Publisher --> NATS Server --> Stream (subjects: "orders.>")
                               |
                               +-- Consumer: order-validator (push, group: validators)
                               +-- Consumer: order-archiver  (pull, durable)
                               +-- Consumer: order-analytics (push, ephemeral)
```

### Retention Policies

```go
package jetstream

import (
    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

// StreamRetentionExamples shows the three retention modes
func StreamRetentionExamples(js jetstream.JetStream) {
    ctx := context.Background()

    // Limits retention: keep messages up to size/count/age limits
    // Best for: event logs, audit trails, time-series data
    _, _ = js.CreateStream(ctx, jetstream.StreamConfig{
        Name:      "EVENTS",
        Subjects:  []string{"events.>"},
        Retention: jetstream.LimitsPolicy,
        MaxMsgs:   10_000_000,
        MaxBytes:  10 * 1024 * 1024 * 1024, // 10 GB
        MaxAge:    7 * 24 * time.Hour,
        Storage:   jetstream.FileStorage,
        Replicas:  3, // For HA
    })

    // Interest retention: messages removed when all consumers have acked
    // Best for: event bus where multiple consumers must process each event
    _, _ = js.CreateStream(ctx, jetstream.StreamConfig{
        Name:      "DOMAIN_EVENTS",
        Subjects:  []string{"domain.>"},
        Retention: jetstream.InterestPolicy,
        MaxAge:    24 * time.Hour, // Max retention even without consumers
        Storage:   jetstream.FileStorage,
        Replicas:  3,
    })

    // Work queue retention: messages removed after any one consumer acks
    // Best for: task queues where only one worker should process each message
    _, _ = js.CreateStream(ctx, jetstream.StreamConfig{
        Name:      "WORK",
        Subjects:  []string{"work.tasks.>"},
        Retention: jetstream.WorkQueuePolicy,
        MaxAge:    4 * time.Hour,
        Storage:   jetstream.FileStorage,
        Replicas:  3,
    })
}
```

## Setting Up NATS JetStream

### NATS Server Configuration

```bash
# NATS server configuration for JetStream
cat > /etc/nats/nats.conf <<'EOF'
port: 4222
http_port: 8222

jetstream {
  store_dir: /data/nats/jetstream
  max_memory_store: 2GB
  max_file_store: 100GB
}

# Clustering for HA
cluster {
  name: production-cluster
  listen: 0.0.0.0:6222

  routes: [
    nats-route://nats-0.nats:6222
    nats-route://nats-1.nats:6222
    nats-route://nats-2.nats:6222
  ]
}

# Authentication
accounts: {
  orders: {
    users: [
      { user: "orders-service", password: "$2a$..." }
    ]
    jetstream: enabled
  }
}
EOF
```

```yaml
# kubernetes/nats-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: nats
  namespace: messaging
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
      terminationGracePeriodSeconds: 60
      containers:
        - name: nats
          image: nats:2.10-alpine
          args:
            - "-c"
            - "/etc/nats/nats.conf"
            - "--cluster_name"
            - "production"
            - "--cluster"
            - "nats://0.0.0.0:6222"
            - "--routes"
            - "nats-route://nats-0.nats.messaging.svc:6222,nats-route://nats-1.nats.messaging.svc:6222,nats-route://nats-2.nats.messaging.svc:6222"
            - "--jetstream"
            - "--store_dir"
            - "/data"
          ports:
            - name: client
              containerPort: 4222
            - name: cluster
              containerPort: 6222
            - name: monitor
              containerPort: 8222
          volumeMounts:
            - name: data
              mountPath: /data
            - name: config
              mountPath: /etc/nats
          resources:
            requests:
              cpu: "1"
              memory: "2Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 50Gi
```

### Go Client Setup

```go
package natsutil

import (
    "context"
    "fmt"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

// Config holds NATS connection configuration
type Config struct {
    URLs        []string
    Username    string
    Password    string
    TLSCertFile string
    TLSKeyFile  string
    TLSCAFile   string
    MaxReconnect int
    ReconnectWait time.Duration
}

// Connect establishes a NATS connection with production-grade settings
func Connect(cfg Config) (*nats.Conn, error) {
    opts := []nats.Option{
        nats.Name("orders-service"),
        nats.UserInfo(cfg.Username, cfg.Password),
        nats.MaxReconnects(cfg.MaxReconnect),
        nats.ReconnectWait(cfg.ReconnectWait),
        nats.PingInterval(20 * time.Second),
        nats.MaxPingsOutstanding(5),

        // Reconnect handlers
        nats.DisconnectErrHandler(func(nc *nats.Conn, err error) {
            if err != nil {
                log.Printf("NATS disconnected: %v", err)
            }
        }),
        nats.ReconnectHandler(func(nc *nats.Conn) {
            log.Printf("NATS reconnected to %s", nc.ConnectedUrl())
        }),
        nats.ClosedHandler(func(nc *nats.Conn) {
            log.Println("NATS connection closed")
        }),
        nats.ErrorHandler(func(nc *nats.Conn, sub *nats.Subscription, err error) {
            log.Printf("NATS async error on %v: %v", sub.Subject, err)
        }),
    }

    if cfg.TLSCertFile != "" {
        opts = append(opts, nats.ClientCert(cfg.TLSCertFile, cfg.TLSKeyFile))
        opts = append(opts, nats.RootCAs(cfg.TLSCAFile))
    }

    return nats.Connect(
        strings.Join(cfg.URLs, ","),
        opts...,
    )
}

// NewJetStream creates a JetStream context
func NewJetStream(nc *nats.Conn) (jetstream.JetStream, error) {
    return jetstream.New(nc)
}

// EnsureStream creates a stream if it doesn't exist, or updates if config changed
func EnsureStream(ctx context.Context, js jetstream.JetStream, cfg jetstream.StreamConfig) (jetstream.Stream, error) {
    stream, err := js.Stream(ctx, cfg.Name)
    if err == jetstream.ErrStreamNotFound {
        return js.CreateStream(ctx, cfg)
    }
    if err != nil {
        return nil, fmt.Errorf("get stream: %w", err)
    }

    // Stream exists - update configuration
    return js.UpdateStream(ctx, cfg)
}
```

## Publishing Messages

### Reliable Publishing with Acknowledgment

```go
package publisher

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

type OrderEvent struct {
    ID        string    `json:"id"`
    Type      string    `json:"type"`
    OrderID   string    `json:"order_id"`
    CustomerID string   `json:"customer_id"`
    Amount    float64   `json:"amount"`
    Timestamp time.Time `json:"timestamp"`
}

type OrderPublisher struct {
    js      jetstream.JetStream
    subject string
}

func NewOrderPublisher(js jetstream.JetStream) *OrderPublisher {
    return &OrderPublisher{
        js:      js,
        subject: "orders.events",
    }
}

// Publish publishes an event and waits for server acknowledgment
func (p *OrderPublisher) Publish(ctx context.Context, event OrderEvent) error {
    data, err := json.Marshal(event)
    if err != nil {
        return fmt.Errorf("marshal event: %w", err)
    }

    // PublishMsg returns an acknowledgment from the server
    // This confirms the message has been persisted to the stream
    ack, err := p.js.PublishMsg(ctx, &nats.Msg{
        Subject: fmt.Sprintf("orders.events.%s", event.Type),
        Data:    data,
        Header: nats.Header{
            "Nats-Msg-Id":  []string{event.ID},           // Deduplication ID
            "Content-Type": []string{"application/json"},
            "Event-Type":   []string{event.Type},
        },
    })
    if err != nil {
        return fmt.Errorf("publish event: %w", err)
    }

    // ack.Sequence is the stream sequence number - log for tracing
    log.Printf("Published event %s, stream sequence: %d", event.ID, ack.Sequence)
    return nil
}

// PublishBatch publishes multiple events efficiently
func (p *OrderPublisher) PublishBatch(ctx context.Context, events []OrderEvent) error {
    // Use async publish for throughput
    var futures []jetstream.PubAckFuture

    for _, event := range events {
        data, err := json.Marshal(event)
        if err != nil {
            return fmt.Errorf("marshal event %s: %w", event.ID, err)
        }

        future, err := p.js.PublishMsgAsync(&nats.Msg{
            Subject: fmt.Sprintf("orders.events.%s", event.Type),
            Data:    data,
            Header: nats.Header{
                "Nats-Msg-Id": []string{event.ID},
            },
        })
        if err != nil {
            return fmt.Errorf("async publish %s: %w", event.ID, err)
        }

        futures = append(futures, future)
    }

    // Wait for all acknowledgments
    errs := p.js.PublishAsyncComplete()
    select {
    case <-errs:
        // Check each future for errors
        for i, f := range futures {
            select {
            case <-f.Ok():
                // Published successfully
            case err := <-f.Err():
                return fmt.Errorf("event %d failed: %w", i, err)
            }
        }
    case <-ctx.Done():
        return ctx.Err()
    }

    return nil
}
```

## Push Consumers

### Durable Push Consumer with Queue Groups

```go
package consumer

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/nats-io/nats.go/jetstream"
)

type OrderValidator struct {
    js        jetstream.JetStream
    consumer  jetstream.Consumer
    inventory InventoryService
}

func NewOrderValidator(ctx context.Context, js jetstream.JetStream, inventory InventoryService) (*OrderValidator, error) {
    // Create or bind to an existing durable consumer
    consumer, err := js.CreateOrUpdateConsumer(ctx, "ORDERS", jetstream.ConsumerConfig{
        Name:          "order-validator",
        Durable:       "order-validator",
        Description:   "Validates orders before processing",
        FilterSubject: "orders.events.created",

        // Delivery configuration
        DeliverPolicy: jetstream.DeliverAllPolicy, // Start from the beginning
        AckPolicy:     jetstream.AckExplicitPolicy, // Must explicitly ack each message

        // Work queue group - only one consumer in the group processes each message
        DeliverGroup:  "order-validators",
        DeliverSubject: "_INBOX.order-validators",

        // Retry configuration
        AckWait:    30 * time.Second, // Re-deliver if not acked within 30s
        MaxDeliver: 5,                // Maximum delivery attempts before NACK to dead letter

        // Flow control
        MaxAckPending: 100, // Maximum unacknowledged messages in flight

        // Start from newest messages (for new deployments catching up is not desired)
        DeliverPolicy: jetstream.DeliverNewPolicy,
    })
    if err != nil {
        return nil, fmt.Errorf("create consumer: %w", err)
    }

    return &OrderValidator{
        js:        js,
        consumer:  consumer,
        inventory: inventory,
    }, nil
}

// ConsumeMessages starts consuming messages from the push consumer
func (v *OrderValidator) ConsumeMessages(ctx context.Context) error {
    // Messages is a channel-based API for push consumers
    msgCh, err := v.consumer.Messages(
        jetstream.PullMaxMessages(10), // Process up to 10 messages at a time
    )
    if err != nil {
        return fmt.Errorf("get messages: %w", err)
    }
    defer msgCh.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()

        case msg, ok := <-msgCh.Messages():
            if !ok {
                return nil // Channel closed
            }

            if err := v.processMessage(ctx, msg); err != nil {
                log.Printf("Process failed (delivery %d): %v",
                    msg.Metadata().NumDelivered, err)

                // Negative acknowledgment with delay
                if msg.Metadata().NumDelivered >= 3 {
                    // Give up and move to dead letter
                    _ = msg.Term()
                } else {
                    // Retry after backoff
                    _ = msg.NakWithDelay(
                        time.Duration(msg.Metadata().NumDelivered) * 30 * time.Second,
                    )
                }
                continue
            }

            // Success - acknowledge the message
            if err := msg.Ack(); err != nil {
                log.Printf("Ack failed: %v", err)
            }
        }
    }
}

func (v *OrderValidator) processMessage(ctx context.Context, msg jetstream.Msg) error {
    var event OrderEvent
    if err := json.Unmarshal(msg.Data(), &event); err != nil {
        // Malformed message - terminate it (don't retry)
        _ = msg.Term()
        return nil
    }

    // Mark as in-progress (extends the AckWait timer)
    if err := msg.InProgress(); err != nil {
        return fmt.Errorf("mark in-progress: %w", err)
    }

    // Validate the order
    available, err := v.inventory.CheckAvailability(ctx, event.OrderID)
    if err != nil {
        return fmt.Errorf("check inventory: %w", err)
    }

    if !available {
        // Publish rejection event
        _ = v.publishRejection(ctx, event)
    } else {
        // Publish approval event
        _ = v.publishApproval(ctx, event)
    }

    return nil
}
```

## Pull Consumers

Pull consumers give the client control over when and how many messages to fetch. This is better for rate-limited processing or when you want to batch messages.

### Pull Consumer for Batch Processing

```go
package pullconsumer

import (
    "context"
    "fmt"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

type OrderArchiver struct {
    js       jetstream.JetStream
    consumer jetstream.Consumer
    store    ArchiveStore
}

func NewOrderArchiver(ctx context.Context, js jetstream.JetStream, store ArchiveStore) (*OrderArchiver, error) {
    consumer, err := js.CreateOrUpdateConsumer(ctx, "ORDERS", jetstream.ConsumerConfig{
        Name:          "order-archiver",
        Durable:       "order-archiver",
        AckPolicy:     jetstream.AckExplicitPolicy,
        DeliverPolicy: jetstream.DeliverAllPolicy,
        AckWait:       5 * time.Minute, // Archives take time
        MaxDeliver:    3,
    })
    if err != nil {
        return nil, fmt.Errorf("create pull consumer: %w", err)
    }

    return &OrderArchiver{
        js:       js,
        consumer: consumer,
        store:    store,
    }, nil
}

// RunBatchProcessor pulls and processes messages in batches
func (a *OrderArchiver) RunBatchProcessor(ctx context.Context) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        // Fetch a batch of messages
        msgs, err := a.consumer.Fetch(100, // up to 100 messages
            jetstream.FetchMaxWait(5*time.Second), // wait up to 5s for messages
        )
        if err != nil {
            if err == jetstream.ErrTimeout {
                // No messages available, wait and retry
                continue
            }
            return fmt.Errorf("fetch batch: %w", err)
        }

        // Collect messages into a batch
        var batch []OrderEvent
        var msgRefs []jetstream.Msg

        for msg := range msgs.Messages() {
            var event OrderEvent
            if err := json.Unmarshal(msg.Data(), &event); err != nil {
                log.Printf("Invalid message: %v", err)
                _ = msg.Term()
                continue
            }
            batch = append(batch, event)
            msgRefs = append(msgRefs, msg)
        }

        if len(batch) == 0 {
            continue
        }

        // Archive the batch atomically
        if err := a.store.ArchiveBatch(ctx, batch); err != nil {
            // Archive failed - NAK all messages for retry
            for _, msg := range msgRefs {
                _ = msg.Nak()
            }
            log.Printf("Batch archive failed: %v", err)
            continue
        }

        // Archive succeeded - ACK all messages
        for _, msg := range msgRefs {
            _ = msg.Ack()
        }

        log.Printf("Archived batch of %d orders", len(batch))
    }
}

// FetchWithContext is a context-aware batch fetch
func (a *OrderArchiver) FetchWithContext(ctx context.Context, maxMessages int) ([]OrderEvent, []jetstream.Msg, error) {
    fetchCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    msgs, err := a.consumer.FetchNoWait(maxMessages)
    if err != nil {
        return nil, nil, err
    }

    var events []OrderEvent
    var msgRefs []jetstream.Msg

    for {
        select {
        case <-fetchCtx.Done():
            return events, msgRefs, nil
        case msg, ok := <-msgs.Messages():
            if !ok {
                return events, msgRefs, nil
            }
            var event OrderEvent
            if err := json.Unmarshal(msg.Data(), &event); err != nil {
                _ = msg.Term()
                continue
            }
            events = append(events, event)
            msgRefs = append(msgRefs, msg)
        }
    }
}
```

## Consumer Groups for Load Distribution

Consumer groups (queue groups in NATS) distribute messages across multiple instances of the same consumer:

```go
package workergroup

// WorkerPool creates multiple competing consumers on the same durable consumer
type WorkerPool struct {
    js       jetstream.JetStream
    workers  []*Worker
    consumer jetstream.Consumer
}

func NewWorkerPool(ctx context.Context, js jetstream.JetStream, workerCount int) (*WorkerPool, error) {
    // Single durable consumer that all workers share
    consumer, err := js.CreateOrUpdateConsumer(ctx, "WORK", jetstream.ConsumerConfig{
        Name:          "task-processor",
        Durable:       "task-processor",
        AckPolicy:     jetstream.AckExplicitPolicy,
        AckWait:       2 * time.Minute,
        MaxDeliver:    3,
        MaxAckPending: workerCount * 10, // Allow 10 in-flight per worker
    })
    if err != nil {
        return nil, err
    }

    pool := &WorkerPool{
        js:       js,
        workers:  make([]*Worker, workerCount),
        consumer: consumer,
    }

    for i := range pool.workers {
        pool.workers[i] = &Worker{
            id:       i,
            consumer: consumer,
        }
    }

    return pool, nil
}

func (p *WorkerPool) Start(ctx context.Context) error {
    g, ctx := errgroup.WithContext(ctx)

    for _, w := range p.workers {
        w := w
        g.Go(func() error {
            return w.Run(ctx)
        })
    }

    return g.Wait()
}

type Worker struct {
    id       int
    consumer jetstream.Consumer
}

func (w *Worker) Run(ctx context.Context) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        msgs, err := w.consumer.Fetch(1, jetstream.FetchMaxWait(5*time.Second))
        if err != nil {
            if err == jetstream.ErrTimeout {
                continue
            }
            return fmt.Errorf("worker %d fetch: %w", w.id, err)
        }

        for msg := range msgs.Messages() {
            if err := w.processTask(ctx, msg); err != nil {
                _ = msg.Nak()
            } else {
                _ = msg.Ack()
            }
        }
    }
}
```

## At-Least-Once Delivery Guarantees

### Idempotent Message Processing

At-least-once delivery means your consumers may receive duplicates. Always design for idempotency:

```go
package idempotent

import (
    "context"
    "crypto/sha256"
    "fmt"
)

// IdempotentProcessor tracks which messages have been processed
type IdempotentProcessor struct {
    processed ProcessedMessageStore
    processor MessageProcessor
}

func (p *IdempotentProcessor) Process(ctx context.Context, msg jetstream.Msg) error {
    // Use NATS-provided message ID for deduplication
    msgID := msg.Headers().Get("Nats-Msg-Id")
    if msgID == "" {
        // Fall back to content hash
        hash := sha256.Sum256(msg.Data())
        msgID = fmt.Sprintf("hash-%x", hash[:8])
    }

    // Check if already processed
    alreadyProcessed, err := p.processed.IsProcessed(ctx, msgID)
    if err != nil {
        return fmt.Errorf("check processed: %w", err)
    }

    if alreadyProcessed {
        log.Printf("Skipping duplicate message: %s", msgID)
        _ = msg.Ack() // Ack to clear from JetStream
        return nil
    }

    // Process the message
    if err := p.processor.Process(ctx, msg.Data()); err != nil {
        return fmt.Errorf("process: %w", err)
    }

    // Mark as processed (after successful processing)
    if err := p.processed.MarkProcessed(ctx, msgID); err != nil {
        // Message was processed but we couldn't record it
        // This is acceptable - on retry we'll detect it processed already
        // OR we'll process it again (idempotent operation handles this)
        log.Printf("Warning: could not mark message %s as processed: %v", msgID, err)
    }

    return nil
}
```

### Dead Letter Queue Pattern

```go
package dlq

// SetupDeadLetterStream creates a stream for failed messages
func SetupDeadLetterStream(ctx context.Context, js jetstream.JetStream) error {
    _, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
        Name:      "DLQ",
        Subjects:  []string{"dlq.>"},
        Retention: jetstream.LimitsPolicy,
        MaxAge:    30 * 24 * time.Hour, // Keep for 30 days
        Storage:   jetstream.FileStorage,
        Replicas:  3,
    })
    return err
}

// DeadLetterHandler handles messages that have exhausted retries
type DeadLetterHandler struct {
    js       jetstream.JetStream
    dlqJS    jetstream.JetStream
    consumer jetstream.Consumer
}

func (h *DeadLetterHandler) HandleFailures(ctx context.Context) error {
    // Subscribe to terminal messages from the main stream
    consumer, err := h.js.CreateOrUpdateConsumer(ctx, "ORDERS", jetstream.ConsumerConfig{
        Name:          "dlq-collector",
        FilterSubject: "$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.ORDERS.>",
        DeliverPolicy: jetstream.DeliverAllPolicy,
        AckPolicy:     jetstream.AckExplicitPolicy,
    })
    if err != nil {
        return err
    }

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        msgs, err := consumer.Fetch(10, jetstream.FetchMaxWait(5*time.Second))
        if err != nil {
            continue
        }

        for msg := range msgs.Messages() {
            // Get the original message that failed
            var advisory MaxDeliveriesAdvisory
            if err := json.Unmarshal(msg.Data(), &advisory); err != nil {
                _ = msg.Term()
                continue
            }

            // Retrieve and republish to DLQ
            original, err := h.getOriginalMessage(ctx, advisory)
            if err == nil {
                _, _ = h.dlqJS.Publish(ctx,
                    fmt.Sprintf("dlq.orders.%s", advisory.Consumer),
                    original,
                )
            }

            _ = msg.Ack()
        }
    }
}
```

## Message Replay and Sequence Management

```go
package replay

// ReplayFromBeginning creates a consumer that replays all messages from stream start
func ReplayFromBeginning(ctx context.Context, js jetstream.JetStream, streamName string) (jetstream.Consumer, error) {
    return js.CreateOrUpdateConsumer(ctx, streamName, jetstream.ConsumerConfig{
        Name:          "replay-" + generateID(),
        DeliverPolicy: jetstream.DeliverAllPolicy,
        AckPolicy:     jetstream.AckNonePolicy, // Ephemeral replay, no ack needed
    })
}

// ReplayFromSequence replays messages starting from a specific sequence number
func ReplayFromSequence(ctx context.Context, js jetstream.JetStream, streamName string, seq uint64) (jetstream.Consumer, error) {
    return js.CreateOrUpdateConsumer(ctx, streamName, jetstream.ConsumerConfig{
        Name:          "replay-seq-" + generateID(),
        DeliverPolicy: jetstream.DeliverByStartSequencePolicy,
        OptStartSeq:   seq,
        AckPolicy:     jetstream.AckNonePolicy,
    })
}

// ReplayFromTime replays messages published after a specific time
func ReplayFromTime(ctx context.Context, js jetstream.JetStream, streamName string, since time.Time) (jetstream.Consumer, error) {
    return js.CreateOrUpdateConsumer(ctx, streamName, jetstream.ConsumerConfig{
        Name:          "replay-time-" + generateID(),
        DeliverPolicy: jetstream.DeliverByStartTimePolicy,
        OptStartTime:  &since,
        AckPolicy:     jetstream.AckNonePolicy,
    })
}
```

## Monitoring and Observability

### JetStream Metrics with Prometheus

```go
package metrics

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/nats-io/nats.go/jetstream"
)

var (
    streamMessages = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "nats_stream_messages_total",
        Help: "Total messages in JetStream stream",
    }, []string{"stream"})

    streamBytes = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "nats_stream_bytes_total",
        Help: "Total bytes in JetStream stream",
    }, []string{"stream"})

    consumerPending = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "nats_consumer_pending_messages",
        Help: "Pending messages for a consumer",
    }, []string{"stream", "consumer"})

    consumerAckPending = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "nats_consumer_ack_pending_messages",
        Help: "Messages waiting for acknowledgment",
    }, []string{"stream", "consumer"})

    messagesProcessed = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "nats_messages_processed_total",
        Help: "Total messages processed by consumers",
    }, []string{"stream", "consumer", "result"})

    processingDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "nats_message_processing_duration_seconds",
        Help:    "Time spent processing messages",
        Buckets: prometheus.ExponentialBuckets(0.001, 2, 12),
    }, []string{"stream", "consumer"})
)

// MetricsCollector collects JetStream metrics
type MetricsCollector struct {
    js jetstream.JetStream
}

func (c *MetricsCollector) Collect(ctx context.Context) error {
    ticker := time.NewTicker(15 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            c.collectStreamMetrics(ctx)
        }
    }
}

func (c *MetricsCollector) collectStreamMetrics(ctx context.Context) {
    streams := c.js.ListStreams(ctx)
    for stream := range streams.Info() {
        name := stream.Config.Name
        streamMessages.WithLabelValues(name).Set(float64(stream.State.Msgs))
        streamBytes.WithLabelValues(name).Set(float64(stream.State.Bytes))

        // Collect consumer metrics
        consumers := c.js.ListConsumers(ctx, name)
        for consumer := range consumers.Info() {
            cname := consumer.Name
            consumerPending.WithLabelValues(name, cname).Set(
                float64(consumer.NumPending),
            )
            consumerAckPending.WithLabelValues(name, cname).Set(
                float64(consumer.NumAckPending),
            )
        }
    }
}
```

```yaml
# grafana-dashboard snippet for JetStream monitoring
# prometheus-rules/nats-alerts.yaml
groups:
  - name: nats-jetstream
    rules:
      - alert: NATSConsumerLagging
        expr: nats_consumer_pending_messages > 10000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "NATS consumer {{ $labels.consumer }} is lagging"
          description: "Consumer {{ $labels.consumer }} on stream {{ $labels.stream }} has {{ $value }} pending messages"

      - alert: NATSConsumerAckStuck
        expr: nats_consumer_ack_pending_messages > 1000
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "NATS consumer ack backlog growing"
          description: "Consumer {{ $labels.consumer }} has {{ $value }} unacknowledged messages"
```

## Summary

NATS JetStream provides a compelling foundation for event-driven Go architectures:

1. **Streams** persist messages with configurable retention policies suited to different use cases (event log, event bus, work queue)
2. **Push consumers** with queue groups enable scalable, load-balanced processing with automatic failover
3. **Pull consumers** give precise control over message rate and batch sizes, ideal for variable-throughput workloads
4. **Explicit acknowledgment** with configurable retry and dead-letter patterns implements reliable at-least-once delivery
5. **Idempotent processing** using the `Nats-Msg-Id` header handles the inevitable duplicates in at-least-once systems
6. **Message replay** from sequence numbers or timestamps enables audit, debugging, and event sourcing use cases

JetStream's operational simplicity — a single binary, no external ZooKeeper or Schema Registry — makes it particularly well-suited for Kubernetes deployments where reducing operational complexity directly reduces risk.
