---
title: "Go Saga Pattern: Distributed Transaction Management"
date: 2029-07-19T00:00:00-05:00
draft: false
tags: ["Go", "Saga Pattern", "Distributed Transactions", "Microservices", "Outbox Pattern", "Event-Driven"]
categories: ["Go", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to implementing the Saga pattern in Go for distributed transaction management, covering choreography vs orchestration, compensating transactions, outbox pattern, idempotency keys, and failure recovery."
more_link: "yes"
url: "/go-saga-pattern-distributed-transaction-management-guide/"
---

Distributed transactions across microservices are one of the hardest problems in modern backend engineering. The two-phase commit (2PC) protocol works in theory but introduces distributed locks, coordinator single points of failure, and poor availability under network partitions. The Saga pattern solves this by decomposing a long-running business transaction into a sequence of local transactions, each with a corresponding compensating transaction to undo its effect. This guide builds production-grade Saga implementations in Go, covering both choreography and orchestration approaches, the outbox pattern for reliable event publishing, idempotency guarantees, and failure recovery strategies.

<!--more-->

# Go Saga Pattern: Distributed Transaction Management

## Section 1: Saga Pattern Fundamentals

A Saga is a sequence of local transactions T1, T2, ..., Tn where each Ti has a compensating transaction Ci that semantically undoes the effect of Ti. If Ti succeeds but Ti+1 fails, the Saga executes Ci, Ci-1, ..., C1 to restore consistency.

### Key Properties

- **ACD (not ACID)**: Sagas provide Atomicity (via compensation), Consistency (eventual), and Durability, but NOT Isolation
- **Semantic compensation**: compensation does not undo at the database level but applies business-level reversal (e.g., "issue refund" rather than "delete payment row")
- **Eventual consistency**: intermediate states are visible; isolation is the developer's responsibility to manage

### When to Use Sagas

```
Use Saga when:
  - Transaction spans multiple services/databases
  - Long-running processes (minutes to hours)
  - High availability more important than strong consistency
  - 2PC is not supported by participating services

Avoid Saga when:
  - Strong isolation is required (e.g., financial exact-match accounting)
  - Compensation is impossible (e.g., sending an SMS cannot be unsent)
  - All data is in a single transactional data store
```

### Choreography vs Orchestration

```
Choreography:
  Service A ──event──> Service B ──event──> Service C
  - Services react to events from each other
  - No central coordinator
  - Pros: loose coupling, no SPOF coordinator
  - Cons: hard to track overall state, implicit flow

Orchestration:
  Orchestrator ──cmd──> Service A
       ^                    |
       └──result────────────┘
  Orchestrator ──cmd──> Service B
  - Central saga orchestrator drives the flow
  - Pros: explicit workflow, easy to monitor, easier compensation
  - Cons: orchestrator is coupled to all services
```

## Section 2: Domain Model and Interfaces

```go
// saga/domain.go
package saga

import (
	"context"
	"time"
)

// SagaStatus represents the current state of a saga execution
type SagaStatus string

const (
	SagaStatusPending      SagaStatus = "PENDING"
	SagaStatusRunning      SagaStatus = "RUNNING"
	SagaStatusCompleted    SagaStatus = "COMPLETED"
	SagaStatusCompensating SagaStatus = "COMPENSATING"
	SagaStatusFailed       SagaStatus = "FAILED"
	SagaStatusRolledBack   SagaStatus = "ROLLED_BACK"
)

// StepStatus represents the state of a single saga step
type StepStatus string

const (
	StepStatusPending     StepStatus = "PENDING"
	StepStatusExecuting   StepStatus = "EXECUTING"
	StepStatusCompleted   StepStatus = "COMPLETED"
	StepStatusFailed      StepStatus = "FAILED"
	StepStatusCompensated StepStatus = "COMPENSATED"
)

// SagaID uniquely identifies a saga instance
type SagaID string

// IdempotencyKey prevents duplicate execution of steps
type IdempotencyKey string

// SagaContext carries state between steps
type SagaContext struct {
	SagaID        SagaID
	CorrelationID string
	Payload       map[string]any
	StepResults   map[string]any
	CurrentStep   int
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// Step defines a single unit of work in a saga
type Step interface {
	// Name returns the unique identifier for this step
	Name() string

	// Execute performs the step's action
	Execute(ctx context.Context, sagaCtx *SagaContext) error

	// Compensate undoes the effect of a successful Execute
	Compensate(ctx context.Context, sagaCtx *SagaContext) error

	// IdempotencyKey returns a key for deduplication
	IdempotencyKey(sagaCtx *SagaContext) IdempotencyKey
}

// SagaRepository persists saga state
type SagaRepository interface {
	Save(ctx context.Context, saga *SagaInstance) error
	FindByID(ctx context.Context, id SagaID) (*SagaInstance, error)
	FindByStatus(ctx context.Context, status SagaStatus, limit int) ([]*SagaInstance, error)
	UpdateStatus(ctx context.Context, id SagaID, status SagaStatus) error
	UpdateStep(ctx context.Context, id SagaID, stepName string, status StepStatus, result any) error
}

// SagaInstance is the persisted representation of a saga execution
type SagaInstance struct {
	ID            SagaID
	DefinitionID  string
	Status        SagaStatus
	Context       SagaContext
	StepStatuses  map[string]StepStatus
	StepResults   map[string]any
	LastError     string
	CreatedAt     time.Time
	UpdatedAt     time.Time
	CompletedAt   *time.Time
}
```

## Section 3: Orchestration Saga Executor

```go
// saga/orchestrator.go
package saga

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// Orchestrator drives saga execution step by step
type Orchestrator struct {
	steps      []Step
	repository SagaRepository
	logger     *slog.Logger
	retryDelay time.Duration
	maxRetries int
}

// NewOrchestrator creates a new saga orchestrator
func NewOrchestrator(
	steps []Step,
	repo SagaRepository,
	logger *slog.Logger,
) *Orchestrator {
	return &Orchestrator{
		steps:      steps,
		repository: repo,
		logger:     logger,
		retryDelay: 1 * time.Second,
		maxRetries: 3,
	}
}

// Execute runs the saga to completion, compensating on failure
func (o *Orchestrator) Execute(ctx context.Context, sagaCtx *SagaContext) error {
	instance := &SagaInstance{
		ID:           sagaCtx.SagaID,
		Status:       SagaStatusRunning,
		Context:      *sagaCtx,
		StepStatuses: make(map[string]StepStatus),
		StepResults:  make(map[string]any),
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}

	if err := o.repository.Save(ctx, instance); err != nil {
		return fmt.Errorf("save saga instance: %w", err)
	}

	o.logger.Info("saga started",
		"saga_id", sagaCtx.SagaID,
		"steps", len(o.steps),
	)

	// Execute steps forward
	executedSteps := make([]int, 0, len(o.steps))
	for i, step := range o.steps {
		if err := o.executeStep(ctx, sagaCtx, instance, step, i); err != nil {
			o.logger.Error("saga step failed",
				"saga_id", sagaCtx.SagaID,
				"step", step.Name(),
				"error", err,
			)

			// Update saga status to compensating
			instance.Status = SagaStatusCompensating
			instance.LastError = err.Error()
			_ = o.repository.Save(ctx, instance)

			// Compensate all previously executed steps in reverse order
			if compErr := o.compensate(ctx, sagaCtx, instance, executedSteps); compErr != nil {
				o.logger.Error("compensation failed",
					"saga_id", sagaCtx.SagaID,
					"error", compErr,
				)
				instance.Status = SagaStatusFailed
				_ = o.repository.Save(ctx, instance)
				return fmt.Errorf("step %s failed and compensation failed: step_err=%w comp_err=%v",
					step.Name(), err, compErr)
			}

			instance.Status = SagaStatusRolledBack
			_ = o.repository.Save(ctx, instance)
			return fmt.Errorf("saga rolled back after step %s failed: %w", step.Name(), err)
		}
		executedSteps = append(executedSteps, i)
	}

	now := time.Now()
	instance.Status = SagaStatusCompleted
	instance.CompletedAt = &now
	_ = o.repository.Save(ctx, instance)

	o.logger.Info("saga completed",
		"saga_id", sagaCtx.SagaID,
		"duration", time.Since(sagaCtx.CreatedAt),
	)

	return nil
}

func (o *Orchestrator) executeStep(
	ctx context.Context,
	sagaCtx *SagaContext,
	instance *SagaInstance,
	step Step,
	idx int,
) error {
	name := step.Name()
	ikey := step.IdempotencyKey(sagaCtx)

	o.logger.Info("executing saga step",
		"saga_id", sagaCtx.SagaID,
		"step", name,
		"idempotency_key", ikey,
	)

	// Check if step was already completed (resume after crash)
	if status, ok := instance.StepStatuses[name]; ok && status == StepStatusCompleted {
		o.logger.Info("step already completed, skipping",
			"saga_id", sagaCtx.SagaID,
			"step", name,
		)
		sagaCtx.CurrentStep = idx + 1
		return nil
	}

	instance.StepStatuses[name] = StepStatusExecuting
	_ = o.repository.UpdateStep(ctx, instance.ID, name, StepStatusExecuting, nil)

	var lastErr error
	for attempt := 0; attempt <= o.maxRetries; attempt++ {
		if attempt > 0 {
			delay := o.retryDelay * time.Duration(1<<uint(attempt-1)) // exponential backoff
			o.logger.Info("retrying step",
				"saga_id", sagaCtx.SagaID,
				"step", name,
				"attempt", attempt,
				"delay", delay,
			)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
		}

		lastErr = step.Execute(ctx, sagaCtx)
		if lastErr == nil {
			break
		}

		// Check if error is retryable
		if !isRetryable(lastErr) {
			break
		}
	}

	if lastErr != nil {
		instance.StepStatuses[name] = StepStatusFailed
		_ = o.repository.UpdateStep(ctx, instance.ID, name, StepStatusFailed, lastErr.Error())
		return fmt.Errorf("step %s failed after %d attempts: %w", name, o.maxRetries+1, lastErr)
	}

	sagaCtx.CurrentStep = idx + 1
	instance.StepStatuses[name] = StepStatusCompleted
	_ = o.repository.UpdateStep(ctx, instance.ID, name, StepStatusCompleted,
		sagaCtx.StepResults[name])

	return nil
}

func (o *Orchestrator) compensate(
	ctx context.Context,
	sagaCtx *SagaContext,
	instance *SagaInstance,
	executedIndices []int,
) error {
	// Compensate in reverse order
	for i := len(executedIndices) - 1; i >= 0; i-- {
		idx := executedIndices[i]
		step := o.steps[idx]
		name := step.Name()

		// Skip if already compensated
		if status, ok := instance.StepStatuses[name]; ok && status == StepStatusCompensated {
			continue
		}

		o.logger.Info("compensating step",
			"saga_id", sagaCtx.SagaID,
			"step", name,
		)

		if err := step.Compensate(ctx, sagaCtx); err != nil {
			return fmt.Errorf("compensate step %s: %w", name, err)
		}

		instance.StepStatuses[name] = StepStatusCompensated
		_ = o.repository.UpdateStep(ctx, instance.ID, name, StepStatusCompensated, nil)
	}
	return nil
}

// isRetryable determines if an error warrants retry
func isRetryable(err error) bool {
	// In production, check for specific error types
	// e.g., network timeouts, temporary unavailability
	type retryableError interface {
		IsRetryable() bool
	}
	if re, ok := err.(retryableError); ok {
		return re.IsRetryable()
	}
	return false
}
```

## Section 4: Order Processing Saga Example

```go
// saga/examples/order_saga.go
package examples

import (
	"context"
	"fmt"
	"time"

	"github.com/example/app/saga"
)

// === Step: Reserve Inventory ===

type ReserveInventoryStep struct {
	inventoryClient InventoryClient
}

func (s *ReserveInventoryStep) Name() string { return "reserve_inventory" }

func (s *ReserveInventoryStep) IdempotencyKey(ctx *saga.SagaContext) saga.IdempotencyKey {
	return saga.IdempotencyKey(fmt.Sprintf("reserve-inv-%s", ctx.SagaID))
}

func (s *ReserveInventoryStep) Execute(ctx context.Context, sagaCtx *saga.SagaContext) error {
	orderID := sagaCtx.Payload["order_id"].(string)
	items := sagaCtx.Payload["items"].([]OrderItem)

	reservationID, err := s.inventoryClient.Reserve(ctx, ReserveRequest{
		OrderID:        orderID,
		Items:          items,
		IdempotencyKey: string(s.IdempotencyKey(sagaCtx)),
	})
	if err != nil {
		return fmt.Errorf("inventory reserve: %w", err)
	}

	// Store result for use by subsequent steps and compensation
	sagaCtx.StepResults["reservation_id"] = reservationID
	return nil
}

func (s *ReserveInventoryStep) Compensate(ctx context.Context, sagaCtx *saga.SagaContext) error {
	reservationID, ok := sagaCtx.StepResults["reservation_id"].(string)
	if !ok {
		// Step never succeeded — nothing to compensate
		return nil
	}
	return s.inventoryClient.ReleaseReservation(ctx, reservationID)
}

// === Step: Charge Payment ===

type ChargePaymentStep struct {
	paymentClient PaymentClient
}

func (s *ChargePaymentStep) Name() string { return "charge_payment" }

func (s *ChargePaymentStep) IdempotencyKey(ctx *saga.SagaContext) saga.IdempotencyKey {
	return saga.IdempotencyKey(fmt.Sprintf("payment-%s", ctx.SagaID))
}

func (s *ChargePaymentStep) Execute(ctx context.Context, sagaCtx *saga.SagaContext) error {
	amount := sagaCtx.Payload["amount"].(float64)
	paymentMethodID := sagaCtx.Payload["payment_method_id"].(string)

	chargeID, err := s.paymentClient.Charge(ctx, ChargeRequest{
		Amount:          amount,
		PaymentMethodID: paymentMethodID,
		IdempotencyKey:  string(s.IdempotencyKey(sagaCtx)),
	})
	if err != nil {
		return fmt.Errorf("payment charge: %w", err)
	}

	sagaCtx.StepResults["charge_id"] = chargeID
	return nil
}

func (s *ChargePaymentStep) Compensate(ctx context.Context, sagaCtx *saga.SagaContext) error {
	chargeID, ok := sagaCtx.StepResults["charge_id"].(string)
	if !ok {
		return nil
	}
	return s.paymentClient.Refund(ctx, RefundRequest{
		ChargeID:       chargeID,
		IdempotencyKey: fmt.Sprintf("refund-%s", string(s.IdempotencyKey(sagaCtx))),
	})
}

// === Step: Schedule Fulfillment ===

type ScheduleFulfillmentStep struct {
	fulfillmentClient FulfillmentClient
}

func (s *ScheduleFulfillmentStep) Name() string { return "schedule_fulfillment" }

func (s *ScheduleFulfillmentStep) IdempotencyKey(ctx *saga.SagaContext) saga.IdempotencyKey {
	return saga.IdempotencyKey(fmt.Sprintf("fulfill-%s", ctx.SagaID))
}

func (s *ScheduleFulfillmentStep) Execute(ctx context.Context, sagaCtx *saga.SagaContext) error {
	orderID := sagaCtx.Payload["order_id"].(string)
	reservationID := sagaCtx.StepResults["reservation_id"].(string)
	chargeID := sagaCtx.StepResults["charge_id"].(string)

	jobID, err := s.fulfillmentClient.Schedule(ctx, FulfillRequest{
		OrderID:       orderID,
		ReservationID: reservationID,
		ChargeID:      chargeID,
	})
	if err != nil {
		return fmt.Errorf("fulfillment schedule: %w", err)
	}

	sagaCtx.StepResults["fulfillment_job_id"] = jobID
	return nil
}

func (s *ScheduleFulfillmentStep) Compensate(ctx context.Context, sagaCtx *saga.SagaContext) error {
	jobID, ok := sagaCtx.StepResults["fulfillment_job_id"].(string)
	if !ok {
		return nil
	}
	return s.fulfillmentClient.Cancel(ctx, jobID)
}

// === Build and Execute the Order Saga ===

type OrderSagaFactory struct {
	inventory   InventoryClient
	payment     PaymentClient
	fulfillment FulfillmentClient
	repo        saga.SagaRepository
}

func (f *OrderSagaFactory) PlaceOrder(ctx context.Context, order PlaceOrderRequest) error {
	sagaID := saga.SagaID(fmt.Sprintf("order-%s-%d", order.OrderID, time.Now().UnixNano()))

	sagaCtx := &saga.SagaContext{
		SagaID:        sagaID,
		CorrelationID: order.CorrelationID,
		Payload: map[string]any{
			"order_id":          order.OrderID,
			"items":             order.Items,
			"amount":            order.TotalAmount,
			"payment_method_id": order.PaymentMethodID,
		},
		StepResults: make(map[string]any),
		CreatedAt:   time.Now(),
	}

	steps := []saga.Step{
		&ReserveInventoryStep{inventoryClient: f.inventory},
		&ChargePaymentStep{paymentClient: f.payment},
		&ScheduleFulfillmentStep{fulfillmentClient: f.fulfillment},
	}

	orchestrator := saga.NewOrchestrator(steps, f.repo, slog.Default())
	return orchestrator.Execute(ctx, sagaCtx)
}
```

## Section 5: Choreography-Based Saga

```go
// saga/choreography/handler.go
package choreography

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"
)

// EventBus abstracts the message broker
type EventBus interface {
	Publish(ctx context.Context, topic string, event any) error
	Subscribe(topic string, handler func(ctx context.Context, payload []byte) error) error
}

// OrderEvent types for choreography saga
const (
	TopicOrderCreated          = "order.created"
	TopicInventoryReserved     = "inventory.reserved"
	TopicInventoryFailed       = "inventory.failed"
	TopicPaymentCharged        = "payment.charged"
	TopicPaymentFailed         = "payment.failed"
	TopicFulfillmentScheduled  = "fulfillment.scheduled"
	TopicOrderCancelled        = "order.cancelled"
	// Compensation events
	TopicInventoryRelease      = "inventory.release"
	TopicPaymentRefund         = "payment.refund"
)

type OrderCreatedEvent struct {
	SagaID          string    `json:"saga_id"`
	OrderID         string    `json:"order_id"`
	Items           []any     `json:"items"`
	Amount          float64   `json:"amount"`
	PaymentMethodID string    `json:"payment_method_id"`
	CreatedAt       time.Time `json:"created_at"`
}

type InventoryReservedEvent struct {
	SagaID        string `json:"saga_id"`
	OrderID       string `json:"order_id"`
	ReservationID string `json:"reservation_id"`
}

type PaymentChargedEvent struct {
	SagaID        string `json:"saga_id"`
	OrderID       string `json:"order_id"`
	ReservationID string `json:"reservation_id"`
	ChargeID      string `json:"charge_id"`
}

// InventoryService handles inventory events
type InventoryService struct {
	client    InventoryClient
	eventBus  EventBus
	sagaStore SagaStore
	logger    *slog.Logger
}

func (s *InventoryService) RegisterHandlers() {
	s.eventBus.Subscribe(TopicOrderCreated, s.onOrderCreated)
	s.eventBus.Subscribe(TopicInventoryRelease, s.onInventoryRelease)
}

func (s *InventoryService) onOrderCreated(ctx context.Context, payload []byte) error {
	var event OrderCreatedEvent
	if err := json.Unmarshal(payload, &event); err != nil {
		return fmt.Errorf("unmarshal OrderCreatedEvent: %w", err)
	}

	s.logger.Info("handling order created",
		"saga_id", event.SagaID,
		"order_id", event.OrderID,
	)

	// Idempotency check
	if s.sagaStore.StepCompleted(ctx, event.SagaID, "reserve_inventory") {
		s.logger.Info("step already completed, skipping",
			"saga_id", event.SagaID,
		)
		return nil
	}

	reservationID, err := s.client.Reserve(ctx, event.OrderID, event.Items)
	if err != nil {
		s.logger.Error("inventory reservation failed",
			"saga_id", event.SagaID,
			"error", err,
		)
		return s.eventBus.Publish(ctx, TopicInventoryFailed, map[string]any{
			"saga_id":   event.SagaID,
			"order_id":  event.OrderID,
			"reason":    err.Error(),
		})
	}

	s.sagaStore.MarkStepComplete(ctx, event.SagaID, "reserve_inventory", reservationID)

	return s.eventBus.Publish(ctx, TopicInventoryReserved, InventoryReservedEvent{
		SagaID:        event.SagaID,
		OrderID:       event.OrderID,
		ReservationID: reservationID,
	})
}

func (s *InventoryService) onInventoryRelease(ctx context.Context, payload []byte) error {
	var event struct {
		SagaID        string `json:"saga_id"`
		ReservationID string `json:"reservation_id"`
	}
	if err := json.Unmarshal(payload, &event); err != nil {
		return err
	}

	return s.client.ReleaseReservation(ctx, event.ReservationID)
}
```

## Section 6: Outbox Pattern for Reliable Event Publishing

The outbox pattern guarantees at-least-once delivery of events by writing them to the same database transaction as the business data, then relaying them to the event bus asynchronously.

```go
// outbox/outbox.go
package outbox

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"
)

// OutboxMessage is stored in the outbox table
type OutboxMessage struct {
	ID          string
	Topic       string
	Payload     []byte
	CreatedAt   time.Time
	ProcessedAt *time.Time
	RetryCount  int
	LastError   string
}

// OutboxRepository manages outbox persistence
type OutboxRepository struct {
	db *sql.DB
}

// SaveInTransaction saves a saga step result and outbox message atomically
func (r *OutboxRepository) SaveInTransaction(
	ctx context.Context,
	tx *sql.Tx,
	messageID string,
	topic string,
	payload any,
) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal outbox payload: %w", err)
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO outbox_messages (id, topic, payload, created_at, processed, retry_count)
		VALUES ($1, $2, $3, $4, false, 0)
		ON CONFLICT (id) DO NOTHING
	`, messageID, topic, data, time.Now())

	return err
}

// OutboxRelay polls the outbox and publishes unpublished messages
type OutboxRelay struct {
	repo     *OutboxRepository
	eventBus EventBus
	logger   *slog.Logger
	batchSize int
}

func NewOutboxRelay(repo *OutboxRepository, bus EventBus, logger *slog.Logger) *OutboxRelay {
	return &OutboxRelay{
		repo:      repo,
		eventBus:  bus,
		logger:    logger,
		batchSize: 100,
	}
}

func (r *OutboxRelay) Run(ctx context.Context) error {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := r.processBatch(ctx); err != nil {
				r.logger.Error("outbox relay error", "error", err)
			}
		}
	}
}

func (r *OutboxRelay) processBatch(ctx context.Context) error {
	messages, err := r.repo.FetchUnprocessed(ctx, r.batchSize)
	if err != nil {
		return fmt.Errorf("fetch unprocessed: %w", err)
	}

	for _, msg := range messages {
		if err := r.publishMessage(ctx, msg); err != nil {
			r.logger.Error("failed to publish outbox message",
				"message_id", msg.ID,
				"topic", msg.Topic,
				"error", err,
			)
			_ = r.repo.IncrementRetry(ctx, msg.ID, err.Error())
			continue
		}

		if err := r.repo.MarkProcessed(ctx, msg.ID); err != nil {
			r.logger.Error("failed to mark message processed",
				"message_id", msg.ID,
				"error", err,
			)
		}
	}

	return nil
}

func (r *OutboxRelay) publishMessage(ctx context.Context, msg *OutboxMessage) error {
	return r.eventBus.Publish(ctx, msg.Topic, msg.Payload)
}
```

```sql
-- outbox schema
CREATE TABLE outbox_messages (
    id           UUID PRIMARY KEY,
    topic        VARCHAR(255) NOT NULL,
    payload      JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed    BOOLEAN NOT NULL DEFAULT FALSE,
    processed_at TIMESTAMPTZ,
    retry_count  INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    -- Composite index for polling query
    INDEX idx_outbox_unprocessed (processed, created_at)
        WHERE processed = FALSE
);

-- Saga state table
CREATE TABLE saga_instances (
    id              UUID PRIMARY KEY,
    definition_id   VARCHAR(255) NOT NULL,
    status          VARCHAR(50) NOT NULL,
    context         JSONB NOT NULL,
    step_statuses   JSONB NOT NULL DEFAULT '{}',
    step_results    JSONB NOT NULL DEFAULT '{}',
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    INDEX idx_saga_status (status),
    INDEX idx_saga_updated (updated_at)
);
```

## Section 7: Idempotency Keys

```go
// idempotency/store.go
package idempotency

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// ErrDuplicateRequest is returned when the same idempotency key has been used
var ErrDuplicateRequest = errors.New("duplicate idempotency key")

// RequestRecord tracks a processed request
type RequestRecord struct {
	Key          string
	Response     []byte
	StatusCode   int
	CreatedAt    time.Time
	ExpiresAt    time.Time
}

// Store manages idempotency records
type Store struct {
	db  *sql.DB
	ttl time.Duration
}

// NewStore creates an idempotency store with the given TTL
func NewStore(db *sql.DB, ttl time.Duration) *Store {
	return &Store{db: db, ttl: ttl}
}

// GenerateKey produces a deterministic idempotency key from inputs
func GenerateKey(namespace string, inputs ...any) string {
	h := sha256.New()
	h.Write([]byte(namespace))
	for _, input := range inputs {
		data, _ := json.Marshal(input)
		h.Write(data)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// CheckOrCreate checks for an existing record or creates a new one.
// Returns (existingResponse, true, nil) if already processed.
// Returns (nil, false, nil) if new request — caller should process and call Complete.
func (s *Store) CheckOrCreate(ctx context.Context, key string) ([]byte, bool, error) {
	var response []byte
	var expiresAt time.Time

	err := s.db.QueryRowContext(ctx, `
		SELECT response, expires_at
		FROM idempotency_records
		WHERE key = $1
	`, key).Scan(&response, &expiresAt)

	if err == nil {
		if time.Now().Before(expiresAt) {
			return response, true, nil
		}
		// Expired — treat as new
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, false, fmt.Errorf("check idempotency key: %w", err)
	}

	// Insert a "processing" record to prevent concurrent duplicate execution
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO idempotency_records (key, status, created_at, expires_at)
		VALUES ($1, 'processing', $2, $3)
		ON CONFLICT (key) DO UPDATE
			SET status = 'processing', created_at = $2
			WHERE idempotency_records.status = 'expired'
	`, key, time.Now(), time.Now().Add(s.ttl))

	if err != nil {
		return nil, false, fmt.Errorf("insert idempotency record: %w", err)
	}

	return nil, false, nil
}

// Complete stores the result for an idempotency key
func (s *Store) Complete(ctx context.Context, key string, response []byte, statusCode int) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE idempotency_records
		SET response = $1, status_code = $2, status = 'completed', completed_at = $3
		WHERE key = $4
	`, response, statusCode, time.Now(), key)
	return err
}
```

## Section 8: Saga State Machine

```go
// saga/statemachine.go
package saga

import (
	"fmt"
)

// Transition defines a valid state change
type Transition struct {
	From  SagaStatus
	Event string
	To    SagaStatus
}

// StateMachine enforces valid saga state transitions
type StateMachine struct {
	transitions map[string]SagaStatus
}

// NewSagaStateMachine creates the state machine for saga lifecycle
func NewSagaStateMachine() *StateMachine {
	sm := &StateMachine{
		transitions: make(map[string]SagaStatus),
	}

	transitions := []Transition{
		{SagaStatusPending, "start", SagaStatusRunning},
		{SagaStatusRunning, "step_failed", SagaStatusCompensating},
		{SagaStatusRunning, "all_steps_complete", SagaStatusCompleted},
		{SagaStatusCompensating, "compensation_complete", SagaStatusRolledBack},
		{SagaStatusCompensating, "compensation_failed", SagaStatusFailed},
	}

	for _, t := range transitions {
		key := string(t.From) + ":" + t.Event
		sm.transitions[key] = t.To
	}

	return sm
}

// Transition applies an event to the current status
func (sm *StateMachine) Transition(current SagaStatus, event string) (SagaStatus, error) {
	key := string(current) + ":" + event
	next, ok := sm.transitions[key]
	if !ok {
		return "", fmt.Errorf("invalid transition: status=%s event=%s", current, event)
	}
	return next, nil
}

// IsTerminal returns true if no further transitions are possible
func (sm *StateMachine) IsTerminal(status SagaStatus) bool {
	switch status {
	case SagaStatusCompleted, SagaStatusRolledBack, SagaStatusFailed:
		return true
	}
	return false
}
```

## Section 9: Failure Recovery and Resumption

```go
// saga/recovery.go
package saga

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// RecoveryWorker resumes interrupted sagas after crashes
type RecoveryWorker struct {
	repository  SagaRepository
	definitions map[string]*SagaDefinition
	logger      *slog.Logger
	interval    time.Duration
	maxAge      time.Duration
}

// SagaDefinition maps saga IDs to their step configurations
type SagaDefinition struct {
	ID    string
	Steps func() []Step
}

func NewRecoveryWorker(
	repo SagaRepository,
	defs []*SagaDefinition,
	logger *slog.Logger,
) *RecoveryWorker {
	defMap := make(map[string]*SagaDefinition)
	for _, d := range defs {
		defMap[d.ID] = d
	}
	return &RecoveryWorker{
		repository:  repo,
		definitions: defMap,
		logger:      logger,
		interval:    30 * time.Second,
		maxAge:      24 * time.Hour,
	}
}

// Run polls for incomplete sagas and attempts recovery
func (w *RecoveryWorker) Run(ctx context.Context) error {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := w.recoverBatch(ctx); err != nil {
				w.logger.Error("recovery batch error", "error", err)
			}
		}
	}
}

func (w *RecoveryWorker) recoverBatch(ctx context.Context) error {
	// Find sagas stuck in RUNNING or COMPENSATING state
	stuck, err := w.repository.FindByStatus(ctx, SagaStatusRunning, 50)
	if err != nil {
		return fmt.Errorf("find stuck sagas: %w", err)
	}

	for _, instance := range stuck {
		age := time.Since(instance.UpdatedAt)

		// Skip recently updated sagas (may still be processing)
		if age < 2*time.Minute {
			continue
		}

		// Skip very old sagas (likely unrecoverable)
		if age > w.maxAge {
			w.logger.Warn("saga too old to recover",
				"saga_id", instance.ID,
				"age", age,
			)
			_ = w.repository.UpdateStatus(ctx, instance.ID, SagaStatusFailed)
			continue
		}

		def, ok := w.definitions[instance.DefinitionID]
		if !ok {
			w.logger.Error("unknown saga definition",
				"saga_id", instance.ID,
				"definition_id", instance.DefinitionID,
			)
			continue
		}

		w.logger.Info("recovering saga",
			"saga_id", instance.ID,
			"age", age,
			"last_step", instance.Context.CurrentStep,
		)

		go func(inst *SagaInstance) {
			recoverCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
			defer cancel()

			steps := def.Steps()
			orchestrator := NewOrchestrator(steps, w.repository, w.logger)

			// Restore saga context from persisted state
			sagaCtx := &inst.Context
			sagaCtx.StepResults = inst.StepResults

			if err := orchestrator.Execute(recoverCtx, sagaCtx); err != nil {
				w.logger.Error("saga recovery failed",
					"saga_id", inst.ID,
					"error", err,
				)
			}
		}(instance)
	}

	return nil
}
```

## Section 10: Testing Sagas

```go
// saga/orchestrator_test.go
package saga_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/example/app/saga"
)

// MockStep is a controllable test step
type MockStep struct {
	name           string
	executeCalls   int
	compensateCalls int
	executeErr     error
	compensateErr  error
	mu             sync.Mutex
}

func (s *MockStep) Name() string { return s.name }

func (s *MockStep) IdempotencyKey(ctx *saga.SagaContext) saga.IdempotencyKey {
	return saga.IdempotencyKey(s.name + "-" + string(ctx.SagaID))
}

func (s *MockStep) Execute(_ context.Context, sagaCtx *saga.SagaContext) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.executeCalls++
	if s.executeErr != nil {
		return s.executeErr
	}
	sagaCtx.StepResults[s.name] = s.name + "_result"
	return nil
}

func (s *MockStep) Compensate(_ context.Context, sagaCtx *saga.SagaContext) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.compensateCalls++
	return s.compensateErr
}

// InMemoryRepo is a test saga repository
type InMemoryRepo struct {
	mu        sync.Mutex
	instances map[saga.SagaID]*saga.SagaInstance
}

func NewInMemoryRepo() *InMemoryRepo {
	return &InMemoryRepo{
		instances: make(map[saga.SagaID]*saga.SagaInstance),
	}
}

func (r *InMemoryRepo) Save(_ context.Context, inst *saga.SagaInstance) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	copy := *inst
	r.instances[inst.ID] = &copy
	return nil
}

func (r *InMemoryRepo) FindByID(_ context.Context, id saga.SagaID) (*saga.SagaInstance, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if inst, ok := r.instances[id]; ok {
		copy := *inst
		return &copy, nil
	}
	return nil, errors.New("not found")
}

func (r *InMemoryRepo) FindByStatus(_ context.Context, status saga.SagaStatus, _ int) ([]*saga.SagaInstance, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var result []*saga.SagaInstance
	for _, inst := range r.instances {
		if inst.Status == status {
			copy := *inst
			result = append(result, &copy)
		}
	}
	return result, nil
}

func (r *InMemoryRepo) UpdateStatus(_ context.Context, id saga.SagaID, status saga.SagaStatus) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if inst, ok := r.instances[id]; ok {
		inst.Status = status
	}
	return nil
}

func (r *InMemoryRepo) UpdateStep(_ context.Context, id saga.SagaID, name string, status saga.StepStatus, _ any) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if inst, ok := r.instances[id]; ok {
		inst.StepStatuses[name] = status
	}
	return nil
}

func TestOrchestratorSuccess(t *testing.T) {
	step1 := &MockStep{name: "step1"}
	step2 := &MockStep{name: "step2"}
	step3 := &MockStep{name: "step3"}

	repo := NewInMemoryRepo()
	orch := saga.NewOrchestrator(
		[]saga.Step{step1, step2, step3},
		repo,
		slog.Default(),
	)

	sagaCtx := &saga.SagaContext{
		SagaID:      "test-saga-1",
		Payload:     map[string]any{"order_id": "ORD-001"},
		StepResults: make(map[string]any),
		CreatedAt:   time.Now(),
	}

	if err := orch.Execute(context.Background(), sagaCtx); err != nil {
		t.Fatalf("expected success, got: %v", err)
	}

	// All steps executed, none compensated
	if step1.executeCalls != 1 { t.Errorf("step1 execute: want 1, got %d", step1.executeCalls) }
	if step2.executeCalls != 1 { t.Errorf("step2 execute: want 1, got %d", step2.executeCalls) }
	if step3.executeCalls != 1 { t.Errorf("step3 execute: want 1, got %d", step3.executeCalls) }
	if step1.compensateCalls != 0 { t.Errorf("step1 compensate: want 0, got %d", step1.compensateCalls) }

	// Verify saga completed
	inst, _ := repo.FindByID(context.Background(), "test-saga-1")
	if inst.Status != saga.SagaStatusCompleted {
		t.Errorf("expected COMPLETED, got %s", inst.Status)
	}
}

func TestOrchestratorCompensatesOnFailure(t *testing.T) {
	step1 := &MockStep{name: "step1"}
	step2 := &MockStep{name: "step2"}
	step3 := &MockStep{name: "step3", executeErr: errors.New("step3 failed")}

	repo := NewInMemoryRepo()
	orch := saga.NewOrchestrator(
		[]saga.Step{step1, step2, step3},
		repo,
		slog.Default(),
	)

	sagaCtx := &saga.SagaContext{
		SagaID:      "test-saga-2",
		Payload:     map[string]any{},
		StepResults: make(map[string]any),
		CreatedAt:   time.Now(),
	}

	err := orch.Execute(context.Background(), sagaCtx)
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	// step3 failed — step1 and step2 should be compensated
	if step1.compensateCalls != 1 { t.Errorf("step1 compensate: want 1, got %d", step1.compensateCalls) }
	if step2.compensateCalls != 1 { t.Errorf("step2 compensate: want 1, got %d", step2.compensateCalls) }
	if step3.compensateCalls != 0 { t.Errorf("step3 compensate: want 0 (never succeeded), got %d", step3.compensateCalls) }

	// Verify saga rolled back
	inst, _ := repo.FindByID(context.Background(), "test-saga-2")
	if inst.Status != saga.SagaStatusRolledBack {
		t.Errorf("expected ROLLED_BACK, got %s", inst.Status)
	}
}
```

## Section 11: Observability and Metrics

```go
// saga/metrics.go
package saga

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	sagaExecutionsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "saga_executions_total",
		Help: "Total number of saga executions by definition and outcome",
	}, []string{"definition", "outcome"})

	sagaExecutionDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "saga_execution_duration_seconds",
		Help:    "Duration of saga executions",
		Buckets: prometheus.ExponentialBuckets(0.001, 2, 15),
	}, []string{"definition", "outcome"})

	sagaStepDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "saga_step_duration_seconds",
		Help:    "Duration of individual saga steps",
		Buckets: prometheus.ExponentialBuckets(0.001, 2, 12),
	}, []string{"definition", "step", "outcome"})

	sagaCompensationsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "saga_compensations_total",
		Help: "Total number of saga compensations triggered",
	}, []string{"definition", "step"})

	sagaActiveGauge = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "saga_active",
		Help: "Number of currently running saga instances",
	}, []string{"definition"})
)
```

## Section 12: Production Deployment Checklist

```
Saga Production Checklist:

Database:
  [ ] outbox_messages table with proper index on (processed, created_at)
  [ ] saga_instances table with index on status and updated_at
  [ ] idempotency_records table with TTL-based cleanup job
  [ ] Database-level transactions for saga state + outbox writes

Reliability:
  [ ] Outbox relay running with at-least-once delivery guarantee
  [ ] Recovery worker scanning for stuck sagas every 30s
  [ ] Idempotency keys on all external service calls
  [ ] Retry with exponential backoff for transient failures
  [ ] Circuit breaker on all service clients

Observability:
  [ ] Prometheus metrics: saga_executions_total, saga_step_duration_seconds
  [ ] Alerting on stuck saga rate (sagas in RUNNING > 5min)
  [ ] Alerting on compensation rate (high rate = systemic failure)
  [ ] Distributed trace IDs propagated through saga context
  [ ] Log saga_id and step_name on every log line

Testing:
  [ ] Unit test each step's Execute and Compensate independently
  [ ] Integration test for full saga happy path
  [ ] Chaos test: kill process mid-saga, verify recovery
  [ ] Idempotency test: replay same events, verify no duplicates
  [ ] Compensation test: inject failure at each step position
```
