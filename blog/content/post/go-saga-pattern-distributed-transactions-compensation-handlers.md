---
title: "Go: Implementing the Saga Pattern for Distributed Transactions with Compensation Handlers"
date: 2031-07-02T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Distributed Systems", "Saga Pattern", "Microservices", "Transactions"]
categories: ["Go", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive implementation of the saga pattern in Go for managing distributed transactions across microservices, covering orchestration vs choreography, compensation handlers, idempotency, and observability."
more_link: "yes"
url: "/go-saga-pattern-distributed-transactions-compensation-handlers/"
---

Distributed transactions are one of the hardest problems in microservices architecture. Two-phase commit (2PC) achieves consistency but couples services tightly and creates availability risks when coordinators fail. The saga pattern achieves eventual consistency through a sequence of local transactions, each with a compensating transaction that can undo its effects if a later step fails. This post implements a production-grade saga orchestrator in Go with durable state, idempotent steps, and comprehensive observability.

<!--more-->

# Go: Implementing the Saga Pattern for Distributed Transactions with Compensation Handlers

## The Problem with Distributed Transactions

Consider a flight booking flow that spans three services:

1. **Inventory Service**: Reserve seat on flight
2. **Payment Service**: Charge customer credit card
3. **Notification Service**: Send booking confirmation

If payment fails after inventory is reserved, the seat must be unreserved. If notification fails after payment succeeds, the payment must be refunded and the seat unreserved. Without a coordination mechanism, partial failures leave the system in an inconsistent state.

2PC would solve this with a prepare/commit protocol, but requires all services to hold locks during the protocol, which creates contention and availability risk. The saga pattern instead uses:

- **Forward transactions**: Each step performs its local work
- **Compensating transactions**: Each step has a corresponding undo operation

If step N fails, the saga executes compensating transactions for steps N-1 through 1 in reverse order.

## Saga Patterns: Orchestration vs Choreography

**Choreography**: Services emit events and react to events from other services. No central coordinator. Difficult to debug and trace.

**Orchestration**: A central saga orchestrator explicitly calls each service and manages the compensation flow. Easier to observe and debug. This post implements orchestration.

## Data Structures

```go
// saga/saga.go
package saga

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Status represents the current state of a saga execution.
type Status string

const (
	StatusPending     Status = "pending"
	StatusRunning     Status = "running"
	StatusCompleted   Status = "completed"
	StatusFailed      Status = "failed"
	StatusCompensating Status = "compensating"
	StatusCompensated  Status = "compensated"
)

// StepStatus represents the state of an individual saga step.
type StepStatus string

const (
	StepPending      StepStatus = "pending"
	StepRunning      StepStatus = "running"
	StepCompleted    StepStatus = "completed"
	StepFailed       StepStatus = "failed"
	StepCompensating StepStatus = "compensating"
	StepCompensated  StepStatus = "compensated"
	StepSkipped      StepStatus = "skipped"
)

// StepFunc is a function that executes a single saga step.
// ctx carries cancellation and deadline signals.
// data is the shared saga payload, which steps may read and modify.
// Returns an error if the step fails.
type StepFunc func(ctx context.Context, data map[string]interface{}) error

// CompensationFunc undoes the effects of a saga step.
// It must be idempotent: calling it multiple times must produce the same result.
type CompensationFunc func(ctx context.Context, data map[string]interface{}) error

// Step defines a single unit of work within a saga.
type Step struct {
	Name         string
	Execute      StepFunc
	Compensate   CompensationFunc
	// MaxRetries controls how many times Execute is retried on failure
	// before the saga moves to compensation.
	MaxRetries   int
	// RetryDelay is the base delay between retries (exponential backoff applied).
	RetryDelay   time.Duration
	// Timeout is the per-step execution timeout.
	Timeout      time.Duration
	// Critical indicates that compensation should not continue past this
	// step even if its compensating transaction fails.
	Critical     bool
}

// StepResult records the outcome of a single step execution.
type StepResult struct {
	StepName     string
	Status       StepStatus
	Attempts     int
	Error        string
	StartedAt    time.Time
	CompletedAt  time.Time
	CompensatedAt *time.Time
}

// Execution represents a running or completed saga.
type Execution struct {
	ID          string
	SagaName    string
	Status      Status
	Data        map[string]interface{}
	StepResults []StepResult
	CreatedAt   time.Time
	UpdatedAt   time.Time
	Error       string

	mu sync.RWMutex
}

// Saga is a named sequence of steps with compensation support.
type Saga struct {
	Name  string
	Steps []Step
}
```

## Saga Orchestrator

```go
// saga/orchestrator.go
package saga

import (
	"context"
	"fmt"
	"math"
	"time"

	"go.uber.org/zap"
)

// StateStore persists saga execution state for durability.
// Implementations may use PostgreSQL, Redis, or any durable store.
type StateStore interface {
	Save(ctx context.Context, exec *Execution) error
	Load(ctx context.Context, executionID string) (*Execution, error)
	List(ctx context.Context, filter ExecutionFilter) ([]*Execution, error)
}

// ExecutionFilter provides query criteria for listing executions.
type ExecutionFilter struct {
	SagaName string
	Status   Status
	Limit    int
	Offset   int
}

// Orchestrator manages saga execution with durability and compensation.
type Orchestrator struct {
	store  StateStore
	logger *zap.Logger
}

// NewOrchestrator creates an Orchestrator backed by the given state store.
func NewOrchestrator(store StateStore, logger *zap.Logger) *Orchestrator {
	return &Orchestrator{store: store, logger: logger}
}

// Execute runs a saga to completion or compensates on failure.
// It returns the final Execution record.
func (o *Orchestrator) Execute(ctx context.Context, saga *Saga, executionID string, initialData map[string]interface{}) (*Execution, error) {
	exec := &Execution{
		ID:          executionID,
		SagaName:    saga.Name,
		Status:      StatusPending,
		Data:        cloneData(initialData),
		StepResults: make([]StepResult, len(saga.Steps)),
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}

	// Initialize step results
	for i, step := range saga.Steps {
		exec.StepResults[i] = StepResult{
			StepName: step.Name,
			Status:   StepPending,
		}
	}

	// Persist initial state
	if err := o.store.Save(ctx, exec); err != nil {
		return nil, fmt.Errorf("persisting initial saga state: %w", err)
	}

	exec.Status = StatusRunning
	exec.UpdatedAt = time.Now()
	o.store.Save(ctx, exec)

	o.logger.Info("saga execution started",
		zap.String("saga", saga.Name),
		zap.String("executionID", executionID),
	)

	// Execute steps forward
	failedAt := -1
	for i, step := range saga.Steps {
		result := &exec.StepResults[i]
		result.Status = StepRunning
		result.StartedAt = time.Now()
		result.Attempts = 0

		o.logger.Info("executing saga step",
			zap.String("saga", saga.Name),
			zap.String("step", step.Name),
			zap.Int("index", i),
		)

		err := o.executeWithRetry(ctx, step, exec.Data)
		result.CompletedAt = time.Now()

		if err != nil {
			result.Status = StepFailed
			result.Error = err.Error()
			exec.Error = fmt.Sprintf("step %q failed: %v", step.Name, err)
			failedAt = i

			o.logger.Error("saga step failed",
				zap.String("saga", saga.Name),
				zap.String("step", step.Name),
				zap.Error(err),
			)

			o.store.Save(ctx, exec)
			break
		}

		result.Status = StepCompleted
		exec.UpdatedAt = time.Now()
		o.store.Save(ctx, exec)

		o.logger.Info("saga step completed",
			zap.String("saga", saga.Name),
			zap.String("step", step.Name),
		)
	}

	if failedAt == -1 {
		// All steps succeeded
		exec.Status = StatusCompleted
		exec.UpdatedAt = time.Now()
		o.store.Save(ctx, exec)

		o.logger.Info("saga completed successfully",
			zap.String("saga", saga.Name),
			zap.String("executionID", executionID),
		)
		return exec, nil
	}

	// Compensate in reverse order from the step before the failed one
	o.compensate(ctx, saga, exec, failedAt)
	return exec, fmt.Errorf("saga failed at step %q: %s", saga.Steps[failedAt].Name, exec.Error)
}

func (o *Orchestrator) compensate(ctx context.Context, saga *Saga, exec *Execution, failedAt int) {
	exec.Status = StatusCompensating
	exec.UpdatedAt = time.Now()
	o.store.Save(ctx, exec)

	o.logger.Info("starting saga compensation",
		zap.String("saga", saga.Name),
		zap.String("executionID", exec.ID),
		zap.Int("compensatingFrom", failedAt-1),
	)

	// Compensate from (failedAt - 1) down to 0
	for i := failedAt - 1; i >= 0; i-- {
		step := saga.Steps[i]
		if step.Compensate == nil {
			exec.StepResults[i].Status = StepSkipped
			continue
		}

		result := &exec.StepResults[i]
		result.Status = StepCompensating

		o.logger.Info("compensating saga step",
			zap.String("saga", saga.Name),
			zap.String("step", step.Name),
		)

		// Use a separate context for compensation with generous timeout
		compCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		err := o.compensateWithRetry(compCtx, step, exec.Data)
		cancel()

		now := time.Now()
		result.CompensatedAt = &now

		if err != nil {
			o.logger.Error("compensation step failed",
				zap.String("saga", saga.Name),
				zap.String("step", step.Name),
				zap.Error(err),
			)
			result.Status = StepFailed
			result.Error = fmt.Sprintf("compensation failed: %v", err)

			// If this is a critical step, stop compensation
			if step.Critical {
				exec.Status = StatusFailed
				exec.Error = fmt.Sprintf("critical compensation failure at step %q: %v", step.Name, err)
				exec.UpdatedAt = time.Now()
				o.store.Save(ctx, exec)
				return
			}
			// Non-critical: log and continue compensating
		} else {
			result.Status = StepCompensated
		}

		exec.UpdatedAt = time.Now()
		o.store.Save(ctx, exec)
	}

	exec.Status = StatusCompensated
	exec.UpdatedAt = time.Now()
	o.store.Save(ctx, exec)

	o.logger.Info("saga compensation complete",
		zap.String("saga", saga.Name),
		zap.String("executionID", exec.ID),
	)
}

func (o *Orchestrator) executeWithRetry(ctx context.Context, step Step, data map[string]interface{}) error {
	maxRetries := step.MaxRetries
	if maxRetries == 0 {
		maxRetries = 3
	}
	baseDelay := step.RetryDelay
	if baseDelay == 0 {
		baseDelay = 500 * time.Millisecond
	}
	timeout := step.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}

	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			delay := time.Duration(float64(baseDelay) * math.Pow(2, float64(attempt-1)))
			if delay > 30*time.Second {
				delay = 30 * time.Second
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
		}

		stepCtx, cancel := context.WithTimeout(ctx, timeout)
		lastErr = step.Execute(stepCtx, data)
		cancel()

		if lastErr == nil {
			return nil
		}

		// Don't retry on context cancellation
		if ctx.Err() != nil {
			return ctx.Err()
		}

		// Check if error is retryable
		if !isRetryable(lastErr) {
			return lastErr
		}
	}

	return fmt.Errorf("step failed after %d attempts: %w", maxRetries+1, lastErr)
}

func (o *Orchestrator) compensateWithRetry(ctx context.Context, step Step, data map[string]interface{}) error {
	// Compensating transactions get more retry attempts since failures here
	// leave the system in an inconsistent state.
	maxRetries := 5
	baseDelay := 1 * time.Second

	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			delay := time.Duration(float64(baseDelay) * math.Pow(2, float64(attempt-1)))
			if delay > 60*time.Second {
				delay = 60 * time.Second
			}
			select {
			case <-ctx.Done():
				return fmt.Errorf("compensation context cancelled: %w", ctx.Err())
			case <-time.After(delay):
			}
		}

		compCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		lastErr = step.Compensate(compCtx, data)
		cancel()

		if lastErr == nil {
			return nil
		}
	}

	return fmt.Errorf("compensation failed after %d attempts: %w", maxRetries+1, lastErr)
}

// RetryableError marks an error as safe to retry.
type RetryableError struct {
	Cause error
}

func (e *RetryableError) Error() string {
	return fmt.Sprintf("retryable: %v", e.Cause)
}

func (e *RetryableError) Unwrap() error { return e.Cause }

func isRetryable(err error) bool {
	var retryable *RetryableError
	return errors.As(err, &retryable)
}

func cloneData(data map[string]interface{}) map[string]interface{} {
	clone := make(map[string]interface{}, len(data))
	for k, v := range data {
		clone[k] = v
	}
	return clone
}
```

## PostgreSQL State Store

```go
// saga/postgres_store.go
package saga

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	_ "github.com/lib/pq"
)

// PostgresStore persists saga execution state in PostgreSQL.
type PostgresStore struct {
	db *sql.DB
}

// NewPostgresStore creates a PostgresStore and initializes the schema.
func NewPostgresStore(connStr string) (*PostgresStore, error) {
	db, err := sql.Open("postgres", connStr)
	if err != nil {
		return nil, fmt.Errorf("opening database: %w", err)
	}

	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(5 * time.Minute)

	store := &PostgresStore{db: db}
	if err := store.migrate(); err != nil {
		return nil, fmt.Errorf("running migrations: %w", err)
	}

	return store, nil
}

func (s *PostgresStore) migrate() error {
	_, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS saga_executions (
			id            TEXT PRIMARY KEY,
			saga_name     TEXT NOT NULL,
			status        TEXT NOT NULL,
			data          JSONB NOT NULL DEFAULT '{}',
			step_results  JSONB NOT NULL DEFAULT '[]',
			error         TEXT,
			created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);

		CREATE INDEX IF NOT EXISTS idx_saga_executions_saga_name ON saga_executions (saga_name);
		CREATE INDEX IF NOT EXISTS idx_saga_executions_status ON saga_executions (status);
		CREATE INDEX IF NOT EXISTS idx_saga_executions_updated_at ON saga_executions (updated_at);
	`)
	return err
}

func (s *PostgresStore) Save(ctx context.Context, exec *Execution) error {
	exec.mu.RLock()
	defer exec.mu.RUnlock()

	dataJSON, err := json.Marshal(exec.Data)
	if err != nil {
		return fmt.Errorf("marshaling data: %w", err)
	}

	stepsJSON, err := json.Marshal(exec.StepResults)
	if err != nil {
		return fmt.Errorf("marshaling step results: %w", err)
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO saga_executions
			(id, saga_name, status, data, step_results, error, created_at, updated_at)
		VALUES
			($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (id) DO UPDATE SET
			status       = EXCLUDED.status,
			data         = EXCLUDED.data,
			step_results = EXCLUDED.step_results,
			error        = EXCLUDED.error,
			updated_at   = EXCLUDED.updated_at
	`,
		exec.ID, exec.SagaName, exec.Status,
		dataJSON, stepsJSON, exec.Error,
		exec.CreatedAt, exec.UpdatedAt,
	)
	return err
}

func (s *PostgresStore) Load(ctx context.Context, executionID string) (*Execution, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, saga_name, status, data, step_results, error, created_at, updated_at
		FROM saga_executions
		WHERE id = $1
	`, executionID)

	var exec Execution
	var dataJSON, stepsJSON []byte
	var errStr sql.NullString

	err := row.Scan(
		&exec.ID, &exec.SagaName, &exec.Status,
		&dataJSON, &stepsJSON, &errStr,
		&exec.CreatedAt, &exec.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("execution %q not found", executionID)
	}
	if err != nil {
		return nil, fmt.Errorf("scanning row: %w", err)
	}

	if err := json.Unmarshal(dataJSON, &exec.Data); err != nil {
		return nil, fmt.Errorf("unmarshaling data: %w", err)
	}
	if err := json.Unmarshal(stepsJSON, &exec.StepResults); err != nil {
		return nil, fmt.Errorf("unmarshaling step results: %w", err)
	}
	if errStr.Valid {
		exec.Error = errStr.String
	}

	return &exec, nil
}

func (s *PostgresStore) List(ctx context.Context, filter ExecutionFilter) ([]*Execution, error) {
	query := `
		SELECT id, saga_name, status, data, step_results, error, created_at, updated_at
		FROM saga_executions
		WHERE 1=1
	`
	var args []interface{}
	argIdx := 1

	if filter.SagaName != "" {
		query += fmt.Sprintf(" AND saga_name = $%d", argIdx)
		args = append(args, filter.SagaName)
		argIdx++
	}
	if filter.Status != "" {
		query += fmt.Sprintf(" AND status = $%d", argIdx)
		args = append(args, filter.Status)
		argIdx++
	}

	query += fmt.Sprintf(" ORDER BY created_at DESC LIMIT $%d OFFSET $%d", argIdx, argIdx+1)
	args = append(args, filter.Limit, filter.Offset)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var executions []*Execution
	for rows.Next() {
		var exec Execution
		var dataJSON, stepsJSON []byte
		var errStr sql.NullString

		if err := rows.Scan(
			&exec.ID, &exec.SagaName, &exec.Status,
			&dataJSON, &stepsJSON, &errStr,
			&exec.CreatedAt, &exec.UpdatedAt,
		); err != nil {
			return nil, err
		}

		json.Unmarshal(dataJSON, &exec.Data)
		json.Unmarshal(stepsJSON, &exec.StepResults)
		if errStr.Valid {
			exec.Error = errStr.String
		}

		executions = append(executions, &exec)
	}

	return executions, rows.Err()
}
```

## Flight Booking Example

A concrete implementation of the flight booking scenario:

```go
// examples/booking/booking_saga.go
package booking

import (
	"context"
	"fmt"

	"github.com/myorg/saga-service/saga"
)

// BookingRequest is the input to the booking saga.
type BookingRequest struct {
	CustomerID string
	FlightID   string
	SeatClass  string
	Amount     float64
	Currency   string
}

// BuildFlightBookingSaga constructs the flight booking saga definition.
func BuildFlightBookingSaga(
	inventory InventoryService,
	payment PaymentService,
	notification NotificationService,
) *saga.Saga {
	return &saga.Saga{
		Name: "flight-booking",
		Steps: []saga.Step{
			{
				Name:       "reserve-seat",
				MaxRetries: 3,
				Timeout:    10 * time.Second,
				Execute: func(ctx context.Context, data map[string]interface{}) error {
					req := extractBookingRequest(data)

					reservation, err := inventory.ReserveSeat(ctx, req.FlightID, req.SeatClass)
					if err != nil {
						if isTransient(err) {
							return &saga.RetryableError{Cause: err}
						}
						return err
					}

					// Store reservation ID for compensation
					data["reservation_id"] = reservation.ID
					data["seat_number"] = reservation.SeatNumber
					return nil
				},
				Compensate: func(ctx context.Context, data map[string]interface{}) error {
					reservationID, ok := data["reservation_id"].(string)
					if !ok || reservationID == "" {
						// Nothing to compensate
						return nil
					}
					return inventory.CancelReservation(ctx, reservationID)
				},
			},
			{
				Name:       "process-payment",
				MaxRetries: 2,
				Timeout:    30 * time.Second,
				Critical:   true, // If payment compensation fails, alert ops immediately
				Execute: func(ctx context.Context, data map[string]interface{}) error {
					req := extractBookingRequest(data)

					// Use idempotency key to prevent double-charging on retry
					idempotencyKey := fmt.Sprintf("booking-%s-%s-%s",
						req.CustomerID, req.FlightID, data["execution_id"])

					charge, err := payment.ChargeCard(ctx, payment.ChargeRequest{
						CustomerID:     req.CustomerID,
						Amount:         req.Amount,
						Currency:       req.Currency,
						IdempotencyKey: idempotencyKey,
					})
					if err != nil {
						// Payment errors are generally not retryable (insufficient funds, etc.)
						return fmt.Errorf("payment failed: %w", err)
					}

					data["charge_id"] = charge.ID
					data["payment_status"] = charge.Status
					return nil
				},
				Compensate: func(ctx context.Context, data map[string]interface{}) error {
					chargeID, ok := data["charge_id"].(string)
					if !ok || chargeID == "" {
						return nil
					}
					return payment.RefundCharge(ctx, chargeID, "booking-saga-compensation")
				},
			},
			{
				Name:       "send-confirmation",
				MaxRetries: 5,
				Timeout:    15 * time.Second,
				Execute: func(ctx context.Context, data map[string]interface{}) error {
					req := extractBookingRequest(data)

					err := notification.SendBookingConfirmation(ctx, notification.BookingConfirmation{
						CustomerID: req.CustomerID,
						FlightID:   req.FlightID,
						SeatNumber: data["seat_number"].(string),
						ChargeID:   data["charge_id"].(string),
					})
					if err != nil {
						// Notification failure should retry but not block the transaction
						return &saga.RetryableError{Cause: err}
					}
					return nil
				},
				// No compensation for notifications - they're best-effort
				// In production, a separate reconciliation job handles missed notifications
				Compensate: nil,
			},
		},
	}
}

func extractBookingRequest(data map[string]interface{}) *BookingRequest {
	return &BookingRequest{
		CustomerID: data["customer_id"].(string),
		FlightID:   data["flight_id"].(string),
		SeatClass:  data["seat_class"].(string),
		Amount:     data["amount"].(float64),
		Currency:   data["currency"].(string),
	}
}
```

## HTTP Handler for Saga Execution

```go
// api/booking_handler.go
package api

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/myorg/saga-service/examples/booking"
	"github.com/myorg/saga-service/saga"
	"go.uber.org/zap"
)

type BookingHandler struct {
	orchestrator *saga.Orchestrator
	bookingSaga  *saga.Saga
	logger       *zap.Logger
}

func (h *BookingHandler) CreateBooking(w http.ResponseWriter, r *http.Request) {
	var req booking.BookingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// Use client-provided idempotency key or generate one
	idempotencyKey := r.Header.Get("Idempotency-Key")
	if idempotencyKey == "" {
		idempotencyKey = uuid.NewString()
	}

	// Check if this execution already exists (idempotent retry)
	if existing, err := h.orchestrator.Store().Load(r.Context(), idempotencyKey); err == nil {
		h.respondWithExecution(w, existing)
		return
	}

	// Build the initial data payload
	data := map[string]interface{}{
		"execution_id": idempotencyKey,
		"customer_id":  req.CustomerID,
		"flight_id":    req.FlightID,
		"seat_class":   req.SeatClass,
		"amount":       req.Amount,
		"currency":     req.Currency,
	}

	// Execute asynchronously; return 202 Accepted
	go func() {
		exec, err := h.orchestrator.Execute(
			context.Background(),
			h.bookingSaga,
			idempotencyKey,
			data,
		)
		if err != nil {
			h.logger.Error("booking saga failed",
				zap.String("executionID", idempotencyKey),
				zap.Error(err),
			)
		} else {
			h.logger.Info("booking saga completed",
				zap.String("executionID", idempotencyKey),
				zap.String("status", string(exec.Status)),
			)
		}
	}()

	w.Header().Set("Location", "/bookings/"+idempotencyKey)
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{
		"execution_id": idempotencyKey,
		"status":       "pending",
		"poll_url":     "/bookings/" + idempotencyKey,
	})
}

func (h *BookingHandler) GetBookingStatus(w http.ResponseWriter, r *http.Request) {
	executionID := r.PathValue("executionID")

	exec, err := h.orchestrator.Store().Load(r.Context(), executionID)
	if err != nil {
		http.Error(w, "execution not found", http.StatusNotFound)
		return
	}

	h.respondWithExecution(w, exec)
}

func (h *BookingHandler) respondWithExecution(w http.ResponseWriter, exec *saga.Execution) {
	w.Header().Set("Content-Type", "application/json")

	statusCode := http.StatusOK
	switch exec.Status {
	case saga.StatusPending, saga.StatusRunning, saga.StatusCompensating:
		statusCode = http.StatusAccepted
	case saga.StatusFailed:
		statusCode = http.StatusUnprocessableEntity
	}

	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(exec)
}
```

## Testing Saga Compensation

```go
// saga/orchestrator_test.go
package saga_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/myorg/saga-service/saga"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// inMemoryStore is a test double for the state store.
type inMemoryStore struct {
	executions map[string]*saga.Execution
}

func newInMemoryStore() *inMemoryStore {
	return &inMemoryStore{executions: make(map[string]*saga.Execution)}
}

func (s *inMemoryStore) Save(_ context.Context, exec *saga.Execution) error {
	s.executions[exec.ID] = exec
	return nil
}

func (s *inMemoryStore) Load(_ context.Context, id string) (*saga.Execution, error) {
	exec, ok := s.executions[id]
	if !ok {
		return nil, errors.New("not found")
	}
	return exec, nil
}

func (s *inMemoryStore) List(_ context.Context, _ saga.ExecutionFilter) ([]*saga.Execution, error) {
	var result []*saga.Execution
	for _, e := range s.executions {
		result = append(result, e)
	}
	return result, nil
}

func TestOrchestrator_SuccessfulExecution(t *testing.T) {
	store := newInMemoryStore()
	logger, _ := zap.NewDevelopment()
	orch := saga.NewOrchestrator(store, logger)

	var step1Done, step2Done, step3Done bool

	s := &saga.Saga{
		Name: "test-saga",
		Steps: []saga.Step{
			{
				Name: "step1",
				Execute: func(_ context.Context, data map[string]interface{}) error {
					step1Done = true
					data["step1_result"] = "done"
					return nil
				},
				Compensate: func(_ context.Context, _ map[string]interface{}) error {
					t.Error("step1 compensation should not be called on success")
					return nil
				},
			},
			{
				Name: "step2",
				Execute: func(_ context.Context, data map[string]interface{}) error {
					step2Done = true
					return nil
				},
			},
			{
				Name: "step3",
				Execute: func(_ context.Context, data map[string]interface{}) error {
					step3Done = true
					return nil
				},
			},
		},
	}

	exec, err := orch.Execute(context.Background(), s, "exec-001", nil)

	require.NoError(t, err)
	assert.Equal(t, saga.StatusCompleted, exec.Status)
	assert.True(t, step1Done)
	assert.True(t, step2Done)
	assert.True(t, step3Done)
	assert.Equal(t, "done", exec.Data["step1_result"])
}

func TestOrchestrator_CompensationOnFailure(t *testing.T) {
	store := newInMemoryStore()
	logger, _ := zap.NewDevelopment()
	orch := saga.NewOrchestrator(store, logger)

	var compensated []string

	s := &saga.Saga{
		Name: "compensation-test",
		Steps: []saga.Step{
			{
				Name: "step1",
				Execute: func(_ context.Context, data map[string]interface{}) error {
					data["step1_id"] = "res-001"
					return nil
				},
				Compensate: func(_ context.Context, _ map[string]interface{}) error {
					compensated = append(compensated, "step1")
					return nil
				},
			},
			{
				Name: "step2",
				Execute: func(_ context.Context, data map[string]interface{}) error {
					data["step2_id"] = "res-002"
					return nil
				},
				Compensate: func(_ context.Context, _ map[string]interface{}) error {
					compensated = append(compensated, "step2")
					return nil
				},
			},
			{
				Name: "step3-fails",
				Execute: func(_ context.Context, _ map[string]interface{}) error {
					return errors.New("step3 intentionally failed")
				},
			},
		},
	}

	exec, err := orch.Execute(context.Background(), s, "exec-002", nil)

	require.Error(t, err)
	assert.Equal(t, saga.StatusCompensated, exec.Status)
	// step2 compensated before step1 (reverse order)
	assert.Equal(t, []string{"step2", "step1"}, compensated)
}
```

## Observability

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
		Help: "Total number of saga executions by name and final status",
	}, []string{"saga_name", "status"})

	sagaExecutionDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "saga_execution_duration_seconds",
		Help:    "Duration of saga executions in seconds",
		Buckets: []float64{0.1, 0.5, 1, 5, 10, 30, 60, 300},
	}, []string{"saga_name", "status"})

	sagaStepDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "saga_step_duration_seconds",
		Help:    "Duration of individual saga step executions",
		Buckets: []float64{0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30},
	}, []string{"saga_name", "step_name", "status"})

	sagaCompensationsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "saga_compensations_total",
		Help: "Total number of compensation flows triggered",
	}, []string{"saga_name", "failed_step"})
)
```

## Conclusion

The saga pattern trades the strong consistency of 2PC for availability and loose coupling. The implementation presented here provides the essential production requirements: durable state in PostgreSQL, idempotent step execution, exponential backoff with configurable retry limits, and comprehensive compensation tracking. The key insight for reliable saga implementation is that compensating transactions must be idempotent and must tolerate partial completion—in a distributed system, the compensation path will be retried, and partial compensations are a normal occurrence rather than an error case.
