---
title: "Go Saga Pattern: Distributed Transaction Management for Microservices"
date: 2030-10-16T00:00:00-05:00
draft: false
tags: ["Go", "Saga Pattern", "Distributed Transactions", "Microservices", "NATS", "Kafka", "Event-Driven"]
categories:
- Go
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "Production saga implementation in Go: choreography vs orchestration sagas, compensating transactions, saga log persistence, rollback coordination, event-driven saga with NATS/Kafka, timeout handling, and correctness testing."
more_link: "yes"
url: "/go-saga-pattern-distributed-transaction-management-microservices/"
---

Distributed transactions that span multiple microservices present a fundamental challenge: traditional ACID transactions cannot span service boundaries without distributed lock managers or two-phase commit protocols, both of which introduce availability risks and coupling that contradict microservice design goals. The saga pattern solves this by decomposing a distributed transaction into a sequence of local transactions, each publishing events that trigger the next step, with compensating transactions providing rollback semantics when any step fails.

<!--more-->

## Choreography vs Orchestration Sagas

### Choreography

In choreography, each service listens for events and reacts independently. There is no central coordinator — services know only about their immediate input events and the events they emit.

```
Order Service    Payment Service    Inventory Service    Shipping Service
     │                │                    │                    │
     │──OrderCreated──►│                   │                    │
     │                │                    │                    │
     │                │──PaymentProcessed──►│                   │
     │                │                    │                    │
     │                │                    │──InventoryReserved─►│
     │                │                    │                    │
     │                │                    │                    │──ShipmentCreated
     │                │                    │                    │
     [on failure]
     │◄──PaymentFailed─│
     │                │◄──InventoryFailed──│
```

**Advantages**: Loose coupling, no single point of failure, each service is independently deployable.

**Disadvantages**: Difficult to understand overall transaction flow, hard to debug, cyclic dependencies can emerge.

### Orchestration

An orchestrator explicitly sequences saga steps, handling success and failure transitions for each participant.

```
Saga Orchestrator
       │
       │──[Step 1] Reserve Inventory──►InventoryService
       │◄──[OK/FAIL]───────────────────
       │
       │──[Step 2] Process Payment─────►PaymentService
       │◄──[OK/FAIL]───────────────────
       │
       │──[Step 3] Create Shipment─────►ShippingService
       │◄──[OK/FAIL]───────────────────
       │
       [On any FAIL: execute compensating transactions in reverse]
```

**Advantages**: Explicit flow, centralized error handling, easy to monitor and debug.

**Disadvantages**: Orchestrator can become a bottleneck, introduces coupling through the orchestrator.

## Core Saga Infrastructure in Go

### Saga Definition and State Machine

```go
// pkg/saga/types.go
package saga

import (
    "context"
    "time"
)

// SagaStatus represents the current state of a saga execution.
type SagaStatus string

const (
    SagaStatusPending     SagaStatus = "PENDING"
    SagaStatusRunning     SagaStatus = "RUNNING"
    SagaStatusCompleted   SagaStatus = "COMPLETED"
    SagaStatusFailed      SagaStatus = "FAILED"
    SagaStatusCompensating SagaStatus = "COMPENSATING"
    SagaStatusCompensated SagaStatus = "COMPENSATED"
)

// StepStatus represents the state of an individual saga step.
type StepStatus string

const (
    StepStatusPending     StepStatus = "PENDING"
    StepStatusRunning     StepStatus = "RUNNING"
    StepStatusCompleted   StepStatus = "COMPLETED"
    StepStatusFailed      StepStatus = "FAILED"
    StepStatusCompensating StepStatus = "COMPENSATING"
    StepStatusCompensated StepStatus = "COMPENSATED"
    StepStatusSkipped     StepStatus = "SKIPPED"
)

// SagaStep defines a single step in a saga with its transaction
// and compensating transaction.
type SagaStep struct {
    Name        string
    Description string

    // Execute performs the forward transaction.
    // Returns a result payload stored in the saga log for use by later steps.
    Execute func(ctx context.Context, state SagaState) (SagaStepResult, error)

    // Compensate undoes the effects of Execute.
    // Must be idempotent - may be called multiple times.
    Compensate func(ctx context.Context, state SagaState) error

    // Timeout for the Execute step. Zero means no timeout.
    Timeout time.Duration

    // MaxRetries before marking the step as failed.
    MaxRetries int

    // RetryDelay is the base delay between retries.
    RetryDelay time.Duration
}

// SagaStepResult holds the output of a completed saga step.
type SagaStepResult struct {
    // Payload contains arbitrary step output stored in the saga log.
    // Available to subsequent steps via SagaState.StepResults.
    Payload map[string]interface{}
}

// SagaState provides read access to saga context during step execution.
type SagaState struct {
    SagaID     string
    CorrelationID string
    Input      map[string]interface{}
    StepResults map[string]SagaStepResult
}

// SagaDefinition describes a complete saga workflow.
type SagaDefinition struct {
    Name  string
    Steps []SagaStep
}

// SagaInstance tracks the runtime state of a saga execution.
type SagaInstance struct {
    ID            string
    DefinitionName string
    CorrelationID  string
    Status        SagaStatus
    Input         map[string]interface{}
    StepStates    []SagaStepState
    CreatedAt     time.Time
    UpdatedAt     time.Time
    CompletedAt   *time.Time
    Error         *string
}

// SagaStepState tracks runtime state for a single step.
type SagaStepState struct {
    StepName   string
    Status     StepStatus
    Result     *SagaStepResult
    Error      *string
    Attempts   int
    StartedAt  *time.Time
    CompletedAt *time.Time
}
```

### Saga Orchestrator Implementation

```go
// pkg/saga/orchestrator.go
package saga

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "time"

    "github.com/google/uuid"
)

// Repository persists saga state to durable storage.
type Repository interface {
    Create(ctx context.Context, instance *SagaInstance) error
    Update(ctx context.Context, instance *SagaInstance) error
    Get(ctx context.Context, sagaID string) (*SagaInstance, error)
    GetByCorrelationID(ctx context.Context, correlationID string) (*SagaInstance, error)
    ListActive(ctx context.Context) ([]*SagaInstance, error)
}

// Orchestrator executes saga definitions.
type Orchestrator struct {
    definitions map[string]SagaDefinition
    repo        Repository
    logger      *slog.Logger
}

// NewOrchestrator creates a new saga orchestrator.
func NewOrchestrator(repo Repository, logger *slog.Logger) *Orchestrator {
    return &Orchestrator{
        definitions: make(map[string]SagaDefinition),
        repo:        repo,
        logger:      logger,
    }
}

// Register adds a saga definition to the orchestrator.
func (o *Orchestrator) Register(def SagaDefinition) {
    o.definitions[def.Name] = def
}

// Start initiates a new saga execution.
func (o *Orchestrator) Start(
    ctx context.Context,
    definitionName string,
    correlationID string,
    input map[string]interface{},
) (*SagaInstance, error) {
    def, ok := o.definitions[definitionName]
    if !ok {
        return nil, fmt.Errorf("saga definition %q not found", definitionName)
    }

    // Idempotency: check if a saga with this correlationID already exists
    existing, err := o.repo.GetByCorrelationID(ctx, correlationID)
    if err == nil && existing != nil {
        o.logger.Info("saga already exists for correlation ID",
            "correlation_id", correlationID,
            "saga_id", existing.ID,
            "status", existing.Status)
        return existing, nil
    }

    stepStates := make([]SagaStepState, len(def.Steps))
    for i, step := range def.Steps {
        stepStates[i] = SagaStepState{
            StepName: step.Name,
            Status:   StepStatusPending,
        }
    }

    instance := &SagaInstance{
        ID:             uuid.New().String(),
        DefinitionName: definitionName,
        CorrelationID:  correlationID,
        Status:         SagaStatusPending,
        Input:          input,
        StepStates:     stepStates,
        CreatedAt:      time.Now().UTC(),
        UpdatedAt:      time.Now().UTC(),
    }

    if err := o.repo.Create(ctx, instance); err != nil {
        return nil, fmt.Errorf("persisting saga instance: %w", err)
    }

    // Execute asynchronously to allow immediate return to caller
    go o.execute(context.Background(), def, instance)

    return instance, nil
}

// execute runs all saga steps sequentially, triggering compensation on failure.
func (o *Orchestrator) execute(ctx context.Context, def SagaDefinition, instance *SagaInstance) {
    logger := o.logger.With(
        "saga_id", instance.ID,
        "saga_definition", def.Name,
        "correlation_id", instance.CorrelationID,
    )

    instance.Status = SagaStatusRunning
    instance.UpdatedAt = time.Now().UTC()
    if err := o.repo.Update(ctx, instance); err != nil {
        logger.Error("failed to update saga status", "error", err)
        return
    }

    // Build state from previously completed steps (for resume after crash)
    state := SagaState{
        SagaID:        instance.ID,
        CorrelationID: instance.CorrelationID,
        Input:         instance.Input,
        StepResults:   make(map[string]SagaStepResult),
    }
    for _, ss := range instance.StepStates {
        if ss.Status == StepStatusCompleted && ss.Result != nil {
            state.StepResults[ss.StepName] = *ss.Result
        }
    }

    // Execute forward transactions
    var failedAt int = -1
    for i, step := range def.Steps {
        stepState := &instance.StepStates[i]

        // Skip already completed steps (resume support)
        if stepState.Status == StepStatusCompleted {
            logger.Info("skipping completed step", "step", step.Name)
            continue
        }

        logger.Info("executing step", "step", step.Name, "attempt", stepState.Attempts+1)

        result, err := o.executeStep(ctx, step, state)
        stepState.Attempts++
        now := time.Now().UTC()

        if err != nil {
            errStr := err.Error()
            stepState.Status = StepStatusFailed
            stepState.Error = &errStr
            stepState.CompletedAt = &now
            instance.Error = &errStr

            logger.Error("step failed",
                "step", step.Name,
                "error", err,
                "attempts", stepState.Attempts)

            failedAt = i
            o.repo.Update(ctx, instance)
            break
        }

        stepState.Status = StepStatusCompleted
        stepState.Result = result
        stepState.CompletedAt = &now
        state.StepResults[step.Name] = *result

        o.repo.Update(ctx, instance)
        logger.Info("step completed", "step", step.Name)
    }

    if failedAt >= 0 {
        o.compensate(ctx, def, instance, failedAt, logger)
        return
    }

    now := time.Now().UTC()
    instance.Status = SagaStatusCompleted
    instance.CompletedAt = &now
    instance.UpdatedAt = now
    o.repo.Update(ctx, instance)

    logger.Info("saga completed successfully")
}

// executeStep runs a single saga step with retry and timeout handling.
func (o *Orchestrator) executeStep(
    ctx context.Context,
    step SagaStep,
    state SagaState,
) (*SagaStepResult, error) {
    maxRetries := step.MaxRetries
    if maxRetries < 1 {
        maxRetries = 1
    }

    var lastErr error
    for attempt := 0; attempt < maxRetries; attempt++ {
        if attempt > 0 {
            delay := step.RetryDelay
            if delay == 0 {
                delay = time.Duration(attempt) * 2 * time.Second
            }
            time.Sleep(delay)
        }

        stepCtx := ctx
        var cancel context.CancelFunc
        if step.Timeout > 0 {
            stepCtx, cancel = context.WithTimeout(ctx, step.Timeout)
            defer cancel()
        }

        result, err := step.Execute(stepCtx, state)
        if err == nil {
            return &result, nil
        }

        // Do not retry non-retriable errors
        var nonRetriable *NonRetriableError
        if errors.As(err, &nonRetriable) {
            return nil, err
        }

        lastErr = err
        o.logger.Warn("step execution failed, will retry",
            "step", step.Name,
            "attempt", attempt+1,
            "max_retries", maxRetries,
            "error", err)
    }

    return nil, fmt.Errorf("step %s failed after %d attempts: %w", step.Name, maxRetries, lastErr)
}

// compensate runs compensating transactions in reverse order.
func (o *Orchestrator) compensate(
    ctx context.Context,
    def SagaDefinition,
    instance *SagaInstance,
    failedAt int,
    logger *slog.Logger,
) {
    instance.Status = SagaStatusCompensating
    instance.UpdatedAt = time.Now().UTC()
    o.repo.Update(ctx, instance)

    state := SagaState{
        SagaID:        instance.ID,
        CorrelationID: instance.CorrelationID,
        Input:         instance.Input,
        StepResults:   make(map[string]SagaStepResult),
    }
    for _, ss := range instance.StepStates {
        if ss.Status == StepStatusCompleted && ss.Result != nil {
            state.StepResults[ss.StepName] = *ss.Result
        }
    }

    // Compensate in reverse order from the step before the failure
    var compensationErrors []error
    for i := failedAt - 1; i >= 0; i-- {
        step := def.Steps[i]
        stepState := &instance.StepStates[i]

        if stepState.Status != StepStatusCompleted {
            continue
        }

        logger.Info("compensating step", "step", step.Name)
        stepState.Status = StepStatusCompensating
        o.repo.Update(ctx, instance)

        // Compensation must be retried until it succeeds.
        // A failed compensation requires manual intervention.
        var compensationErr error
        for attempt := 0; attempt < 10; attempt++ {
            if attempt > 0 {
                time.Sleep(time.Duration(attempt) * 5 * time.Second)
            }

            compensationErr = step.Compensate(ctx, state)
            if compensationErr == nil {
                break
            }

            logger.Warn("compensation attempt failed",
                "step", step.Name,
                "attempt", attempt+1,
                "error", compensationErr)
        }

        now := time.Now().UTC()
        if compensationErr != nil {
            compensationErrors = append(compensationErrors, compensationErr)
            logger.Error("compensation failed permanently - manual intervention required",
                "step", step.Name,
                "error", compensationErr)
            errStr := fmt.Sprintf("compensation failed: %v", compensationErr)
            stepState.Status = StepStatusFailed
            stepState.Error = &errStr
        } else {
            stepState.Status = StepStatusCompensated
            stepState.CompletedAt = &now
            logger.Info("step compensated", "step", step.Name)
        }

        instance.UpdatedAt = now
        o.repo.Update(ctx, instance)
    }

    now := time.Now().UTC()
    if len(compensationErrors) > 0 {
        instance.Status = SagaStatusFailed
        errStr := fmt.Sprintf("compensation failed for %d steps", len(compensationErrors))
        instance.Error = &errStr
    } else {
        instance.Status = SagaStatusCompensated
        instance.CompletedAt = &now
    }
    instance.UpdatedAt = now
    o.repo.Update(ctx, instance)

    logger.Info("saga compensation complete", "final_status", instance.Status)
}

// NonRetriableError marks an error as not worth retrying.
type NonRetriableError struct {
    Cause error
}

func (e *NonRetriableError) Error() string {
    return e.Cause.Error()
}

func (e *NonRetriableError) Unwrap() error {
    return e.Cause
}

// NewNonRetriableError wraps an error as non-retriable.
func NewNonRetriableError(err error) error {
    return &NonRetriableError{Cause: err}
}
```

## Persisting Saga State with PostgreSQL

```go
// pkg/saga/postgres_repository.go
package saga

import (
    "context"
    "database/sql"
    "encoding/json"
    "errors"
    "fmt"
    "time"

    "github.com/jmoiron/sqlx"
    _ "github.com/jackc/pgx/v5/stdlib"
)

// PostgresRepository implements Repository backed by PostgreSQL.
type PostgresRepository struct {
    db *sqlx.DB
}

// NewPostgresRepository creates a new PostgreSQL-backed saga repository.
func NewPostgresRepository(db *sqlx.DB) *PostgresRepository {
    return &PostgresRepository{db: db}
}

// Schema creates the required tables.
const schemaSQL = `
CREATE TABLE IF NOT EXISTS sagas (
    id              TEXT PRIMARY KEY,
    definition_name TEXT NOT NULL,
    correlation_id  TEXT NOT NULL UNIQUE,
    status          TEXT NOT NULL,
    input_json      JSONB NOT NULL DEFAULT '{}',
    step_states_json JSONB NOT NULL DEFAULT '[]',
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sagas_correlation_id ON sagas (correlation_id);
CREATE INDEX IF NOT EXISTS idx_sagas_status ON sagas (status);
CREATE INDEX IF NOT EXISTS idx_sagas_definition_name ON sagas (definition_name);
`

func (r *PostgresRepository) CreateSchema(ctx context.Context) error {
    _, err := r.db.ExecContext(ctx, schemaSQL)
    return err
}

func (r *PostgresRepository) Create(ctx context.Context, instance *SagaInstance) error {
    inputJSON, err := json.Marshal(instance.Input)
    if err != nil {
        return fmt.Errorf("marshaling input: %w", err)
    }

    stepStatesJSON, err := json.Marshal(instance.StepStates)
    if err != nil {
        return fmt.Errorf("marshaling step states: %w", err)
    }

    _, err = r.db.ExecContext(ctx, `
        INSERT INTO sagas
            (id, definition_name, correlation_id, status, input_json,
             step_states_json, error, created_at, updated_at)
        VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
        instance.ID,
        instance.DefinitionName,
        instance.CorrelationID,
        string(instance.Status),
        inputJSON,
        stepStatesJSON,
        instance.Error,
        instance.CreatedAt,
        instance.UpdatedAt,
    )
    return err
}

func (r *PostgresRepository) Update(ctx context.Context, instance *SagaInstance) error {
    stepStatesJSON, err := json.Marshal(instance.StepStates)
    if err != nil {
        return fmt.Errorf("marshaling step states: %w", err)
    }

    result, err := r.db.ExecContext(ctx, `
        UPDATE sagas SET
            status           = $1,
            step_states_json = $2,
            error            = $3,
            updated_at       = $4,
            completed_at     = $5
        WHERE id = $6
    `,
        string(instance.Status),
        stepStatesJSON,
        instance.Error,
        time.Now().UTC(),
        instance.CompletedAt,
        instance.ID,
    )
    if err != nil {
        return err
    }

    rows, _ := result.RowsAffected()
    if rows == 0 {
        return fmt.Errorf("saga %s not found for update", instance.ID)
    }
    return nil
}

func (r *PostgresRepository) Get(ctx context.Context, sagaID string) (*SagaInstance, error) {
    return r.scanInstance(ctx, `
        SELECT id, definition_name, correlation_id, status,
               input_json, step_states_json, error,
               created_at, updated_at, completed_at
        FROM sagas WHERE id = $1
    `, sagaID)
}

func (r *PostgresRepository) GetByCorrelationID(ctx context.Context, correlationID string) (*SagaInstance, error) {
    return r.scanInstance(ctx, `
        SELECT id, definition_name, correlation_id, status,
               input_json, step_states_json, error,
               created_at, updated_at, completed_at
        FROM sagas WHERE correlation_id = $1
    `, correlationID)
}

func (r *PostgresRepository) ListActive(ctx context.Context) ([]*SagaInstance, error) {
    rows, err := r.db.QueryContext(ctx, `
        SELECT id, definition_name, correlation_id, status,
               input_json, step_states_json, error,
               created_at, updated_at, completed_at
        FROM sagas
        WHERE status IN ('PENDING', 'RUNNING', 'COMPENSATING')
        ORDER BY created_at ASC
    `)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var instances []*SagaInstance
    for rows.Next() {
        instance, err := r.scanRow(rows)
        if err != nil {
            return nil, err
        }
        instances = append(instances, instance)
    }
    return instances, rows.Err()
}

func (r *PostgresRepository) scanInstance(ctx context.Context, query string, args ...interface{}) (*SagaInstance, error) {
    row := r.db.QueryRowContext(ctx, query, args...)
    instance, err := r.scanRow(row)
    if errors.Is(err, sql.ErrNoRows) {
        return nil, nil
    }
    return instance, err
}

type rowScanner interface {
    Scan(dest ...interface{}) error
}

func (r *PostgresRepository) scanRow(row rowScanner) (*SagaInstance, error) {
    var (
        instance         SagaInstance
        status           string
        inputJSON        []byte
        stepStatesJSON   []byte
        errStr           sql.NullString
        completedAt      sql.NullTime
    )

    err := row.Scan(
        &instance.ID,
        &instance.DefinitionName,
        &instance.CorrelationID,
        &status,
        &inputJSON,
        &stepStatesJSON,
        &errStr,
        &instance.CreatedAt,
        &instance.UpdatedAt,
        &completedAt,
    )
    if err != nil {
        return nil, err
    }

    instance.Status = SagaStatus(status)

    if err := json.Unmarshal(inputJSON, &instance.Input); err != nil {
        return nil, fmt.Errorf("unmarshaling input: %w", err)
    }
    if err := json.Unmarshal(stepStatesJSON, &instance.StepStates); err != nil {
        return nil, fmt.Errorf("unmarshaling step states: %w", err)
    }
    if errStr.Valid {
        instance.Error = &errStr.String
    }
    if completedAt.Valid {
        t := completedAt.Time
        instance.CompletedAt = &t
    }

    return &instance, nil
}
```

## Order Fulfillment Saga Example

```go
// internal/sagas/order_fulfillment.go
package sagas

import (
    "context"
    "fmt"
    "time"

    "your.org/pkg/saga"
    "your.org/internal/inventory"
    "your.org/internal/payment"
    "your.org/internal/shipping"
    "your.org/internal/notifications"
)

// BuildOrderFulfillmentSaga defines the order fulfillment saga.
func BuildOrderFulfillmentSaga(
    inventorySvc *inventory.Service,
    paymentSvc *payment.Service,
    shippingSvc *shipping.Service,
    notificationSvc *notifications.Service,
) saga.SagaDefinition {
    return saga.SagaDefinition{
        Name: "order-fulfillment",
        Steps: []saga.SagaStep{
            {
                Name:        "reserve-inventory",
                Description: "Reserve items from inventory",
                Timeout:     10 * time.Second,
                MaxRetries:  3,
                RetryDelay:  2 * time.Second,

                Execute: func(ctx context.Context, state saga.SagaState) (saga.SagaStepResult, error) {
                    orderID, _ := state.Input["order_id"].(string)
                    items, _ := state.Input["items"].([]interface{})

                    reservation, err := inventorySvc.ReserveItems(ctx, inventory.ReservationRequest{
                        OrderID: orderID,
                        Items:   items,
                    })
                    if err != nil {
                        if inventory.IsInsufficientStockError(err) {
                            // Don't retry insufficient stock - it won't fix itself
                            return saga.SagaStepResult{}, saga.NewNonRetriableError(
                                fmt.Errorf("insufficient stock: %w", err),
                            )
                        }
                        return saga.SagaStepResult{}, err
                    }

                    return saga.SagaStepResult{
                        Payload: map[string]interface{}{
                            "reservation_id": reservation.ID,
                            "reserved_items": reservation.Items,
                        },
                    }, nil
                },

                Compensate: func(ctx context.Context, state saga.SagaState) error {
                    reservationID, _ := state.StepResults["reserve-inventory"].Payload["reservation_id"].(string)
                    if reservationID == "" {
                        return nil // Nothing to compensate
                    }
                    return inventorySvc.CancelReservation(ctx, reservationID)
                },
            },

            {
                Name:        "process-payment",
                Description: "Charge the customer's payment method",
                Timeout:     30 * time.Second,
                MaxRetries:  2,
                RetryDelay:  5 * time.Second,

                Execute: func(ctx context.Context, state saga.SagaState) (saga.SagaStepResult, error) {
                    orderID, _ := state.Input["order_id"].(string)
                    amount, _ := state.Input["amount"].(float64)
                    paymentMethodID, _ := state.Input["payment_method_id"].(string)

                    charge, err := paymentSvc.ProcessPayment(ctx, payment.ChargeRequest{
                        OrderID:         orderID,
                        Amount:          amount,
                        PaymentMethodID: paymentMethodID,
                        // Idempotency key prevents double-charging on retry
                        IdempotencyKey:  fmt.Sprintf("order-%s-charge", orderID),
                    })
                    if err != nil {
                        if payment.IsDeclinedError(err) {
                            return saga.SagaStepResult{}, saga.NewNonRetriableError(
                                fmt.Errorf("payment declined: %w", err),
                            )
                        }
                        return saga.SagaStepResult{}, err
                    }

                    return saga.SagaStepResult{
                        Payload: map[string]interface{}{
                            "charge_id":       charge.ID,
                            "amount_charged":  charge.Amount,
                            "payment_status":  charge.Status,
                        },
                    }, nil
                },

                Compensate: func(ctx context.Context, state saga.SagaState) error {
                    chargeID, _ := state.StepResults["process-payment"].Payload["charge_id"].(string)
                    if chargeID == "" {
                        return nil
                    }
                    return paymentSvc.RefundCharge(ctx, payment.RefundRequest{
                        ChargeID:       chargeID,
                        IdempotencyKey: fmt.Sprintf("refund-%s", chargeID),
                    })
                },
            },

            {
                Name:        "create-shipment",
                Description: "Create shipment with fulfillment center",
                Timeout:     15 * time.Second,
                MaxRetries:  3,
                RetryDelay:  3 * time.Second,

                Execute: func(ctx context.Context, state saga.SagaState) (saga.SagaStepResult, error) {
                    orderID, _ := state.Input["order_id"].(string)
                    shippingAddress, _ := state.Input["shipping_address"].(map[string]interface{})
                    reservedItems, _ := state.StepResults["reserve-inventory"].Payload["reserved_items"]

                    shipment, err := shippingSvc.CreateShipment(ctx, shipping.CreateRequest{
                        OrderID:         orderID,
                        ShippingAddress: shippingAddress,
                        Items:           reservedItems,
                    })
                    if err != nil {
                        return saga.SagaStepResult{}, err
                    }

                    return saga.SagaStepResult{
                        Payload: map[string]interface{}{
                            "shipment_id":     shipment.ID,
                            "tracking_number": shipment.TrackingNumber,
                            "carrier":         shipment.Carrier,
                        },
                    }, nil
                },

                Compensate: func(ctx context.Context, state saga.SagaState) error {
                    shipmentID, _ := state.StepResults["create-shipment"].Payload["shipment_id"].(string)
                    if shipmentID == "" {
                        return nil
                    }
                    return shippingSvc.CancelShipment(ctx, shipmentID)
                },
            },

            {
                Name:        "send-confirmation",
                Description: "Send order confirmation email",
                Timeout:     10 * time.Second,
                MaxRetries:  5,
                RetryDelay:  10 * time.Second,

                Execute: func(ctx context.Context, state saga.SagaState) (saga.SagaStepResult, error) {
                    orderID, _ := state.Input["order_id"].(string)
                    customerEmail, _ := state.Input["customer_email"].(string)
                    trackingNumber, _ := state.StepResults["create-shipment"].Payload["tracking_number"].(string)

                    err := notificationSvc.SendOrderConfirmation(ctx, notifications.OrderConfirmation{
                        OrderID:        orderID,
                        CustomerEmail:  customerEmail,
                        TrackingNumber: trackingNumber,
                    })
                    // Notification failures don't fail the saga
                    if err != nil {
                        // Log but don't propagate
                        return saga.SagaStepResult{
                            Payload: map[string]interface{}{
                                "notification_sent": false,
                                "error":             err.Error(),
                            },
                        }, nil
                    }

                    return saga.SagaStepResult{
                        Payload: map[string]interface{}{
                            "notification_sent": true,
                        },
                    }, nil
                },

                // No compensation needed for notifications
                Compensate: func(ctx context.Context, state saga.SagaState) error {
                    return nil
                },
            },
        },
    }
}
```

## Event-Driven Saga with NATS JetStream

```go
// pkg/saga/nats_event_bus.go
package saga

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

// SagaEvent is published to the event bus after each saga state transition.
type SagaEvent struct {
    EventID     string                 `json:"event_id"`
    SagaID      string                 `json:"saga_id"`
    CorrelationID string               `json:"correlation_id"`
    EventType   string                 `json:"event_type"`
    StepName    string                 `json:"step_name,omitempty"`
    Status      string                 `json:"status"`
    Payload     map[string]interface{} `json:"payload,omitempty"`
    Timestamp   time.Time              `json:"timestamp"`
}

// NATSEventPublisher publishes saga events to NATS JetStream.
type NATSEventPublisher struct {
    js      jetstream.JetStream
    subject string
}

// NewNATSEventPublisher creates a NATS JetStream publisher.
func NewNATSEventPublisher(nc *nats.Conn, streamName string) (*NATSEventPublisher, error) {
    js, err := jetstream.New(nc)
    if err != nil {
        return nil, fmt.Errorf("creating JetStream context: %w", err)
    }

    ctx := context.Background()
    _, err = js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
        Name:     streamName,
        Subjects: []string{fmt.Sprintf("saga.events.>")},
        MaxAge:   7 * 24 * time.Hour,  // Retain events for 7 days
        Replicas: 3,
        Storage:  jetstream.FileStorage,
        // Ensure ordering per saga ID
        SubjectTransform: &jetstream.SubjectTransformConfig{
            Src:  "saga.events.>",
            Dest: "saga.events.>",
        },
    })
    if err != nil {
        return nil, fmt.Errorf("creating JetStream stream: %w", err)
    }

    return &NATSEventPublisher{
        js:      js,
        subject: "saga.events",
    }, nil
}

// Publish sends a saga event to NATS.
func (p *NATSEventPublisher) Publish(ctx context.Context, event SagaEvent) error {
    data, err := json.Marshal(event)
    if err != nil {
        return fmt.Errorf("marshaling event: %w", err)
    }

    subject := fmt.Sprintf("%s.%s.%s", p.subject, event.SagaID, event.EventType)
    _, err = p.js.Publish(ctx, subject, data,
        jetstream.WithMsgID(event.EventID),  // Deduplication
    )
    return err
}
```

## Testing Saga Correctness with Fault Injection

```go
// pkg/saga/testing.go
package sagatesting

import (
    "context"
    "errors"
    "sync/atomic"
    "testing"
    "time"

    "your.org/pkg/saga"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

// FaultInjector injects controlled failures into saga steps for testing.
type FaultInjector struct {
    failures map[string]*StepFaultConfig
}

// StepFaultConfig configures failure injection for a specific step.
type StepFaultConfig struct {
    // FailOnAttempt specifies which attempt number to fail (1-indexed).
    // 0 means always fail.
    FailOnAttempt int
    // Error to return when failing.
    Error error
    // attemptCount tracks how many times this step has been called.
    attemptCount atomic.Int32
}

// NewFaultInjector creates a fault injector.
func NewFaultInjector() *FaultInjector {
    return &FaultInjector{
        failures: make(map[string]*StepFaultConfig),
    }
}

// InjectFault configures a step to fail on a specific attempt.
func (f *FaultInjector) InjectFault(stepName string, config *StepFaultConfig) {
    f.failures[stepName] = config
}

// WrapStep wraps a saga step with fault injection.
func (f *FaultInjector) WrapStep(step saga.SagaStep) saga.SagaStep {
    config, ok := f.failures[step.Name]
    if !ok {
        return step
    }

    originalExecute := step.Execute
    step.Execute = func(ctx context.Context, state saga.SagaState) (saga.SagaStepResult, error) {
        attempt := int(config.attemptCount.Add(1))

        if config.FailOnAttempt == 0 || attempt == config.FailOnAttempt {
            return saga.SagaStepResult{}, config.Error
        }

        return originalExecute(ctx, state)
    }

    return step
}

// TestOrderFulfillmentSagaHappyPath tests successful saga execution.
func TestOrderFulfillmentSagaHappyPath(t *testing.T) {
    t.Parallel()

    // Setup
    repo := NewInMemoryRepository()
    orchestrator := saga.NewOrchestrator(repo, testLogger(t))

    // Use test doubles for all external services
    inventorySvc := NewMockInventoryService()
    paymentSvc := NewMockPaymentService()
    shippingSvc := NewMockShippingService()
    notificationSvc := NewMockNotificationService()

    sagaDef := BuildTestOrderFulfillmentSaga(
        inventorySvc, paymentSvc, shippingSvc, notificationSvc,
    )
    orchestrator.Register(sagaDef)

    // Execute
    instance, err := orchestrator.Start(context.Background(), "order-fulfillment", "order-123", map[string]interface{}{
        "order_id":          "order-123",
        "customer_email":    "user@example.com",
        "amount":            99.99,
        "payment_method_id": "pm_test_visa",
        "items": []interface{}{
            map[string]interface{}{"sku": "WIDGET-001", "qty": 2},
        },
        "shipping_address": map[string]interface{}{
            "street": "123 Main St",
            "city":   "Anytown",
            "state":  "CA",
            "zip":    "90210",
        },
    })
    require.NoError(t, err)
    require.NotNil(t, instance)

    // Wait for async execution with polling
    require.Eventually(t, func() bool {
        updated, _ := repo.Get(context.Background(), instance.ID)
        return updated != nil && (updated.Status == saga.SagaStatusCompleted ||
            updated.Status == saga.SagaStatusFailed)
    }, 10*time.Second, 100*time.Millisecond, "saga did not complete")

    // Verify
    final, err := repo.Get(context.Background(), instance.ID)
    require.NoError(t, err)
    assert.Equal(t, saga.SagaStatusCompleted, final.Status)

    // Verify all steps completed
    for _, ss := range final.StepStates {
        assert.Equal(t, saga.StepStatusCompleted, ss.Status,
            "step %s should be completed", ss.StepName)
    }

    // Verify no compensations ran
    assert.True(t, inventorySvc.CancelReservationCallCount() == 0)
    assert.True(t, paymentSvc.RefundCallCount() == 0)
}

// TestOrderFulfillmentSagaPaymentFailure tests compensation on payment failure.
func TestOrderFulfillmentSagaPaymentFailure(t *testing.T) {
    t.Parallel()

    repo := NewInMemoryRepository()
    orchestrator := saga.NewOrchestrator(repo, testLogger(t))

    inventorySvc := NewMockInventoryService()
    paymentSvc := NewMockPaymentService()
    paymentSvc.SetDeclineAll(true)  // Simulate card decline
    shippingSvc := NewMockShippingService()
    notificationSvc := NewMockNotificationService()

    sagaDef := BuildTestOrderFulfillmentSaga(
        inventorySvc, paymentSvc, shippingSvc, notificationSvc,
    )
    orchestrator.Register(sagaDef)

    instance, err := orchestrator.Start(context.Background(), "order-fulfillment", "order-456", map[string]interface{}{
        "order_id":          "order-456",
        "amount":            99.99,
        "payment_method_id": "pm_test_declined",
    })
    require.NoError(t, err)

    // Wait for compensation to complete
    require.Eventually(t, func() bool {
        updated, _ := repo.Get(context.Background(), instance.ID)
        return updated != nil && (updated.Status == saga.SagaStatusCompensated ||
            updated.Status == saga.SagaStatusFailed)
    }, 30*time.Second, 100*time.Millisecond)

    final, _ := repo.Get(context.Background(), instance.ID)
    assert.Equal(t, saga.SagaStatusCompensated, final.Status)

    // Verify inventory reservation was cancelled
    assert.Equal(t, 1, inventorySvc.CancelReservationCallCount(),
        "inventory reservation should have been cancelled")

    // Verify payment was not charged (or was refunded if charged before decline)
    assert.Equal(t, 0, paymentSvc.RefundCallCount(),
        "no refund needed for declined payment")

    // Verify shipment was never created
    assert.Equal(t, 0, shippingSvc.CreateShipmentCallCount())
}
```

The saga pattern requires accepting eventual consistency as the operational model. When teams are comfortable with that constraint and have invested in observability tooling to surface stuck or failed sagas, it provides a robust foundation for distributed business transactions that is far more available and operationally tractable than distributed lock-based approaches.
