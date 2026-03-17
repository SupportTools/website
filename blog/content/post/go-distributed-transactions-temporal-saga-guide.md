---
title: "Go Distributed Transactions: Two-Phase Commit, Saga Orchestration with Temporal, and Compensation Logic"
date: 2028-09-04T00:00:00-05:00
draft: false
tags: ["Go", "Distributed Systems", "Temporal", "Saga", "Two-Phase Commit"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Implement distributed transactions in Go using Two-Phase Commit for tight consistency, Saga orchestration with Temporal for long-running workflows, and robust compensation logic for failure recovery."
more_link: "yes"
url: "/go-distributed-transactions-temporal-saga-guide/"
---

Distributed transactions are one of the hardest problems in microservices. A monolith executes business logic inside a single ACID database transaction — rollback is free. In a microservice architecture, a single business operation may touch five services and four databases. When service 4 fails after services 1-3 have committed, you need a strategy. This guide covers Two-Phase Commit for tight consistency requirements, Saga orchestration with Temporal for long-running workflows, and the compensation patterns that make rollback reliable.

<!--more-->

# Go Distributed Transactions: Two-Phase Commit, Saga Orchestration with Temporal, and Compensation Logic

## Section 1: The Distributed Transaction Problem

Consider an e-commerce order placement that must:
1. Reserve inventory (Inventory Service)
2. Charge the customer (Payment Service)
3. Create a shipment (Fulfillment Service)
4. Send a confirmation email (Notification Service)

Each service has its own database. If step 3 fails after 1 and 2 succeed, you have a charged customer with no shipment — a business disaster.

**Options:**

| Approach | Consistency | Complexity | Suitable For |
|----------|------------|------------|--------------|
| Two-Phase Commit (2PC) | Strong (ACID) | High | Short txns, same tech stack |
| Saga (choreography) | Eventual | Medium | Autonomous services |
| Saga (orchestration) | Eventual | High | Complex workflows |
| Outbox + CDC | Eventual | Medium | Event-driven |

## Section 2: Two-Phase Commit Implementation in Go

2PC coordinates a distributed transaction through a coordinator that drives two phases: prepare and commit/abort.

```go
// internal/twophase/coordinator.go
package twophase

import (
    "context"
    "fmt"
    "sync"
    "time"

    "go.uber.org/zap"
)

// Participant is a service that can participate in a 2PC transaction.
type Participant interface {
    // Prepare checks if the participant can commit and locks resources.
    Prepare(ctx context.Context, txID string, data interface{}) error
    // Commit applies the prepared changes.
    Commit(ctx context.Context, txID string) error
    // Abort rolls back the prepared changes.
    Abort(ctx context.Context, txID string) error
}

type TxState int

const (
    TxStatePreparing TxState = iota
    TxStatePrepared
    TxStateCommitting
    TxStateCommitted
    TxStateAborting
    TxStateAborted
)

type Transaction struct {
    ID           string
    State        TxState
    Participants []Participant
    PreparedBy   []bool
    mu           sync.Mutex
    log          *zap.Logger
}

// Coordinator manages 2PC transactions.
type Coordinator struct {
    log *zap.Logger
}

func NewCoordinator(log *zap.Logger) *Coordinator {
    return &Coordinator{log: log}
}

// Execute runs a 2PC transaction across all participants.
func (c *Coordinator) Execute(ctx context.Context, participants []Participant, data interface{}) error {
    txID := generateTxID()
    tx := &Transaction{
        ID:           txID,
        State:        TxStatePreparing,
        Participants: participants,
        PreparedBy:   make([]bool, len(participants)),
        log:          c.log,
    }

    c.log.Info("starting 2PC transaction", zap.String("tx_id", txID))

    // Phase 1: Prepare
    if err := tx.prepare(ctx, data); err != nil {
        c.log.Error("prepare phase failed, aborting",
            zap.String("tx_id", txID), zap.Error(err))
        tx.abort(ctx)
        return fmt.Errorf("2PC prepare failed: %w", err)
    }

    // Phase 2: Commit
    if err := tx.commit(ctx); err != nil {
        // This should not happen after all participants prepared.
        // If it does, we need manual intervention or a recovery log.
        c.log.Error("CRITICAL: commit failed after successful prepare",
            zap.String("tx_id", txID), zap.Error(err))
        return fmt.Errorf("2PC commit failed after prepare: %w", err)
    }

    c.log.Info("2PC transaction committed", zap.String("tx_id", txID))
    return nil
}

func (tx *Transaction) prepare(ctx context.Context, data interface{}) error {
    tx.mu.Lock()
    tx.State = TxStatePreparing
    tx.mu.Unlock()

    // Parallel prepare with timeout
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    type result struct {
        idx int
        err error
    }
    results := make(chan result, len(tx.Participants))

    for i, p := range tx.Participants {
        go func(idx int, participant Participant) {
            err := participant.Prepare(ctx, tx.ID, data)
            results <- result{idx: idx, err: err}
        }(i, p)
    }

    var firstErr error
    prepared := 0
    for range tx.Participants {
        r := <-results
        if r.err != nil {
            if firstErr == nil {
                firstErr = fmt.Errorf("participant %d prepare failed: %w", r.idx, r.err)
            }
        } else {
            tx.mu.Lock()
            tx.PreparedBy[r.idx] = true
            tx.mu.Unlock()
            prepared++
        }
    }

    if firstErr != nil {
        return firstErr
    }

    tx.mu.Lock()
    tx.State = TxStatePrepared
    tx.mu.Unlock()
    return nil
}

func (tx *Transaction) commit(ctx context.Context) error {
    tx.mu.Lock()
    tx.State = TxStateCommitting
    tx.mu.Unlock()

    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    var wg sync.WaitGroup
    errs := make(chan error, len(tx.Participants))

    for i, p := range tx.Participants {
        if !tx.PreparedBy[i] {
            continue
        }
        wg.Add(1)
        go func(participant Participant) {
            defer wg.Done()
            if err := participant.Commit(ctx, tx.ID); err != nil {
                errs <- err
            }
        }(p)
    }

    wg.Wait()
    close(errs)

    for err := range errs {
        if err != nil {
            return err
        }
    }

    tx.mu.Lock()
    tx.State = TxStateCommitted
    tx.mu.Unlock()
    return nil
}

func (tx *Transaction) abort(ctx context.Context) {
    tx.mu.Lock()
    tx.State = TxStateAborting
    tx.mu.Unlock()

    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    var wg sync.WaitGroup
    for i, p := range tx.Participants {
        if !tx.PreparedBy[i] {
            continue
        }
        wg.Add(1)
        go func(participant Participant, idx int) {
            defer wg.Done()
            if err := participant.Abort(ctx, tx.ID); err != nil {
                tx.log.Error("abort failed",
                    zap.String("tx_id", tx.ID),
                    zap.Int("participant", idx),
                    zap.Error(err))
            }
        }(p, i)
    }
    wg.Wait()

    tx.mu.Lock()
    tx.State = TxStateAborted
    tx.mu.Unlock()
}

func generateTxID() string {
    return fmt.Sprintf("tx-%d", time.Now().UnixNano())
}
```

### Concrete Participant Implementation

```go
// internal/inventory/participant.go
package inventory

import (
    "context"
    "database/sql"
    "fmt"
    "sync"
)

type ReservationData struct {
    ProductID string
    Quantity  int
    OrderID   string
}

// InventoryParticipant implements the 2PC Participant interface.
type InventoryParticipant struct {
    db      *sql.DB
    pending sync.Map // txID -> *sql.Tx (prepared but not committed)
}

func (p *InventoryParticipant) Prepare(ctx context.Context, txID string, data interface{}) error {
    req, ok := data.(*ReservationData)
    if !ok {
        return fmt.Errorf("invalid data type for inventory prepare")
    }

    tx, err := p.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }

    // Check and lock inventory
    var available int
    row := tx.QueryRowContext(ctx,
        "SELECT available_qty FROM inventory WHERE product_id = $1 FOR UPDATE",
        req.ProductID)
    if err := row.Scan(&available); err != nil {
        tx.Rollback()
        return fmt.Errorf("query inventory: %w", err)
    }

    if available < req.Quantity {
        tx.Rollback()
        return fmt.Errorf("insufficient inventory: have %d, need %d", available, req.Quantity)
    }

    // Deduct inventory but do NOT commit yet
    _, err = tx.ExecContext(ctx,
        "UPDATE inventory SET available_qty = available_qty - $1, reserved_qty = reserved_qty + $1 WHERE product_id = $2",
        req.Quantity, req.ProductID)
    if err != nil {
        tx.Rollback()
        return fmt.Errorf("update inventory: %w", err)
    }

    // Record the pending reservation
    _, err = tx.ExecContext(ctx,
        "INSERT INTO reservations (tx_id, product_id, quantity, order_id, status) VALUES ($1, $2, $3, $4, 'prepared')",
        txID, req.ProductID, req.Quantity, req.OrderID)
    if err != nil {
        tx.Rollback()
        return fmt.Errorf("insert reservation: %w", err)
    }

    // Store the open transaction — will be committed or rolled back later
    p.pending.Store(txID, tx)
    return nil
}

func (p *InventoryParticipant) Commit(ctx context.Context, txID string) error {
    val, ok := p.pending.LoadAndDelete(txID)
    if !ok {
        return fmt.Errorf("no prepared transaction for txID: %s", txID)
    }
    tx := val.(*sql.Tx)

    _, err := tx.ExecContext(ctx,
        "UPDATE reservations SET status = 'committed' WHERE tx_id = $1", txID)
    if err != nil {
        tx.Rollback()
        return fmt.Errorf("update reservation status: %w", err)
    }

    return tx.Commit()
}

func (p *InventoryParticipant) Abort(ctx context.Context, txID string) error {
    val, ok := p.pending.LoadAndDelete(txID)
    if !ok {
        // Already aborted or never prepared — idempotent
        return nil
    }
    tx := val.(*sql.Tx)
    return tx.Rollback()
}
```

## Section 3: Saga Pattern with Temporal

Temporal is a workflow engine that persists every step of a workflow, enabling durable execution through failures.

```bash
# Install Temporal server for development
curl -sSf https://temporal.download/cli.sh | sh
temporal server start-dev --db-filename /tmp/temporal.db

# Or via Docker
docker run --rm -p 7233:7233 temporalio/auto-setup:latest

# Install Go SDK
go get go.temporal.io/sdk@latest
```

### Saga Workflow Definition

```go
// workflow/order_saga.go
package workflow

import (
    "fmt"
    "time"

    "go.temporal.io/sdk/temporal"
    "go.temporal.io/sdk/workflow"
)

// OrderInput contains all data needed for the order saga.
type OrderInput struct {
    OrderID    string
    CustomerID string
    ProductID  string
    Quantity   int
    Amount     float64
    Email      string
}

// OrderResult is returned when the saga completes.
type OrderResult struct {
    OrderID     string
    ShipmentID  string
    PaymentID   string
}

// OrderSaga orchestrates the order placement saga.
// Temporal persists every activity result — if the worker crashes,
// execution resumes from where it left off.
func OrderSaga(ctx workflow.Context, input OrderInput) (*OrderResult, error) {
    logger := workflow.GetLogger(ctx)
    logger.Info("OrderSaga started", "orderID", input.OrderID)

    // Track what has been done for compensation
    var compensations []func(workflow.Context) error

    ao := workflow.ActivityOptions{
        StartToCloseTimeout: 30 * time.Second,
        RetryPolicy: &temporal.RetryPolicy{
            InitialInterval:    time.Second,
            BackoffCoefficient: 2.0,
            MaximumInterval:    30 * time.Second,
            MaximumAttempts:    3,
        },
    }
    ctx = workflow.WithActivityOptions(ctx, ao)

    result := &OrderResult{OrderID: input.OrderID}

    // Step 1: Reserve Inventory
    var inventoryResult InventoryResult
    if err := workflow.ExecuteActivity(ctx, ReserveInventoryActivity, input).Get(ctx, &inventoryResult); err != nil {
        return nil, runCompensations(ctx, compensations, fmt.Errorf("reserve inventory: %w", err))
    }
    compensations = append(compensations, func(ctx workflow.Context) error {
        return workflow.ExecuteActivity(ctx, ReleaseInventoryActivity, inventoryResult.ReservationID).Get(ctx, nil)
    })
    logger.Info("Inventory reserved", "reservationID", inventoryResult.ReservationID)

    // Step 2: Charge Payment
    var paymentResult PaymentResult
    if err := workflow.ExecuteActivity(ctx, ChargePaymentActivity, input).Get(ctx, &paymentResult); err != nil {
        return nil, runCompensations(ctx, compensations, fmt.Errorf("charge payment: %w", err))
    }
    result.PaymentID = paymentResult.PaymentID
    compensations = append(compensations, func(ctx workflow.Context) error {
        return workflow.ExecuteActivity(ctx, RefundPaymentActivity, paymentResult.PaymentID).Get(ctx, nil)
    })
    logger.Info("Payment charged", "paymentID", paymentResult.PaymentID)

    // Step 3: Create Shipment
    var shipmentResult ShipmentResult
    if err := workflow.ExecuteActivity(ctx, CreateShipmentActivity, input).Get(ctx, &shipmentResult); err != nil {
        return nil, runCompensations(ctx, compensations, fmt.Errorf("create shipment: %w", err))
    }
    result.ShipmentID = shipmentResult.ShipmentID
    compensations = append(compensations, func(ctx workflow.Context) error {
        return workflow.ExecuteActivity(ctx, CancelShipmentActivity, shipmentResult.ShipmentID).Get(ctx, nil)
    })
    logger.Info("Shipment created", "shipmentID", shipmentResult.ShipmentID)

    // Step 4: Send Confirmation (best-effort, no compensation needed)
    _ = workflow.ExecuteActivity(ctx, SendConfirmationActivity, input, result).Get(ctx, nil)

    logger.Info("OrderSaga completed successfully", "orderID", input.OrderID)
    return result, nil
}

// runCompensations executes all compensation actions in reverse order.
func runCompensations(ctx workflow.Context, compensations []func(workflow.Context) error, originalErr error) error {
    logger := workflow.GetLogger(ctx)
    logger.Info("Running compensations", "count", len(compensations))

    // Compensation activities get more retries and longer timeout
    compensationCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
        StartToCloseTimeout: 60 * time.Second,
        RetryPolicy: &temporal.RetryPolicy{
            MaximumAttempts: 10,
        },
    })

    // Execute in reverse (LIFO) order
    for i := len(compensations) - 1; i >= 0; i-- {
        if err := compensations[i](compensationCtx); err != nil {
            logger.Error("compensation failed", "step", i, "error", err)
            // Continue with other compensations even if one fails
        }
    }

    return fmt.Errorf("saga failed (compensations executed): %w", originalErr)
}
```

### Activity Implementations

```go
// activities/inventory.go
package activities

import (
    "context"
    "fmt"
    "time"

    "go.temporal.io/sdk/activity"
)

type InventoryResult struct {
    ReservationID string
}

// ReserveInventoryActivity is idempotent — safe to retry.
func ReserveInventoryActivity(ctx context.Context, input workflow.OrderInput) (*InventoryResult, error) {
    logger := activity.GetLogger(ctx)
    logger.Info("Reserving inventory",
        "orderID", input.OrderID,
        "productID", input.ProductID,
        "quantity", input.Quantity)

    // Heartbeat for long-running activities
    activity.RecordHeartbeat(ctx, "reserving")

    // Use the orderID as idempotency key to prevent double-reservation
    // on retries
    reservationID, err := inventoryService.Reserve(ctx,
        input.OrderID,  // idempotency key
        input.ProductID,
        input.Quantity)
    if err != nil {
        return nil, fmt.Errorf("inventory service error: %w", err)
    }

    return &InventoryResult{ReservationID: reservationID}, nil
}

func ReleaseInventoryActivity(ctx context.Context, reservationID string) error {
    activity.GetLogger(ctx).Info("Releasing inventory reservation", "reservationID", reservationID)
    return inventoryService.Release(ctx, reservationID)
}
```

```go
// activities/payment.go
package activities

import (
    "context"
    "fmt"

    "go.temporal.io/sdk/activity"
)

type PaymentResult struct {
    PaymentID string
    Amount    float64
}

func ChargePaymentActivity(ctx context.Context, input workflow.OrderInput) (*PaymentResult, error) {
    activity.GetLogger(ctx).Info("Charging payment",
        "orderID", input.OrderID,
        "amount", input.Amount)

    activity.RecordHeartbeat(ctx, "charging")

    // Idempotency key prevents double-charge on retry
    paymentID, err := paymentService.Charge(ctx,
        input.OrderID,    // idempotency key
        input.CustomerID,
        input.Amount)
    if err != nil {
        // Classify error: don't retry payment declines
        if isPaymentDeclined(err) {
            return nil, temporal.NewNonRetryableApplicationError(
                "payment declined",
                "PAYMENT_DECLINED",
                err)
        }
        return nil, err
    }

    return &PaymentResult{PaymentID: paymentID, Amount: input.Amount}, nil
}

func RefundPaymentActivity(ctx context.Context, paymentID string) error {
    activity.GetLogger(ctx).Info("Refunding payment", "paymentID", paymentID)
    return paymentService.Refund(ctx, paymentID)
}

func isPaymentDeclined(err error) bool {
    // Check error type from payment gateway
    return err != nil && err.Error() == "card_declined"
}
```

### Worker Registration

```go
// worker/main.go
package main

import (
    "log"

    "go.temporal.io/sdk/client"
    "go.temporal.io/sdk/worker"

    "github.com/myorg/ordersvc/activities"
    "github.com/myorg/ordersvc/workflow"
)

const TaskQueueName = "order-saga"

func main() {
    c, err := client.Dial(client.Options{
        HostPort: "localhost:7233",
    })
    if err != nil {
        log.Fatalf("Unable to create Temporal client: %v", err)
    }
    defer c.Close()

    w := worker.New(c, TaskQueueName, worker.Options{
        MaxConcurrentActivityExecutionSize: 100,
        MaxConcurrentWorkflowTaskExecutionSize: 50,
    })

    // Register workflows
    w.RegisterWorkflow(workflow.OrderSaga)

    // Register activities
    w.RegisterActivity(activities.ReserveInventoryActivity)
    w.RegisterActivity(activities.ReleaseInventoryActivity)
    w.RegisterActivity(activities.ChargePaymentActivity)
    w.RegisterActivity(activities.RefundPaymentActivity)
    w.RegisterActivity(activities.CreateShipmentActivity)
    w.RegisterActivity(activities.CancelShipmentActivity)
    w.RegisterActivity(activities.SendConfirmationActivity)

    if err := w.Run(worker.InterruptCh()); err != nil {
        log.Fatalf("Unable to start worker: %v", err)
    }
}
```

### Workflow Starter (HTTP Handler)

```go
// api/order_handler.go
package api

import (
    "encoding/json"
    "net/http"
    "time"

    "go.temporal.io/sdk/client"
    "go.temporal.io/sdk/temporal"

    "github.com/myorg/ordersvc/workflow"
)

type OrderHandler struct {
    temporal client.Client
}

func (h *OrderHandler) CreateOrder(w http.ResponseWriter, r *http.Request) {
    var input workflow.OrderInput
    if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    if input.OrderID == "" {
        input.OrderID = generateOrderID()
    }

    // Start the saga workflow
    we, err := h.temporal.ExecuteWorkflow(r.Context(),
        client.StartWorkflowOptions{
            ID:        "order-" + input.OrderID,
            TaskQueue: "order-saga",
            // Idempotency: same workflow ID won't start twice
            WorkflowIDReusePolicy: temporal.WorkflowIDReusePolicyRejectDuplicate,
            WorkflowExecutionTimeout: 10 * time.Minute,
            RetryPolicy: &temporal.RetryPolicy{
                MaximumAttempts: 1, // Don't retry the workflow itself
            },
        },
        workflow.OrderSaga,
        input)
    if err != nil {
        http.Error(w, "Failed to start order workflow: "+err.Error(), http.StatusInternalServerError)
        return
    }

    // Respond with workflow ID so client can poll for status
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]string{
        "order_id":    input.OrderID,
        "workflow_id": we.GetID(),
        "run_id":      we.GetRunID(),
    })
}

func (h *OrderHandler) GetOrderStatus(w http.ResponseWriter, r *http.Request) {
    workflowID := r.URL.Query().Get("workflow_id")

    resp, err := h.temporal.DescribeWorkflowExecution(r.Context(), workflowID, "")
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]interface{}{
        "status": resp.WorkflowExecutionInfo.Status.String(),
    })
}
```

## Section 4: Outbox Pattern for Event-Driven Sagas

When you don't use a workflow engine, the outbox pattern guarantees at-least-once event delivery:

```go
// internal/outbox/outbox.go
package outbox

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "time"

    "go.uber.org/zap"
)

type OutboxMessage struct {
    ID          int64
    AggregateID string
    EventType   string
    Payload     json.RawMessage
    CreatedAt   time.Time
    PublishedAt *time.Time
}

// Publish stores a domain event in the outbox table atomically with
// the business transaction. Never publish directly to Kafka in the
// same transaction — use this instead.
func Publish(tx *sql.Tx, aggregateID, eventType string, payload interface{}) error {
    data, err := json.Marshal(payload)
    if err != nil {
        return fmt.Errorf("marshal payload: %w", err)
    }

    _, err = tx.Exec(
        `INSERT INTO outbox_events (aggregate_id, event_type, payload, created_at)
         VALUES ($1, $2, $3, NOW())`,
        aggregateID, eventType, data)
    return err
}

// Relay polls the outbox table and publishes unpublished events to Kafka.
// Run as a background goroutine or a separate microservice.
type Relay struct {
    db          *sql.DB
    publisher   Publisher
    log         *zap.Logger
    batchSize   int
    pollInterval time.Duration
}

type Publisher interface {
    Publish(ctx context.Context, topic, key string, value []byte) error
}

func (r *Relay) Run(ctx context.Context) error {
    ticker := time.NewTicker(r.pollInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            if err := r.relay(ctx); err != nil {
                r.log.Error("outbox relay error", zap.Error(err))
            }
        }
    }
}

func (r *Relay) relay(ctx context.Context) error {
    rows, err := r.db.QueryContext(ctx,
        `SELECT id, aggregate_id, event_type, payload
         FROM outbox_events
         WHERE published_at IS NULL
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        r.batchSize)
    if err != nil {
        return fmt.Errorf("query outbox: %w", err)
    }
    defer rows.Close()

    var messages []OutboxMessage
    for rows.Next() {
        var m OutboxMessage
        if err := rows.Scan(&m.ID, &m.AggregateID, &m.EventType, &m.Payload); err != nil {
            return err
        }
        messages = append(messages, m)
    }

    for _, m := range messages {
        topic := "domain." + m.EventType
        if err := r.publisher.Publish(ctx, topic, m.AggregateID, m.Payload); err != nil {
            return fmt.Errorf("publish event %d: %w", m.ID, err)
        }

        _, err := r.db.ExecContext(ctx,
            "UPDATE outbox_events SET published_at = NOW() WHERE id = $1", m.ID)
        if err != nil {
            return fmt.Errorf("mark event %d published: %w", m.ID, err)
        }
    }

    return nil
}
```

## Section 5: Idempotency Keys — The Foundation of Safe Retries

Every compensation and activity must be idempotent. Here is a reusable middleware:

```go
// internal/idempotency/middleware.go
package idempotency

import (
    "context"
    "crypto/sha256"
    "database/sql"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "net/http"
    "time"
)

type Store struct {
    db *sql.DB
}

type CachedResponse struct {
    StatusCode int
    Body       json.RawMessage
    CreatedAt  time.Time
}

// Middleware checks for an Idempotency-Key header and caches responses.
func (s *Store) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        key := r.Header.Get("Idempotency-Key")
        if key == "" {
            next.ServeHTTP(w, r)
            return
        }

        // Hash the key to use as DB key
        h := sha256.Sum256([]byte(key))
        hashedKey := hex.EncodeToString(h[:])

        // Check cache
        cached, err := s.get(r.Context(), hashedKey)
        if err == nil && cached != nil {
            // Return cached response
            w.Header().Set("X-Idempotency-Replayed", "true")
            w.WriteHeader(cached.StatusCode)
            w.Write(cached.Body)
            return
        }

        // Capture the response
        rec := &responseRecorder{ResponseWriter: w, statusCode: http.StatusOK}
        next.ServeHTTP(rec, r)

        // Cache the response (ignore errors — idempotency is best-effort for caching)
        _ = s.set(r.Context(), hashedKey, &CachedResponse{
            StatusCode: rec.statusCode,
            Body:       rec.body,
        })
    })
}

func (s *Store) get(ctx context.Context, key string) (*CachedResponse, error) {
    var cr CachedResponse
    err := s.db.QueryRowContext(ctx,
        "SELECT status_code, body FROM idempotency_cache WHERE key = $1 AND expires_at > NOW()",
        key).Scan(&cr.StatusCode, &cr.Body)
    if err == sql.ErrNoRows {
        return nil, nil
    }
    return &cr, err
}

func (s *Store) set(ctx context.Context, key string, cr *CachedResponse) error {
    _, err := s.db.ExecContext(ctx,
        `INSERT INTO idempotency_cache (key, status_code, body, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
         ON CONFLICT (key) DO NOTHING`,
        key, cr.StatusCode, cr.Body)
    return err
}

type responseRecorder struct {
    http.ResponseWriter
    statusCode int
    body       []byte
}

func (r *responseRecorder) WriteHeader(code int) {
    r.statusCode = code
    r.ResponseWriter.WriteHeader(code)
}

func (r *responseRecorder) Write(b []byte) (int, error) {
    r.body = append(r.body, b...)
    return r.ResponseWriter.Write(b)
}
```

## Section 6: Testing Distributed Transactions

```go
// workflow/order_saga_test.go
package workflow_test

import (
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
    "go.temporal.io/sdk/testsuite"
    "go.temporal.io/sdk/worker"

    "github.com/myorg/ordersvc/activities"
    "github.com/myorg/ordersvc/workflow"
)

func TestOrderSagaSuccess(t *testing.T) {
    suite := testsuite.WorkflowTestSuite{}
    env := suite.NewTestWorkflowEnvironment()

    input := workflow.OrderInput{
        OrderID:    "order-123",
        CustomerID: "cust-456",
        ProductID:  "prod-789",
        Quantity:   2,
        Amount:     99.99,
        Email:      "test@example.com",
    }

    // Mock all activities
    env.OnActivity(activities.ReserveInventoryActivity, mock.Anything, input).
        Return(&activities.InventoryResult{ReservationID: "res-001"}, nil)

    env.OnActivity(activities.ChargePaymentActivity, mock.Anything, input).
        Return(&activities.PaymentResult{PaymentID: "pay-001", Amount: 99.99}, nil)

    env.OnActivity(activities.CreateShipmentActivity, mock.Anything, input).
        Return(&activities.ShipmentResult{ShipmentID: "ship-001"}, nil)

    env.OnActivity(activities.SendConfirmationActivity, mock.Anything, mock.Anything, mock.Anything).
        Return(nil)

    env.ExecuteWorkflow(workflow.OrderSaga, input)

    assert.True(t, env.IsWorkflowCompleted())
    assert.NoError(t, env.GetWorkflowError())

    var result workflow.OrderResult
    assert.NoError(t, env.GetWorkflowResult(&result))
    assert.Equal(t, "pay-001", result.PaymentID)
    assert.Equal(t, "ship-001", result.ShipmentID)
}

func TestOrderSagaCompensatesOnShipmentFailure(t *testing.T) {
    suite := testsuite.WorkflowTestSuite{}
    env := suite.NewTestWorkflowEnvironment()

    input := workflow.OrderInput{OrderID: "order-123", Amount: 99.99}

    env.OnActivity(activities.ReserveInventoryActivity, mock.Anything, input).
        Return(&activities.InventoryResult{ReservationID: "res-001"}, nil)

    env.OnActivity(activities.ChargePaymentActivity, mock.Anything, input).
        Return(&activities.PaymentResult{PaymentID: "pay-001", Amount: 99.99}, nil)

    env.OnActivity(activities.CreateShipmentActivity, mock.Anything, input).
        Return(nil, fmt.Errorf("fulfillment center unavailable"))

    // Expect compensations in reverse order
    env.OnActivity(activities.RefundPaymentActivity, mock.Anything, "pay-001").
        Return(nil).Once()

    env.OnActivity(activities.ReleaseInventoryActivity, mock.Anything, "res-001").
        Return(nil).Once()

    env.ExecuteWorkflow(workflow.OrderSaga, input)

    assert.True(t, env.IsWorkflowCompleted())
    assert.Error(t, env.GetWorkflowError())
    assert.Contains(t, env.GetWorkflowError().Error(), "create shipment")

    // Verify compensations were called
    env.AssertExpectations(t)
}

func TestOrderSagaPaymentDeclinedNoCompensation(t *testing.T) {
    suite := testsuite.WorkflowTestSuite{}
    env := suite.NewTestWorkflowEnvironment()

    input := workflow.OrderInput{OrderID: "order-123", Amount: 999.99}

    env.OnActivity(activities.ReserveInventoryActivity, mock.Anything, input).
        Return(&activities.InventoryResult{ReservationID: "res-001"}, nil)

    // Non-retryable error from payment service
    env.OnActivity(activities.ChargePaymentActivity, mock.Anything, input).
        Return(nil, temporal.NewNonRetryableApplicationError(
            "payment declined", "PAYMENT_DECLINED", nil))

    // Inventory reservation must be released
    env.OnActivity(activities.ReleaseInventoryActivity, mock.Anything, "res-001").
        Return(nil).Once()

    // Refund should NOT be called (payment never succeeded)
    env.OnActivity(activities.RefundPaymentActivity, mock.Anything, mock.Anything).
        Times(0)

    env.ExecuteWorkflow(workflow.OrderSaga, input)

    assert.True(t, env.IsWorkflowCompleted())
    assert.Error(t, env.GetWorkflowError())
    env.AssertExpectations(t)
}
```

## Section 7: Monitoring Saga Workflows

```bash
# Temporal Web UI — built into temporal server start-dev
open http://localhost:8233

# Query workflow status via CLI
temporal workflow list --namespace default --query 'WorkflowType="OrderSaga" AND ExecutionStatus="Running"'

# Describe a specific workflow
temporal workflow describe --workflow-id order-123

# Show workflow history (all activities and their results)
temporal workflow show --workflow-id order-123

# Prometheus metrics from Temporal worker
# temporal_request_total, temporal_workflow_active, temporal_activity_execute_latency
```

These patterns — 2PC for synchronous tight consistency, Saga with Temporal for durable long-running workflows, the outbox pattern for reliable event publishing, and idempotency keys for safe retries — cover the full spectrum of distributed transaction requirements in Go microservices.
