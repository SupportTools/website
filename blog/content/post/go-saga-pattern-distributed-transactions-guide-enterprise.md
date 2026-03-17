---
title: "Saga Pattern in Go: Choreography vs Orchestration for Distributed Transactions"
date: 2028-11-14T00:00:00-05:00
draft: false
tags: ["Go", "Distributed Systems", "Saga Pattern", "Microservices", "Architecture"]
categories:
- Go
- Distributed Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to the saga pattern in Go covering two-phase commit limitations, choreography vs orchestration trade-offs, compensating transactions, idempotency keys, state machine implementation, Temporal workflows for durable sagas, and chaos testing."
more_link: "yes"
url: "/go-saga-pattern-distributed-transactions-guide-enterprise/"
---

Distributed transactions are one of the hardest problems in microservices architecture. Two-phase commit (2PC) provides ACID guarantees but requires all participants to be available simultaneously and creates blocking locks that kill performance under load. The saga pattern offers an alternative: a sequence of local transactions, each publishing events that trigger the next step, with compensating transactions to undo completed steps when a later step fails. This guide shows how to implement both saga styles in production Go code.

<!--more-->

# Saga Pattern in Go: Choreography vs Orchestration for Distributed Transactions

## Why Two-Phase Commit Fails at Scale

2PC requires a coordinator that locks resources across all participants during the prepare phase. Under network partitions or participant failures, resources stay locked indefinitely — blocking all other transactions that touch those resources.

```
2PC coordinator state machine:
  1. PREPARE → send "prepare" to all participants
  2. All respond YES → send "commit" to all (if any says NO, send "abort")
  3. Wait for all ACKs

Problems:
- Coordinator failure between phases = indefinite lock
- Participant failure after PREPARE = coordinator blocks waiting
- Network partition = coordinator cannot determine participant state
- Blocking locks = lower throughput, higher latency
- All participants must be available simultaneously
```

In a microservices system with 10+ services, the probability that all 10 are simultaneously available for a 2PC round trip is (availability)^10. At 99.9% each, that's 99.0% for the combined transaction — worse than any single service.

## The Saga Alternative

A saga replaces one distributed ACID transaction with a sequence of local transactions:

```
Order Saga:
  T1: Create order (Order Service)      → undo: Cancel order
  T2: Reserve inventory (Inventory Svc) → undo: Release reservation
  T3: Charge payment (Payment Service)  → undo: Issue refund
  T4: Schedule delivery (Delivery Svc)  → undo: Cancel delivery

If T3 (payment) fails:
  Run C2: Release inventory reservation
  Run C1: Cancel order
```

The compensating transactions (C1, C2) must be:
- **Idempotent**: safe to run multiple times
- **Retryable**: will eventually succeed (or the saga coordinator retries)
- **Semantically reversible**: undo the business effect, even if not strictly transactional

## Saga Choreography: Event-Driven, No Central Coordinator

In choreography, each service listens for events and reacts by performing its local transaction and publishing the next event.

```
OrderCreated ──► InventoryService ──► InventoryReserved ──► PaymentService
                                                         │
                                                         ▼
                                              PaymentFailed ──► InventoryService
                                                                (releases reservation)
                                                                ──► OrderService
                                                                    (cancels order)
```

### Event Definitions

```go
// events/events.go
package events

import "time"

type OrderCreated struct {
	OrderID    string    `json:"order_id"`
	CustomerID string    `json:"customer_id"`
	Items      []Item    `json:"items"`
	TotalCents int64     `json:"total_cents"`
	CreatedAt  time.Time `json:"created_at"`
}

type InventoryReserved struct {
	OrderID       string    `json:"order_id"`
	ReservationID string    `json:"reservation_id"`
	ReservedAt    time.Time `json:"reserved_at"`
}

type InventoryReservationFailed struct {
	OrderID string `json:"order_id"`
	Reason  string `json:"reason"`
}

type PaymentCharged struct {
	OrderID       string    `json:"order_id"`
	ChargeID      string    `json:"charge_id"`
	AmountCents   int64     `json:"amount_cents"`
	ChargedAt     time.Time `json:"charged_at"`
}

type PaymentFailed struct {
	OrderID string `json:"order_id"`
	Reason  string `json:"reason"`
}

type Item struct {
	ProductID string `json:"product_id"`
	Quantity  int    `json:"quantity"`
}
```

### Inventory Service: Choreography Participant

```go
// inventory/service.go
package inventory

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/myorg/events"
	"github.com/segmentio/kafka-go"
)

type Service struct {
	db     DB
	writer *kafka.Writer
	reader *kafka.Reader
}

func (s *Service) Start(ctx context.Context) error {
	for {
		msg, err := s.reader.ReadMessage(ctx)
		if err != nil {
			return fmt.Errorf("read message: %w", err)
		}

		switch string(msg.Key) {
		case "OrderCreated":
			var event events.OrderCreated
			if err := json.Unmarshal(msg.Value, &event); err != nil {
				log.Printf("unmarshal OrderCreated: %v", err)
				continue
			}
			s.handleOrderCreated(ctx, event)

		case "PaymentFailed":
			var event events.PaymentFailed
			if err := json.Unmarshal(msg.Value, &event); err != nil {
				log.Printf("unmarshal PaymentFailed: %v", err)
				continue
			}
			s.handlePaymentFailed(ctx, event)
		}
	}
}

func (s *Service) handleOrderCreated(ctx context.Context, event events.OrderCreated) {
	// Idempotency: check if we already processed this order
	if s.db.ReservationExists(ctx, event.OrderID) {
		log.Printf("reservation for order %s already exists, skipping", event.OrderID)
		return
	}

	reservationID, err := s.db.ReserveItems(ctx, event.OrderID, event.Items)
	if err != nil {
		// Publish failure event so other services can compensate
		s.publish(ctx, "InventoryReservationFailed", events.InventoryReservationFailed{
			OrderID: event.OrderID,
			Reason:  err.Error(),
		})
		return
	}

	s.publish(ctx, "InventoryReserved", events.InventoryReserved{
		OrderID:       event.OrderID,
		ReservationID: reservationID,
	})
}

func (s *Service) handlePaymentFailed(ctx context.Context, event events.PaymentFailed) {
	// Compensating transaction: release the reservation
	if err := s.db.ReleaseReservation(ctx, event.OrderID); err != nil {
		// Log and retry — this MUST eventually succeed
		log.Printf("CRITICAL: failed to release reservation for order %s: %v",
			event.OrderID, err)
		// In production: dead-letter queue + manual intervention alert
		return
	}

	log.Printf("Released reservation for order %s due to payment failure", event.OrderID)
}

func (s *Service) publish(ctx context.Context, key string, value interface{}) {
	data, _ := json.Marshal(value)
	err := s.writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(key),
		Value: data,
	})
	if err != nil {
		// In production: implement retry with backoff
		log.Printf("failed to publish %s: %v", key, err)
	}
}
```

### Choreography Drawbacks

- Difficult to track overall saga state (which step are we on?)
- Business logic scattered across services
- Hard to add a new step without touching multiple services
- Cyclic event dependencies can cause hard-to-debug loops

## Saga Orchestration: Central State Machine

In orchestration, a central saga orchestrator tells each service what to do and tracks the overall transaction state:

```
SagaOrchestrator
    │
    ├──► InventoryService.Reserve(orderID)
    │    └── OK → next step
    │
    ├──► PaymentService.Charge(orderID, amount)
    │    └── FAIL → compensate
    │        ├──► InventoryService.Release(orderID)
    │        └──► OrderService.Cancel(orderID)
    │
    └──► DeliveryService.Schedule(orderID)
         └── OK → saga complete
```

### Saga State Machine in Go

```go
// saga/orchestrator.go
package saga

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"time"
)

type SagaState string

const (
	SagaStateStarted              SagaState = "started"
	SagaStateInventoryReserved    SagaState = "inventory_reserved"
	SagaStatePaymentCharged       SagaState = "payment_charged"
	SagaStateDeliveryScheduled    SagaState = "delivery_scheduled"
	SagaStateCompleted            SagaState = "completed"
	SagaStateCompensatingPayment  SagaState = "compensating_payment"
	SagaStateCompensatingInventory SagaState = "compensating_inventory"
	SagaStateCompensatingOrder    SagaState = "compensating_order"
	SagaStateFailed               SagaState = "failed"
)

type SagaRecord struct {
	SagaID      string            `json:"saga_id"`
	OrderID     string            `json:"order_id"`
	State       SagaState         `json:"state"`
	Data        map[string]string `json:"data"` // stores IDs from each step
	CreatedAt   time.Time         `json:"created_at"`
	UpdatedAt   time.Time         `json:"updated_at"`
	CompletedAt *time.Time        `json:"completed_at,omitempty"`
	FailedAt    *time.Time        `json:"failed_at,omitempty"`
	FailReason  string            `json:"fail_reason,omitempty"`
}

type OrderData struct {
	CustomerID  string
	Items       []Item
	TotalCents  int64
}

type Orchestrator struct {
	db          *sql.DB
	inventory   InventoryClient
	payment     PaymentClient
	delivery    DeliveryClient
	orderSvc    OrderClient
}

func (o *Orchestrator) ExecuteOrderSaga(ctx context.Context, orderID string, data OrderData) error {
	// Create saga record with idempotency key
	sagaID := fmt.Sprintf("order-saga-%s", orderID)

	saga, err := o.getOrCreateSaga(ctx, sagaID, orderID)
	if err != nil {
		return fmt.Errorf("get or create saga: %w", err)
	}

	// Resume from current state (handles retries)
	return o.advance(ctx, saga, data)
}

func (o *Orchestrator) advance(ctx context.Context, saga *SagaRecord, data OrderData) error {
	for {
		switch saga.State {
		case SagaStateStarted:
			log.Printf("[saga:%s] Reserving inventory for order %s", saga.SagaID, saga.OrderID)
			reservationID, err := o.inventory.Reserve(ctx, saga.OrderID, data.Items)
			if err != nil {
				return o.beginCompensation(ctx, saga, fmt.Sprintf("inventory reservation failed: %v", err))
			}
			saga.Data["reservation_id"] = reservationID
			saga.State = SagaStateInventoryReserved
			if err := o.updateSaga(ctx, saga); err != nil {
				return err
			}

		case SagaStateInventoryReserved:
			log.Printf("[saga:%s] Charging payment for order %s", saga.SagaID, saga.OrderID)
			chargeID, err := o.payment.Charge(ctx, saga.OrderID, data.CustomerID, data.TotalCents)
			if err != nil {
				return o.beginCompensation(ctx, saga, fmt.Sprintf("payment failed: %v", err))
			}
			saga.Data["charge_id"] = chargeID
			saga.State = SagaStatePaymentCharged
			if err := o.updateSaga(ctx, saga); err != nil {
				return err
			}

		case SagaStatePaymentCharged:
			log.Printf("[saga:%s] Scheduling delivery for order %s", saga.SagaID, saga.OrderID)
			deliveryID, err := o.delivery.Schedule(ctx, saga.OrderID)
			if err != nil {
				// Delivery failure: refund payment and release inventory
				return o.beginCompensation(ctx, saga, fmt.Sprintf("delivery scheduling failed: %v", err))
			}
			saga.Data["delivery_id"] = deliveryID
			saga.State = SagaStateDeliveryScheduled
			if err := o.updateSaga(ctx, saga); err != nil {
				return err
			}

		case SagaStateDeliveryScheduled:
			now := time.Now()
			saga.State = SagaStateCompleted
			saga.CompletedAt = &now
			return o.updateSaga(ctx, saga)

		case SagaStateCompleted:
			log.Printf("[saga:%s] Already completed", saga.SagaID)
			return nil

		case SagaStateFailed:
			return fmt.Errorf("saga %s failed: %s", saga.SagaID, saga.FailReason)

		// Compensation states
		case SagaStateCompensatingPayment:
			log.Printf("[saga:%s] Refunding payment %s", saga.SagaID, saga.Data["charge_id"])
			if chargeID, ok := saga.Data["charge_id"]; ok {
				if err := o.payment.Refund(ctx, chargeID); err != nil {
					// Retry compensation — it MUST eventually succeed
					log.Printf("[saga:%s] CRITICAL: refund failed, will retry: %v", saga.SagaID, err)
					return fmt.Errorf("refund failed (will retry): %w", err)
				}
			}
			saga.State = SagaStateCompensatingInventory
			if err := o.updateSaga(ctx, saga); err != nil {
				return err
			}

		case SagaStateCompensatingInventory:
			log.Printf("[saga:%s] Releasing reservation %s", saga.SagaID, saga.Data["reservation_id"])
			if reservationID, ok := saga.Data["reservation_id"]; ok {
				if err := o.inventory.Release(ctx, reservationID); err != nil {
					log.Printf("[saga:%s] CRITICAL: inventory release failed, will retry: %v", saga.SagaID, err)
					return fmt.Errorf("inventory release failed (will retry): %w", err)
				}
			}
			saga.State = SagaStateCompensatingOrder
			if err := o.updateSaga(ctx, saga); err != nil {
				return err
			}

		case SagaStateCompensatingOrder:
			log.Printf("[saga:%s] Cancelling order %s", saga.SagaID, saga.OrderID)
			if err := o.orderSvc.Cancel(ctx, saga.OrderID, saga.FailReason); err != nil {
				log.Printf("[saga:%s] CRITICAL: order cancel failed, will retry: %v", saga.SagaID, err)
				return fmt.Errorf("order cancel failed (will retry): %w", err)
			}
			now := time.Now()
			saga.State = SagaStateFailed
			saga.FailedAt = &now
			return o.updateSaga(ctx, saga)
		}
	}
}

func (o *Orchestrator) beginCompensation(ctx context.Context, saga *SagaRecord, reason string) error {
	saga.FailReason = reason
	log.Printf("[saga:%s] Starting compensation: %s", saga.SagaID, reason)

	// Determine where to start compensation based on current state
	switch saga.State {
	case SagaStatePaymentCharged, SagaStateDeliveryScheduled:
		saga.State = SagaStateCompensatingPayment
	case SagaStateInventoryReserved:
		saga.State = SagaStateCompensatingInventory
	default:
		saga.State = SagaStateCompensatingOrder
	}

	if err := o.updateSaga(ctx, saga); err != nil {
		return err
	}
	return o.advance(ctx, saga, OrderData{})
}

func (o *Orchestrator) getOrCreateSaga(ctx context.Context, sagaID, orderID string) (*SagaRecord, error) {
	var record SagaRecord
	err := o.db.QueryRowContext(ctx,
		"SELECT saga_id, order_id, state, data, created_at, updated_at FROM sagas WHERE saga_id = $1",
		sagaID,
	).Scan(&record.SagaID, &record.OrderID, &record.State, (*jsonColumn)(&record.Data),
		&record.CreatedAt, &record.UpdatedAt)

	if err == sql.ErrNoRows {
		record = SagaRecord{
			SagaID:    sagaID,
			OrderID:   orderID,
			State:     SagaStateStarted,
			Data:      make(map[string]string),
			CreatedAt: time.Now(),
			UpdatedAt: time.Now(),
		}
		data, _ := json.Marshal(record.Data)
		_, err = o.db.ExecContext(ctx,
			"INSERT INTO sagas (saga_id, order_id, state, data, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6)",
			record.SagaID, record.OrderID, record.State, data, record.CreatedAt, record.UpdatedAt,
		)
		return &record, err
	}
	return &record, err
}

func (o *Orchestrator) updateSaga(ctx context.Context, saga *SagaRecord) error {
	saga.UpdatedAt = time.Now()
	data, _ := json.Marshal(saga.Data)
	_, err := o.db.ExecContext(ctx,
		`UPDATE sagas SET state=$1, data=$2, updated_at=$3,
		 completed_at=$4, failed_at=$5, fail_reason=$6
		 WHERE saga_id=$7`,
		saga.State, data, saga.UpdatedAt,
		saga.CompletedAt, saga.FailedAt, saga.FailReason,
		saga.SagaID,
	)
	return err
}
```

### Schema for Saga State Persistence

```sql
CREATE TABLE sagas (
    saga_id      text PRIMARY KEY,
    order_id     text NOT NULL,
    state        text NOT NULL,
    data         jsonb NOT NULL DEFAULT '{}',
    created_at   timestamptz NOT NULL,
    updated_at   timestamptz NOT NULL,
    completed_at timestamptz,
    failed_at    timestamptz,
    fail_reason  text
);

CREATE INDEX idx_sagas_order_id ON sagas (order_id);
CREATE INDEX idx_sagas_state ON sagas (state) WHERE state NOT IN ('completed', 'failed');
```

## Idempotency Keys for Safe Retries

Every participant must be idempotent. If the orchestrator retries a step, the participant must detect the duplicate and return the same result:

```go
// payment/service.go
package payment

import (
	"context"
	"database/sql"
	"fmt"
)

type Service struct {
	db       *sql.DB
	gateway  PaymentGateway
}

// Charge is idempotent: calling it twice with the same orderID returns the same chargeID
func (s *Service) Charge(ctx context.Context, orderID, customerID string, amountCents int64) (string, error) {
	// Check if we already charged for this order
	var chargeID string
	err := s.db.QueryRowContext(ctx,
		"SELECT charge_id FROM charges WHERE order_id = $1 AND status = 'succeeded'",
		orderID,
	).Scan(&chargeID)

	if err == nil {
		// Already charged — return existing charge ID
		return chargeID, nil
	}
	if err != sql.ErrNoRows {
		return "", fmt.Errorf("check existing charge: %w", err)
	}

	// Not yet charged — attempt charge with idempotency key
	chargeID, err = s.gateway.Charge(ctx, PaymentRequest{
		IdempotencyKey: fmt.Sprintf("order-%s", orderID),
		CustomerID:     customerID,
		AmountCents:    amountCents,
		Currency:       "USD",
	})
	if err != nil {
		return "", fmt.Errorf("payment gateway charge: %w", err)
	}

	// Record the charge
	_, err = s.db.ExecContext(ctx,
		"INSERT INTO charges (order_id, charge_id, amount_cents, status) VALUES ($1, $2, $3, 'succeeded')",
		orderID, chargeID, amountCents,
	)
	if err != nil {
		// Charge succeeded but DB write failed — this is safe because
		// we'll find the charge via the idempotency key on next call
		return chargeID, nil
	}

	return chargeID, nil
}
```

## Temporal Workflows for Durable Sagas

Temporal provides durable execution: if the worker crashes mid-saga, Temporal replays the workflow history to resume from the exact point it stopped. This eliminates the need to manually persist saga state.

```go
// temporal/order_saga_workflow.go
package temporal

import (
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

type OrderSagaInput struct {
	OrderID    string
	CustomerID string
	Items      []Item
	TotalCents int64
}

func OrderSagaWorkflow(ctx workflow.Context, input OrderSagaInput) error {
	// Configure activity options: retries, timeouts
	activityOpts := workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			MaxAttempts:        5,
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaxInterval:        30 * time.Second,
			// Do not retry business failures (e.g., insufficient stock)
			NonRetryableErrorTypes: []string{"InsufficientStockError", "PaymentDeclinedError"},
		},
	}
	ctx = workflow.WithActivityOptions(ctx, activityOpts)

	// Track what needs to be compensated
	var reservationID, chargeID string

	// Step 1: Reserve inventory
	err := workflow.ExecuteActivity(ctx, ReserveInventoryActivity, input.OrderID, input.Items).Get(ctx, &reservationID)
	if err != nil {
		// Nothing to compensate yet
		return workflow.ExecuteActivity(ctx, CancelOrderActivity, input.OrderID, err.Error()).Get(ctx, nil)
	}

	// Step 2: Charge payment
	err = workflow.ExecuteActivity(ctx, ChargePaymentActivity, input.OrderID, input.CustomerID, input.TotalCents).Get(ctx, &chargeID)
	if err != nil {
		// Compensate: release inventory
		_ = workflow.ExecuteActivity(ctx, ReleaseInventoryActivity, reservationID).Get(ctx, nil)
		return workflow.ExecuteActivity(ctx, CancelOrderActivity, input.OrderID, err.Error()).Get(ctx, nil)
	}

	// Step 3: Schedule delivery
	var deliveryID string
	err = workflow.ExecuteActivity(ctx, ScheduleDeliveryActivity, input.OrderID).Get(ctx, &deliveryID)
	if err != nil {
		// Compensate: refund payment and release inventory
		_ = workflow.ExecuteActivity(ctx, RefundPaymentActivity, chargeID).Get(ctx, nil)
		_ = workflow.ExecuteActivity(ctx, ReleaseInventoryActivity, reservationID).Get(ctx, nil)
		return workflow.ExecuteActivity(ctx, CancelOrderActivity, input.OrderID, err.Error()).Get(ctx, nil)
	}

	// All steps complete
	return workflow.ExecuteActivity(ctx, ConfirmOrderActivity, input.OrderID, deliveryID).Get(ctx, nil)
}

// Activity implementations
func ReserveInventoryActivity(ctx context.Context, orderID string, items []Item) (string, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Reserving inventory", "orderID", orderID)

	// Call inventory service
	client := getInventoryClient()
	return client.Reserve(ctx, orderID, items)
}

func ChargePaymentActivity(ctx context.Context, orderID, customerID string, amountCents int64) (string, error) {
	client := getPaymentClient()
	return client.Charge(ctx, orderID, customerID, amountCents)
}
```

Start and query a workflow:

```go
// worker/main.go
func main() {
	c, err := client.Dial(client.Options{
		HostPort: "temporal:7233",
	})
	if err != nil {
		log.Fatalf("temporal client: %v", err)
	}
	defer c.Close()

	w := worker.New(c, "order-saga-queue", worker.Options{})
	w.RegisterWorkflow(temporal.OrderSagaWorkflow)
	w.RegisterActivity(temporal.ReserveInventoryActivity)
	w.RegisterActivity(temporal.ChargePaymentActivity)
	w.RegisterActivity(temporal.ScheduleDeliveryActivity)
	w.RegisterActivity(temporal.RefundPaymentActivity)
	w.RegisterActivity(temporal.ReleaseInventoryActivity)
	w.RegisterActivity(temporal.CancelOrderActivity)
	w.RegisterActivity(temporal.ConfirmOrderActivity)

	if err := w.Run(worker.InterruptCh()); err != nil {
		log.Fatalf("worker: %v", err)
	}
}

// Trigger a saga
func triggerSaga(c client.Client, orderID string, data OrderData) error {
	we, err := c.ExecuteWorkflow(context.Background(),
		client.StartWorkflowOptions{
			ID:        fmt.Sprintf("order-saga-%s", orderID),
			TaskQueue: "order-saga-queue",
			// Prevent duplicate execution for same order
			WorkflowIDReusePolicy: enums.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
		},
		temporal.OrderSagaWorkflow,
		temporal.OrderSagaInput{
			OrderID:    data.OrderID,
			CustomerID: data.CustomerID,
			Items:      data.Items,
			TotalCents: data.TotalCents,
		},
	)
	if err != nil {
		return fmt.Errorf("start workflow: %w", err)
	}
	log.Printf("Started workflow ID: %s, Run ID: %s", we.GetID(), we.GetRunID())
	return nil
}
```

## Testing Distributed Transactions with Chaos Injection

```go
// saga_test.go
package saga_test

import (
	"context"
	"errors"
	"math/rand"
	"sync/atomic"
	"testing"
	"time"
)

// ChaosPaymentClient randomly fails to simulate network/service failures
type ChaosPaymentClient struct {
	real          PaymentClient
	failureRate   float64
	callCount     atomic.Int64
	failCallCount atomic.Int64
}

func (c *ChaosPaymentClient) Charge(ctx context.Context, orderID, customerID string, amountCents int64) (string, error) {
	c.callCount.Add(1)
	if rand.Float64() < c.failureRate {
		c.failCallCount.Add(1)
		return "", errors.New("simulated payment service failure")
	}
	return c.real.Charge(ctx, orderID, customerID, amountCents)
}

func TestSagaCompensationOnPaymentFailure(t *testing.T) {
	db := setupTestDB(t)

	inventoryClient := &RecordingInventoryClient{}
	paymentClient := &ChaosPaymentClient{
		real:        &MockPaymentClient{},
		failureRate: 1.0, // Always fail
	}
	deliveryClient := &MockDeliveryClient{}
	orderClient := &RecordingOrderClient{}

	orchestrator := &Orchestrator{
		db:        db,
		inventory: inventoryClient,
		payment:   paymentClient,
		delivery:  deliveryClient,
		orderSvc:  orderClient,
	}

	ctx := context.Background()
	err := orchestrator.ExecuteOrderSaga(ctx, "test-order-001", OrderData{
		CustomerID: "cust-001",
		Items:      []Item{{ProductID: "prod-001", Quantity: 2}},
		TotalCents: 9999,
	})

	// Saga should fail (payment always fails)
	if err == nil {
		t.Fatal("expected saga to fail, but it succeeded")
	}

	// Compensation must have run
	if !inventoryClient.ReleaseWasCalled("test-order-001") {
		t.Error("inventory release was not called during compensation")
	}
	if !orderClient.CancelWasCalled("test-order-001") {
		t.Error("order cancel was not called during compensation")
	}

	// Saga state must be 'failed' in DB
	var state string
	db.QueryRowContext(ctx,
		"SELECT state FROM sagas WHERE order_id = $1",
		"test-order-001",
	).Scan(&state)
	if state != string(SagaStateFailed) {
		t.Errorf("expected saga state 'failed', got '%s'", state)
	}
}

func TestSagaIdempotency(t *testing.T) {
	db := setupTestDB(t)
	inventoryClient := &MockInventoryClient{}
	paymentClient := &MockPaymentClient{}
	deliveryClient := &MockDeliveryClient{}
	orderClient := &MockOrderClient{}

	orchestrator := &Orchestrator{
		db:        db,
		inventory: inventoryClient,
		payment:   paymentClient,
		delivery:  deliveryClient,
		orderSvc:  orderClient,
	}

	ctx := context.Background()
	data := OrderData{
		CustomerID: "cust-001",
		Items:      []Item{{ProductID: "prod-001", Quantity: 1}},
		TotalCents: 4999,
	}

	// Execute saga twice with same order ID
	if err := orchestrator.ExecuteOrderSaga(ctx, "test-order-002", data); err != nil {
		t.Fatalf("first execution failed: %v", err)
	}
	if err := orchestrator.ExecuteOrderSaga(ctx, "test-order-002", data); err != nil {
		t.Fatalf("second execution failed: %v", err)
	}

	// Each step should have been called exactly once
	if inventoryClient.ReserveCallCount("test-order-002") != 1 {
		t.Errorf("inventory reserve called %d times, expected 1",
			inventoryClient.ReserveCallCount("test-order-002"))
	}
	if paymentClient.ChargeCallCount("test-order-002") != 1 {
		t.Errorf("payment charge called %d times, expected 1",
			paymentClient.ChargeCallCount("test-order-002"))
	}
}
```

## Choreography vs Orchestration: When to Choose Each

| Factor | Choreography | Orchestration |
|---|---|---|
| Number of services | 2-3 | 4+ |
| Business logic visibility | Scattered | Centralized |
| Adding a new step | Change multiple services | Change orchestrator only |
| Debugging failed sagas | Hard (follow events) | Easy (check saga record) |
| Coupling between services | Low (via events) | Medium (orchestrator depends on all) |
| Infrastructure | Message bus required | DB required (+ optional Temporal) |
| Compensating transaction coordination | Each service must know what to undo | Orchestrator knows the full undo sequence |

## Summary

The saga pattern solves distributed transactions at the cost of eventual consistency. Choreography works well for simple, stable workflows where services are owned by separate teams and coupling must be minimized. Orchestration is better for complex workflows with many steps where observability and debugging matter, or where the compensation sequence is non-trivial.

Critical implementation rules regardless of style: all participants must be idempotent (use idempotency keys), all compensating transactions must be retryable until they succeed, and the saga coordinator's state must survive crashes (either in a database or via a durable execution engine like Temporal). Skipping any of these properties means your saga will produce incorrect state under failure conditions.
