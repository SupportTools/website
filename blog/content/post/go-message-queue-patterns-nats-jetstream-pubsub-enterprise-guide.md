---
title: "Go Message Queue Patterns: Pub/Sub with NATS JetStream, At-Least-Once Delivery, Consumer Groups, and Ack Management"
date: 2031-12-09T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "NATS", "JetStream", "Message Queue", "Pub/Sub", "Distributed Systems", "Event Streaming"]
categories: ["Go", "Distributed Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to building reliable message-driven applications in Go with NATS JetStream, covering at-least-once delivery guarantees, durable consumer groups, ack management, backpressure, and fault-tolerant consumer patterns for enterprise event streaming."
more_link: "yes"
url: "/go-message-queue-patterns-nats-jetstream-pubsub-enterprise-guide/"
---

NATS JetStream adds persistent, at-least-once delivery semantics on top of NATS's core pub/sub model. The result is a message streaming system that combines the operational simplicity of NATS with the durability and consumer group semantics needed for production event-driven architectures. This guide covers the Go client patterns for building fault-tolerant producers and consumers, managing acknowledgment flows, handling redelivery, and structuring consumer groups for horizontal scaling.

<!--more-->

# Go Message Queue Patterns with NATS JetStream

## NATS JetStream Architecture Overview

JetStream extends NATS with:

- **Streams**: Named, ordered sequences of messages stored on disk or memory
- **Consumers**: Named cursors over a stream; each consumer tracks its own position
- **Durable consumers**: Survive server restarts and reconnections
- **Consumer groups**: Multiple instances of the same durable consumer share work (competing consumers pattern)

The message flow:

```
Producer --> Subject --> Stream (persisted) --> Consumer (ack required)
                                            --> Consumer Group
                                                  |- Instance 1
                                                  |- Instance 2
                                                  |- Instance 3
```

## Setting Up NATS JetStream

### Running NATS with JetStream Enabled

```yaml
# nats-k8s.yaml
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
      containers:
        - name: nats
          image: nats:2.10-alpine
          args:
            - "-c"
            - "/etc/nats/nats.conf"
          ports:
            - containerPort: 4222   # Client
            - containerPort: 6222   # Cluster
            - containerPort: 8222   # Monitoring
          volumeMounts:
            - name: config
              mountPath: /etc/nats
            - name: data
              mountPath: /data
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2"
              memory: "2Gi"
      volumes:
        - name: config
          configMap:
            name: nats-config
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: rook-ceph-block
        resources:
          requests:
            storage: 50Gi
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: nats-config
  namespace: messaging
data:
  nats.conf: |
    port: 4222
    cluster {
      port: 6222
      name: "nats-cluster"
      routes: [
        nats://nats-0.nats.messaging.svc.cluster.local:6222
        nats://nats-1.nats.messaging.svc.cluster.local:6222
        nats://nats-2.nats.messaging.svc.cluster.local:6222
      ]
    }
    jetstream {
      enabled: true
      store_dir: /data/jetstream
      max_memory_store: 1GB
      max_file_store: 40GB
    }
    http_port: 8222
    max_payload: 8MB
    max_connections: 10000
```

### Go Module Setup

```bash
go get github.com/nats-io/nats.go@latest
```

## Core Connection Management

```go
// internal/messaging/client.go
package messaging

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

type Client struct {
    nc  *nats.Conn
    js  jetstream.JetStream
    log *slog.Logger
}

type Config struct {
    URLs           []string
    CredsFile      string  // path to nats credentials file
    MaxReconnects  int
    ReconnectWait  time.Duration
    ConnectTimeout time.Duration
    Name           string
}

func NewClient(cfg Config, log *slog.Logger) (*Client, error) {
    opts := []nats.Option{
        nats.Name(cfg.Name),
        nats.MaxReconnects(cfg.MaxReconnects),
        nats.ReconnectWait(cfg.ReconnectWait),
        nats.Timeout(cfg.ConnectTimeout),
        // Reconnect handler for logging
        nats.ReconnectHandler(func(nc *nats.Conn) {
            log.Warn("NATS reconnected", "url", nc.ConnectedUrl())
        }),
        nats.DisconnectErrHandler(func(nc *nats.Conn, err error) {
            log.Error("NATS disconnected", "err", err)
        }),
        nats.ErrorHandler(func(nc *nats.Conn, sub *nats.Subscription, err error) {
            log.Error("NATS async error", "subject", sub.Subject, "err", err)
        }),
        nats.ClosedHandler(func(nc *nats.Conn) {
            log.Info("NATS connection closed")
        }),
    }

    if cfg.CredsFile != "" {
        opts = append(opts, nats.UserCredentials(cfg.CredsFile))
    }

    urls := nats.DefaultURL
    if len(cfg.URLs) > 0 {
        urls = cfg.URLs[0]
        for _, u := range cfg.URLs[1:] {
            urls += "," + u
        }
    }

    nc, err := nats.Connect(urls, opts...)
    if err != nil {
        return nil, fmt.Errorf("connect to NATS: %w", err)
    }

    js, err := jetstream.New(nc)
    if err != nil {
        nc.Close()
        return nil, fmt.Errorf("create JetStream context: %w", err)
    }

    return &Client{nc: nc, js: js, log: log}, nil
}

func (c *Client) JetStream() jetstream.JetStream {
    return c.js
}

func (c *Client) Close() {
    if err := c.nc.Drain(); err != nil {
        c.log.Error("NATS drain failed", "err", err)
    }
}
```

## Stream Management

```go
// internal/messaging/streams.go
package messaging

import (
    "context"
    "fmt"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

// StreamSpec defines the desired state of a stream
type StreamSpec struct {
    Name        string
    Subjects    []string
    MaxAge      time.Duration  // How long to retain messages
    MaxBytes    int64          // Max stream size in bytes
    MaxMsgSize  int32          // Max single message size
    MaxMsgs     int64          // Max total messages
    Replicas    int
    WorkQueue   bool           // Work queue (each message delivered once across all consumers)
    DenyDelete  bool
    DenyPurge   bool
}

func EnsureStream(ctx context.Context, js jetstream.JetStream, spec StreamSpec) (jetstream.Stream, error) {
    cfg := jetstream.StreamConfig{
        Name:        spec.Name,
        Subjects:    spec.Subjects,
        MaxAge:      spec.MaxAge,
        MaxBytes:    spec.MaxBytes,
        MaxMsgSize:  spec.MaxMsgSize,
        MaxMsgs:     spec.MaxMsgs,
        NumReplicas: spec.Replicas,
        Storage:     jetstream.FileStorage,
        Retention:   jetstream.LimitsPolicy,
        Discard:     jetstream.DiscardOld,
        DenyDelete:  spec.DenyDelete,
        DenyPurge:   spec.DenyPurge,
        Compression: jetstream.S2Compression,
        // Deduplicate messages with the same Nats-Msg-Id header within this window
        Duplicates: 2 * time.Minute,
    }

    if spec.WorkQueue {
        cfg.Retention = jetstream.WorkQueuePolicy
    }

    // CreateOrUpdate is idempotent — safe to call on startup
    stream, err := js.CreateOrUpdateStream(ctx, cfg)
    if err != nil {
        return nil, fmt.Errorf("create/update stream %s: %w", spec.Name, err)
    }
    return stream, nil
}
```

## Producer Patterns

### Synchronous Publishing with Deduplication

```go
// internal/messaging/producer.go
package messaging

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/nats-io/nats.go/jetstream"
)

type Publisher struct {
    js  jetstream.JetStream
    log *slog.Logger
}

func NewPublisher(js jetstream.JetStream, log *slog.Logger) *Publisher {
    return &Publisher{js: js, log: log}
}

// PublishEvent publishes a message with deduplication support.
// If idempotencyKey is provided, NATS will deduplicate within the stream's
// Duplicates window — safe to retry without double-processing.
func (p *Publisher) PublishEvent(
    ctx context.Context,
    subject string,
    event interface{},
    idempotencyKey string,
) error {
    data, err := json.Marshal(event)
    if err != nil {
        return fmt.Errorf("marshal event: %w", err)
    }

    msgOpts := []jetstream.PublishOpt{
        jetstream.WithRetryAttempts(5),
        jetstream.WithRetryWait(100 * time.Millisecond),
    }

    if idempotencyKey != "" {
        msgOpts = append(msgOpts, jetstream.WithMsgID(idempotencyKey))
    } else {
        // Generate a unique ID if none provided
        msgOpts = append(msgOpts, jetstream.WithMsgID(uuid.NewString()))
    }

    ack, err := p.js.Publish(ctx, subject, data, msgOpts...)
    if err != nil {
        return fmt.Errorf("publish to %s: %w", subject, err)
    }

    p.log.Debug("published event",
        "subject", subject,
        "stream", ack.Stream,
        "seq", ack.Sequence,
        "duplicate", ack.Duplicate,
    )

    return nil
}

// OrderEvent is an example domain event with typed fields
type OrderEvent struct {
    EventID   string    `json:"event_id"`
    OrderID   string    `json:"order_id"`
    EventType string    `json:"event_type"`
    Amount    int64     `json:"amount_cents"`
    Currency  string    `json:"currency"`
    Timestamp time.Time `json:"timestamp"`
}

// PublishOrderEvent publishes an order event with order ID as idempotency key
func (p *Publisher) PublishOrderEvent(ctx context.Context, event OrderEvent) error {
    // Use event_id as the idempotency key for exactly-once semantics
    // within the deduplication window
    return p.PublishEvent(ctx, "orders.events", event, event.EventID)
}
```

### Async Publishing with PublishAsync

```go
// PublishAsync publishes multiple messages and waits for all acks
func (p *Publisher) PublishBatch(ctx context.Context, subject string, events []interface{}) error {
    // Use async publish for higher throughput
    futures := make([]jetstream.PubAckFuture, 0, len(events))

    for i, event := range events {
        data, err := json.Marshal(event)
        if err != nil {
            return fmt.Errorf("marshal event %d: %w", i, err)
        }

        future, err := p.js.PublishAsync(subject, data,
            jetstream.WithMsgID(uuid.NewString()),
        )
        if err != nil {
            return fmt.Errorf("publish async event %d: %w", i, err)
        }
        futures = append(futures, future)
    }

    // Wait for all acks with a timeout
    select {
    case <-p.js.PublishAsyncComplete():
        // All published — check for errors
    case <-ctx.Done():
        return fmt.Errorf("context cancelled waiting for publish acks: %w", ctx.Err())
    case <-time.After(30 * time.Second):
        return fmt.Errorf("timeout waiting for publish acks")
    }

    for i, f := range futures {
        select {
        case ack := <-f.Ok():
            p.log.Debug("async ack received", "seq", ack.Sequence)
        case err := <-f.Err():
            return fmt.Errorf("publish ack error for event %d: %w", i, err)
        }
    }

    return nil
}
```

## Consumer Patterns

### Durable Push Consumer (Simple)

```go
// internal/messaging/consumer.go
package messaging

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

type HandlerFunc[T any] func(ctx context.Context, msg T, metadata MessageMetadata) error

type MessageMetadata struct {
    Subject    string
    Stream     string
    Consumer   string
    Sequence   uint64
    Timestamp  time.Time
    NumDeliveries uint64
}

// PushConsumer is a simple durable consumer that receives messages via callback
type PushConsumer[T any] struct {
    js       jetstream.JetStream
    stream   string
    name     string
    subject  string
    handler  HandlerFunc[T]
    log      *slog.Logger
    con      jetstream.Consumer
}

func NewPushConsumer[T any](
    js jetstream.JetStream,
    stream, consumerName, filterSubject string,
    handler HandlerFunc[T],
    log *slog.Logger,
) *PushConsumer[T] {
    return &PushConsumer[T]{
        js:      js,
        stream:  stream,
        name:    consumerName,
        subject: filterSubject,
        handler: handler,
        log:     log,
    }
}

func (c *PushConsumer[T]) Start(ctx context.Context) error {
    // Create or resume durable consumer
    consumer, err := c.js.CreateOrUpdateConsumer(ctx, c.stream, jetstream.ConsumerConfig{
        Name:           c.name,
        Durable:        c.name,       // Durable: survives restarts
        FilterSubject:  c.subject,
        AckPolicy:      jetstream.AckExplicitPolicy,
        AckWait:        30 * time.Second,  // Re-deliver if not acked within 30s
        MaxDeliver:     5,                 // Max redelivery attempts
        DeliverPolicy:  jetstream.DeliverAllPolicy,  // Start from beginning (or last for existing)
        ReplayPolicy:   jetstream.ReplayInstantPolicy,
        MaxAckPending:  1000,  // Max unacked messages in flight
        // Backoff policy for retries: 1s, 5s, 30s, 2m, 10m
        BackOff: []time.Duration{
            1 * time.Second,
            5 * time.Second,
            30 * time.Second,
            2 * time.Minute,
            10 * time.Minute,
        },
    })
    if err != nil {
        return fmt.Errorf("create consumer %s: %w", c.name, err)
    }
    c.con = consumer

    // Consume with context-aware message callback
    consCtx, err := consumer.Consume(func(msg jetstream.Msg) {
        c.processMessage(ctx, msg)
    })
    if err != nil {
        return fmt.Errorf("start consuming: %w", err)
    }

    // Stop consuming when context is cancelled
    go func() {
        <-ctx.Done()
        consCtx.Stop()
    }()

    return nil
}

func (c *PushConsumer[T]) processMessage(ctx context.Context, msg jetstream.Msg) {
    meta, err := msg.Metadata()
    if err != nil {
        c.log.Error("get message metadata", "err", err)
        msg.Nak()
        return
    }

    metadata := MessageMetadata{
        Subject:       msg.Subject(),
        Stream:        meta.Stream,
        Consumer:      meta.Consumer,
        Sequence:      meta.Sequence.Stream,
        Timestamp:     meta.Timestamp,
        NumDeliveries: meta.NumDelivered,
    }

    // Parse the typed message
    var payload T
    if err := json.Unmarshal(msg.Data(), &payload); err != nil {
        c.log.Error("unmarshal message",
            "subject", msg.Subject(),
            "seq", metadata.Sequence,
            "err", err,
        )
        // Bad messages should be terminated (not redelivered)
        msg.Term()
        return
    }

    // Log redeliveries for monitoring
    if metadata.NumDeliveries > 1 {
        c.log.Warn("processing redelivered message",
            "seq", metadata.Sequence,
            "delivery_count", metadata.NumDeliveries,
        )
    }

    // Call the handler with a timeout
    handlerCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
    defer cancel()

    if err := c.handler(handlerCtx, payload, metadata); err != nil {
        c.log.Error("handler failed",
            "seq", metadata.Sequence,
            "delivery_count", metadata.NumDeliveries,
            "err", err,
        )

        if metadata.NumDeliveries >= 5 {
            // Max retries exceeded — terminate and dead-letter
            c.log.Error("max retries exceeded, terminating message",
                "seq", metadata.Sequence,
            )
            msg.Term()
            return
        }

        // Nak with backoff — tells JetStream to redeliver after a delay
        msg.NakWithDelay(backoffDelay(metadata.NumDeliveries))
        return
    }

    // Success
    msg.Ack()
}

// backoffDelay returns an exponential backoff delay for a given delivery count
func backoffDelay(deliveryCount uint64) time.Duration {
    delays := []time.Duration{
        1 * time.Second,
        5 * time.Second,
        30 * time.Second,
        2 * time.Minute,
        10 * time.Minute,
    }
    idx := int(deliveryCount - 1)
    if idx >= len(delays) {
        return delays[len(delays)-1]
    }
    return delays[idx]
}
```

### Pull Consumer with Work Queue Semantics

For controlled concurrency and backpressure:

```go
// internal/messaging/pull_consumer.go
package messaging

import (
    "context"
    "encoding/json"
    "fmt"
    "sync"
    "time"

    "github.com/nats-io/nats.go/jetstream"
    "golang.org/x/sync/semaphore"
)

// PullConsumer fetches messages explicitly, giving the application
// full control over concurrency and backpressure.
type PullConsumer[T any] struct {
    js          jetstream.JetStream
    stream      string
    name        string
    subjects    []string
    handler     HandlerFunc[T]
    concurrency int
    batchSize   int
    log         *slog.Logger
}

func NewPullConsumer[T any](
    js jetstream.JetStream,
    stream, name string,
    subjects []string,
    concurrency, batchSize int,
    handler HandlerFunc[T],
    log *slog.Logger,
) *PullConsumer[T] {
    return &PullConsumer[T]{
        js:          js,
        stream:      stream,
        name:        name,
        subjects:    subjects,
        handler:     handler,
        concurrency: concurrency,
        batchSize:   batchSize,
        log:         log,
    }
}

func (c *PullConsumer[T]) Run(ctx context.Context) error {
    consumer, err := c.js.CreateOrUpdateConsumer(ctx, c.stream, jetstream.ConsumerConfig{
        Name:          c.name,
        Durable:       c.name,
        FilterSubjects: c.subjects,
        AckPolicy:     jetstream.AckExplicitPolicy,
        AckWait:       30 * time.Second,
        MaxDeliver:    5,
        MaxAckPending: c.concurrency * c.batchSize,
        BackOff: []time.Duration{
            1 * time.Second,
            10 * time.Second,
            60 * time.Second,
        },
    })
    if err != nil {
        return fmt.Errorf("create pull consumer: %w", err)
    }

    sem := semaphore.NewWeighted(int64(c.concurrency))
    var wg sync.WaitGroup

    for {
        // Check for context cancellation
        if ctx.Err() != nil {
            break
        }

        // Acquire semaphore slots before fetching
        // This prevents fetching more than we can process
        if err := sem.Acquire(ctx, int64(c.batchSize)); err != nil {
            break
        }

        // Fetch a batch of messages
        msgs, err := consumer.FetchNoWait(c.batchSize)
        if err != nil {
            sem.Release(int64(c.batchSize))
            c.log.Error("fetch messages", "err", err)
            select {
            case <-time.After(1 * time.Second):
            case <-ctx.Done():
                return ctx.Err()
            }
            continue
        }

        fetched := 0
        for msg := range msgs.Messages() {
            fetched++
            wg.Add(1)
            go func(m jetstream.Msg) {
                defer wg.Done()
                defer sem.Release(1)
                c.processMessage(ctx, m)
            }(msg)
        }

        // Release unused semaphore slots if we got fewer messages than batch size
        if unused := int64(c.batchSize - fetched); unused > 0 {
            sem.Release(unused)
        }

        // If no messages were available, wait before polling again
        if fetched == 0 {
            select {
            case <-time.After(250 * time.Millisecond):
            case <-ctx.Done():
                break
            }
        }
    }

    // Drain: wait for all in-flight messages to complete
    c.log.Info("pull consumer shutting down, draining in-flight messages")
    waitCtx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
    defer cancel()

    done := make(chan struct{})
    go func() {
        wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        c.log.Info("pull consumer drained successfully")
    case <-waitCtx.Done():
        c.log.Warn("pull consumer drain timeout — some messages may be redelivered")
    }

    return ctx.Err()
}

func (c *PullConsumer[T]) processMessage(ctx context.Context, msg jetstream.Msg) {
    meta, _ := msg.Metadata()

    var payload T
    if err := json.Unmarshal(msg.Data(), &payload); err != nil {
        c.log.Error("unmarshal pull message", "err", err)
        msg.Term()
        return
    }

    metadata := MessageMetadata{
        Subject:       msg.Subject(),
        Sequence:      meta.Sequence.Stream,
        NumDeliveries: meta.NumDelivered,
    }

    handlerCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
    defer cancel()

    if err := c.handler(handlerCtx, payload, metadata); err != nil {
        c.log.Error("pull handler error",
            "seq", metadata.Sequence,
            "err", err,
        )
        msg.NakWithDelay(backoffDelay(metadata.NumDeliveries))
        return
    }

    msg.Ack()
}
```

## Dead Letter Queue Pattern

Messages that exceed `MaxDeliver` are automatically NakTermed. To capture them:

```go
// internal/messaging/dlq.go
package messaging

import (
    "context"
    "fmt"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

// SetupDLQ creates a stream that captures all terminated messages
// from the given source stream via the $JS.EVENT.ADVISORY.MSG.TERMINATED subject
func SetupDLQ(ctx context.Context, js jetstream.JetStream, sourceStream string) error {
    dlqStreamName := sourceStream + "-DLQ"

    _, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
        Name: dlqStreamName,
        // Subscribe to terminated message advisories for the source stream
        Subjects: []string{
            fmt.Sprintf("$JS.EVENT.ADVISORY.MSG.TERMINATED.%s.>", sourceStream),
        },
        MaxAge:      30 * 24 * time.Hour, // Keep DLQ messages for 30 days
        MaxBytes:    1 << 30,             // 1 GiB
        Storage:     jetstream.FileStorage,
        NumReplicas: 3,
    })
    if err != nil {
        return fmt.Errorf("create DLQ stream %s: %w", dlqStreamName, err)
    }

    return nil
}

// DLQEntry represents a terminated message captured in the DLQ
type DLQEntry struct {
    Stream     string    `json:"stream"`
    Consumer   string    `json:"consumer"`
    Subject    string    `json:"subject"`
    Sequence   uint64    `json:"sequence"`
    Deliveries uint64    `json:"deliveries"`
    Reason     string    `json:"reason"`
    Timestamp  time.Time `json:"timestamp"`
}

// ReplayDLQ reads terminated messages and reprocesses them
func ReplayDLQ(ctx context.Context, js jetstream.JetStream, dlqStream string, handler func(DLQEntry) error) error {
    consumer, err := js.CreateOrUpdateConsumer(ctx, dlqStream, jetstream.ConsumerConfig{
        Name:          "dlq-replay-" + fmt.Sprint(time.Now().Unix()),
        DeliverPolicy: jetstream.DeliverAllPolicy,
        AckPolicy:     jetstream.AckExplicitPolicy,
        MaxAckPending: 10,
    })
    if err != nil {
        return fmt.Errorf("create DLQ replay consumer: %w", err)
    }

    for {
        msgs, err := consumer.FetchNoWait(10)
        if err != nil {
            return err
        }

        hasMessages := false
        for msg := range msgs.Messages() {
            hasMessages = true
            var entry DLQEntry
            if err := json.Unmarshal(msg.Data(), &entry); err != nil {
                msg.Term()
                continue
            }
            if err := handler(entry); err != nil {
                msg.Nak()
                continue
            }
            msg.Ack()
        }

        if !hasMessages {
            break
        }
    }

    return nil
}
```

## Consumer Group: Competing Consumers

Multiple instances of the same durable consumer name form a competing consumer group — JetStream delivers each message to exactly one instance:

```go
// main.go — run multiple instances with the same consumer name
func main() {
    cfg := messaging.Config{
        URLs:           []string{"nats://nats.messaging.svc.cluster.local:4222"},
        Name:           "order-processor-" + os.Getenv("POD_NAME"),
        MaxReconnects:  -1, // Unlimited reconnects
        ReconnectWait:  2 * time.Second,
        ConnectTimeout: 10 * time.Second,
    }

    client, err := messaging.NewClient(cfg, slog.Default())
    if err != nil {
        slog.Error("connect to NATS", "err", err)
        os.Exit(1)
    }
    defer client.Close()

    js := client.JetStream()

    // Ensure the stream exists (idempotent)
    _, err = messaging.EnsureStream(context.Background(), js, messaging.StreamSpec{
        Name:     "ORDERS",
        Subjects: []string{"orders.events", "orders.commands"},
        MaxAge:   7 * 24 * time.Hour,
        MaxBytes: 10 << 30, // 10 GiB
        Replicas: 3,
    })
    if err != nil {
        slog.Error("ensure stream", "err", err)
        os.Exit(1)
    }

    // All pod instances use the SAME consumer name "order-processor"
    // JetStream distributes messages across them automatically
    consumer := messaging.NewPullConsumer[OrderEvent](
        js,
        "ORDERS",
        "order-processor",  // <-- shared name = competing consumers
        []string{"orders.events"},
        10,   // concurrency: 10 goroutines per pod
        50,   // batch size: fetch 50 messages at a time
        processOrderEvent,
        slog.Default(),
    )

    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
    defer stop()

    if err := consumer.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
        slog.Error("consumer run failed", "err", err)
        os.Exit(1)
    }
}

func processOrderEvent(ctx context.Context, event OrderEvent, meta messaging.MessageMetadata) error {
    slog.InfoContext(ctx, "processing order event",
        "order_id", event.OrderID,
        "event_type", event.EventType,
        "seq", meta.Sequence,
        "delivery", meta.NumDeliveries,
    )
    // ... business logic ...
    return nil
}
```

## Observability and Metrics

```go
// internal/messaging/metrics.go
package messaging

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    messagesPublished = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "nats_messages_published_total",
            Help: "Total number of messages published",
        },
        []string{"subject", "stream"},
    )

    messagesConsumed = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "nats_messages_consumed_total",
            Help: "Total number of messages consumed",
        },
        []string{"consumer", "stream", "status"},
    )

    messageProcessingDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "nats_message_processing_duration_seconds",
            Help:    "Time spent processing a message",
            Buckets: prometheus.ExponentialBuckets(0.001, 2, 15),
        },
        []string{"consumer", "stream"},
    )

    redeliveryCount = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "nats_message_redeliveries_total",
            Help: "Number of message redeliveries",
        },
        []string{"consumer", "stream"},
    )

    consumerLag = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "nats_consumer_lag",
            Help: "Number of unprocessed messages in the consumer",
        },
        []string{"consumer", "stream"},
    )
)

// Prometheus alerts for NATS JetStream
const prometheusAlerts = `
groups:
  - name: nats-jetstream
    rules:
      - alert: NATSConsumerLagHigh
        expr: nats_consumer_lag > 10000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "NATS consumer {{ $labels.consumer }} has high lag"
          description: "Consumer {{ $labels.consumer }} on stream {{ $labels.stream }} has {{ $value }} unprocessed messages."

      - alert: NATSMessageRedeliveryRateHigh
        expr: >
          rate(nats_message_redeliveries_total[5m]) /
          rate(nats_messages_consumed_total[5m]) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High message redelivery rate for {{ $labels.consumer }}"

      - alert: NATSStreamStorageCritical
        expr: >
          nats_stream_bytes / nats_stream_max_bytes > 0.85
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "NATS stream {{ $labels.stream }} storage above 85%"
`
```

## Testing Strategies

```go
// internal/messaging/consumer_test.go
package messaging_test

import (
    "context"
    "testing"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestPushConsumer_AtLeastOnce(t *testing.T) {
    // Use embedded NATS server for tests
    // go get github.com/nats-io/nats-server/v2/server
    srv := startTestNATSServer(t)
    defer srv.Shutdown()

    nc, err := nats.Connect(srv.ClientURL())
    require.NoError(t, err)
    defer nc.Close()

    js, err := jetstream.New(nc)
    require.NoError(t, err)

    ctx := context.Background()

    // Create test stream
    _, err = js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
        Name:     "TEST",
        Subjects: []string{"test.>"},
        MaxAge:   1 * time.Hour,
    })
    require.NoError(t, err)

    // Track processed messages
    processed := make(chan string, 10)
    handler := func(ctx context.Context, event map[string]string, meta MessageMetadata) error {
        processed <- event["id"]
        return nil
    }

    consumer := messaging.NewPushConsumer[map[string]string](
        js, "TEST", "test-consumer", "test.events", handler, slog.Default(),
    )
    require.NoError(t, consumer.Start(ctx))

    // Publish 3 messages
    for i := 1; i <= 3; i++ {
        _, err := js.Publish(ctx, "test.events",
            []byte(fmt.Sprintf(`{"id":"msg-%d"}`, i)),
        )
        require.NoError(t, err)
    }

    // Verify all 3 are processed
    seen := make(map[string]bool)
    timeout := time.After(5 * time.Second)
    for len(seen) < 3 {
        select {
        case id := <-processed:
            seen[id] = true
        case <-timeout:
            t.Fatalf("timeout waiting for messages; got %d/3: %v", len(seen), seen)
        }
    }

    assert.True(t, seen["msg-1"])
    assert.True(t, seen["msg-2"])
    assert.True(t, seen["msg-3"])
}

func TestPushConsumer_RetriesOnError(t *testing.T) {
    srv := startTestNATSServer(t)
    defer srv.Shutdown()

    nc, err := nats.Connect(srv.ClientURL())
    require.NoError(t, err)
    defer nc.Close()

    js, err := jetstream.New(nc)
    require.NoError(t, err)

    ctx := context.Background()

    _, err = js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
        Name:     "RETRY",
        Subjects: []string{"retry.>"},
    })
    require.NoError(t, err)

    attempts := 0
    handler := func(ctx context.Context, event map[string]string, meta MessageMetadata) error {
        attempts++
        if attempts < 3 {
            return fmt.Errorf("simulated failure attempt %d", attempts)
        }
        return nil // succeed on 3rd attempt
    }

    consumer := messaging.NewPushConsumer[map[string]string](
        js, "RETRY", "retry-consumer", "retry.events", handler, slog.Default(),
    )
    require.NoError(t, consumer.Start(ctx))

    _, err = js.Publish(ctx, "retry.events", []byte(`{"id":"retry-msg"}`))
    require.NoError(t, err)

    // Wait for eventual success
    require.Eventually(t, func() bool { return attempts >= 3 }, 30*time.Second, 100*time.Millisecond)
    assert.Equal(t, 3, attempts)
}
```

## Summary

NATS JetStream's push and pull consumer models address different backpressure and throughput needs. Push consumers (via `Consume`) are optimal for low-latency event processing where NATS controls delivery timing. Pull consumers (via `Fetch`/`FetchNoWait`) give the application explicit control over concurrency and prevent memory pressure under load spikes. Durable consumer names enable competing consumers with zero additional configuration — all pods sharing the same consumer name automatically form a work queue. The critical operational pattern is always configuring `MaxDeliver` with exponential `BackOff` and routing terminated messages to a DLQ stream via advisory subjects, so no message is silently lost without inspection. Use `WithMsgID` on every publish to prevent double-processing during producer retries within the deduplication window.
