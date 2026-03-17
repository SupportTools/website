---
title: "Go Saga Pattern Implementation: Distributed Transactions Without Two-Phase Commit"
date: 2028-05-11T00:00:00-05:00
draft: false
tags: ["Go", "Saga Pattern", "Distributed Systems", "Microservices", "Transactions"]
categories: ["Go", "Distributed Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing the Saga pattern in Go for distributed transactions across microservices, covering choreography-based sagas with Kafka, orchestration-based sagas with a saga orchestrator, and compensating transaction design."
more_link: "yes"
url: "/go-saga-pattern-distributed-transactions-guide/"
---

Distributed transactions are one of the hardest problems in microservices architecture. Two-phase commit (2PC) solves the problem in theory but creates coupling, reduces availability, and scales poorly. The Saga pattern provides a practical alternative: break the distributed transaction into a sequence of local transactions, each publishing an event or message. If any step fails, compensating transactions undo the completed steps. This guide covers both choreography-based and orchestration-based Saga implementations in Go with full production error handling.

<!--more-->

# Go Saga Pattern Implementation: Distributed Transactions Without Two-Phase Commit

## The Distributed Transaction Problem

Consider an e-commerce order placement flow:
1. Reserve inventory (Inventory Service)
2. Charge customer payment (Payment Service)
3. Create shipment (Shipping Service)
4. Send confirmation email (Notification Service)

With a monolith, a single database transaction handles all of this atomically. With microservices, each service has its own database. If payment succeeds but shipment creation fails, you need to refund the payment and release the inventory. Without distributed transactions, you need compensating logic.

Two-phase commit (2PC) solves this but requires a distributed coordinator that becomes a bottleneck and single point of failure. More critically, 2PC requires all participants to hold locks during the protocol, preventing availability during failures.

The Saga pattern decomposes the distributed transaction into steps, each with a compensating action for rollback:

```
Forward: Reserve → Charge → Create Shipment → Send Email
Compensating: Release Reservation ← Refund ← Cancel Shipment ← (email sent, no compensation)
```

## Choreography-Based Sagas

In choreography, each service listens for events and decides what to do next. There is no central coordinator.

### Architecture

```
OrderService → publishes OrderCreated
  InventoryService subscribes → reserves inventory → publishes InventoryReserved
    PaymentService subscribes → charges payment → publishes PaymentCharged
      ShippingService subscribes → creates shipment → publishes ShipmentCreated
        NotificationService subscribes → sends email → publishes OrderConfirmed

On failure:
PaymentService publishes PaymentFailed
  InventoryService subscribes to PaymentFailed → releases reservation → publishes InventoryReleased
    OrderService subscribes to InventoryReleased → marks order as failed
```

### Event Definitions

```go
package events

import "time"

// Base event
type Event struct {
	ID          string    `json:"id"`
	Type        string    `json:"type"`
	CorrelationID string  `json:"correlation_id"` // Saga instance ID
	OccurredAt  time.Time `json:"occurred_at"`
	Version     int       `json:"version"`
}

// Order events
type OrderCreated struct {
	Event
	OrderID    string     `json:"order_id"`
	CustomerID string     `json:"customer_id"`
	Items      []OrderItem `json:"items"`
	TotalAmount Money      `json:"total_amount"`
}

type OrderFailed struct {
	Event
	OrderID string `json:"order_id"`
	Reason  string `json:"reason"`
}

// Inventory events
type InventoryReserved struct {
	Event
	OrderID     string `json:"order_id"`
	ReservationID string `json:"reservation_id"`
}

type InventoryReservationFailed struct {
	Event
	OrderID string `json:"order_id"`
	Reason  string `json:"reason"`
}

type InventoryReleased struct {
	Event
	OrderID      string `json:"order_id"`
	ReservationID string `json:"reservation_id"`
}

// Payment events
type PaymentCharged struct {
	Event
	OrderID       string `json:"order_id"`
	TransactionID string `json:"transaction_id"`
	Amount        Money  `json:"amount"`
}

type PaymentFailed struct {
	Event
	OrderID string `json:"order_id"`
	Reason  string `json:"reason"`
}

type PaymentRefunded struct {
	Event
	OrderID       string `json:"order_id"`
	TransactionID string `json:"transaction_id"`
}

// Shipping events
type ShipmentCreated struct {
	Event
	OrderID    string `json:"order_id"`
	ShipmentID string `json:"shipment_id"`
	TrackingNo string `json:"tracking_no"`
}

type ShipmentCreationFailed struct {
	Event
	OrderID string `json:"order_id"`
	Reason  string `json:"reason"`
}

type ShipmentCancelled struct {
	Event
	OrderID    string `json:"order_id"`
	ShipmentID string `json:"shipment_id"`
}

// Supporting types
type OrderItem struct {
	ProductID string `json:"product_id"`
	Quantity  int    `json:"quantity"`
	UnitPrice Money  `json:"unit_price"`
}

type Money struct {
	Amount   int64  `json:"amount"`   // In cents
	Currency string `json:"currency"`
}
```

### Inventory Service (Choreography Consumer/Producer)

```go
package inventory

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/acme/platform/events"
	"github.com/acme/platform/messaging"
)

type InventoryService struct {
	db        *sql.DB
	publisher messaging.Publisher
}

// HandleOrderCreated reserves inventory when an order is created
func (s *InventoryService) HandleOrderCreated(ctx context.Context, event events.OrderCreated) error {
	slog.Info("handling OrderCreated",
		"order_id", event.OrderID,
		"correlation_id", event.CorrelationID,
	)

	// Reserve inventory in a local transaction
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	defer tx.Rollback()

	reservationID, err := s.reserveItems(ctx, tx, event.OrderID, event.Items)
	if err != nil {
		// Publish failure event — triggers compensation in upstream services
		return s.publisher.Publish(ctx, "inventory-events", events.InventoryReservationFailed{
			Event: events.Event{
				ID:            generateID(),
				Type:          "InventoryReservationFailed",
				CorrelationID: event.CorrelationID,
			},
			OrderID: event.OrderID,
			Reason:  err.Error(),
		})
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing reservation: %w", err)
	}

	// Publish success event
	return s.publisher.Publish(ctx, "inventory-events", events.InventoryReserved{
		Event: events.Event{
			ID:            generateID(),
			Type:          "InventoryReserved",
			CorrelationID: event.CorrelationID,
		},
		OrderID:       event.OrderID,
		ReservationID: reservationID,
	})
}

// HandlePaymentFailed releases inventory when payment fails (compensation)
func (s *InventoryService) HandlePaymentFailed(ctx context.Context, event events.PaymentFailed) error {
	slog.Info("compensating: releasing inventory due to payment failure",
		"order_id", event.OrderID,
		"correlation_id", event.CorrelationID,
	)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	defer tx.Rollback()

	reservationID, err := s.releaseReservation(ctx, tx, event.OrderID)
	if err != nil {
		return fmt.Errorf("releasing reservation for order %s: %w", event.OrderID, err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing reservation release: %w", err)
	}

	return s.publisher.Publish(ctx, "inventory-events", events.InventoryReleased{
		Event: events.Event{
			ID:            generateID(),
			Type:          "InventoryReleased",
			CorrelationID: event.CorrelationID,
		},
		OrderID:       event.OrderID,
		ReservationID: reservationID,
	})
}

func (s *InventoryService) reserveItems(
	ctx context.Context,
	tx *sql.Tx,
	orderID string,
	items []events.OrderItem,
) (string, error) {
	reservationID := generateID()

	for _, item := range items {
		var available int
		err := tx.QueryRowContext(ctx,
			"SELECT quantity FROM inventory WHERE product_id = $1 FOR UPDATE",
			item.ProductID,
		).Scan(&available)
		if err != nil {
			return "", fmt.Errorf("querying inventory for %s: %w", item.ProductID, err)
		}

		if available < item.Quantity {
			return "", fmt.Errorf("insufficient inventory for %s: have %d, need %d",
				item.ProductID, available, item.Quantity)
		}

		_, err = tx.ExecContext(ctx,
			"UPDATE inventory SET quantity = quantity - $1 WHERE product_id = $2",
			item.Quantity, item.ProductID,
		)
		if err != nil {
			return "", fmt.Errorf("updating inventory for %s: %w", item.ProductID, err)
		}
	}

	// Record the reservation for compensating transaction
	_, err := tx.ExecContext(ctx,
		`INSERT INTO reservations (id, order_id, items, created_at)
		 VALUES ($1, $2, $3, NOW())`,
		reservationID, orderID, marshalItems(items),
	)
	if err != nil {
		return "", fmt.Errorf("recording reservation: %w", err)
	}

	return reservationID, nil
}

func (s *InventoryService) releaseReservation(ctx context.Context, tx *sql.Tx, orderID string) (string, error) {
	var reservationID string
	var itemsJSON []byte

	err := tx.QueryRowContext(ctx,
		"SELECT id, items FROM reservations WHERE order_id = $1 AND released_at IS NULL",
		orderID,
	).Scan(&reservationID, &itemsJSON)
	if err == sql.ErrNoRows {
		slog.Warn("no reservation found for order", "order_id", orderID)
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("finding reservation: %w", err)
	}

	var items []events.OrderItem
	if err := json.Unmarshal(itemsJSON, &items); err != nil {
		return "", fmt.Errorf("parsing reservation items: %w", err)
	}

	// Restore inventory
	for _, item := range items {
		_, err = tx.ExecContext(ctx,
			"UPDATE inventory SET quantity = quantity + $1 WHERE product_id = $2",
			item.Quantity, item.ProductID,
		)
		if err != nil {
			return "", fmt.Errorf("restoring inventory for %s: %w", item.ProductID, err)
		}
	}

	// Mark reservation as released
	_, err = tx.ExecContext(ctx,
		"UPDATE reservations SET released_at = NOW() WHERE id = $1",
		reservationID,
	)
	if err != nil {
		return "", fmt.Errorf("marking reservation released: %w", err)
	}

	return reservationID, nil
}
```

## Orchestration-Based Sagas

Orchestration uses a central coordinator (the Saga Orchestrator) that explicitly commands each participant what to do and tracks the saga's state:

```
SagaOrchestrator → commands InventoryService to reserve
  InventoryService → replies with ReservationResult
    SagaOrchestrator → commands PaymentService to charge
      PaymentService → replies with ChargeResult
        SagaOrchestrator → commands ShippingService to create shipment
          ... and so on
```

### Saga State Machine

```go
package saga

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"
)

// SagaState represents the current state of an order saga
type SagaState string

const (
	StateStarted              SagaState = "STARTED"
	StateInventoryPending     SagaState = "INVENTORY_PENDING"
	StateInventoryReserved    SagaState = "INVENTORY_RESERVED"
	StateInventoryFailed      SagaState = "INVENTORY_FAILED"
	StatePaymentPending       SagaState = "PAYMENT_PENDING"
	StatePaymentCharged       SagaState = "PAYMENT_CHARGED"
	StatePaymentFailed        SagaState = "PAYMENT_FAILED"
	StateShippingPending      SagaState = "SHIPPING_PENDING"
	StateShipmentCreated      SagaState = "SHIPMENT_CREATED"
	StateShippingFailed       SagaState = "SHIPPING_FAILED"
	StateCompensatingPayment  SagaState = "COMPENSATING_PAYMENT"
	StateCompensatingInventory SagaState = "COMPENSATING_INVENTORY"
	StateCompleted            SagaState = "COMPLETED"
	StateFailed               SagaState = "FAILED"
)

// OrderSagaData holds all data needed to execute and compensate the saga
type OrderSagaData struct {
	OrderID       string          `json:"order_id"`
	CustomerID    string          `json:"customer_id"`
	Items         []OrderItem     `json:"items"`
	TotalAmount   Money           `json:"total_amount"`
	ReservationID string          `json:"reservation_id,omitempty"`
	TransactionID string          `json:"transaction_id,omitempty"`
	ShipmentID    string          `json:"shipment_id,omitempty"`
	FailureReason string          `json:"failure_reason,omitempty"`
}

// SagaInstance tracks a running saga
type SagaInstance struct {
	ID          string        `json:"id"`
	SagaType    string        `json:"saga_type"`
	State       SagaState     `json:"state"`
	Data        OrderSagaData `json:"data"`
	CreatedAt   time.Time     `json:"created_at"`
	UpdatedAt   time.Time     `json:"updated_at"`
	CompletedAt *time.Time    `json:"completed_at,omitempty"`
}

// OrderSagaOrchestrator manages the order creation saga
type OrderSagaOrchestrator struct {
	db         *sql.DB
	inventory  InventoryClient
	payment    PaymentClient
	shipping   ShippingClient
	notifier   NotificationClient
}

// Start initiates the saga
func (o *OrderSagaOrchestrator) Start(ctx context.Context, data OrderSagaData) (*SagaInstance, error) {
	saga := &SagaInstance{
		ID:        generateID(),
		SagaType:  "order-placement",
		State:     StateStarted,
		Data:      data,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	if err := o.persist(ctx, saga); err != nil {
		return nil, fmt.Errorf("persisting saga: %w", err)
	}

	// Execute first step
	if err := o.executeStep(ctx, saga); err != nil {
		return nil, err
	}

	return saga, nil
}

// executeStep moves the saga to the next state
func (o *OrderSagaOrchestrator) executeStep(ctx context.Context, saga *SagaInstance) error {
	var newState SagaState
	var err error

	switch saga.State {
	case StateStarted, StateInventoryPending:
		newState, err = o.reserveInventory(ctx, saga)

	case StateInventoryReserved, StatePaymentPending:
		newState, err = o.chargePayment(ctx, saga)

	case StatePaymentCharged, StateShippingPending:
		newState, err = o.createShipment(ctx, saga)

	case StateShipmentCreated:
		newState, err = o.sendNotification(ctx, saga)
		if err == nil {
			newState = StateCompleted
		}

	// Compensation steps (backward execution)
	case StateShippingFailed, StateCompensatingPayment:
		newState, err = o.refundPayment(ctx, saga)

	case StatePaymentFailed, StateCompensatingInventory:
		newState, err = o.releaseInventory(ctx, saga)

	case StateInventoryFailed:
		newState = StateFailed

	default:
		return fmt.Errorf("unknown saga state: %s", saga.State)
	}

	if err != nil {
		slog.Error("saga step failed",
			"saga_id", saga.ID,
			"state", saga.State,
			"error", err,
		)
		// Don't change state on transient errors — will retry
		return err
	}

	saga.State = newState
	saga.UpdatedAt = time.Now()

	if newState == StateCompleted || newState == StateFailed {
		now := time.Now()
		saga.CompletedAt = &now
	}

	if err := o.persist(ctx, saga); err != nil {
		return fmt.Errorf("persisting saga state %s: %w", newState, err)
	}

	// If there's another step to execute, do it
	if newState != StateCompleted && newState != StateFailed {
		return o.executeStep(ctx, saga)
	}

	return nil
}

func (o *OrderSagaOrchestrator) reserveInventory(ctx context.Context, saga *SagaInstance) (SagaState, error) {
	slog.Info("saga: reserving inventory",
		"saga_id", saga.ID,
		"order_id", saga.Data.OrderID,
	)

	result, err := o.inventory.Reserve(ctx, ReserveRequest{
		OrderID:    saga.Data.OrderID,
		Items:      saga.Data.Items,
		IdempotencyKey: saga.ID + "-inventory",
	})
	if err != nil {
		// Transient error — will retry
		return StateInventoryPending, fmt.Errorf("inventory reservation: %w", err)
	}

	if !result.Success {
		saga.Data.FailureReason = fmt.Sprintf("inventory: %s", result.Reason)
		return StateInventoryFailed, nil
	}

	saga.Data.ReservationID = result.ReservationID
	return StateInventoryReserved, nil
}

func (o *OrderSagaOrchestrator) chargePayment(ctx context.Context, saga *SagaInstance) (SagaState, error) {
	slog.Info("saga: charging payment",
		"saga_id", saga.ID,
		"order_id", saga.Data.OrderID,
		"amount", saga.Data.TotalAmount,
	)

	result, err := o.payment.Charge(ctx, ChargeRequest{
		CustomerID:     saga.Data.CustomerID,
		OrderID:        saga.Data.OrderID,
		Amount:         saga.Data.TotalAmount,
		IdempotencyKey: saga.ID + "-payment",
	})
	if err != nil {
		return StatePaymentPending, fmt.Errorf("payment charge: %w", err)
	}

	if !result.Success {
		saga.Data.FailureReason = fmt.Sprintf("payment: %s", result.Reason)
		// Trigger compensation: need to release inventory
		return StatePaymentFailed, nil
	}

	saga.Data.TransactionID = result.TransactionID
	return StatePaymentCharged, nil
}

func (o *OrderSagaOrchestrator) createShipment(ctx context.Context, saga *SagaInstance) (SagaState, error) {
	slog.Info("saga: creating shipment",
		"saga_id", saga.ID,
		"order_id", saga.Data.OrderID,
	)

	result, err := o.shipping.CreateShipment(ctx, ShipmentRequest{
		OrderID:        saga.Data.OrderID,
		Items:          saga.Data.Items,
		IdempotencyKey: saga.ID + "-shipping",
	})
	if err != nil {
		return StateShippingPending, fmt.Errorf("create shipment: %w", err)
	}

	if !result.Success {
		saga.Data.FailureReason = fmt.Sprintf("shipping: %s", result.Reason)
		// Trigger compensation: need to refund payment and release inventory
		return StateShippingFailed, nil
	}

	saga.Data.ShipmentID = result.ShipmentID
	return StateShipmentCreated, nil
}

func (o *OrderSagaOrchestrator) refundPayment(ctx context.Context, saga *SagaInstance) (SagaState, error) {
	slog.Info("saga: compensating - refunding payment",
		"saga_id", saga.ID,
		"transaction_id", saga.Data.TransactionID,
	)

	if saga.Data.TransactionID == "" {
		// Payment was never charged — skip refund
		return StateCompensatingInventory, nil
	}

	err := o.payment.Refund(ctx, RefundRequest{
		TransactionID:  saga.Data.TransactionID,
		OrderID:        saga.Data.OrderID,
		IdempotencyKey: saga.ID + "-refund",
	})
	if err != nil {
		return StateCompensatingPayment, fmt.Errorf("payment refund: %w", err)
	}

	return StateCompensatingInventory, nil
}

func (o *OrderSagaOrchestrator) releaseInventory(ctx context.Context, saga *SagaInstance) (SagaState, error) {
	slog.Info("saga: compensating - releasing inventory",
		"saga_id", saga.ID,
		"reservation_id", saga.Data.ReservationID,
	)

	if saga.Data.ReservationID == "" {
		// Inventory was never reserved — saga is done
		return StateFailed, nil
	}

	err := o.inventory.Release(ctx, ReleaseRequest{
		ReservationID:  saga.Data.ReservationID,
		OrderID:        saga.Data.OrderID,
		IdempotencyKey: saga.ID + "-release",
	})
	if err != nil {
		return StateCompensatingInventory, fmt.Errorf("inventory release: %w", err)
	}

	return StateFailed, nil
}

func (o *OrderSagaOrchestrator) sendNotification(ctx context.Context, saga *SagaInstance) (SagaState, error) {
	// Notifications are best-effort — don't fail the saga if email fails
	if err := o.notifier.SendOrderConfirmation(ctx, saga.Data.OrderID, saga.Data.CustomerID); err != nil {
		slog.Warn("failed to send order confirmation",
			"order_id", saga.Data.OrderID,
			"error", err,
		)
	}
	return StateCompleted, nil
}

// persist saves the saga state to the database
func (o *OrderSagaOrchestrator) persist(ctx context.Context, saga *SagaInstance) error {
	dataJSON, err := json.Marshal(saga.Data)
	if err != nil {
		return fmt.Errorf("marshaling saga data: %w", err)
	}

	_, err = o.db.ExecContext(ctx,
		`INSERT INTO sagas (id, saga_type, state, data, created_at, updated_at, completed_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (id) DO UPDATE SET
		   state = $3,
		   data = $4,
		   updated_at = $6,
		   completed_at = $7`,
		saga.ID, saga.SagaType, saga.State, dataJSON,
		saga.CreatedAt, saga.UpdatedAt, saga.CompletedAt,
	)
	return err
}
```

### Saga Recovery on Restart

Sagas must be recoverable after process restart. A recovery loop processes stuck sagas:

```go
package saga

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"time"
)

// RecoveryWorker finds and resumes stuck sagas
type RecoveryWorker struct {
	db           *sql.DB
	orchestrator *OrderSagaOrchestrator
	interval     time.Duration
	stuckTimeout time.Duration
}

func NewRecoveryWorker(db *sql.DB, orchestrator *OrderSagaOrchestrator) *RecoveryWorker {
	return &RecoveryWorker{
		db:           db,
		orchestrator: orchestrator,
		interval:     30 * time.Second,
		stuckTimeout: 5 * time.Minute,
	}
}

func (w *RecoveryWorker) Run(ctx context.Context) {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := w.recoverStuckSagas(ctx); err != nil {
				slog.Error("saga recovery failed", "error", err)
			}
		}
	}
}

func (w *RecoveryWorker) recoverStuckSagas(ctx context.Context) error {
	// Find sagas that haven't progressed in stuckTimeout
	rows, err := w.db.QueryContext(ctx,
		`SELECT id, saga_type, state, data, created_at, updated_at
		 FROM sagas
		 WHERE state NOT IN ('COMPLETED', 'FAILED')
		   AND updated_at < $1
		 ORDER BY updated_at ASC
		 LIMIT 50`,
		time.Now().Add(-w.stuckTimeout),
	)
	if err != nil {
		return err
	}
	defer rows.Close()

	var recovered, failed int
	for rows.Next() {
		var saga SagaInstance
		var dataJSON []byte

		if err := rows.Scan(
			&saga.ID, &saga.SagaType, &saga.State, &dataJSON,
			&saga.CreatedAt, &saga.UpdatedAt,
		); err != nil {
			continue
		}

		if err := json.Unmarshal(dataJSON, &saga.Data); err != nil {
			slog.Error("failed to unmarshal saga data", "saga_id", saga.ID, "error", err)
			failed++
			continue
		}

		slog.Info("recovering stuck saga",
			"saga_id", saga.ID,
			"state", saga.State,
			"stuck_for", time.Since(saga.UpdatedAt),
		)

		if err := w.orchestrator.executeStep(ctx, &saga); err != nil {
			slog.Error("saga recovery step failed",
				"saga_id", saga.ID,
				"state", saga.State,
				"error", err,
			)
			failed++
		} else {
			recovered++
		}
	}

	if recovered > 0 || failed > 0 {
		slog.Info("saga recovery complete",
			"recovered", recovered,
			"failed", failed,
		)
	}

	return rows.Err()
}
```

## Idempotency in Saga Steps

Every step must be idempotent — safe to retry multiple times with the same result:

```go
package idempotent

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
)

// IdempotencyStore provides idempotent operation tracking
type IdempotencyStore struct {
	db *sql.DB
}

type StoredResult struct {
	StatusCode int
	Body       json.RawMessage
}

// Execute runs fn only if the idempotency key hasn't been seen before.
// Returns the stored result if the key already exists.
func (s *IdempotencyStore) Execute(
	ctx context.Context,
	key string,
	fn func() (*StoredResult, error),
) (*StoredResult, error) {
	// Check if we already have a result for this key
	var body json.RawMessage
	var statusCode int
	err := s.db.QueryRowContext(ctx,
		"SELECT status_code, body FROM idempotency_keys WHERE key = $1",
		key,
	).Scan(&statusCode, &body)

	if err == nil {
		// Already have a result — return it
		return &StoredResult{StatusCode: statusCode, Body: body}, nil
	}

	if err != sql.ErrNoRows {
		return nil, fmt.Errorf("checking idempotency key: %w", err)
	}

	// Execute the operation
	result, err := fn()
	if err != nil {
		return nil, err
	}

	// Store the result
	_, storeErr := s.db.ExecContext(ctx,
		`INSERT INTO idempotency_keys (key, status_code, body, created_at)
		 VALUES ($1, $2, $3, NOW())
		 ON CONFLICT (key) DO NOTHING`,
		key, result.StatusCode, result.Body,
	)
	if storeErr != nil {
		// Don't fail if we couldn't store — the operation succeeded
		// It might be retried, but fn must handle that gracefully
	}

	return result, nil
}

// Schema:
// CREATE TABLE idempotency_keys (
//   key         VARCHAR(255) PRIMARY KEY,
//   status_code INTEGER NOT NULL,
//   body        JSONB,
//   created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
//   expires_at  TIMESTAMPTZ GENERATED ALWAYS AS (created_at + INTERVAL '7 days') STORED
// );
// CREATE INDEX ON idempotency_keys (expires_at) WHERE expires_at IS NOT NULL;
// -- Cleanup job: DELETE FROM idempotency_keys WHERE expires_at < NOW();
```

## Saga Monitoring and Observability

```go
package metrics

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	sagasStarted = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "saga_started_total",
			Help: "Total number of sagas started",
		},
		[]string{"saga_type"},
	)

	sagasCompleted = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "saga_completed_total",
			Help: "Total number of sagas completed",
		},
		[]string{"saga_type", "outcome"}, // outcome: "success" | "failed" | "compensated"
	)

	sagaDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "saga_duration_seconds",
			Help:    "Duration of sagas from start to completion",
			Buckets: []float64{0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300},
		},
		[]string{"saga_type", "outcome"},
	)

	sagasInProgress = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "saga_in_progress",
			Help: "Number of sagas currently in progress",
		},
		[]string{"saga_type", "state"},
	)

	sagaStepDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "saga_step_duration_seconds",
			Help:    "Duration of individual saga steps",
			Buckets: []float64{0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10},
		},
		[]string{"saga_type", "step", "outcome"},
	)
)

func RecordSagaStep(sagaType, step string, duration time.Duration, err error) {
	outcome := "success"
	if err != nil {
		outcome = "error"
	}
	sagaStepDuration.WithLabelValues(sagaType, step, outcome).
		Observe(duration.Seconds())
}
```

## Choosing Between Choreography and Orchestration

| Aspect | Choreography | Orchestration |
|--------|-------------|---------------|
| Coupling | Loose (event-based) | Tighter (command-based) |
| Visibility | Distributed, hard to trace | Centralized, easy to monitor |
| State tracking | Each service tracks own state | Orchestrator tracks all state |
| Debugging | Requires distributed tracing | Single saga state table |
| Cyclic dependencies | Risk of event cycles | Explicit control flow |
| Team organization | Better for independent teams | Better when one team owns flow |

**Use choreography when:**
- Services are owned by independent teams
- You want maximum decoupling
- The flow has few steps and clear event semantics
- Services already publish events for other purposes

**Use orchestration when:**
- You need clear visibility into saga state
- The flow has many steps or complex branching
- You want centralized compensation logic
- Recovery and retry needs to be managed in one place

## Conclusion

The Saga pattern enables distributed transactions across microservices without the availability and coupling costs of two-phase commit. Both choreography and orchestration have their place: choreography for loosely coupled, event-driven systems; orchestration for complex flows that need centralized visibility and state management.

The critical implementation details are idempotency (every step must be safe to retry), compensating transactions (every forward step that has external effects needs a compensation), and recovery (sagas must resume correctly after process restart). Get these right and the Saga pattern provides a robust foundation for distributed business transactions at scale.
