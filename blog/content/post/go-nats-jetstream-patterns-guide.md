---
title: "Go NATS JetStream Patterns: Durable Consumers, Key-Value Store, and Object Store"
date: 2028-04-25T00:00:00-05:00
draft: false
tags: ["Go", "NATS", "JetStream", "Messaging", "Event Streaming"]
categories: ["Go", "Messaging"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Go patterns for NATS JetStream covering durable consumer management, exactly-once delivery, Key-Value store for distributed state, and Object Store for large payload handling."
more_link: "yes"
url: "/go-nats-jetstream-patterns-guide/"
---

NATS JetStream transforms NATS from a fire-and-forget messaging system into a persistent, replay-capable event streaming platform. This guide covers the Go patterns that production teams actually need: building reliable durable consumers, leveraging the Key-Value store as a distributed configuration and state backend, handling large payloads with Object Store, and structuring JetStream applications for operational manageability.

<!--more-->

# Go NATS JetStream Patterns: Durable Consumers, Key-Value Store, and Object Store

## JetStream Architecture Primer

JetStream is NATS's built-in persistence layer. Unlike NATS core messaging where messages are lost if no subscriber is present, JetStream persists messages in **Streams** and delivers them to **Consumers**. A stream captures messages from one or more subjects. A consumer is a view into a stream with its own position, filters, and delivery semantics.

Key JetStream primitives:

- **Stream**: A named, ordered, persistent sequence of messages on a subject namespace
- **Consumer**: A stateful cursor through a stream. Consumers can be push (server delivers) or pull (client requests batches)
- **Durable Consumer**: A named consumer whose progress survives client restarts
- **Key-Value Store**: Built on JetStream streams, provides a distributed KV interface with revision history
- **Object Store**: Built on JetStream streams, handles large binary payloads in chunks

The Go client library is `nats.go` with the `jetstream` package (v2 API):

```bash
go get github.com/nats-io/nats.go@latest
```

## Connecting and Initializing JetStream

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

func connect(servers string) (*nats.Conn, jetstream.JetStream, error) {
    nc, err := nats.Connect(
        servers,
        nats.Name("my-service"),
        nats.ReconnectWait(2*time.Second),
        nats.MaxReconnects(-1), // Reconnect indefinitely
        nats.DisconnectErrHandler(func(nc *nats.Conn, err error) {
            log.Printf("NATS disconnected: %v", err)
        }),
        nats.ReconnectHandler(func(nc *nats.Conn) {
            log.Printf("NATS reconnected to %s", nc.ConnectedUrl())
        }),
        nats.ErrorHandler(func(nc *nats.Conn, sub *nats.Subscription, err error) {
            log.Printf("NATS async error: sub=%v err=%v", sub.Subject, err)
        }),
    )
    if err != nil {
        return nil, nil, fmt.Errorf("connecting to NATS: %w", err)
    }

    js, err := jetstream.New(nc)
    if err != nil {
        nc.Close()
        return nil, nil, fmt.Errorf("creating JetStream context: %w", err)
    }

    return nc, js, nil
}
```

## Stream Management

### Creating Streams with Idempotent Setup

Stream creation should be idempotent so that application startup doesn't fail if the stream already exists:

```go
package streams

import (
    "context"
    "errors"
    "fmt"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

type StreamConfig struct {
    Name        string
    Subjects    []string
    Replicas    int
    MaxAge      time.Duration
    MaxBytes    int64
    MaxMsgSize  int32
    Storage     jetstream.StorageType
    Retention   jetstream.RetentionPolicy
    Discard     jetstream.DiscardPolicy
    DedupWindow time.Duration
}

// EnsureStream creates the stream if it doesn't exist, or updates it if config changed.
func EnsureStream(ctx context.Context, js jetstream.JetStream, cfg StreamConfig) (jetstream.Stream, error) {
    jsCfg := jetstream.StreamConfig{
        Name:              cfg.Name,
        Subjects:          cfg.Subjects,
        Replicas:          cfg.Replicas,
        MaxAge:            cfg.MaxAge,
        MaxBytes:          cfg.MaxBytes,
        MaxMsgSize:        cfg.MaxMsgSize,
        Storage:           cfg.Storage,
        Retention:         cfg.Retention,
        Discard:           cfg.Discard,
        Duplicates:        cfg.DedupWindow,
        AllowDirect:       true,  // Enable direct get for KV-like access
        MirrorDirect:      false,
    }

    stream, err := js.CreateOrUpdateStream(ctx, jsCfg)
    if err != nil {
        return nil, fmt.Errorf("ensuring stream %s: %w", cfg.Name, err)
    }

    info, err := stream.Info(ctx)
    if err != nil {
        return nil, fmt.Errorf("getting stream info: %w", err)
    }

    _ = info // Log or validate as needed
    return stream, nil
}

// OrdersStream returns a stream config appropriate for an order processing system.
func OrdersStreamConfig() StreamConfig {
    return StreamConfig{
        Name:        "ORDERS",
        Subjects:    []string{"orders.>"},
        Replicas:    3,
        MaxAge:      7 * 24 * time.Hour, // 7 days retention
        MaxBytes:    10 * 1024 * 1024 * 1024, // 10 GiB
        MaxMsgSize:  1 * 1024 * 1024, // 1 MiB per message
        Storage:     jetstream.FileStorage,
        Retention:   jetstream.LimitsPolicy,
        Discard:     jetstream.DiscardOld,
        DedupWindow: 5 * time.Minute,
    }
}
```

## Publishing with Exactly-Once Semantics

JetStream supports exactly-once publish using a message ID for deduplication within the `Duplicates` window:

```go
package publisher

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

type Order struct {
    ID         string    `json:"id"`
    CustomerID string    `json:"customer_id"`
    Amount     float64   `json:"amount"`
    Items      []string  `json:"items"`
    CreatedAt  time.Time `json:"created_at"`
}

type Publisher struct {
    js jetstream.JetStream
}

func NewPublisher(js jetstream.JetStream) *Publisher {
    return &Publisher{js: js}
}

// PublishOrder publishes an order event with exactly-once semantics.
// The message ID is used for deduplication within the stream's Duplicates window.
func (p *Publisher) PublishOrder(ctx context.Context, order Order) error {
    data, err := json.Marshal(order)
    if err != nil {
        return fmt.Errorf("marshaling order: %w", err)
    }

    subject := fmt.Sprintf("orders.placed.%s", order.CustomerID)

    ack, err := p.js.Publish(ctx, subject, data,
        jetstream.WithMsgID(order.ID), // Dedup key
        jetstream.WithExpectStream("ORDERS"),
    )
    if err != nil {
        return fmt.Errorf("publishing order %s: %w", order.ID, err)
    }

    _ = ack.Duplicate // true if this was a duplicate (idempotent)
    return nil
}

// PublishBatch publishes multiple orders efficiently using async publish.
func (p *Publisher) PublishBatch(ctx context.Context, orders []Order) error {
    type result struct {
        orderID string
        paf     jetstream.PubAckFuture
    }

    futures := make([]result, 0, len(orders))

    for _, order := range orders {
        data, err := json.Marshal(order)
        if err != nil {
            return fmt.Errorf("marshaling order %s: %w", order.ID, err)
        }

        subject := fmt.Sprintf("orders.placed.%s", order.CustomerID)

        paf, err := p.js.PublishAsync(subject, data,
            jetstream.WithMsgID(order.ID),
        )
        if err != nil {
            return fmt.Errorf("async publish order %s: %w", order.ID, err)
        }

        futures = append(futures, result{orderID: order.ID, paf: paf})
    }

    // Wait for all acks
    for _, r := range futures {
        select {
        case ack := <-r.paf.Ok():
            _ = ack
        case err := <-r.paf.Err():
            return fmt.Errorf("ack failed for order %s: %w", r.orderID, err)
        case <-ctx.Done():
            return ctx.Err()
        }
    }

    return nil
}
```

## Durable Consumer Patterns

### Pull Consumer with Batching

Pull consumers are preferred for high-throughput processing because the client controls fetch rate:

```go
package consumer

import (
    "context"
    "errors"
    "fmt"
    "log"
    "sync"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

type OrderProcessor struct {
    consumer jetstream.Consumer
    handler  func(ctx context.Context, msg jetstream.Msg) error
    workers  int
    batchSize int
}

// CreateDurableConsumer creates or gets an existing durable pull consumer.
func CreateDurableConsumer(
    ctx context.Context,
    stream jetstream.Stream,
    name string,
    filterSubject string,
) (jetstream.Consumer, error) {
    consumer, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
        Durable:        name,
        FilterSubject:  filterSubject,
        AckPolicy:      jetstream.AckExplicitPolicy,
        AckWait:        30 * time.Second,
        MaxDeliver:     5,    // Retry up to 5 times before dead-lettering
        BackOff:        []time.Duration{
            1 * time.Second,
            5 * time.Second,
            15 * time.Second,
            60 * time.Second,
        },
        DeliverPolicy:  jetstream.DeliverAllPolicy,
        ReplayPolicy:   jetstream.ReplayInstantPolicy,
        MaxAckPending:  1000, // Limit in-flight messages
        FlowControl:    false,
        // Dead letter: messages that exceed MaxDeliver go to advisory subject
        // Monitor: $JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.*
    })
    if err != nil {
        return nil, fmt.Errorf("creating consumer %s: %w", name, err)
    }

    return consumer, nil
}

func NewOrderProcessor(
    consumer jetstream.Consumer,
    handler func(ctx context.Context, msg jetstream.Msg) error,
    workers int,
    batchSize int,
) *OrderProcessor {
    return &OrderProcessor{
        consumer:  consumer,
        handler:   handler,
        workers:   workers,
        batchSize: batchSize,
    }
}

// Run starts the pull consumer processing loop with worker pool.
func (p *OrderProcessor) Run(ctx context.Context) error {
    msgCh := make(chan jetstream.Msg, p.batchSize*p.workers)

    var wg sync.WaitGroup

    // Start worker goroutines
    for i := 0; i < p.workers; i++ {
        wg.Add(1)
        go func(workerID int) {
            defer wg.Done()
            p.processMessages(ctx, workerID, msgCh)
        }(i)
    }

    // Fetch loop
    fetchErr := p.fetchLoop(ctx, msgCh)

    // Signal workers to drain and stop
    close(msgCh)
    wg.Wait()

    return fetchErr
}

func (p *OrderProcessor) fetchLoop(ctx context.Context, msgCh chan<- jetstream.Msg) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        msgs, err := p.consumer.Fetch(p.batchSize,
            jetstream.FetchMaxWait(5*time.Second),
        )
        if err != nil {
            if errors.Is(err, jetstream.ErrMsgNotFound) ||
                errors.Is(err, context.DeadlineExceeded) {
                // No messages available; back off briefly
                select {
                case <-ctx.Done():
                    return ctx.Err()
                case <-time.After(100 * time.Millisecond):
                }
                continue
            }
            return fmt.Errorf("fetch error: %w", err)
        }

        for msg := range msgs.Messages() {
            select {
            case msgCh <- msg:
            case <-ctx.Done():
                _ = msg.Nak() // Return message to stream
                return ctx.Err()
            }
        }

        if err := msgs.Error(); err != nil {
            log.Printf("Fetch messages error: %v", err)
        }
    }
}

func (p *OrderProcessor) processMessages(
    ctx context.Context,
    workerID int,
    msgCh <-chan jetstream.Msg,
) {
    for msg := range msgCh {
        if err := p.processWithRetry(ctx, msg); err != nil {
            log.Printf("[worker %d] Failed to process message %s: %v",
                workerID, msg.Subject(), err)
            // Nak with delay to trigger backoff retry
            if nakErr := msg.NakWithDelay(10 * time.Second); nakErr != nil {
                log.Printf("[worker %d] Nak failed: %v", workerID, nakErr)
            }
        }
    }
}

func (p *OrderProcessor) processWithRetry(ctx context.Context, msg jetstream.Msg) error {
    // Extend ack deadline if processing might be slow
    meta, err := msg.Metadata()
    if err == nil && meta.NumDelivered > 1 {
        log.Printf("Redelivered message (delivery %d): %s", meta.NumDelivered, msg.Subject())
    }

    // Call handler
    handlerErr := p.handler(ctx, msg)
    if handlerErr != nil {
        return handlerErr
    }

    // Explicit ack on success
    return msg.Ack()
}
```

### Push Consumer with OrderedConsumer for Event Replay

Ordered consumers are useful for event replay and audit scenarios:

```go
package replay

import (
    "context"
    "fmt"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

// ReplayOrdersFrom replays all orders from a given sequence number.
func ReplayOrdersFrom(
    ctx context.Context,
    js jetstream.JetStream,
    startSeq uint64,
    handler func(msg jetstream.Msg),
) error {
    // OrderedConsumer is ephemeral, auto-restored on interruption
    consumer, err := js.OrderedConsumer(ctx, "ORDERS", jetstream.OrderedConsumerConfig{
        FilterSubjects: []string{"orders.>"},
        DeliverPolicy:  jetstream.DeliverByStartSequencePolicy,
        OptStartSeq:    startSeq,
        ReplayPolicy:   jetstream.ReplayInstantPolicy,
    })
    if err != nil {
        return fmt.Errorf("creating ordered consumer: %w", err)
    }

    // Consume until caught up to current sequence
    info, err := js.Stream(ctx, "ORDERS")
    if err != nil {
        return fmt.Errorf("getting stream: %w", err)
    }

    streamInfo, err := info.Info(ctx)
    if err != nil {
        return fmt.Errorf("getting stream info: %w", err)
    }

    lastSeq := streamInfo.State.LastSeq

    msgs, err := consumer.Fetch(int(lastSeq-startSeq+1),
        jetstream.FetchMaxWait(30*time.Second),
    )
    if err != nil {
        return fmt.Errorf("fetching replay messages: %w", err)
    }

    for msg := range msgs.Messages() {
        handler(msg)
        _ = msg.Ack()

        meta, _ := msg.Metadata()
        if meta.Sequence.Stream >= lastSeq {
            break // Reached the end of historical data
        }
    }

    return msgs.Error()
}
```

## Key-Value Store Patterns

JetStream's KV Store provides a distributed, revision-tracked key-value interface ideal for configuration, distributed locks, and leader election.

### Setting Up a KV Bucket

```go
package kv

import (
    "context"
    "fmt"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

type KVManager struct {
    js jetstream.JetStream
}

func NewKVManager(js jetstream.JetStream) *KVManager {
    return &KVManager{js: js}
}

// EnsureBucket creates or gets a KV bucket with the given configuration.
func (m *KVManager) EnsureBucket(ctx context.Context, name string, opts ...jetstream.KeyValueConfig) (jetstream.KeyValue, error) {
    cfg := jetstream.KeyValueConfig{
        Bucket:       name,
        TTL:          0, // No expiration by default
        Storage:      jetstream.FileStorage,
        Replicas:     3,
        MaxValueSize: 1024 * 1024, // 1 MiB max value
        History:      10,          // Keep last 10 revisions
    }

    if len(opts) > 0 {
        cfg = opts[0]
        cfg.Bucket = name
    }

    kv, err := m.js.CreateOrUpdateKeyValue(ctx, cfg)
    if err != nil {
        return nil, fmt.Errorf("ensuring KV bucket %s: %w", name, err)
    }

    return kv, nil
}
```

### Configuration Store with Watch

```go
package config

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "sync"

    "github.com/nats-io/nats.go/jetstream"
)

type ServiceConfig struct {
    MaxConnections int    `json:"max_connections"`
    Timeout        int    `json:"timeout_seconds"`
    FeatureFlags   map[string]bool `json:"feature_flags"`
}

type ConfigStore struct {
    kv     jetstream.KeyValue
    mu     sync.RWMutex
    config ServiceConfig
    onUpdate func(ServiceConfig)
}

func NewConfigStore(kv jetstream.KeyValue, onUpdate func(ServiceConfig)) *ConfigStore {
    return &ConfigStore{
        kv:       kv,
        onUpdate: onUpdate,
    }
}

// Load reads the current configuration.
func (c *ConfigStore) Load(ctx context.Context, service string) error {
    entry, err := c.kv.Get(ctx, fmt.Sprintf("config.%s", service))
    if err != nil {
        return fmt.Errorf("loading config for %s: %w", service, err)
    }

    var cfg ServiceConfig
    if err := json.Unmarshal(entry.Value(), &cfg); err != nil {
        return fmt.Errorf("parsing config: %w", err)
    }

    c.mu.Lock()
    c.config = cfg
    c.mu.Unlock()

    return nil
}

// Watch starts watching for config changes and updates the in-memory config.
func (c *ConfigStore) Watch(ctx context.Context, service string) error {
    watcher, err := c.kv.Watch(ctx,
        fmt.Sprintf("config.%s", service),
        jetstream.IncludeHistory(),
    )
    if err != nil {
        return fmt.Errorf("creating config watcher: %w", err)
    }

    go func() {
        defer watcher.Stop()

        for {
            select {
            case <-ctx.Done():
                return
            case entry, ok := <-watcher.Updates():
                if !ok {
                    return
                }

                if entry == nil {
                    // Nil entry signals end of initial history
                    continue
                }

                if entry.Operation() == jetstream.KeyValueDelete {
                    log.Printf("Config deleted for %s", service)
                    continue
                }

                var cfg ServiceConfig
                if err := json.Unmarshal(entry.Value(), &cfg); err != nil {
                    log.Printf("Failed to parse config update: %v", err)
                    continue
                }

                c.mu.Lock()
                c.config = cfg
                c.mu.Unlock()

                log.Printf("Config updated for %s (revision %d)", service, entry.Revision())

                if c.onUpdate != nil {
                    c.onUpdate(cfg)
                }
            }
        }
    }()

    return nil
}

// Get returns the current config with read lock.
func (c *ConfigStore) Get() ServiceConfig {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.config
}
```

### Distributed Lock with CAS

The KV Store's compare-and-swap operations enable distributed locking:

```go
package lock

import (
    "context"
    "errors"
    "fmt"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

var ErrLockNotAcquired = errors.New("lock not acquired")

type DistributedLock struct {
    kv      jetstream.KeyValue
    key     string
    ownerID string
    ttl     time.Duration
}

func NewDistributedLock(kv jetstream.KeyValue, key, ownerID string, ttl time.Duration) *DistributedLock {
    return &DistributedLock{kv: kv, key: key, ownerID: ownerID, ttl: ttl}
}

// TryAcquire attempts to acquire the lock. Returns ErrLockNotAcquired if unavailable.
func (l *DistributedLock) TryAcquire(ctx context.Context) (revision uint64, err error) {
    // Try to create the key (only succeeds if it doesn't exist)
    rev, err := l.kv.Create(ctx, l.key, []byte(l.ownerID))
    if err != nil {
        if errors.Is(err, jetstream.ErrKeyExists) {
            return 0, ErrLockNotAcquired
        }
        return 0, fmt.Errorf("acquiring lock %s: %w", l.key, err)
    }

    return rev, nil
}

// Release releases the lock using CAS to ensure we only delete our own lock.
func (l *DistributedLock) Release(ctx context.Context, revision uint64) error {
    if err := l.kv.Delete(ctx, l.key, jetstream.LastRevision(revision)); err != nil {
        return fmt.Errorf("releasing lock %s: %w", l.key, err)
    }
    return nil
}

// AcquireWithRetry retries lock acquisition with exponential backoff.
func (l *DistributedLock) AcquireWithRetry(ctx context.Context, maxWait time.Duration) (uint64, error) {
    deadline := time.Now().Add(maxWait)
    backoff := 50 * time.Millisecond

    for {
        rev, err := l.TryAcquire(ctx)
        if err == nil {
            return rev, nil
        }

        if !errors.Is(err, ErrLockNotAcquired) {
            return 0, err
        }

        if time.Now().After(deadline) {
            return 0, fmt.Errorf("timeout acquiring lock %s after %s", l.key, maxWait)
        }

        select {
        case <-ctx.Done():
            return 0, ctx.Err()
        case <-time.After(backoff):
            backoff = min(backoff*2, 2*time.Second)
        }
    }
}

func min(a, b time.Duration) time.Duration {
    if a < b {
        return a
    }
    return b
}
```

## Object Store Patterns

JetStream Object Store handles large binary payloads by chunking them across multiple JetStream messages. It is ideal for model artifacts, configuration blobs, and binary assets.

### Object Store Setup and Usage

```go
package objstore

import (
    "bytes"
    "context"
    "fmt"
    "io"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

type ArtifactStore struct {
    obs jetstream.ObjectStore
}

func NewArtifactStore(ctx context.Context, js jetstream.JetStream, bucket string) (*ArtifactStore, error) {
    obs, err := js.CreateOrUpdateObjectStore(ctx, jetstream.ObjectStoreConfig{
        Bucket:      bucket,
        Description: "ML model artifacts and binary assets",
        TTL:         30 * 24 * time.Hour, // 30 days
        Storage:     jetstream.FileStorage,
        Replicas:    3,
        Compression: jetstream.S2Compression, // S2 compression for chunks
        MaxChunkSize: 128 * 1024, // 128 KiB chunks
    })
    if err != nil {
        return nil, fmt.Errorf("creating object store %s: %w", bucket, err)
    }

    return &ArtifactStore{obs: obs}, nil
}

// PutArtifact stores a named artifact from an io.Reader.
func (s *ArtifactStore) PutArtifact(ctx context.Context, name string, r io.Reader, meta map[string]string) (*jetstream.ObjectInfo, error) {
    info, err := s.obs.Put(ctx, jetstream.ObjectMeta{
        Name:        name,
        Description: meta["description"],
        Headers:     natsHeadersFromMap(meta),
    }, r)
    if err != nil {
        return nil, fmt.Errorf("storing artifact %s: %w", name, err)
    }

    return info, nil
}

// GetArtifact retrieves a named artifact.
func (s *ArtifactStore) GetArtifact(ctx context.Context, name string) (io.ReadCloser, *jetstream.ObjectInfo, error) {
    result, err := s.obs.Get(ctx, name)
    if err != nil {
        return nil, nil, fmt.Errorf("getting artifact %s: %w", name, err)
    }

    info, err := result.Info()
    if err != nil {
        return nil, nil, fmt.Errorf("getting artifact info: %w", err)
    }

    return result, info, nil
}

// ListArtifacts returns all artifacts in the store.
func (s *ArtifactStore) ListArtifacts(ctx context.Context) ([]*jetstream.ObjectInfo, error) {
    var artifacts []*jetstream.ObjectInfo

    lister, err := s.obs.List(ctx)
    if err != nil {
        return nil, fmt.Errorf("listing artifacts: %w", err)
    }

    for info := range lister.Info() {
        copy := *info
        artifacts = append(artifacts, &copy)
    }

    return artifacts, lister.Error()
}

func natsHeadersFromMap(m map[string]string) nats.Header {
    h := make(nats.Header)
    for k, v := range m {
        h.Set(k, v)
    }
    return h
}

// Example: Store and retrieve a model
func ExampleModelStorage(ctx context.Context, js jetstream.JetStream) error {
    store, err := NewArtifactStore(ctx, js, "ml-models")
    if err != nil {
        return err
    }

    // Store a large model file
    modelData := generateFakeModelData(50 * 1024 * 1024) // 50 MiB
    info, err := store.PutArtifact(ctx, "sentiment-model-v3.2.0", bytes.NewReader(modelData), map[string]string{
        "description": "Sentiment analysis model v3.2.0",
        "framework":   "pytorch",
        "accuracy":    "0.923",
    })
    if err != nil {
        return err
    }

    fmt.Printf("Stored model: %s (%d bytes, %d chunks)\n",
        info.Name, info.Size, info.Chunks)

    // Retrieve and verify
    rc, _, err := store.GetArtifact(ctx, "sentiment-model-v3.2.0")
    if err != nil {
        return err
    }
    defer rc.Close()

    data, err := io.ReadAll(rc)
    if err != nil {
        return err
    }

    fmt.Printf("Retrieved %d bytes\n", len(data))
    return nil
}

func generateFakeModelData(size int) []byte {
    data := make([]byte, size)
    for i := range data {
        data[i] = byte(i % 256)
    }
    return data
}
```

## Message Headers and Metadata

JetStream messages support headers for metadata propagation, which is useful for tracing and correlation:

```go
package tracing

import (
    "context"
    "fmt"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/propagation"
)

// PublishWithTrace injects the current trace context into NATS message headers.
func PublishWithTrace(
    ctx context.Context,
    js jetstream.JetStream,
    subject string,
    data []byte,
    msgID string,
) error {
    msg := nats.NewMsg(subject)
    msg.Data = data

    // Inject trace context
    prop := otel.GetTextMapPropagator()
    prop.Inject(ctx, propagation.MapCarrier(msg.Header))

    msg.Header.Set("Nats-Msg-Id", msgID)

    _, err := js.PublishMsg(ctx, msg, jetstream.WithMsgID(msgID))
    return err
}

// ExtractTrace extracts trace context from a received JetStream message.
func ExtractTrace(ctx context.Context, msg jetstream.Msg) context.Context {
    prop := otel.GetTextMapPropagator()
    carrier := propagation.MapCarrier{}

    for k, vals := range msg.Headers() {
        if len(vals) > 0 {
            carrier[k] = vals[0]
        }
    }

    return prop.Extract(ctx, carrier)
}
```

## Dead Letter Queue Pattern

Messages that exceed max delivery attempts need special handling:

```go
package dlq

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

type DeadLetterEntry struct {
    OriginalSubject  string          `json:"original_subject"`
    Payload          json.RawMessage `json:"payload"`
    NumDeliveries    uint64          `json:"num_deliveries"`
    FirstTimestamp   time.Time       `json:"first_timestamp"`
    LastTimestamp    time.Time       `json:"last_timestamp"`
    Error            string          `json:"error"`
}

// MonitorDeadLetters subscribes to JetStream advisory events for max delivery exceeded.
func MonitorDeadLetters(ctx context.Context, js jetstream.JetStream, nc *nats.Conn) error {
    // JetStream publishes advisories on this subject pattern
    sub, err := nc.Subscribe("$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>", func(msg *nats.Msg) {
        var advisory struct {
            Stream      string `json:"stream"`
            Consumer    string `json:"consumer"`
            StreamSeq   uint64 `json:"stream_seq"`
            Deliveries  uint64 `json:"deliveries"`
        }

        if err := json.Unmarshal(msg.Data, &advisory); err != nil {
            log.Printf("Failed to parse advisory: %v", err)
            return
        }

        log.Printf("Max deliveries exceeded: stream=%s consumer=%s seq=%d deliveries=%d",
            advisory.Stream, advisory.Consumer, advisory.StreamSeq, advisory.Deliveries)

        // Optionally fetch the original message and store in DLQ stream
        if err := archiveToDLQ(ctx, js, advisory.Stream, advisory.StreamSeq); err != nil {
            log.Printf("Failed to archive to DLQ: %v", err)
        }
    })
    if err != nil {
        return fmt.Errorf("subscribing to advisories: %w", err)
    }

    <-ctx.Done()
    sub.Unsubscribe()
    return ctx.Err()
}

func archiveToDLQ(ctx context.Context, js jetstream.JetStream, streamName string, seq uint64) error {
    stream, err := js.Stream(ctx, streamName)
    if err != nil {
        return err
    }

    msg, err := stream.GetMsg(ctx, seq)
    if err != nil {
        return err
    }

    entry := DeadLetterEntry{
        OriginalSubject: msg.Subject,
        Payload:         msg.Data,
        LastTimestamp:   msg.Time,
    }

    data, _ := json.Marshal(entry)
    _, err = js.Publish(ctx, fmt.Sprintf("dlq.%s", streamName), data)
    return err
}
```

## Benchmarking JetStream Throughput

```go
package bench

import (
    "context"
    "fmt"
    "sync/atomic"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

type BenchResult struct {
    Duration     time.Duration
    MessagesPublished uint64
    MessagesConsumed  uint64
    PublishRate  float64
    ConsumeRate  float64
    P99Latency   time.Duration
}

func BenchmarkPubSub(ctx context.Context, js jetstream.JetStream, messageCount int, payloadSize int) (*BenchResult, error) {
    payload := make([]byte, payloadSize)

    var published, consumed atomic.Uint64
    latencies := make([]int64, 0, messageCount)

    stream, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
        Name:     "BENCH",
        Subjects: []string{"bench.>"},
        Storage:  jetstream.MemoryStorage, // Use memory for benchmarking
    })
    if err != nil {
        return nil, err
    }
    defer js.DeleteStream(ctx, "BENCH")

    consumer, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
        Durable:   "bench-consumer",
        AckPolicy: jetstream.AckNonePolicy, // Skip acks for throughput test
    })
    if err != nil {
        return nil, err
    }

    start := time.Now()

    // Publish
    for i := 0; i < messageCount; i++ {
        if _, err := js.Publish(ctx, "bench.test", payload); err != nil {
            return nil, fmt.Errorf("publish %d: %w", i, err)
        }
        published.Add(1)
    }

    // Consume
    msgs, err := consumer.Fetch(messageCount, jetstream.FetchMaxWait(30*time.Second))
    if err != nil {
        return nil, err
    }

    for range msgs.Messages() {
        consumed.Add(1)
        if consumed.Load() >= uint64(messageCount) {
            break
        }
    }

    duration := time.Since(start)

    return &BenchResult{
        Duration:          duration,
        MessagesPublished: published.Load(),
        MessagesConsumed:  consumed.Load(),
        PublishRate:       float64(published.Load()) / duration.Seconds(),
        ConsumeRate:       float64(consumed.Load()) / duration.Seconds(),
    }, nil
}
```

## Production Configuration Reference

### NATS Server JetStream Configuration

```conf
# nats-server.conf
port: 4222
monitor_port: 8222

jetstream {
    store_dir: /data/jetstream
    max_memory_store: 4GB
    max_file_store: 100GB
    # Enable compression for file storage
    compress_ok: true
}

cluster {
    name: "production"
    listen: "0.0.0.0:6222"
    routes: [
        "nats://nats-1:6222"
        "nats://nats-2:6222"
        "nats://nats-3:6222"
    ]
}

# TLS configuration
tls {
    cert_file: "/etc/nats/tls/server.crt"
    key_file:  "/etc/nats/tls/server.key"
    ca_file:   "/etc/nats/tls/ca.crt"
    verify:    true
}
```

### Kubernetes StatefulSet for NATS Cluster

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: nats
  namespace: messaging
spec:
  replicas: 3
  serviceName: nats
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
            - containerPort: 4222
              name: client
            - containerPort: 6222
              name: cluster
            - containerPort: 8222
              name: monitor
          resources:
            requests:
              cpu: 500m
              memory: 2Gi
            limits:
              cpu: 2
              memory: 4Gi
          volumeMounts:
            - name: config
              mountPath: /etc/nats
            - name: data
              mountPath: /data/jetstream
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8222
            initialDelaySeconds: 10
            periodSeconds: 5
      volumes:
        - name: config
          configMap:
            name: nats-config
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 100Gi
```

## Summary

NATS JetStream provides a complete event streaming platform with a Go API that favors explicit control over configuration magic. The key patterns for production use:

- Use `CreateOrUpdateStream` and `CreateOrUpdateConsumer` for idempotent setup
- Prefer pull consumers with batching for high-throughput processing
- Configure meaningful `BackOff` arrays on consumers to avoid thundering herd on failures
- Use KV Store for distributed configuration with `Watch` for live updates
- Object Store handles large payloads transparently without application-level chunking
- Inject and extract trace context through message headers for end-to-end observability
- Monitor the `$JS.EVENT.ADVISORY.*` subjects for dead letters and exceeded delivery counts

JetStream's design keeps consumers stateless on the client side - the broker tracks position - which simplifies horizontal scaling and crash recovery significantly compared to systems where clients manage their own offset storage.
