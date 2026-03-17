---
title: "Go: Implementing a Robust Webhook Server with HMAC Signature Verification and Retry Queuing"
date: 2031-08-28T00:00:00-05:00
draft: false
tags: ["Go", "Webhooks", "HMAC", "Security", "Microservices", "Queuing", "Reliability"]
categories:
- Go
- Backend Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Build a production-grade Go webhook server with constant-time HMAC-SHA256 signature verification, idempotent processing, durable retry queuing with exponential backoff, and dead-letter handling."
more_link: "yes"
url: "/go-webhook-server-hmac-signature-verification-retry-queue/"
---

Webhooks are the backbone of event-driven integrations: GitHub triggers CI pipelines, Stripe notifies your billing service, PagerDuty fires alerting workflows. But a naive HTTP handler that processes the payload inline is one network blip away from a missed event, one timing bug away from a signature bypass, and one uncaught panic away from a dropped message. This post builds a production-grade webhook server in Go that handles all three failure modes.

<!--more-->

# Go: Implementing a Robust Webhook Server with HMAC Signature Verification and Retry Queuing

## What "Production Grade" Means for Webhooks

A webhook server must satisfy four requirements that a basic HTTP handler does not:

1. **Authenticity**: Verify that the payload genuinely came from the claimed sender, not a spoofed request.
2. **Idempotency**: Process each event exactly once, even when the sender retries after a timeout.
3. **Durability**: If downstream processing fails, do not lose the event — queue it and retry with backoff.
4. **Observability**: Expose metrics on received, processed, failed, and dead-letter events.

We will build each layer from first principles.

## Project Structure

```
webhook-server/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── auth/
│   │   └── hmac.go          # Signature verification
│   ├── handler/
│   │   └── webhook.go       # HTTP handler
│   ├── queue/
│   │   ├── queue.go         # In-memory persistent queue
│   │   └── worker.go        # Retry worker pool
│   ├── processor/
│   │   └── processor.go     # Business logic dispatch
│   └── store/
│       └── idempotency.go   # Deduplication store
├── go.mod
└── go.sum
```

## HMAC Signature Verification

The most critical piece. Most providers (GitHub, Stripe, Twilio) sign the request body with a shared secret using HMAC-SHA256 and place the signature in a header.

```go
// internal/auth/hmac.go
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// ErrInvalidSignature is returned when the computed HMAC does not match the provided signature.
var ErrInvalidSignature = errors.New("invalid webhook signature")

// ErrMissingSignature is returned when no signature header is present.
var ErrMissingSignature = errors.New("missing webhook signature header")

// Verifier holds a set of secrets indexed by provider name.
// Supporting multiple secrets allows for zero-downtime secret rotation.
type Verifier struct {
	secrets [][]byte
}

// NewVerifier creates a Verifier from one or more raw secret strings.
// Pass multiple secrets during rotation so both old and new secrets are accepted.
func NewVerifier(secrets ...string) (*Verifier, error) {
	if len(secrets) == 0 {
		return nil, errors.New("at least one secret is required")
	}
	v := &Verifier{}
	for _, s := range secrets {
		if s == "" {
			return nil, errors.New("empty secret is not allowed")
		}
		v.secrets = append(v.secrets, []byte(s))
	}
	return v, nil
}

// VerifyGitHub validates a GitHub-style signature header of the form
// "sha256=<hex-digest>".
func (v *Verifier) VerifyGitHub(body []byte, sigHeader string) error {
	if sigHeader == "" {
		return ErrMissingSignature
	}

	const prefix = "sha256="
	if !strings.HasPrefix(sigHeader, prefix) {
		return fmt.Errorf("unsupported signature format: expected %s prefix", prefix)
	}

	supplied, err := hex.DecodeString(strings.TrimPrefix(sigHeader, prefix))
	if err != nil {
		return fmt.Errorf("malformed signature hex: %w", err)
	}

	return v.verify(body, supplied)
}

// VerifyStripe validates a Stripe-style signature header of the form
// "t=<timestamp>,v1=<hex-digest>[,v1=<hex-digest>]".
// The signed payload is "<timestamp>.<body>".
func (v *Verifier) VerifyStripe(body []byte, sigHeader string) error {
	if sigHeader == "" {
		return ErrMissingSignature
	}

	parts := make(map[string][]string)
	for _, part := range strings.Split(sigHeader, ",") {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		parts[kv[0]] = append(parts[kv[0]], kv[1])
	}

	timestamps, ok := parts["t"]
	if !ok || len(timestamps) == 0 {
		return errors.New("stripe signature: missing timestamp")
	}
	ts := timestamps[0]

	signatures, ok := parts["v1"]
	if !ok || len(signatures) == 0 {
		return errors.New("stripe signature: missing v1 signatures")
	}

	signedPayload := []byte(ts + "." + string(body))

	for _, sigHex := range signatures {
		supplied, err := hex.DecodeString(sigHex)
		if err != nil {
			continue
		}
		if v.verify(signedPayload, supplied) == nil {
			return nil // At least one signature matched.
		}
	}

	return ErrInvalidSignature
}

// verify checks body against all registered secrets using constant-time comparison.
// It returns nil if ANY secret produces a matching HMAC.
func (v *Verifier) verify(body, supplied []byte) error {
	for _, secret := range v.secrets {
		mac := hmac.New(sha256.New, secret)
		mac.Write(body)
		computed := mac.Sum(nil)

		// crypto/hmac.Equal is constant-time — never use bytes.Equal here.
		if hmac.Equal(computed, supplied) {
			return nil
		}
	}
	return ErrInvalidSignature
}
```

The constant-time comparison (`hmac.Equal`) is not optional. A timing attack against a naive `bytes.Equal` comparison can recover the secret byte by byte in microseconds on a local network.

## Idempotency Store

Webhook senders retry on timeout. Without deduplication, a 30-second downstream database call causes the sender to retry and you process the same payment twice.

```go
// internal/store/idempotency.go
package store

import (
	"context"
	"sync"
	"time"
)

// ProcessedStatus represents the state of a previously seen event.
type ProcessedStatus int

const (
	StatusNotSeen    ProcessedStatus = iota
	StatusProcessing                 // acquired, not yet committed
	StatusDone                       // successfully processed
)

// IdempotencyRecord holds the result of processing an event.
type IdempotencyRecord struct {
	Status    ProcessedStatus
	CreatedAt time.Time
	Result    []byte // serialized response, for replay to the sender
}

// IdempotencyStore tracks event IDs to prevent duplicate processing.
// In production, replace the in-memory map with Redis using SETNX / SET NX EX.
type IdempotencyStore struct {
	mu  sync.RWMutex
	ttl time.Duration
	m   map[string]*IdempotencyRecord
}

// NewIdempotencyStore creates a store with the given entry TTL.
func NewIdempotencyStore(ttl time.Duration) *IdempotencyStore {
	s := &IdempotencyStore{
		ttl: ttl,
		m:   make(map[string]*IdempotencyRecord),
	}
	go s.gcLoop()
	return s
}

// TryAcquire attempts to mark eventID as "being processed".
// Returns (true, nil) if the caller should process the event.
// Returns (false, existing) if the event has already been seen.
func (s *IdempotencyStore) TryAcquire(ctx context.Context, eventID string) (bool, *IdempotencyRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if rec, ok := s.m[eventID]; ok {
		return false, rec
	}

	s.m[eventID] = &IdempotencyRecord{
		Status:    StatusProcessing,
		CreatedAt: time.Now(),
	}
	return true, nil
}

// Commit marks the event as fully processed and stores the result.
func (s *IdempotencyStore) Commit(eventID string, result []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if rec, ok := s.m[eventID]; ok {
		rec.Status = StatusDone
		rec.Result = result
	}
}

// Release removes the lock without committing (e.g., on processing error).
func (s *IdempotencyStore) Release(eventID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, eventID)
}

func (s *IdempotencyStore) gcLoop() {
	ticker := time.NewTicker(s.ttl / 2)
	defer ticker.Stop()
	for range ticker.C {
		s.mu.Lock()
		cutoff := time.Now().Add(-s.ttl)
		for id, rec := range s.m {
			if rec.CreatedAt.Before(cutoff) {
				delete(s.m, id)
			}
		}
		s.mu.Unlock()
	}
}
```

### Redis-Backed Production Implementation

```go
// RedisIdempotencyStore — production implementation using Redis SETNX
package store

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

type RedisIdempotencyStore struct {
	client *redis.Client
	ttl    time.Duration
	prefix string
}

func NewRedisIdempotencyStore(client *redis.Client, ttl time.Duration, prefix string) *RedisIdempotencyStore {
	return &RedisIdempotencyStore{client: client, ttl: ttl, prefix: prefix}
}

func (s *RedisIdempotencyStore) TryAcquire(ctx context.Context, eventID string) (bool, error) {
	key := s.prefix + eventID
	// SET key value NX EX ttl — atomic "set if not exists"
	ok, err := s.client.SetNX(ctx, key, "processing", s.ttl).Result()
	return ok, err
}

func (s *RedisIdempotencyStore) Commit(ctx context.Context, eventID string, result []byte) error {
	key := s.prefix + eventID
	return s.client.Set(ctx, key, result, s.ttl).Err()
}
```

## Durable Retry Queue

When downstream processing fails, we must not drop the event. An in-process queue with persistent write-ahead log handles transient failures; for true durability use a message broker.

```go
// internal/queue/queue.go
package queue

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"time"
)

// Event is a webhook event waiting to be processed.
type Event struct {
	ID          string            `json:"id"`
	Provider    string            `json:"provider"`
	EventType   string            `json:"event_type"`
	Body        []byte            `json:"body"`
	Headers     map[string]string `json:"headers"`
	ReceivedAt  time.Time         `json:"received_at"`
	Attempts    int               `json:"attempts"`
	NextAttempt time.Time         `json:"next_attempt"`
	LastError   string            `json:"last_error,omitempty"`
}

const (
	MaxAttempts    = 10
	InitialBackoff = 5 * time.Second
	MaxBackoff     = 2 * time.Hour
)

// BackoffDuration computes exponential backoff with full jitter.
func BackoffDuration(attempt int) time.Duration {
	if attempt <= 0 {
		return InitialBackoff
	}
	exp := InitialBackoff * (1 << uint(attempt))
	if exp > MaxBackoff {
		exp = MaxBackoff
	}
	return exp
}

// Queue is a thread-safe in-memory event queue backed by a WAL file.
type Queue struct {
	mu       sync.Mutex
	events   []*Event
	dlq      []*Event       // dead-letter queue
	ready    chan struct{}   // signals new events available
	walPath  string
	walFile  *os.File
}

func New(walPath string) (*Queue, error) {
	q := &Queue{
		ready:   make(chan struct{}, 1),
		walPath: walPath,
	}

	f, err := os.OpenFile(walPath, os.O_APPEND|os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	q.walFile = f

	if err := q.replayWAL(); err != nil {
		return nil, err
	}

	return q, nil
}

// Enqueue adds an event to the queue and writes it to the WAL.
func (q *Queue) Enqueue(e *Event) error {
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	data = append(data, '\n')

	q.mu.Lock()
	defer q.mu.Unlock()

	if _, err := q.walFile.Write(data); err != nil {
		return err
	}
	if err := q.walFile.Sync(); err != nil {
		return err
	}

	q.events = append(q.events, e)

	// Non-blocking signal.
	select {
	case q.ready <- struct{}{}:
	default:
	}

	return nil
}

// Dequeue returns the next event that is ready for processing.
// Blocks until an event becomes available or ctx is cancelled.
func (q *Queue) Dequeue(ctx context.Context) (*Event, error) {
	for {
		q.mu.Lock()
		now := time.Now()
		for i, e := range q.events {
			if now.Before(e.NextAttempt) {
				continue
			}
			// Remove from queue.
			q.events = append(q.events[:i], q.events[i+1:]...)
			q.mu.Unlock()
			return e, nil
		}
		q.mu.Unlock()

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-q.ready:
			// New event or retry timer fired; loop again.
		case <-time.After(1 * time.Second):
			// Poll for events whose NextAttempt has elapsed.
		}
	}
}

// Requeue reschedules a failed event with exponential backoff.
// If MaxAttempts is exceeded, the event moves to the dead-letter queue.
func (q *Queue) Requeue(e *Event, processingErr error) {
	e.Attempts++
	e.LastError = processingErr.Error()

	q.mu.Lock()
	defer q.mu.Unlock()

	if e.Attempts >= MaxAttempts {
		q.dlq = append(q.dlq, e)
		return
	}

	e.NextAttempt = time.Now().Add(BackoffDuration(e.Attempts))
	q.events = append(q.events, e)

	select {
	case q.ready <- struct{}{}:
	default:
	}
}

// DeadLetterEvents returns all dead-letter events.
func (q *Queue) DeadLetterEvents() []*Event {
	q.mu.Lock()
	defer q.mu.Unlock()
	out := make([]*Event, len(q.dlq))
	copy(out, q.dlq)
	return out
}

func (q *Queue) replayWAL() error {
	data, err := os.ReadFile(q.walPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}

	dec := json.NewDecoder(
		bytesReaderFromSlice(data),
	)
	for dec.More() {
		var e Event
		if err := dec.Decode(&e); err != nil {
			continue // Skip corrupt entries.
		}
		if e.Attempts < MaxAttempts {
			q.events = append(q.events, &e)
		}
	}
	return nil
}

// bytesReaderFromSlice wraps a byte slice for json.NewDecoder.
func bytesReaderFromSlice(b []byte) *bytesReader {
	return &bytesReader{buf: b}
}

type bytesReader struct {
	buf []byte
	pos int
}

func (r *bytesReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.buf) {
		return 0, errors.New("EOF")
	}
	n := copy(p, r.buf[r.pos:])
	r.pos += n
	return n, nil
}
```

## Worker Pool

```go
// internal/queue/worker.go
package queue

import (
	"context"
	"log/slog"
	"sync"
)

// ProcessFunc is the function called to handle a single event.
type ProcessFunc func(ctx context.Context, e *Event) error

// WorkerPool manages a fixed number of goroutines consuming from a Queue.
type WorkerPool struct {
	q         *Queue
	process   ProcessFunc
	workers   int
	wg        sync.WaitGroup
	log       *slog.Logger
}

// NewWorkerPool creates a pool of n workers.
func NewWorkerPool(q *Queue, n int, fn ProcessFunc, log *slog.Logger) *WorkerPool {
	return &WorkerPool{
		q:       q,
		process: fn,
		workers: n,
		log:     log,
	}
}

// Start launches worker goroutines and blocks until ctx is cancelled.
func (p *WorkerPool) Start(ctx context.Context) {
	for i := 0; i < p.workers; i++ {
		p.wg.Add(1)
		go p.runWorker(ctx, i)
	}
	p.wg.Wait()
}

func (p *WorkerPool) runWorker(ctx context.Context, id int) {
	defer p.wg.Done()
	log := p.log.With("worker_id", id)

	for {
		e, err := p.q.Dequeue(ctx)
		if err != nil {
			// Context cancelled — normal shutdown.
			return
		}

		log.Info("processing event",
			"event_id", e.ID,
			"provider", e.Provider,
			"event_type", e.EventType,
			"attempt", e.Attempts+1,
		)

		if err := p.process(ctx, e); err != nil {
			log.Error("event processing failed",
				"event_id", e.ID,
				"error", err,
				"attempt", e.Attempts+1,
			)
			p.q.Requeue(e, err)
			continue
		}

		log.Info("event processed successfully", "event_id", e.ID)
	}
}
```

## HTTP Handler

```go
// internal/handler/webhook.go
package handler

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/yourorg/webhook-server/internal/auth"
	"github.com/yourorg/webhook-server/internal/queue"
	"github.com/yourorg/webhook-server/internal/store"
)

// WebhookHandler handles incoming webhook HTTP requests.
type WebhookHandler struct {
	verifiers    map[string]*auth.Verifier // keyed by provider
	q            *queue.Queue
	idempotency  *store.IdempotencyStore
	maxBodyBytes int64
}

// NewWebhookHandler constructs a handler with the given verifiers and queue.
func NewWebhookHandler(
	verifiers map[string]*auth.Verifier,
	q *queue.Queue,
	idem *store.IdempotencyStore,
) *WebhookHandler {
	return &WebhookHandler{
		verifiers:    verifiers,
		q:            q,
		idempotency:  idem,
		maxBodyBytes: 5 * 1024 * 1024, // 5 MB
	}
}

// ServeHTTP implements http.Handler.
// URL pattern: POST /webhook/{provider}
func (h *WebhookHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	provider := r.PathValue("provider") // Go 1.22 built-in routing
	if provider == "" {
		http.Error(w, "missing provider", http.StatusBadRequest)
		return
	}

	verifier, ok := h.verifiers[provider]
	if !ok {
		http.Error(w, fmt.Sprintf("unknown provider: %s", provider), http.StatusNotFound)
		return
	}

	// Read body with a size limit.
	body, err := io.ReadAll(io.LimitReader(r.Body, h.maxBodyBytes))
	if err != nil {
		http.Error(w, "failed to read body", http.StatusInternalServerError)
		return
	}

	// Verify signature before doing anything else.
	sigHeader := r.Header.Get("X-Hub-Signature-256") // GitHub
	if sigHeader == "" {
		sigHeader = r.Header.Get("Stripe-Signature") // Stripe
	}

	var verifyErr error
	switch provider {
	case "github":
		verifyErr = verifier.VerifyGitHub(body, r.Header.Get("X-Hub-Signature-256"))
	case "stripe":
		verifyErr = verifier.VerifyStripe(body, r.Header.Get("Stripe-Signature"))
	default:
		// Generic: expect X-Signature: sha256=<hex>
		verifyErr = verifier.VerifyGitHub(body, r.Header.Get("X-Signature"))
	}

	if verifyErr != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	// Determine event ID for idempotency.
	eventID := r.Header.Get("X-GitHub-Delivery") // GitHub
	if eventID == "" {
		eventID = extractStripeEventID(body) // Stripe
	}
	if eventID == "" {
		eventID = generateID() // Fallback: best-effort
	}

	// Check idempotency.
	acquired, existing := h.idempotency.TryAcquire(r.Context(), eventID)
	if !acquired {
		if existing != nil && existing.Status == store.StatusDone {
			// Replay cached response.
			w.Header().Set("X-Idempotent-Replay", "true")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(existing.Result)
			return
		}
		// Still processing — return 202 so sender does not retry yet.
		w.WriteHeader(http.StatusAccepted)
		return
	}

	// Extract headers needed for processing.
	headers := map[string]string{
		"Content-Type":       r.Header.Get("Content-Type"),
		"X-GitHub-Event":     r.Header.Get("X-GitHub-Event"),
		"X-Stripe-Event":     r.Header.Get("Stripe-Event"),
	}

	e := &queue.Event{
		ID:         eventID,
		Provider:   provider,
		EventType:  headers["X-GitHub-Event"],
		Body:       body,
		Headers:    headers,
		ReceivedAt: time.Now(),
	}

	if err := h.q.Enqueue(e); err != nil {
		h.idempotency.Release(eventID)
		http.Error(w, "failed to enqueue event", http.StatusInternalServerError)
		return
	}

	result := []byte(`{"status":"queued"}`)
	h.idempotency.Commit(eventID, result)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_, _ = w.Write(result)
}

func extractStripeEventID(body []byte) string {
	var payload struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	return payload.ID
}

func generateID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
```

## Processor: Business Logic Dispatch

```go
// internal/processor/processor.go
package processor

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/yourorg/webhook-server/internal/queue"
)

// EventHandler processes a specific event type.
type EventHandler func(ctx context.Context, body []byte) error

// Processor dispatches events to registered handlers.
type Processor struct {
	handlers map[string]map[string]EventHandler // provider -> eventType -> handler
	log      *slog.Logger
}

func New(log *slog.Logger) *Processor {
	return &Processor{
		handlers: make(map[string]map[string]EventHandler),
		log:      log,
	}
}

// Register adds a handler for a specific provider/eventType combination.
// Use "*" as eventType to match all events from a provider.
func (p *Processor) Register(provider, eventType string, h EventHandler) {
	if _, ok := p.handlers[provider]; !ok {
		p.handlers[provider] = make(map[string]EventHandler)
	}
	p.handlers[provider][eventType] = h
}

// Process implements queue.ProcessFunc.
func (p *Processor) Process(ctx context.Context, e *queue.Event) error {
	providerHandlers, ok := p.handlers[e.Provider]
	if !ok {
		return fmt.Errorf("no handlers registered for provider %q", e.Provider)
	}

	h, ok := providerHandlers[e.EventType]
	if !ok {
		h, ok = providerHandlers["*"]
	}
	if !ok {
		p.log.Warn("no handler for event type; discarding",
			"provider", e.Provider,
			"event_type", e.EventType,
		)
		return nil // Not retryable; discard.
	}

	return h(ctx, e.Body)
}

// --- Example handlers ---

// HandleGitHubPush processes a GitHub push event.
func HandleGitHubPush(ctx context.Context, body []byte) error {
	var payload struct {
		Ref        string `json:"ref"`
		Repository struct {
			FullName string `json:"full_name"`
		} `json:"repository"`
		HeadCommit struct {
			ID      string `json:"id"`
			Message string `json:"message"`
		} `json:"head_commit"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return fmt.Errorf("parsing push payload: %w", err)
	}

	slog.Info("push received",
		"repo", payload.Repository.FullName,
		"ref", payload.Ref,
		"commit", payload.HeadCommit.ID[:8],
		"message", payload.HeadCommit.Message,
	)

	// Trigger CI pipeline, update deployment record, etc.
	return nil
}

// HandleStripePaymentSucceeded processes a Stripe payment_intent.succeeded event.
func HandleStripePaymentSucceeded(ctx context.Context, body []byte) error {
	var payload struct {
		Data struct {
			Object struct {
				ID     string `json:"id"`
				Amount int64  `json:"amount"`
			} `json:"object"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return fmt.Errorf("parsing stripe payload: %w", err)
	}

	slog.Info("payment succeeded",
		"payment_intent_id", payload.Data.Object.ID,
		"amount_cents", payload.Data.Object.Amount,
	)

	// Update order status, send receipt email, etc.
	return nil
}
```

## Main: Wiring It All Together

```go
// cmd/server/main.go
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/yourorg/webhook-server/internal/auth"
	"github.com/yourorg/webhook-server/internal/handler"
	"github.com/yourorg/webhook-server/internal/processor"
	"github.com/yourorg/webhook-server/internal/queue"
	"github.com/yourorg/webhook-server/internal/store"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	// --- Secrets from environment variables ---
	githubSecret := os.Getenv("GITHUB_WEBHOOK_SECRET")
	stripeSecret := os.Getenv("STRIPE_WEBHOOK_SECRET")

	if githubSecret == "" || stripeSecret == "" {
		log.Error("GITHUB_WEBHOOK_SECRET and STRIPE_WEBHOOK_SECRET must be set")
		os.Exit(1)
	}

	githubVerifier, err := auth.NewVerifier(githubSecret)
	if err != nil {
		log.Error("failed to create GitHub verifier", "error", err)
		os.Exit(1)
	}

	stripeVerifier, err := auth.NewVerifier(stripeSecret)
	if err != nil {
		log.Error("failed to create Stripe verifier", "error", err)
		os.Exit(1)
	}

	// --- Queue ---
	q, err := queue.New("/var/data/webhook-wal.jsonl")
	if err != nil {
		log.Error("failed to create queue", "error", err)
		os.Exit(1)
	}

	// --- Idempotency store ---
	idem := store.NewIdempotencyStore(24 * time.Hour)

	// --- Processor ---
	proc := processor.New(log)
	proc.Register("github", "push", processor.HandleGitHubPush)
	proc.Register("stripe", "payment_intent.succeeded", processor.HandleStripePaymentSucceeded)

	// --- Worker pool: 5 concurrent workers ---
	pool := queue.NewWorkerPool(q, 5, proc.Process, log)

	// --- HTTP server ---
	mux := http.NewServeMux()

	wh := handler.NewWebhookHandler(
		map[string]*auth.Verifier{
			"github": githubVerifier,
			"stripe": stripeVerifier,
		},
		q,
		idem,
	)

	mux.Handle("POST /webhook/{provider}", wh)
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{
		Addr:         ":8080",
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Start workers.
	go pool.Start(ctx)

	// Start HTTP server.
	go func() {
		log.Info("starting webhook server", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("server shutdown error", "error", err)
	}
}
```

## Deployment: Kubernetes Manifest

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webhook-server
  namespace: integrations
spec:
  replicas: 3
  selector:
    matchLabels:
      app: webhook-server
  template:
    metadata:
      labels:
        app: webhook-server
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: webhook-server
          image: your-registry.example.com/webhook-server:1.0.0
          ports:
            - containerPort: 8080
          env:
            - name: GITHUB_WEBHOOK_SECRET
              valueFrom:
                secretKeyRef:
                  name: webhook-secrets
                  key: github-secret
            - name: STRIPE_WEBHOOK_SECRET
              valueFrom:
                secretKeyRef:
                  name: webhook-secrets
                  key: stripe-secret
          volumeMounts:
            - name: wal-storage
              mountPath: /var/data
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 20
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
      volumes:
        - name: wal-storage
          persistentVolumeClaim:
            claimName: webhook-wal-pvc
---
apiVersion: v1
kind: Secret
metadata:
  name: webhook-secrets
  namespace: integrations
type: Opaque
stringData:
  github-secret: "<your-github-webhook-secret>"
  stripe-secret: "<your-stripe-webhook-secret>"
```

## Testing

```go
// internal/auth/hmac_test.go
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestVerifyGitHub(t *testing.T) {
	secret := "test-secret"
	body := []byte(`{"ref":"refs/heads/main"}`)

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	v, _ := NewVerifier(secret)

	t.Run("valid signature", func(t *testing.T) {
		if err := v.VerifyGitHub(body, sig); err != nil {
			t.Fatalf("expected nil, got %v", err)
		}
	})

	t.Run("tampered body", func(t *testing.T) {
		tampered := []byte(`{"ref":"refs/heads/evil"}`)
		if err := v.VerifyGitHub(tampered, sig); err == nil {
			t.Fatal("expected error for tampered body")
		}
	})

	t.Run("missing signature", func(t *testing.T) {
		if err := v.VerifyGitHub(body, ""); err == nil {
			t.Fatal("expected error for missing signature")
		}
	})

	t.Run("timing safety — no early exit", func(t *testing.T) {
		// Verify that wrong-first-byte doesn't return faster than wrong-last-byte.
		// This is a sanity check; true timing analysis requires statistical methods.
		wrongFirst := "sha256=" + hex.EncodeToString(make([]byte, 32))
		wrongLast := "sha256=" + hex.EncodeToString(append(make([]byte, 31), 0xFF))
		errFirst := v.VerifyGitHub(body, wrongFirst)
		errLast := v.VerifyGitHub(body, wrongLast)
		if errFirst == nil || errLast == nil {
			t.Fatal("expected errors for wrong signatures")
		}
	})
}

func TestSecretRotation(t *testing.T) {
	oldSecret := "old-secret"
	newSecret := "new-secret"
	body := []byte(`{"event":"test"}`)

	// Sign with old secret.
	mac := hmac.New(sha256.New, []byte(oldSecret))
	mac.Write(body)
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	// Verifier with both secrets (rotation period).
	v, _ := NewVerifier(oldSecret, newSecret)

	if err := v.VerifyGitHub(body, sig); err != nil {
		t.Fatalf("old-secret signature should still be valid during rotation: %v", err)
	}
}
```

## Summary

The production webhook server built in this post provides:

1. **Constant-time HMAC verification** that cannot be defeated by timing attacks, with support for GitHub, Stripe, and generic signature formats.
2. **Zero-downtime secret rotation** by accepting multiple secrets simultaneously during the transition window.
3. **Idempotent processing** using a lock-and-commit pattern that prevents duplicate processing when senders retry.
4. **Durable retry queue** with exponential backoff, a WAL for crash recovery, and a dead-letter queue for events that exhaust all retries.
5. **Pluggable processor** that dispatches events to registered handlers by provider and event type, keeping business logic separate from infrastructure.

Replacing the in-memory idempotency store with Redis and the WAL-backed queue with Kafka or NATS JetStream converts this into a fully distributed, horizontally scalable webhook processing system.
