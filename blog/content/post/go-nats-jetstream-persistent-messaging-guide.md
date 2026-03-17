---
title: "Go NATS JetStream: Persistent Messaging, Consumer Groups, and Key-Value Store Patterns"
date: 2028-07-17T00:00:00-05:00
draft: false
tags: ["Go", "NATS", "JetStream", "Messaging", "Event Streaming"]
categories:
- Go
- Messaging
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to NATS JetStream in Go covering streams, durable consumers, consumer groups, work queues, key-value store patterns, object store, and cluster configuration for high-availability deployments."
more_link: "yes"
url: "/go-nats-jetstream-persistent-messaging-guide/"
---

NATS JetStream transforms NATS from a fire-and-forget pub/sub system into a persistent, replay-capable messaging platform that competes directly with Kafka and Pulsar while maintaining NATS's signature simplicity. With native Go support, sub-millisecond latency, and built-in clustering, JetStream is becoming the messaging backbone of choice for cloud-native Go services that need durability without operational complexity.

<!--more-->

# Go NATS JetStream: Persistent Messaging, Consumer Groups, and Key-Value Store Patterns

## Section 1: JetStream Fundamentals

### Core Concepts

| Concept | Description |
|---------|-------------|
| Stream | Named, persistent log of messages. Multiple subjects can map to one stream. |
| Consumer | Named cursor into a stream. Tracks position, handles redelivery on failure. |
| Push Consumer | Server pushes messages to a subject; low latency, high throughput. |
| Pull Consumer | Client fetches batches; preferred for worker pools and backpressure. |
| Durable Consumer | Consumer survives client restarts; state stored in cluster. |
| Ephemeral Consumer | Exists only while client is connected; no state persistence. |
| Work Queue | Exactly-once-delivery pattern: only one consumer receives each message. |
| KV Store | NATS KV built on JetStream; supports watch, history, TTL. |
| Object Store | Chunked binary object storage on top of JetStream. |

### Setup and Connection

```go
// go.mod
// require github.com/nats-io/nats.go v1.35.0

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// NewJetStreamConnection creates a production-ready NATS + JetStream connection
func NewJetStreamConnection(ctx context.Context, urls string, logger *slog.Logger) (jetstream.JetStream, *nats.Conn, error) {
	nc, err := nats.Connect(
		urls,
		// Reconnect automatically with exponential backoff
		nats.MaxReconnects(-1),              // Infinite reconnects
		nats.ReconnectWait(2*time.Second),
		nats.MaxReconnectDelay(30*time.Second),
		// TLS in production
		// nats.RootCAs("/etc/ssl/certs/ca-bundle.crt"),
		// nats.ClientCert("/etc/nats/client.crt", "/etc/nats/client.key"),
		nats.ErrorHandler(func(nc *nats.Conn, sub *nats.Subscription, err error) {
			logger.Error("NATS error", "error", err)
		}),
		nats.DisconnectErrHandler(func(nc *nats.Conn, err error) {
			logger.Warn("NATS disconnected", "error", err)
		}),
		nats.ReconnectHandler(func(nc *nats.Conn) {
			logger.Info("NATS reconnected", "url", nc.ConnectedUrl())
		}),
		nats.ClosedHandler(func(nc *nats.Conn) {
			logger.Info("NATS connection closed")
		}),
		// Name this connection for server-side visibility
		nats.Name("my-service-"+os.Getenv("POD_NAME")),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("nats connect: %w", err)
	}

	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		return nil, nil, fmt.Errorf("jetstream init: %w", err)
	}

	// Verify JetStream is available
	ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err = js.AccountInfo(ctx2)
	if err != nil {
		nc.Close()
		return nil, nil, fmt.Errorf("jetstream not available: %w", err)
	}

	return js, nc, nil
}
```

---

## Section 2: Stream Management

### Creating and Configuring Streams

```go
// streams/manager.go
package streams

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// StreamConfig wraps JetStream stream configuration with defaults
type StreamConfig struct {
	Name        string
	Subjects    []string
	MaxAge      time.Duration
	MaxBytes    int64
	MaxMsgs     int64
	MaxMsgSize  int32
	Replicas    int
	Storage     jetstream.StorageType
	Retention   jetstream.RetentionPolicy
	Compression jetstream.StoreCompression
}

func DefaultStreamConfig(name string, subjects []string) StreamConfig {
	return StreamConfig{
		Name:        name,
		Subjects:    subjects,
		MaxAge:      24 * time.Hour * 7,     // 7 days retention
		MaxBytes:    10 * 1024 * 1024 * 1024, // 10 GB
		MaxMsgs:     -1,                      // Unlimited
		MaxMsgSize:  4 * 1024 * 1024,         // 4 MB max message
		Replicas:    3,                        // HA: 3 replicas
		Storage:     jetstream.FileStorage,
		Retention:   jetstream.LimitsPolicy,
		Compression: jetstream.S2Compression,
	}
}

// EnsureStream creates or updates a stream idempotently
func EnsureStream(ctx context.Context, js jetstream.JetStream, cfg StreamConfig) (jetstream.Stream, error) {
	streamCfg := jetstream.StreamConfig{
		Name:        cfg.Name,
		Subjects:    cfg.Subjects,
		MaxAge:      cfg.MaxAge,
		MaxBytes:    cfg.MaxBytes,
		MaxMsgs:     cfg.MaxMsgs,
		MaxMsgSize:  cfg.MaxMsgSize,
		Replicas:    cfg.Replicas,
		Storage:     cfg.Storage,
		Retention:   cfg.Retention,
		Compression: cfg.Compression,
		// Duplicate detection window — dedup within 2 minutes
		Duplicates: 2 * time.Minute,
		// Allow updates to stream config
		AllowDirect: true,
	}

	// Try to create first; update if already exists
	stream, err := js.CreateOrUpdateStream(ctx, streamCfg)
	if err != nil {
		return nil, fmt.Errorf("creating stream %s: %w", cfg.Name, err)
	}
	return stream, nil
}

// EnsureOrderedStreams creates the standard set of streams for a service
func EnsureOrderedStreams(ctx context.Context, js jetstream.JetStream, serviceName string) error {
	streams := []StreamConfig{
		// Commands — exactly-once work queue
		{
			Name:      serviceName + "_COMMANDS",
			Subjects:  []string{serviceName + ".commands.*"},
			MaxAge:    24 * time.Hour,
			MaxBytes:  1 * 1024 * 1024 * 1024,
			Replicas:  3,
			Storage:   jetstream.FileStorage,
			Retention: jetstream.WorkQueuePolicy, // Consume and delete
		},
		// Events — fan-out, multiple consumers
		{
			Name:      serviceName + "_EVENTS",
			Subjects:  []string{serviceName + ".events.>"},
			MaxAge:    7 * 24 * time.Hour,
			MaxBytes:  10 * 1024 * 1024 * 1024,
			Replicas:  3,
			Storage:   jetstream.FileStorage,
			Retention: jetstream.LimitsPolicy,
			Compression: jetstream.S2Compression,
		},
	}

	for _, sc := range streams {
		if _, err := EnsureStream(ctx, js, sc); err != nil {
			return fmt.Errorf("ensuring stream %s: %w", sc.Name, err)
		}
	}
	return nil
}
```

---

## Section 3: Publishing Messages

### Publisher with Idempotency

```go
// publisher/publisher.go
package publisher

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go/jetstream"
)

type Publisher struct {
	js jetstream.JetStream
}

func New(js jetstream.JetStream) *Publisher {
	return &Publisher{js: js}
}

// PublishOptions configures message publication
type PublishOptions struct {
	// Deduplication ID — same MsgID won't be processed twice within stream's Duplicates window
	MsgID string
	// Expected last sequence for optimistic concurrency
	ExpectLastSeq uint64
	// Expected subject sequence (per-subject last sequence)
	ExpectLastMsgID string
}

// Publish publishes a JSON-serializable event with deduplication
func (p *Publisher) Publish(ctx context.Context, subject string, payload interface{}, opts ...PublishOptions) (*jetstream.PubAck, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("serializing payload: %w", err)
	}

	var pubOpts []jetstream.PublishOpt
	if len(opts) > 0 {
		opt := opts[0]
		if opt.MsgID != "" {
			pubOpts = append(pubOpts, jetstream.WithMsgID(opt.MsgID))
		}
		if opt.ExpectLastSeq > 0 {
			pubOpts = append(pubOpts, jetstream.WithExpectLastSequence(opt.ExpectLastSeq))
		}
	} else {
		// Default: auto-generate dedup ID
		pubOpts = append(pubOpts, jetstream.WithMsgID(uuid.New().String()))
	}

	ack, err := p.js.Publish(ctx, subject, data, pubOpts...)
	if err != nil {
		return nil, fmt.Errorf("publishing to %s: %w", subject, err)
	}

	return ack, nil
}

// PublishBatch publishes multiple messages efficiently
func (p *Publisher) PublishBatch(ctx context.Context, messages []Message) error {
	pa := p.js.PublishAsync
	for _, msg := range messages {
		data, err := json.Marshal(msg.Payload)
		if err != nil {
			return fmt.Errorf("serializing message: %w", err)
		}

		// PublishAsync is non-blocking; acks arrive on a channel
		_, err = p.js.PublishAsync(msg.Subject, data,
			jetstream.WithMsgID(msg.ID),
		)
		if err != nil {
			return fmt.Errorf("async publish to %s: %w", msg.Subject, err)
		}
	}

	// Wait for all acks with timeout
	select {
	case <-p.js.PublishAsyncComplete():
		return nil
	case <-time.After(30 * time.Second):
		// Check for any publish errors
		pending := p.js.PublishAsyncPending()
		return fmt.Errorf("publish async timeout: %d messages still pending", pending)
	case <-ctx.Done():
		return ctx.Err()
	}

	_ = pa
	return nil
}

type Message struct {
	ID      string
	Subject string
	Payload interface{}
}
```

---

## Section 4: Consumer Patterns

### Durable Pull Consumer (Worker Pool Pattern)

```go
// consumer/worker_pool.go
package consumer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

type Handler[T any] func(ctx context.Context, msg T, rawMsg jetstream.Msg) error

type WorkerPool[T any] struct {
	stream   jetstream.Stream
	consumer jetstream.Consumer
	workers  int
	handler  Handler[T]
	log      *slog.Logger
}

func NewWorkerPool[T any](
	ctx context.Context,
	js jetstream.JetStream,
	streamName, consumerName string,
	workers int,
	handler Handler[T],
	logger *slog.Logger,
) (*WorkerPool[T], error) {
	stream, err := js.Stream(ctx, streamName)
	if err != nil {
		return nil, fmt.Errorf("getting stream %s: %w", streamName, err)
	}

	// Create or update the durable consumer
	consumer, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Durable:        consumerName,
		AckPolicy:      jetstream.AckExplicitPolicy,
		AckWait:        30 * time.Second,    // Redelivery after 30s if no ack
		MaxDeliver:     5,                    // Max redelivery attempts
		MaxAckPending:  workers * 10,         // Limit in-flight messages
		FilterSubject:  "",                   // All subjects in stream
		DeliverPolicy:  jetstream.DeliverAllPolicy,
		ReplayPolicy:   jetstream.ReplayInstantPolicy,
		// On repeated failures, send to advisory subject
		BackOff: []time.Duration{
			5 * time.Second,
			30 * time.Second,
			2 * time.Minute,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("creating consumer %s: %w", consumerName, err)
	}

	return &WorkerPool[T]{
		stream:   stream,
		consumer: consumer,
		workers:  workers,
		handler:  handler,
		log:      logger,
	}, nil
}

// Run starts the worker pool and processes messages until ctx is cancelled
func (wp *WorkerPool[T]) Run(ctx context.Context) error {
	var wg sync.WaitGroup

	for i := 0; i < wp.workers; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			wp.runWorker(ctx, workerID)
		}(i)
	}

	wg.Wait()
	return nil
}

func (wp *WorkerPool[T]) runWorker(ctx context.Context, id int) {
	wp.log.Info("Worker started", "id", id)
	defer wp.log.Info("Worker stopped", "id", id)

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Fetch one message at a time with a short timeout
		// to allow context cancellation checks
		msgs, err := wp.consumer.Fetch(1, jetstream.FetchMaxWait(2*time.Second))
		if err != nil {
			if errors.Is(err, jetstream.ErrTimeout) || errors.Is(err, context.DeadlineExceeded) {
				continue
			}
			if errors.Is(err, nats.ErrConnectionClosed) {
				return
			}
			wp.log.Error("Fetch error", "worker", id, "error", err)
			time.Sleep(1 * time.Second)
			continue
		}

		for msg := range msgs.Messages() {
			wp.processMessage(ctx, id, msg)
		}

		if err := msgs.Error(); err != nil && !errors.Is(err, jetstream.ErrTimeout) {
			wp.log.Error("Messages channel error", "worker", id, "error", err)
		}
	}
}

func (wp *WorkerPool[T]) processMessage(ctx context.Context, workerID int, msg jetstream.Msg) {
	meta, _ := msg.Metadata()

	wp.log.Debug("Processing message",
		"worker", workerID,
		"subject", msg.Subject(),
		"sequence", meta.Sequence.Stream,
		"deliveries", meta.NumDelivered,
	)

	// Decode payload
	var payload T
	if err := json.Unmarshal(msg.Data(), &payload); err != nil {
		wp.log.Error("Failed to decode message",
			"error", err,
			"subject", msg.Subject(),
		)
		// Nak immediately — don't retry malformed messages
		msg.Term()
		return
	}

	// Process with timeout
	processCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()

	if err := wp.handler(processCtx, payload, msg); err != nil {
		wp.log.Error("Handler error",
			"error", err,
			"subject", msg.Subject(),
			"deliveries", meta.NumDelivered,
		)

		// On final delivery, move to dead letter queue
		if meta.NumDelivered >= 5 {
			wp.log.Warn("Max deliveries reached, terminating message",
				"subject", msg.Subject(),
				"sequence", meta.Sequence.Stream,
			)
			msg.Term()
			return
		}

		// Nack with delay for backoff
		msg.NakWithDelay(backoffDuration(meta.NumDelivered))
		return
	}

	// Success — acknowledge
	if err := msg.Ack(); err != nil {
		wp.log.Error("Failed to ack message", "error", err)
	}
}

func backoffDuration(deliveries uint64) time.Duration {
	delays := []time.Duration{5 * time.Second, 30 * time.Second, 2 * time.Minute, 10 * time.Minute}
	idx := int(deliveries) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(delays) {
		idx = len(delays) - 1
	}
	return delays[idx]
}
```

### Push Consumer for Low-Latency Event Processing

```go
// consumer/push_consumer.go
package consumer

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// PushSubscriber creates a push-based JetStream consumer
// Best for: low-latency event handling, fan-out to multiple services
func PushSubscriber[T any](
	ctx context.Context,
	js jetstream.JetStream,
	streamName, consumerName string,
	handler func(ctx context.Context, payload T) error,
	logger *slog.Logger,
) (jetstream.ConsumeContext, error) {
	stream, err := js.Stream(ctx, streamName)
	if err != nil {
		return nil, fmt.Errorf("getting stream: %w", err)
	}

	consumer, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Durable:       consumerName,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       15 * time.Second,
		MaxDeliver:    3,
		MaxAckPending: 1000,
	})
	if err != nil {
		return nil, fmt.Errorf("creating consumer: %w", err)
	}

	cc, err := consumer.Consume(func(msg jetstream.Msg) {
		var payload T
		if err := json.Unmarshal(msg.Data(), &payload); err != nil {
			logger.Error("Failed to unmarshal", "error", err, "subject", msg.Subject())
			msg.Term()
			return
		}

		processCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()

		if err := handler(processCtx, payload); err != nil {
			logger.Error("Handler failed", "error", err)
			msg.Nak()
			return
		}

		msg.Ack()
	}, jetstream.ConsumeErrHandler(func(consumeCtx jetstream.ConsumeContext, err error) {
		logger.Error("Consume error", "error", err)
	}))

	if err != nil {
		return nil, fmt.Errorf("starting consume: %w", err)
	}

	return cc, nil
}
```

---

## Section 5: Key-Value Store

### KV Store with Typed Access

```go
// kv/store.go
package kv

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

var ErrNotFound = errors.New("key not found")

// TypedStore wraps JetStream KV with generic typed access
type TypedStore[T any] struct {
	kv      jetstream.KeyValue
	name    string
}

// EnsureStore creates or binds to a KV store with the given configuration
func EnsureStore[T any](ctx context.Context, js jetstream.JetStream, name string, ttl time.Duration) (*TypedStore[T], error) {
	kv, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
		Bucket:      name,
		TTL:         ttl,
		MaxValueSize: 1024 * 1024,   // 1 MB max value
		Storage:     jetstream.FileStorage,
		Replicas:    3,
		History:     10,              // Keep last 10 revisions
		Compression: true,
	})
	if err != nil {
		return nil, fmt.Errorf("creating KV store %s: %w", name, err)
	}
	return &TypedStore[T]{kv: kv, name: name}, nil
}

// Get retrieves and deserializes a value
func (s *TypedStore[T]) Get(ctx context.Context, key string) (T, uint64, error) {
	var zero T
	entry, err := s.kv.Get(ctx, key)
	if err != nil {
		if errors.Is(err, jetstream.ErrKeyNotFound) {
			return zero, 0, ErrNotFound
		}
		return zero, 0, fmt.Errorf("getting key %s: %w", key, err)
	}

	if entry.Operation() == jetstream.KeyValueDelete {
		return zero, 0, ErrNotFound
	}

	var value T
	if err := json.Unmarshal(entry.Value(), &value); err != nil {
		return zero, 0, fmt.Errorf("deserializing value for key %s: %w", key, err)
	}

	return value, entry.Revision(), nil
}

// Put stores a value (unconditional)
func (s *TypedStore[T]) Put(ctx context.Context, key string, value T) (uint64, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return 0, fmt.Errorf("serializing value: %w", err)
	}

	rev, err := s.kv.Put(ctx, key, data)
	if err != nil {
		return 0, fmt.Errorf("putting key %s: %w", key, err)
	}
	return rev, nil
}

// Update performs optimistic concurrency update — fails if revision doesn't match
func (s *TypedStore[T]) Update(ctx context.Context, key string, value T, lastRevision uint64) (uint64, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return 0, fmt.Errorf("serializing value: %w", err)
	}

	rev, err := s.kv.Update(ctx, key, data, lastRevision)
	if err != nil {
		if errors.Is(err, jetstream.ErrKeyWrongLastRevision) {
			return 0, fmt.Errorf("optimistic lock failure for key %s: %w", key, err)
		}
		return 0, fmt.Errorf("updating key %s: %w", key, err)
	}
	return rev, nil
}

// Create sets key only if it doesn't exist — distributed mutex pattern
func (s *TypedStore[T]) Create(ctx context.Context, key string, value T) (uint64, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return 0, fmt.Errorf("serializing value: %w", err)
	}

	rev, err := s.kv.Create(ctx, key, data)
	if err != nil {
		if errors.Is(err, jetstream.ErrKeyExists) {
			return 0, fmt.Errorf("key %s already exists: %w", key, err)
		}
		return 0, fmt.Errorf("creating key %s: %w", key, err)
	}
	return rev, nil
}

// Watch monitors a key prefix for changes
func (s *TypedStore[T]) Watch(ctx context.Context, key string) (<-chan WatchEvent[T], error) {
	watcher, err := s.kv.Watch(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("watching key %s: %w", key, err)
	}

	ch := make(chan WatchEvent[T], 100)

	go func() {
		defer close(ch)
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
					// Initial load complete
					ch <- WatchEvent[T]{InitialLoad: true}
					continue
				}

				event := WatchEvent[T]{
					Key:      entry.Key(),
					Revision: entry.Revision(),
				}

				if entry.Operation() == jetstream.KeyValueDelete {
					event.Deleted = true
				} else {
					var value T
					if err := json.Unmarshal(entry.Value(), &value); err == nil {
						event.Value = value
					}
				}

				ch <- event
			}
		}
	}()

	return ch, nil
}

// Delete removes a key
func (s *TypedStore[T]) Delete(ctx context.Context, key string) error {
	return s.kv.Delete(ctx, key)
}

type WatchEvent[T any] struct {
	Key         string
	Value       T
	Revision    uint64
	Deleted     bool
	InitialLoad bool   // Signals end of initial state delivery
}
```

### Distributed Leader Election with KV

```go
// kv/election.go
package kv

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

type LeaderElection struct {
	kv        jetstream.KeyValue
	key       string
	candidate string    // This instance's ID
	ttl       time.Duration
}

func NewLeaderElection(ctx context.Context, js jetstream.JetStream, name, candidate string) (*LeaderElection, error) {
	kv, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
		Bucket:   "leader-elections",
		TTL:      10 * time.Second,   // Auto-expire if leader crashes
		Replicas: 3,
	})
	if err != nil {
		return nil, fmt.Errorf("creating election KV: %w", err)
	}

	return &LeaderElection{
		kv:        kv,
		key:       name,
		candidate: candidate,
		ttl:       10 * time.Second,
	}, nil
}

// Campaign attempts to become leader; calls onLeader when elected, onFollower otherwise
func (le *LeaderElection) Campaign(ctx context.Context, onLeader func(ctx context.Context), onFollower func()) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Try to create the key (only succeeds if key doesn't exist)
		_, err := le.kv.Create(ctx, le.key, []byte(le.candidate))
		if err == nil {
			// Elected! Start leader duties
			leaderCtx, cancel := context.WithCancel(ctx)

			// Renew lease in background
			go le.renewLease(leaderCtx)

			// Run leader duties
			onLeader(leaderCtx)
			cancel()
		} else if errors.Is(err, jetstream.ErrKeyExists) {
			// Someone else is leader
			onFollower()

			// Watch for leadership to become available
			watcher, watchErr := le.kv.Watch(ctx, le.key)
			if watchErr != nil {
				time.Sleep(5 * time.Second)
				continue
			}

			waitForLeaderChange(ctx, watcher)
			watcher.Stop()
		} else {
			// Connection error — back off
			time.Sleep(2 * time.Second)
		}
	}
}

func (le *LeaderElection) renewLease(ctx context.Context) {
	ticker := time.NewTicker(le.ttl / 3)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Re-put the key to reset TTL
			if _, err := le.kv.Put(ctx, le.key, []byte(le.candidate)); err != nil {
				return // Will cause leader duties to stop via ctx
			}
		}
	}
}

func waitForLeaderChange(ctx context.Context, watcher jetstream.KeyWatcher) {
	for {
		select {
		case <-ctx.Done():
			return
		case entry := <-watcher.Updates():
			if entry == nil {
				return
			}
			if entry.Operation() == jetstream.KeyValueDelete ||
				entry.Operation() == jetstream.KeyValuePurge {
				return // Key deleted/expired — campaign again
			}
		}
	}
}
```

---

## Section 6: Object Store

```go
// objstore/store.go
package objstore

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

type ObjectStore struct {
	store jetstream.ObjectStore
}

func NewObjectStore(ctx context.Context, js jetstream.JetStream, bucket string) (*ObjectStore, error) {
	store, err := js.CreateOrUpdateObjectStore(ctx, jetstream.ObjectStoreConfig{
		Bucket:     bucket,
		TTL:        24 * time.Hour * 30,  // 30 day retention
		Storage:    jetstream.FileStorage,
		Replicas:   3,
		MaxChunkSize: 128 * 1024,        // 128 KB chunks
		Compression: true,
	})
	if err != nil {
		return nil, fmt.Errorf("creating object store %s: %w", bucket, err)
	}
	return &ObjectStore{store: store}, nil
}

// Upload stores binary data with metadata
func (s *ObjectStore) Upload(ctx context.Context, name string, reader io.Reader, meta map[string]string) error {
	headers := make(map[string][]string)
	for k, v := range meta {
		headers[k] = []string{v}
	}

	_, err := s.store.Put(ctx, &jetstream.ObjectMeta{
		Name:        name,
		Description: meta["description"],
		Headers:     headers,
	}, reader)
	if err != nil {
		return fmt.Errorf("uploading object %s: %w", name, err)
	}
	return nil
}

// Download retrieves a stored object
func (s *ObjectStore) Download(ctx context.Context, name string, writer io.Writer) error {
	result, err := s.store.Get(ctx, name)
	if err != nil {
		return fmt.Errorf("getting object %s: %w", name, err)
	}
	defer result.Close()

	if _, err := io.Copy(writer, result); err != nil {
		return fmt.Errorf("reading object %s: %w", name, err)
	}
	return nil
}

// GetInfo returns metadata without downloading
func (s *ObjectStore) GetInfo(ctx context.Context, name string) (*jetstream.ObjectInfo, error) {
	info, err := s.store.GetInfo(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("getting info for %s: %w", name, err)
	}
	return info, nil
}
```

---

## Section 7: Message Schemas and Headers

```go
// messaging/envelope.go
package messaging

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// Envelope wraps all messages with standard metadata headers
type Envelope[T any] struct {
	// Headers (set as NATS message headers for observability)
	MessageID     string    `json:"messageId"`
	CorrelationID string    `json:"correlationId"`
	CausationID   string    `json:"causationId"`
	EventType     string    `json:"eventType"`
	Version       int       `json:"version"`
	Source        string    `json:"source"`
	Timestamp     time.Time `json:"timestamp"`

	// Payload
	Data T `json:"data"`
}

func NewEnvelope[T any](eventType, source, correlationID string, data T) *Envelope[T] {
	return &Envelope[T]{
		MessageID:     uuid.New().String(),
		CorrelationID: correlationID,
		EventType:     eventType,
		Version:       1,
		Source:        source,
		Timestamp:     time.Now().UTC(),
		Data:          data,
	}
}

// PublishEnvelope publishes with standard NATS headers for observability
func PublishEnvelope[T any](ctx context.Context, js jetstream.JetStream, subject string, env *Envelope[T]) error {
	data, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("marshaling envelope: %w", err)
	}

	msg := nats.NewMsg(subject)
	msg.Data = data

	// Standard NATS headers for routing and observability
	msg.Header.Set("Nats-Msg-Id", env.MessageID)              // JetStream dedup ID
	msg.Header.Set("Content-Type", "application/json")
	msg.Header.Set("X-Event-Type", env.EventType)
	msg.Header.Set("X-Correlation-Id", env.CorrelationID)
	msg.Header.Set("X-Source", env.Source)
	msg.Header.Set("X-Timestamp", env.Timestamp.Format(time.RFC3339Nano))
	msg.Header.Set("X-Version", fmt.Sprintf("%d", env.Version))

	_, err = js.PublishMsg(ctx, msg)
	if err != nil {
		return fmt.Errorf("publishing envelope: %w", err)
	}
	return nil
}

// ExtractEnvelope deserializes and extracts the envelope from a JetStream message
func ExtractEnvelope[T any](msg jetstream.Msg) (*Envelope[T], error) {
	var env Envelope[T]
	if err := json.Unmarshal(msg.Data(), &env); err != nil {
		return nil, fmt.Errorf("unmarshaling envelope: %w", err)
	}

	// Validate required fields
	if env.MessageID == "" {
		return nil, fmt.Errorf("envelope missing MessageID")
	}
	if env.EventType == "" {
		return nil, fmt.Errorf("envelope missing EventType")
	}

	return &env, nil
}
```

---

## Section 8: Error Handling and Dead Letter Queue

```go
// dlq/handler.go
package dlq

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// DeadLetterRecord captures failed message information
type DeadLetterRecord struct {
	OriginalSubject string            `json:"originalSubject"`
	Payload         json.RawMessage   `json:"payload"`
	Error           string            `json:"error"`
	Deliveries      uint64            `json:"deliveries"`
	Headers         map[string]string `json:"headers"`
	FailedAt        time.Time         `json:"failedAt"`
	ConsumerName    string            `json:"consumerName"`
}

type DLQHandler struct {
	js          jetstream.JetStream
	dlqSubject  string
	log         *slog.Logger
}

func NewDLQHandler(js jetstream.JetStream, dlqSubject string, logger *slog.Logger) *DLQHandler {
	return &DLQHandler{
		js:         js,
		dlqSubject: dlqSubject,
		log:        logger,
	}
}

// SendToDLQ publishes a failed message to the dead letter queue
func (d *DLQHandler) SendToDLQ(ctx context.Context, msg jetstream.Msg, processingError error, consumerName string) error {
	meta, _ := msg.Metadata()

	headers := make(map[string]string)
	for k, vals := range msg.Headers() {
		if len(vals) > 0 {
			headers[k] = vals[0]
		}
	}

	record := DeadLetterRecord{
		OriginalSubject: msg.Subject(),
		Payload:         json.RawMessage(msg.Data()),
		Error:           processingError.Error(),
		Headers:         headers,
		FailedAt:        time.Now().UTC(),
		ConsumerName:    consumerName,
	}

	if meta != nil {
		record.Deliveries = meta.NumDelivered
	}

	data, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("serializing DLQ record: %w", err)
	}

	_, err = d.js.Publish(ctx, d.dlqSubject, data)
	if err != nil {
		d.log.Error("Failed to send to DLQ",
			"subject", msg.Subject(),
			"error", err,
		)
		return fmt.Errorf("publishing to DLQ: %w", err)
	}

	d.log.Warn("Message sent to DLQ",
		"original_subject", msg.Subject(),
		"processing_error", processingError,
		"deliveries", record.Deliveries,
	)

	return nil
}

// ReplayDLQ reads from the DLQ stream and republishes to original subjects
func (d *DLQHandler) ReplayDLQ(ctx context.Context, filter func(DeadLetterRecord) bool) error {
	stream, err := d.js.Stream(ctx, "DLQ")
	if err != nil {
		return fmt.Errorf("accessing DLQ stream: %w", err)
	}

	consumer, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Durable:      "dlq-replay-" + fmt.Sprintf("%d", time.Now().Unix()),
		AckPolicy:    jetstream.AckExplicitPolicy,
		DeliverPolicy: jetstream.DeliverAllPolicy,
		MaxAckPending: 1,
	})
	if err != nil {
		return fmt.Errorf("creating DLQ consumer: %w", err)
	}

	replayed, skipped := 0, 0

	for {
		msgs, err := consumer.Fetch(1, jetstream.FetchMaxWait(5*time.Second))
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			break // End of stream
		}

		done := true
		for msg := range msgs.Messages() {
			done = false
			var record DeadLetterRecord
			if err := json.Unmarshal(msg.Data(), &record); err != nil {
				d.log.Error("Failed to parse DLQ record", "error", err)
				msg.Ack()
				continue
			}

			if filter != nil && !filter(record) {
				skipped++
				msg.Ack()
				continue
			}

			// Republish to original subject
			if _, err := d.js.Publish(ctx, record.OriginalSubject, record.Payload); err != nil {
				d.log.Error("Failed to replay message", "error", err)
				msg.Nak()
				continue
			}

			replayed++
			msg.Ack()
		}

		if done {
			break
		}
	}

	d.log.Info("DLQ replay complete", "replayed", replayed, "skipped", skipped)
	return nil
}
```

---

## Section 9: NATS Server Configuration for Production

### Docker Compose for Local Development

```yaml
# docker-compose.yaml
version: "3.8"
services:
  nats1:
    image: nats:2.10-alpine
    command: >
      -p 4222
      -cluster nats://nats1:6222
      -routes nats://nats2:6222,nats://nats3:6222
      -js
      -sd /data
      -m 8222
      --name nats1
    ports:
      - "4222:4222"
      - "8222:8222"
    volumes:
      - nats1-data:/data

  nats2:
    image: nats:2.10-alpine
    command: >
      -p 4222
      -cluster nats://nats2:6222
      -routes nats://nats1:6222,nats://nats3:6222
      -js
      -sd /data
      --name nats2
    volumes:
      - nats2-data:/data

  nats3:
    image: nats:2.10-alpine
    command: >
      -p 4222
      -cluster nats://nats3:6222
      -routes nats://nats1:6222,nats://nats2:6222
      -js
      -sd /data
      --name nats3
    volumes:
      - nats3-data:/data

volumes:
  nats1-data:
  nats2-data:
  nats3-data:
```

### Production NATS Configuration File

```conf
# nats.conf — Production JetStream cluster
server_name: $SERVER_NAME

listen: 0.0.0.0:4222
http_port: 8222

# JetStream configuration
jetstream {
  store_dir: /data/jetstream
  max_memory_store: 4G
  max_file_store: 200G
  # Domain isolates JetStream clusters
  domain: production
}

# Cluster configuration
cluster {
  name: production-cluster
  listen: 0.0.0.0:6222
  routes: [
    nats://nats-0.nats.nats-system.svc.cluster.local:6222,
    nats://nats-1.nats.nats-system.svc.cluster.local:6222,
    nats://nats-2.nats.nats-system.svc.cluster.local:6222,
  ]
}

# TLS
tls {
  cert_file:  /etc/nats/tls/tls.crt
  key_file:   /etc/nats/tls/tls.key
  ca_file:    /etc/nats/tls/ca.crt
  verify:     true
  timeout:    3
}

# Logging
log_file: /var/log/nats/nats.log
log_size_limit: 256M
logtime: true
debug: false
trace: false

# Authorization with accounts (multi-tenancy)
accounts {
  APP {
    users: [
      { user: app, password: $APP_PASSWORD }
    ]
    jetstream: enabled
    limits {
      max_data: 50G
      max_mem: 2G
      max_file: 50G
    }
  }
  MONITOR {
    users: [
      { user: monitor, password: $MONITOR_PASSWORD }
    ]
  }
}

# Rate limiting
max_payload: 8MB
max_connections: 10000
max_subscriptions: 10000
write_deadline: "10s"
```

---

## Section 10: Observability and Monitoring

### Prometheus Metrics Integration

```go
// metrics/nats_metrics.go
package metrics

import (
	"context"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	"github.com/prometheus/client_golang/prometheus"
)

var (
	streamMessages = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "nats_jetstream_stream_messages",
			Help: "Current message count per stream",
		},
		[]string{"stream"},
	)

	streamBytes = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "nats_jetstream_stream_bytes",
			Help: "Current storage bytes per stream",
		},
		[]string{"stream"},
	)

	consumerPending = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "nats_jetstream_consumer_pending",
			Help: "Pending messages per consumer",
		},
		[]string{"stream", "consumer"},
	)

	consumerDelivered = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "nats_jetstream_consumer_delivered_total",
			Help: "Total messages delivered per consumer",
		},
		[]string{"stream", "consumer"},
	)
)

func init() {
	prometheus.MustRegister(streamMessages, streamBytes, consumerPending, consumerDelivered)
}

// CollectMetrics periodically collects JetStream metrics
func CollectMetrics(ctx context.Context, js jetstream.JetStream, logger *slog.Logger) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			collectStreamMetrics(ctx, js, logger)
		}
	}
}

func collectStreamMetrics(ctx context.Context, js jetstream.JetStream, logger *slog.Logger) {
	streams := js.ListStreams(ctx)
	for info := range streams.Info() {
		name := info.Config.Name
		streamMessages.WithLabelValues(name).Set(float64(info.State.Msgs))
		streamBytes.WithLabelValues(name).Set(float64(info.State.Bytes))
	}
	if err := streams.Err(); err != nil {
		logger.Error("Listing streams", "error", err)
	}
}
```

### Alerting Rules

```yaml
# prometheus-rules.yaml
groups:
  - name: nats.rules
    rules:
      - alert: NATSConsumerLagging
        expr: nats_jetstream_consumer_pending > 10000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "NATS consumer {{ $labels.consumer }} is lagging"
          description: "Consumer has {{ $value }} pending messages for > 5 minutes"

      - alert: NATSStreamStorageFull
        expr: nats_jetstream_stream_bytes / (10 * 1024 * 1024 * 1024) > 0.9
        labels:
          severity: critical
        annotations:
          summary: "NATS stream {{ $labels.stream }} storage > 90%"

      - alert: NATSConnectionDown
        expr: up{job="nats"} == 0
        for: 1m
        labels:
          severity: critical
```

NATS JetStream provides a uniquely Go-friendly messaging platform — the client library is idiomatic, the server is written in Go, and the operational footprint is tiny compared to Kafka or Pulsar. The pull consumer with worker pools and the KV store for distributed state are the two patterns that cover the vast majority of production Go service requirements. Build streams early, use durable consumers everywhere, and implement DLQ handling from day one.
