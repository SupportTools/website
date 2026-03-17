---
title: "Go NATS Messaging: JetStream Consumers, Key-Value Store, and Object Store Patterns"
date: 2030-11-05T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "NATS", "JetStream", "Messaging", "Distributed Systems", "Key-Value"]
categories:
- Go
- Messaging
- Distributed Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "Production NATS guide in Go: JetStream push vs pull consumers, stream configuration, consumer durability and acknowledgment, KV store for distributed configuration, object store for binary data, and NATS clustering for high availability."
more_link: "yes"
url: "/go-nats-messaging-jetstream-consumers-keyvalue-objectstore-patterns/"
---

NATS with JetStream provides a unified messaging, persistence, key-value, and object storage platform that operates with sub-millisecond latency at scale. Unlike Kafka, which requires significant operational complexity, or Redis Streams, which lacks proper consumer group acknowledgment semantics, NATS JetStream delivers at-least-once and exactly-once delivery, durable subscriptions, and multi-cluster replication in a single binary with minimal operational overhead. This guide covers production-ready patterns for all major JetStream capabilities from a Go application perspective.

<!--more-->

## NATS Architecture and JetStream Overview

Core NATS operates as a fire-and-forget pub/sub system with no persistence. JetStream adds a persistence layer built on NATS itself, providing:

- **Streams**: Named sequences of messages matching subject wildcards, with configurable retention and replication
- **Consumers**: Subscriptions to a stream with position tracking, filtering, and delivery policies
- **KV Store**: A key-value API built on JetStream streams, with change history and TTL
- **Object Store**: A chunked binary blob storage API built on JetStream streams

```
┌─────────────────────────────────────────────────────────┐
│                    NATS JetStream                        │
│                                                         │
│  Streams (subjects: orders.> / events.* / metrics.#)   │
│  ├── Messages stored in file-backed or in-memory store  │
│  ├── Configurable retention: limits / interest / work   │
│  └── Replication factor: R1 / R3 / R5                   │
│                                                         │
│  Consumers (pull or push)                               │
│  ├── Durable: persistent position across restarts       │
│  ├── Ephemeral: no persistence                          │
│  └── Delivery policies: All / New / ByTime / BySeq      │
│                                                         │
│  KV Store (built on streams, prefix KV_)                │
│  Object Store (built on streams, prefix OBJ_)           │
└─────────────────────────────────────────────────────────┘
```

## Connecting to NATS

```go
package main

import (
    "context"
    "fmt"
    "log"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

// NewNATSConnection creates a production-ready NATS connection.
func NewNATSConnection(servers []string) (*nats.Conn, error) {
    opts := []nats.Option{
        // Reconnection: attempt indefinitely with exponential backoff
        nats.MaxReconnects(-1),
        nats.ReconnectWait(1 * time.Second),
        nats.ReconnectBufSize(16 * 1024 * 1024), // 16MB reconnect buffer

        // Connection timeout
        nats.Timeout(10 * time.Second),
        nats.PingInterval(20 * time.Second),
        nats.MaxPingsOutstanding(3),

        // TLS for production
        // nats.Secure(&tls.Config{MinVersion: tls.VersionTLS12}),

        // Authentication
        // nats.UserCredentials("/etc/nats/app.creds"),
        // nats.NkeyOptionFromSeed("/etc/nats/app.nk"),

        // Event handlers
        nats.DisconnectErrHandler(func(nc *nats.Conn, err error) {
            log.Printf("NATS disconnected: %v", err)
        }),
        nats.ReconnectHandler(func(nc *nats.Conn) {
            log.Printf("NATS reconnected to: %s", nc.ConnectedUrl())
        }),
        nats.ErrorHandler(func(nc *nats.Conn, sub *nats.Subscription, err error) {
            log.Printf("NATS async error on subscription %v: %v", sub.Subject, err)
        }),
        nats.ClosedHandler(func(nc *nats.Conn) {
            log.Printf("NATS connection closed")
        }),

        // Drain timeout: graceful shutdown
        nats.DrainTimeout(30 * time.Second),

        // Client name for server-side identification
        nats.Name("my-service-v2.3.1"),
    }

    nc, err := nats.Connect(
        strings.Join(servers, ","),
        opts...,
    )
    if err != nil {
        return nil, fmt.Errorf("connecting to NATS: %w", err)
    }

    return nc, nil
}
```

## Stream Configuration

### Creating Streams

```go
package streams

import (
    "context"
    "fmt"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

// CreateOrdersStream creates a stream for the orders domain.
func CreateOrdersStream(ctx context.Context, js jetstream.JetStream) (jetstream.Stream, error) {
    cfg := jetstream.StreamConfig{
        // Stream name: unique identifier, no spaces
        Name: "ORDERS",

        // Subjects: wildcard patterns this stream captures
        // '.' is a hierarchy separator
        // '*' matches a single token
        // '>' matches any number of tokens
        Subjects: []string{
            "orders.created",
            "orders.updated",
            "orders.completed",
            "orders.cancelled",
            "orders.items.>",
        },

        // Storage type: File for persistence, Memory for pure speed
        Storage: jetstream.FileStorage,

        // Replication factor: 1 (no HA), 3 (typical production), 5 (high durability)
        // Must be <= number of NATS nodes in the cluster
        Replicas: 3,

        // Retention policy:
        // LimitsPolicy:   keep messages until retention limits hit
        // InterestPolicy: delete messages when all consumers have consumed them
        // WorkQueuePolicy: delete messages after any consumer acknowledges them
        Retention: jetstream.LimitsPolicy,

        // Message age limit: messages older than this are deleted
        MaxAge: 7 * 24 * time.Hour,

        // Maximum messages in stream (0 = unlimited)
        MaxMsgs: 10_000_000,

        // Maximum bytes in stream (0 = unlimited)
        // 10GB limit
        MaxBytes: 10 * 1024 * 1024 * 1024,

        // Maximum message size in bytes (prevents runaway producers)
        MaxMsgSize: 1 * 1024 * 1024, // 1MB

        // Maximum consumers that can subscribe to this stream
        MaxConsumers: -1, // unlimited

        // Duplicate window: detect and reject duplicate messages
        // Messages with the same Nats-Msg-Id header within this window are deduplicated
        Duplicates: 1 * time.Hour,

        // Discard policy when stream is full:
        // DiscardOld: remove oldest messages (default)
        // DiscardNew: reject new messages
        Discard: jetstream.DiscardOld,

        // Message acknowledgment: at-least-once delivery
        // NoAck: fire-and-forget (not appropriate for ORDERS stream)
        NoAck: false,

        // Deny delete: prevent stream deletion without explicit configuration update
        DenyDelete: true,

        // Allow rollup: enable subject-level message compression
        AllowRollup: false,

        // Compression: NoCompression, S2Compression (Snappy variant)
        Compression: jetstream.S2Compression,
    }

    // CreateOrUpdate: idempotent — creates if not exists, updates if config changed
    stream, err := js.CreateOrUpdateStream(ctx, cfg)
    if err != nil {
        return nil, fmt.Errorf("creating orders stream: %w", err)
    }

    info, _ := stream.Info(ctx)
    fmt.Printf("Stream created: %s, messages: %d, bytes: %d\n",
        info.Config.Name, info.State.Msgs, info.State.Bytes)

    return stream, nil
}

// CreateMetricsStream creates a stream optimized for high-throughput metrics.
func CreateMetricsStream(ctx context.Context, js jetstream.JetStream) (jetstream.Stream, error) {
    cfg := jetstream.StreamConfig{
        Name:     "METRICS",
        Subjects: []string{"metrics.>"},
        // Memory storage for low-latency write path
        // Only suitable if data loss on restart is acceptable
        Storage:     jetstream.MemoryStorage,
        Replicas:    1,
        Retention:   jetstream.LimitsPolicy,
        MaxAge:      1 * time.Hour,
        MaxMsgs:     5_000_000,
        MaxBytes:    2 * 1024 * 1024 * 1024, // 2GB
        MaxMsgSize:  64 * 1024,               // 64KB per metric batch
        Discard:     jetstream.DiscardOld,
        NoAck:       true, // Metrics are fire-and-forget
        Compression: jetstream.NoCompression,
    }

    return js.CreateOrUpdateStream(ctx, cfg)
}
```

## Push Consumers

Push consumers are simpler but less scalable — the server pushes messages to a subscriber.

```go
package consumers

import (
    "context"
    "fmt"
    "log"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

// PushConsumerExample demonstrates a durable push consumer.
func PushConsumerExample(ctx context.Context, js jetstream.JetStream) error {
    cfg := jetstream.ConsumerConfig{
        // Durable name: makes the consumer persistent across reconnects and restarts
        // Without a durable name, the consumer is ephemeral and deleted when disconnected
        Durable: "orders-processor-v1",

        // Description for operational visibility
        Description: "Processes order events for fulfillment pipeline",

        // Delivery policy: where to start reading from
        // DeliverAllPolicy:        start from the first message in the stream
        // DeliverNewPolicy:        start from messages arriving after consumer creation
        // DeliverLastPolicy:       start from the last message in the stream
        // DeliverLastPerSubjectPolicy: start from last message per subject
        // DeliverByStartSequencePolicy: start from a specific sequence number
        // DeliverByStartTimePolicy:     start from messages at or after a time
        DeliverPolicy: jetstream.DeliverNewPolicy,

        // AckPolicy: how acknowledgments work
        // AckAllPolicy:      ack of sequence N implies ack of all prior sequences
        // AckExplicitPolicy: each message must be individually acknowledged
        // AckNonePolicy:     no acknowledgment required (fire-and-forget delivery)
        AckPolicy: jetstream.AckExplicitPolicy,

        // AckWait: how long the server waits for an ack before redelivering
        // Set to comfortably longer than your message processing time
        AckWait: 30 * time.Second,

        // MaxDeliver: maximum redelivery attempts before the message is moved
        // to a dead-letter stream (or dropped if no DLQ configured)
        MaxDeliver: 5,

        // FilterSubject: consume only messages matching this subject pattern
        FilterSubject: "orders.created",

        // MaxAckPending: maximum unacknowledged messages in flight
        // Controls back-pressure on the consumer
        MaxAckPending: 100,

        // Rate limit: maximum messages per second to deliver to this consumer
        // 0 = no limit
        RateLimit: 0,

        // Replay policy: how to deliver messages when backfilling
        // ReplayInstantPolicy: deliver at maximum speed
        // ReplayOriginalPolicy: deliver at original arrival rate
        ReplayPolicy: jetstream.ReplayInstantPolicy,

        // Headers only: deliver only message headers, not body
        // Useful for routing decisions without large payload overhead
        HeadersOnly: false,
    }

    consumer, err := js.CreateOrUpdateConsumer(ctx, "ORDERS", cfg)
    if err != nil {
        return fmt.Errorf("creating consumer: %w", err)
    }

    // Start consuming via callback
    consCtx, err := consumer.Consume(func(msg jetstream.Msg) {
        // Process the message
        if err := processOrder(msg); err != nil {
            // Nak with a backoff delay — message will be redelivered after 5 seconds
            msg.NakWithDelay(5 * time.Second)
            log.Printf("Processing failed, nacking: %v", err)
            return
        }

        // Acknowledge successful processing
        if err := msg.Ack(); err != nil {
            log.Printf("Failed to ack message: %v", err)
        }
    })
    if err != nil {
        return fmt.Errorf("starting consumer: %w", err)
    }
    defer consCtx.Stop()

    // Wait for context cancellation (shutdown signal)
    <-ctx.Done()
    return nil
}

func processOrder(msg jetstream.Msg) error {
    // Access message metadata
    meta, err := msg.Metadata()
    if err != nil {
        return fmt.Errorf("getting metadata: %w", err)
    }

    fmt.Printf("Processing message: subject=%s seq=%d stream=%s consumer=%s\n",
        msg.Subject(),
        meta.Sequence.Stream,
        meta.Stream,
        meta.Consumer,
    )

    // Access headers
    orderID := msg.Headers().Get("Order-ID")
    fmt.Printf("Order ID: %s\n", orderID)

    // Process payload
    payload := msg.Data()
    _ = payload

    return nil
}
```

## Pull Consumers

Pull consumers are the recommended pattern for production workloads. They give the application control over message fetch rate and naturally implement back-pressure.

```go
package consumers

import (
    "context"
    "fmt"
    "log"
    "sync"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

// PullConsumerWorkerPool implements a pull consumer with a worker pool.
// This pattern provides natural back-pressure and controlled concurrency.
func PullConsumerWorkerPool(
    ctx context.Context,
    js jetstream.JetStream,
    streamName string,
    workers int,
    processFn func(jetstream.Msg) error,
) error {
    cfg := jetstream.ConsumerConfig{
        Durable:       "fulfillment-processor",
        Description:   "Pull consumer for order fulfillment",
        DeliverPolicy: jetstream.DeliverAllPolicy,
        AckPolicy:     jetstream.AckExplicitPolicy,
        AckWait:       60 * time.Second,
        MaxDeliver:    10,
        MaxAckPending: workers * 2, // Allow double the worker count to be in flight
        FilterSubject: "orders.>",
    }

    consumer, err := js.CreateOrUpdateConsumer(ctx, streamName, cfg)
    if err != nil {
        return fmt.Errorf("creating pull consumer: %w", err)
    }

    // Use MessageBatch for efficient fetching
    var wg sync.WaitGroup
    msgCh := make(chan jetstream.Msg, workers*2)

    // Producer goroutine: fetch messages and feed to worker channel
    wg.Add(1)
    go func() {
        defer wg.Done()
        defer close(msgCh)

        for {
            select {
            case <-ctx.Done():
                return
            default:
            }

            // Fetch up to `workers` messages with a 1-second wait
            batch, err := consumer.FetchNoWait(workers)
            if err != nil {
                if ctx.Err() != nil {
                    return
                }
                log.Printf("Fetch error: %v, retrying in 1s", err)
                time.Sleep(1 * time.Second)
                continue
            }

            msgCount := 0
            for msg := range batch.Messages() {
                select {
                case msgCh <- msg:
                    msgCount++
                case <-ctx.Done():
                    // Nak remaining messages on shutdown
                    msg.Nak()
                    return
                }
            }

            if batch.Error() != nil {
                log.Printf("Batch error: %v", batch.Error())
            }

            // If no messages, wait before fetching again to avoid busy loop
            if msgCount == 0 {
                select {
                case <-time.After(500 * time.Millisecond):
                case <-ctx.Done():
                    return
                }
            }
        }
    }()

    // Worker goroutines: process messages
    for i := 0; i < workers; i++ {
        wg.Add(1)
        go func(workerID int) {
            defer wg.Done()

            for msg := range msgCh {
                start := time.Now()

                if err := processFn(msg); err != nil {
                    log.Printf("Worker %d: processing failed: %v", workerID, err)
                    msg.NakWithDelay(calculateBackoff(msg))
                    continue
                }

                if err := msg.Ack(); err != nil {
                    log.Printf("Worker %d: ack failed: %v", workerID, err)
                }

                log.Printf("Worker %d: processed in %v", workerID, time.Since(start))
            }
        }(i)
    }

    wg.Wait()
    return nil
}

// calculateBackoff implements exponential backoff based on delivery count.
func calculateBackoff(msg jetstream.Msg) time.Duration {
    meta, err := msg.Metadata()
    if err != nil {
        return 5 * time.Second
    }

    // Exponential backoff: 5s, 10s, 20s, 40s, 80s
    deliveries := meta.NumDelivered
    backoff := time.Duration(5<<uint(deliveries-1)) * time.Second
    if backoff > 5*time.Minute {
        backoff = 5 * time.Minute
    }
    return backoff
}

// FetchWithTimeout fetches a batch with a blocking timeout.
// Use this when low latency is required (process messages as soon as they arrive).
func FetchWithTimeout(consumer jetstream.Consumer, batchSize int, timeout time.Duration) ([]jetstream.Msg, error) {
    batch, err := consumer.Fetch(batchSize, jetstream.FetchMaxWait(timeout))
    if err != nil {
        return nil, err
    }

    var msgs []jetstream.Msg
    for msg := range batch.Messages() {
        msgs = append(msgs, msg)
    }

    if batch.Error() != nil && batch.Error() != nats.ErrTimeout {
        return msgs, batch.Error()
    }

    return msgs, nil
}
```

### Exactly-Once Delivery with Message Deduplication

```go
package publishing

import (
    "context"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

// PublishWithDeduplication publishes a message with idempotency via Nats-Msg-Id header.
// NATS deduplicates messages with the same ID within the stream's Duplicates window.
func PublishWithDeduplication(
    ctx context.Context,
    js jetstream.JetStream,
    subject string,
    data []byte,
    msgID string,
) (*jetstream.PubAck, error) {
    // If no explicit ID provided, generate one
    if msgID == "" {
        msgID = uuid.New().String()
    }

    headers := nats.Header{}
    headers.Set(nats.MsgIdHdr, msgID)

    // Set a domain-specific correlation header for tracing
    if traceID, ok := ctx.Value("trace-id").(string); ok {
        headers.Set("Trace-ID", traceID)
    }

    msg := &nats.Msg{
        Subject: subject,
        Data:    data,
        Header:  headers,
    }

    // PublishMsgAsync is the high-throughput path
    // PubAckFuture allows batch publishing without waiting for each ack
    future, err := js.PublishMsgAsync(msg)
    if err != nil {
        return nil, fmt.Errorf("publishing message: %w", err)
    }

    // Wait for ack with timeout
    select {
    case ack := <-future.Ok():
        return ack, nil
    case err := <-future.Err():
        return nil, fmt.Errorf("publish ack error: %w", err)
    case <-ctx.Done():
        return nil, ctx.Err()
    case <-time.After(10 * time.Second):
        return nil, fmt.Errorf("publish ack timeout")
    }
}

// HighThroughputPublisher batches publishes and awaits acks asynchronously.
type HighThroughputPublisher struct {
    js       jetstream.JetStream
    pending  []jetstream.PubAckFuture
    maxBatch int
}

func NewHighThroughputPublisher(js jetstream.JetStream, maxBatch int) *HighThroughputPublisher {
    return &HighThroughputPublisher{js: js, maxBatch: maxBatch}
}

func (p *HighThroughputPublisher) Publish(ctx context.Context, subject string, data []byte) error {
    future, err := p.js.PublishAsync(subject, data)
    if err != nil {
        return err
    }
    p.pending = append(p.pending, future)

    if len(p.pending) >= p.maxBatch {
        return p.Flush(ctx)
    }
    return nil
}

func (p *HighThroughputPublisher) Flush(ctx context.Context) error {
    // Wait for all pending publishes to be acknowledged
    select {
    case <-p.js.PublishAsyncComplete():
        p.pending = p.pending[:0]
        return nil
    case <-ctx.Done():
        return ctx.Err()
    case <-time.After(30 * time.Second):
        return fmt.Errorf("flush timeout with %d pending acks", len(p.pending))
    }
}
```

## Key-Value Store

JetStream KV provides a distributed key-value store with change history, TTL, and watch (change notification) capabilities.

```go
package kv

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

// CreateKVBucket creates or updates a KV bucket with production configuration.
func CreateKVBucket(ctx context.Context, js jetstream.JetStream, name string) (jetstream.KeyValue, error) {
    cfg := jetstream.KeyValueConfig{
        // Bucket name (equivalent to stream name KV_<name>)
        Bucket: name,

        // Description for operational visibility
        Description: fmt.Sprintf("Configuration store for %s", name),

        // TTL: 0 means keys never expire
        // Set TTL for ephemeral data like session tokens or feature flags
        TTL: 0,

        // MaxValueSize: maximum size per value
        MaxValueSize: 64 * 1024, // 64KB

        // History: number of historical revisions to keep per key
        // 1 means only current value
        // Higher values enable rollback and audit trail
        History: 10,

        // Storage type: File for durability, Memory for speed
        Storage: jetstream.FileStorage,

        // Replicas for HA
        Replicas: 3,

        // MaxBytes: total size limit for the KV bucket
        MaxBytes: 1 * 1024 * 1024 * 1024, // 1GB
    }

    kv, err := js.CreateOrUpdateKeyValue(ctx, cfg)
    if err != nil {
        return nil, fmt.Errorf("creating KV bucket %s: %w", name, err)
    }
    return kv, nil
}

// ServiceConfig demonstrates using KV as a distributed configuration store.
type ServiceConfig struct {
    RateLimit       int     `json:"rate_limit"`
    FeatureFlags    map[string]bool `json:"feature_flags"`
    UpstreamTimeout string  `json:"upstream_timeout"`
}

// ConfigStore manages service configuration in NATS KV.
type ConfigStore struct {
    kv      jetstream.KeyValue
    cache   map[string]ServiceConfig
    mu      sync.RWMutex
    updates chan struct{}
}

func NewConfigStore(ctx context.Context, js jetstream.JetStream) (*ConfigStore, error) {
    kv, err := CreateKVBucket(ctx, js, "service-config")
    if err != nil {
        return nil, err
    }

    cs := &ConfigStore{
        kv:      kv,
        cache:   make(map[string]ServiceConfig),
        updates: make(chan struct{}, 1),
    }

    // Start watching for changes
    go cs.watchForChanges(ctx)

    return cs, nil
}

func (cs *ConfigStore) watchForChanges(ctx context.Context) {
    // Watch all keys in the bucket
    watcher, err := cs.kv.WatchAll(ctx)
    if err != nil {
        log.Printf("Failed to start KV watcher: %v", err)
        return
    }
    defer watcher.Stop()

    for entry := range watcher.Updates() {
        if entry == nil {
            // nil indicates the initial snapshot is complete
            log.Printf("KV initial snapshot complete")
            continue
        }

        cs.mu.Lock()
        switch entry.Operation() {
        case jetstream.KeyValuePut:
            var config ServiceConfig
            if err := json.Unmarshal(entry.Value(), &config); err != nil {
                log.Printf("Failed to unmarshal config for key %s: %v", entry.Key(), err)
            } else {
                cs.cache[entry.Key()] = config
                log.Printf("Config updated: key=%s revision=%d", entry.Key(), entry.Revision())
            }
        case jetstream.KeyValueDelete, jetstream.KeyValuePurge:
            delete(cs.cache, entry.Key())
            log.Printf("Config deleted: key=%s", entry.Key())
        }
        cs.mu.Unlock()

        // Signal that an update occurred
        select {
        case cs.updates <- struct{}{}:
        default:
        }
    }
}

func (cs *ConfigStore) Get(key string) (ServiceConfig, bool) {
    cs.mu.RLock()
    defer cs.mu.RUnlock()
    cfg, ok := cs.cache[key]
    return cfg, ok
}

func (cs *ConfigStore) Put(ctx context.Context, key string, config ServiceConfig) error {
    data, err := json.Marshal(config)
    if err != nil {
        return err
    }
    _, err = cs.kv.Put(ctx, key, data)
    return err
}

// PutIfRevision implements optimistic concurrency — only update if current revision matches.
func (cs *ConfigStore) PutIfRevision(ctx context.Context, key string, config ServiceConfig, expectedRevision uint64) error {
    data, err := json.Marshal(config)
    if err != nil {
        return err
    }
    _, err = cs.kv.Update(ctx, key, data, expectedRevision)
    if err != nil {
        // err == nats.ErrKeyWrongLastMsgID means another writer updated concurrently
        return fmt.Errorf("optimistic lock failed for key %s: %w", key, err)
    }
    return nil
}

// AtomicIncrementWithLock demonstrates distributed locking via KV CAS operations.
func AtomicIncrement(ctx context.Context, kv jetstream.KeyValue, key string) (int64, error) {
    for {
        entry, err := kv.Get(ctx, key)
        if err == jetstream.ErrKeyNotFound {
            // First write
            _, err = kv.Create(ctx, key, []byte("1"))
            if err == nil {
                return 1, nil
            }
            // Another writer created it first, retry
            continue
        }
        if err != nil {
            return 0, err
        }

        current := int64(0)
        fmt.Sscanf(string(entry.Value()), "%d", &current)
        next := current + 1

        _, err = kv.Update(ctx, key, []byte(fmt.Sprintf("%d", next)), entry.Revision())
        if err == nil {
            return next, nil
        }
        // Revision conflict — retry
    }
}
```

## Object Store

JetStream Object Store provides large binary blob storage with chunked upload, download, and metadata.

```go
package objectstore

import (
    "context"
    "fmt"
    "io"
    "os"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

// CreateObjectBucket creates an Object Store bucket.
func CreateObjectBucket(ctx context.Context, js jetstream.JetStream, name string) (jetstream.ObjectStore, error) {
    cfg := jetstream.ObjectStoreConfig{
        Bucket:      name,
        Description: fmt.Sprintf("Binary object store: %s", name),
        TTL:         30 * 24 * time.Hour, // 30 days
        Storage:     jetstream.FileStorage,
        Replicas:    3,
        // MaxChunkSize: size of each chunk (default 128KB)
        // For large objects, larger chunks reduce overhead
        MaxChunkSize: 512 * 1024, // 512KB chunks
    }

    return js.CreateOrUpdateObjectStore(ctx, cfg)
}

// ArtifactStore demonstrates using Object Store for build artifact storage.
type ArtifactStore struct {
    obs jetstream.ObjectStore
}

func NewArtifactStore(ctx context.Context, js jetstream.JetStream) (*ArtifactStore, error) {
    obs, err := CreateObjectBucket(ctx, js, "build-artifacts")
    if err != nil {
        return nil, err
    }
    return &ArtifactStore{obs: obs}, nil
}

// UploadArtifact uploads a file to the Object Store with metadata.
func (s *ArtifactStore) UploadArtifact(ctx context.Context, name string, filePath string, metadata map[string]string) error {
    f, err := os.Open(filePath)
    if err != nil {
        return fmt.Errorf("opening file: %w", err)
    }
    defer f.Close()

    stat, err := f.Stat()
    if err != nil {
        return err
    }

    opts := jetstream.ObjectMeta{
        Name:        name,
        Description: fmt.Sprintf("Build artifact: %s", name),
        Headers:     make(map[string][]string),
    }

    // Add metadata as headers
    for k, v := range metadata {
        opts.Headers.Set(k, v)
    }

    info, err := s.obs.Put(ctx, opts, f)
    if err != nil {
        return fmt.Errorf("uploading artifact: %w", err)
    }

    fmt.Printf("Uploaded: name=%s size=%d chunks=%d\n",
        info.Name, stat.Size(), info.Chunks)

    return nil
}

// DownloadArtifact retrieves an artifact by name.
func (s *ArtifactStore) DownloadArtifact(ctx context.Context, name string, destPath string) error {
    obj, err := s.obs.Get(ctx, name)
    if err != nil {
        if err == jetstream.ErrObjectNotFound {
            return fmt.Errorf("artifact not found: %s", name)
        }
        return fmt.Errorf("fetching artifact: %w", err)
    }
    defer obj.Close()

    // Print object info
    info, err := obj.Info()
    if err != nil {
        return err
    }
    fmt.Printf("Downloading: name=%s size=%d\n", info.Name, info.Size)

    f, err := os.Create(destPath)
    if err != nil {
        return fmt.Errorf("creating destination file: %w", err)
    }
    defer f.Close()

    written, err := io.Copy(f, obj)
    if err != nil {
        return fmt.Errorf("writing artifact: %w", err)
    }

    fmt.Printf("Downloaded %d bytes to %s\n", written, destPath)
    return nil
}

// ListArtifacts returns all artifact metadata.
func (s *ArtifactStore) ListArtifacts(ctx context.Context) ([]*jetstream.ObjectInfo, error) {
    return s.obs.List(ctx)
}
```

## NATS Clustering for High Availability

### Helm-Based NATS Cluster Deployment

```yaml
# nats-helm-values.yaml
# Production NATS cluster with JetStream
nats:
  # 3-node cluster for HA
  replicaCount: 3

  cluster:
    enabled: true
    name: prod-cluster

  jetstream:
    enabled: true
    fileStorage:
      enabled: true
      storageDirectory: /data/jetstream
      size: 100Gi
      storageClassName: fast-ssd

  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 4Gi

  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app.kubernetes.io/name: nats
        topologyKey: kubernetes.io/hostname

  # TLS configuration
  tls:
    secret:
      name: nats-server-tls
    ca: ca.crt
    cert: tls.crt
    key: tls.key

  # Liveness and readiness
  livenessProbe:
    httpGet:
      path: /healthz
      port: 8222
    initialDelaySeconds: 30
    periodSeconds: 10

  # Monitoring
  exporter:
    enabled: true
    resources:
      requests:
        memory: 64Mi
        cpu: 50m

  # Pod disruption budget
  podDisruptionBudget:
    enabled: true
    minAvailable: 2

volumeClaimTemplates:
  - metadata:
      name: nats-js
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 100Gi
```

### Monitoring JetStream with Prometheus

```yaml
# nats-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: nats
  namespace: monitoring
  labels:
    release: prometheus
spec:
  namespaceSelector:
    matchNames:
    - nats
  selector:
    matchLabels:
      app.kubernetes.io/name: nats-exporter
  endpoints:
  - port: metrics
    interval: 15s
    path: /metrics
---
# Key JetStream metrics to alert on:
# nats_jetstream_enabled                     — JetStream is enabled
# nats_jetstream_consumer_num_ack_pending   — unacked messages per consumer
# nats_jetstream_stream_total_messages      — total messages in stream
# nats_jetstream_stream_total_bytes         — total bytes in stream
# nats_server_sent_msgs_total               — messages sent per server
# nats_server_recv_msgs_total               — messages received per server
# nats_server_slow_consumer_stats           — slow consumer disconnect events
```

```yaml
# nats-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: nats-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
  - name: nats.jetstream
    rules:
    - alert: NATSConsumerAckPendingHigh
      expr: |
        max by (stream, consumer) (
          nats_jetstream_consumer_num_ack_pending
        ) > 10000
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "NATS consumer {{ $labels.consumer }} has high ack pending"
        description: "{{ $value }} unacked messages in stream {{ $labels.stream }}"

    - alert: NATSSlowConsumer
      expr: rate(nats_server_slow_consumer_stats[5m]) > 0
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "NATS slow consumer detected on {{ $labels.server_id }}"

    - alert: NATSStreamStorageHigh
      expr: |
        (nats_jetstream_stream_total_bytes / nats_jetstream_stream_storage_max_bytes) > 0.85
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "NATS stream {{ $labels.stream }} storage above 85%"
```

## Summary

NATS JetStream provides a comprehensive messaging and data platform that covers the majority of messaging patterns needed in production Go applications:

- **Streams**: Configure retention, replication, deduplication, and compression per domain
- **Push consumers**: Simple callback-based consumption for low-concurrency use cases
- **Pull consumers**: Worker pool patterns with natural back-pressure and exponential backoff for production workloads
- **Exactly-once delivery**: Combine producer-side message IDs with stream deduplication windows
- **Key-Value store**: Distributed configuration, distributed locking via CAS operations, and change notification via Watch
- **Object Store**: Chunked binary storage for artifacts and large blobs with metadata
- **Clustering**: 3-node production clusters with pod anti-affinity and persistent storage
- **Monitoring**: Prometheus metrics for stream health, consumer lag, and slow consumers

The combination of high throughput (millions of messages per second), low latency (sub-millisecond), and minimal operational overhead makes NATS JetStream the most operationally efficient choice for Go services that require durable messaging.
