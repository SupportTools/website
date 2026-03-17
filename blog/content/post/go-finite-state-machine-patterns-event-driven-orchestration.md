---
title: "Go Finite State Machine Patterns: Event-Driven Service Orchestration"
date: 2030-07-14T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "FSM", "State Machine", "Event-Driven", "Architecture", "Microservices"]
categories:
- Go
- Architecture
- Backend
author: "Matthew Mattox - mmattox@support.tools"
description: "Production FSM implementation in Go covering state transition tables, event-driven transitions, concurrent FSM instances, persistence patterns with DB-backed state, testing FSMs, and real-world examples in order processing and workflow engines."
more_link: "yes"
url: "/go-finite-state-machine-patterns-event-driven-service-orchestration/"
---

Finite State Machines (FSMs) provide a formal, testable framework for managing the lifecycle of complex business entities. In distributed Go services, FSMs eliminate ad-hoc conditional logic scattered across handlers and replace it with explicit state transition tables, event-driven transitions, and auditable state history. This pattern is essential for order processing, document workflows, device management, and any domain where an entity moves through a defined sequence of states with business rules governing each transition.

<!--more-->

## Core FSM Concepts

A Finite State Machine consists of:

- **States**: A finite set of configurations an entity can be in (e.g., `pending`, `processing`, `completed`, `failed`)
- **Events**: Triggers that drive transitions (e.g., `PaymentReceived`, `ShipmentDispatched`)
- **Transitions**: Rules mapping `(current_state, event) -> next_state`
- **Actions**: Side effects that execute during transitions (e.g., send email, update inventory)
- **Guards**: Conditions that must be true for a transition to proceed

## Building a Type-Safe FSM Foundation

### State and Event Types

Start with strong typing to prevent invalid state/event combinations at compile time:

```go
package fsm

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// State represents a node in the FSM graph
type State string

// Event represents a trigger that drives state transitions
type Event string

// TransitionKey uniquely identifies a (state, event) pair
type TransitionKey struct {
    From  State
    Event Event
}

// Action is a function executed during a transition
type Action func(ctx context.Context, payload TransitionPayload) error

// Guard is a condition that must return true for the transition to proceed
type Guard func(ctx context.Context, payload TransitionPayload) (bool, error)

// TransitionPayload carries contextual data through a transition
type TransitionPayload struct {
    EntityID  string
    Event     Event
    Data      map[string]interface{}
    Timestamp time.Time
    Actor     string // user or system that triggered the event
}

// TransitionRule defines how to move from one state to another
type TransitionRule struct {
    From    State
    Event   Event
    To      State
    Guards  []Guard
    Actions []Action
    // OnError specifies the state to enter if an action fails
    OnError State
}

// Transition records a completed state change
type Transition struct {
    ID        string
    EntityID  string
    FromState State
    ToState   State
    Event     Event
    Actor     string
    Timestamp time.Time
    Metadata  map[string]interface{}
    Error     string
}
```

### The FSM Engine

```go
// FSM manages state transitions for a single entity
type FSM struct {
    mu           sync.RWMutex
    currentState State
    entityID     string
    transitions  map[TransitionKey]TransitionRule
    history      []Transition
    // Lifecycle hooks
    onEnter  map[State][]Action
    onLeave  map[State][]Action
    onEvent  []func(Transition)
}

// FSMConfig holds the configuration for building an FSM instance
type FSMConfig struct {
    InitialState State
    EntityID     string
    Transitions  []TransitionRule
    OnEnter      map[State][]Action
    OnLeave      map[State][]Action
    // Restore from persisted history
    History      []Transition
}

// New creates a new FSM from the given configuration
func New(cfg FSMConfig) (*FSM, error) {
    if cfg.InitialState == "" {
        return nil, fmt.Errorf("initial state cannot be empty")
    }

    f := &FSM{
        entityID:    cfg.EntityID,
        transitions: make(map[TransitionKey]TransitionRule),
        onEnter:     cfg.OnEnter,
        onLeave:     cfg.OnLeave,
        history:     cfg.History,
    }

    for _, rule := range cfg.Transitions {
        key := TransitionKey{From: rule.From, Event: rule.Event}
        if _, exists := f.transitions[key]; exists {
            return nil, fmt.Errorf("duplicate transition: state=%s event=%s", rule.From, rule.Event)
        }
        f.transitions[key] = rule
    }

    // Restore current state from history or use initial state
    if len(cfg.History) > 0 {
        f.currentState = cfg.History[len(cfg.History)-1].ToState
    } else {
        f.currentState = cfg.InitialState
    }

    return f, nil
}

// Current returns the entity's current state
func (f *FSM) Current() State {
    f.mu.RLock()
    defer f.mu.RUnlock()
    return f.currentState
}

// Can returns whether the given event can trigger a transition from the current state
func (f *FSM) Can(event Event) bool {
    f.mu.RLock()
    defer f.mu.RUnlock()
    _, ok := f.transitions[TransitionKey{From: f.currentState, Event: event}]
    return ok
}

// Trigger attempts to transition the FSM using the given event
func (f *FSM) Trigger(ctx context.Context, event Event, payload TransitionPayload) error {
    f.mu.Lock()
    defer f.mu.Unlock()

    key := TransitionKey{From: f.currentState, Event: event}
    rule, ok := f.transitions[key]
    if !ok {
        return &InvalidTransitionError{
            EntityID:     f.entityID,
            CurrentState: f.currentState,
            Event:        event,
        }
    }

    payload.Event = event
    if payload.Timestamp.IsZero() {
        payload.Timestamp = time.Now().UTC()
    }

    // Evaluate guards
    for _, guard := range rule.Guards {
        allowed, err := guard(ctx, payload)
        if err != nil {
            return fmt.Errorf("guard evaluation failed: %w", err)
        }
        if !allowed {
            return &GuardRejectedError{
                EntityID:     f.entityID,
                CurrentState: f.currentState,
                Event:        event,
            }
        }
    }

    fromState := f.currentState

    // Execute onLeave hooks for current state
    if hooks, ok := f.onLeave[fromState]; ok {
        for _, hook := range hooks {
            if err := hook(ctx, payload); err != nil {
                return fmt.Errorf("onLeave hook failed for state %s: %w", fromState, err)
            }
        }
    }

    // Execute transition actions
    for _, action := range rule.Actions {
        if err := action(ctx, payload); err != nil {
            // If OnError state is defined, transition there instead
            if rule.OnError != "" {
                t := Transition{
                    EntityID:  f.entityID,
                    FromState: fromState,
                    ToState:   rule.OnError,
                    Event:     event,
                    Actor:     payload.Actor,
                    Timestamp: payload.Timestamp,
                    Error:     err.Error(),
                }
                f.currentState = rule.OnError
                f.history = append(f.history, t)
                f.notifyObservers(t)
                return fmt.Errorf("action failed, transitioned to error state %s: %w", rule.OnError, err)
            }
            return fmt.Errorf("action failed for transition %s->%s: %w", fromState, rule.To, err)
        }
    }

    // Commit the transition
    f.currentState = rule.To

    t := Transition{
        EntityID:  f.entityID,
        FromState: fromState,
        ToState:   rule.To,
        Event:     event,
        Actor:     payload.Actor,
        Timestamp: payload.Timestamp,
        Metadata:  payload.Data,
    }
    f.history = append(f.history, t)

    // Execute onEnter hooks for new state
    if hooks, ok := f.onEnter[rule.To]; ok {
        for _, hook := range hooks {
            if err := hook(ctx, payload); err != nil {
                // onEnter hooks failing does not roll back the transition
                // but should be logged
                _ = err
            }
        }
    }

    f.notifyObservers(t)
    return nil
}

// History returns a copy of the transition history
func (f *FSM) History() []Transition {
    f.mu.RLock()
    defer f.mu.RUnlock()
    result := make([]Transition, len(f.history))
    copy(result, f.history)
    return result
}

// Subscribe registers a callback invoked after every transition
func (f *FSM) Subscribe(fn func(Transition)) {
    f.mu.Lock()
    defer f.mu.Unlock()
    f.onEvent = append(f.onEvent, fn)
}

func (f *FSM) notifyObservers(t Transition) {
    for _, fn := range f.onEvent {
        fn(t)
    }
}

// Error types

// InvalidTransitionError is returned when no transition exists for (state, event)
type InvalidTransitionError struct {
    EntityID     string
    CurrentState State
    Event        Event
}

func (e *InvalidTransitionError) Error() string {
    return fmt.Sprintf("no transition from state %q on event %q for entity %s",
        e.CurrentState, e.Event, e.EntityID)
}

// GuardRejectedError is returned when a guard condition is not met
type GuardRejectedError struct {
    EntityID     string
    CurrentState State
    Event        Event
}

func (e *GuardRejectedError) Error() string {
    return fmt.Sprintf("guard rejected transition from state %q on event %q for entity %s",
        e.CurrentState, e.Event, e.EntityID)
}
```

## Order Processing FSM

### State and Event Definitions

```go
package order

import (
    "context"
    "fmt"
    "time"

    "github.com/example/fsm"
)

// Order states
const (
    StateCreated    fsm.State = "created"
    StatePending    fsm.State = "pending_payment"
    StatePaid       fsm.State = "paid"
    StateProcessing fsm.State = "processing"
    StateShipped    fsm.State = "shipped"
    StateDelivered  fsm.State = "delivered"
    StateCancelled  fsm.State = "cancelled"
    StateRefunded   fsm.State = "refunded"
    StateFailed     fsm.State = "failed"
)

// Order events
const (
    EventSubmit         fsm.Event = "Submit"
    EventPaymentSuccess fsm.Event = "PaymentSuccess"
    EventPaymentFailed  fsm.Event = "PaymentFailed"
    EventStartProcess   fsm.Event = "StartProcessing"
    EventShip           fsm.Event = "Ship"
    EventDeliver        fsm.Event = "Deliver"
    EventCancel         fsm.Event = "Cancel"
    EventRefund         fsm.Event = "Refund"
    EventRetryPayment   fsm.Event = "RetryPayment"
)

// Order represents the domain entity
type Order struct {
    ID            string
    CustomerID    string
    Items         []OrderItem
    TotalAmount   float64
    Currency      string
    PaymentMethod string
    Status        fsm.State
    CreatedAt     time.Time
    UpdatedAt     time.Time
}

type OrderItem struct {
    SKU      string
    Quantity int
    Price    float64
}

// OrderService manages order lifecycle
type OrderService struct {
    repo        OrderRepository
    paymentSvc  PaymentService
    inventorySvc InventoryService
    emailSvc    EmailService
    eventBus    EventBus
}

// BuildOrderFSM constructs an FSM for the given order
func (s *OrderService) BuildOrderFSM(order *Order) (*fsm.FSM, error) {
    return fsm.New(fsm.FSMConfig{
        InitialState: StateCreated,
        EntityID:     order.ID,
        Transitions: []fsm.TransitionRule{
            // created -> pending_payment
            {
                From:  StateCreated,
                Event: EventSubmit,
                To:    StatePending,
                Guards: []fsm.Guard{
                    s.guardInventoryAvailable(order),
                },
                Actions: []fsm.Action{
                    s.actionReserveInventory(order),
                    s.actionInitiatePayment(order),
                    s.actionSendOrderConfirmationEmail(order),
                },
            },
            // pending_payment -> paid
            {
                From:  StatePending,
                Event: EventPaymentSuccess,
                To:    StatePaid,
                Actions: []fsm.Action{
                    s.actionUpdatePaymentRecord(order),
                    s.actionPublishOrderPaidEvent(order),
                },
            },
            // pending_payment -> failed
            {
                From:    StatePending,
                Event:   EventPaymentFailed,
                To:      StateFailed,
                OnError: StateFailed,
                Actions: []fsm.Action{
                    s.actionReleaseInventory(order),
                    s.actionSendPaymentFailureEmail(order),
                },
            },
            // failed -> pending_payment (retry)
            {
                From:  StateFailed,
                Event: EventRetryPayment,
                To:    StatePending,
                Guards: []fsm.Guard{
                    s.guardRetryAttemptAllowed(order),
                },
                Actions: []fsm.Action{
                    s.actionReserveInventory(order),
                    s.actionInitiatePayment(order),
                },
            },
            // paid -> processing
            {
                From:  StatePaid,
                Event: EventStartProcess,
                To:    StateProcessing,
                Actions: []fsm.Action{
                    s.actionAssignWarehouse(order),
                    s.actionCreateFulfillmentTask(order),
                },
            },
            // processing -> shipped
            {
                From:  StateProcessing,
                Event: EventShip,
                To:    StateShipped,
                Actions: []fsm.Action{
                    s.actionRecordTrackingNumber(order),
                    s.actionSendShippingNotification(order),
                    s.actionPublishShippedEvent(order),
                },
            },
            // shipped -> delivered
            {
                From:  StateShipped,
                Event: EventDeliver,
                To:    StateDelivered,
                Actions: []fsm.Action{
                    s.actionMarkInventoryFulfilled(order),
                    s.actionPublishDeliveredEvent(order),
                    s.actionSendDeliveryConfirmation(order),
                },
            },
            // Any cancelable state -> cancelled
            {From: StateCreated, Event: EventCancel, To: StateCancelled,
                Actions: []fsm.Action{s.actionCancelOrder(order)}},
            {From: StatePending, Event: EventCancel, To: StateCancelled,
                Actions: []fsm.Action{s.actionCancelPayment(order), s.actionReleaseInventory(order)}},
            {From: StatePaid, Event: EventCancel, To: StateCancelled,
                Actions: []fsm.Action{s.actionInitiateRefund(order), s.actionReleaseInventory(order)}},
            // delivered -> refunded
            {
                From:  StateDelivered,
                Event: EventRefund,
                To:    StateRefunded,
                Guards: []fsm.Guard{
                    s.guardRefundWindowOpen(order),
                },
                Actions: []fsm.Action{
                    s.actionProcessRefund(order),
                    s.actionSendRefundConfirmation(order),
                },
            },
        },
        OnEnter: map[fsm.State][]fsm.Action{
            StateDelivered: {s.actionTriggerReviewRequest(order)},
            StateCancelled: {s.actionArchiveOrder(order)},
        },
    })
}

// Guards

func (s *OrderService) guardInventoryAvailable(order *Order) fsm.Guard {
    return func(ctx context.Context, payload fsm.TransitionPayload) (bool, error) {
        for _, item := range order.Items {
            available, err := s.inventorySvc.CheckAvailability(ctx, item.SKU, item.Quantity)
            if err != nil {
                return false, fmt.Errorf("inventory check failed for SKU %s: %w", item.SKU, err)
            }
            if !available {
                return false, nil
            }
        }
        return true, nil
    }
}

func (s *OrderService) guardRefundWindowOpen(order *Order) fsm.Guard {
    return func(ctx context.Context, payload fsm.TransitionPayload) (bool, error) {
        refundDeadline := order.UpdatedAt.Add(30 * 24 * time.Hour) // 30 days
        if time.Now().After(refundDeadline) {
            return false, nil
        }
        return true, nil
    }
}

func (s *OrderService) guardRetryAttemptAllowed(order *Order) fsm.Guard {
    return func(ctx context.Context, payload fsm.TransitionPayload) (bool, error) {
        history, err := s.repo.GetTransitionHistory(ctx, order.ID)
        if err != nil {
            return false, err
        }
        retryCount := 0
        for _, t := range history {
            if t.Event == EventRetryPayment {
                retryCount++
            }
        }
        return retryCount < 3, nil
    }
}

// Actions (stub implementations)

func (s *OrderService) actionReserveInventory(order *Order) fsm.Action {
    return func(ctx context.Context, payload fsm.TransitionPayload) error {
        for _, item := range order.Items {
            if err := s.inventorySvc.Reserve(ctx, item.SKU, item.Quantity, order.ID); err != nil {
                return fmt.Errorf("failed to reserve inventory for SKU %s: %w", item.SKU, err)
            }
        }
        return nil
    }
}

func (s *OrderService) actionInitiatePayment(order *Order) fsm.Action {
    return func(ctx context.Context, payload fsm.TransitionPayload) error {
        return s.paymentSvc.Initiate(ctx, order.ID, order.TotalAmount, order.Currency)
    }
}

func (s *OrderService) actionPublishOrderPaidEvent(order *Order) fsm.Action {
    return func(ctx context.Context, payload fsm.TransitionPayload) error {
        return s.eventBus.Publish(ctx, "orders.paid", map[string]interface{}{
            "order_id":    order.ID,
            "customer_id": order.CustomerID,
            "amount":      order.TotalAmount,
            "currency":    order.Currency,
        })
    }
}

// Stub implementations to satisfy compiler
func (s *OrderService) actionUpdatePaymentRecord(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionReleaseInventory(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionSendOrderConfirmationEmail(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionSendPaymentFailureEmail(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionAssignWarehouse(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionCreateFulfillmentTask(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionRecordTrackingNumber(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionSendShippingNotification(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionPublishShippedEvent(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionMarkInventoryFulfilled(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionPublishDeliveredEvent(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionSendDeliveryConfirmation(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionCancelOrder(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionCancelPayment(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionInitiateRefund(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionProcessRefund(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionSendRefundConfirmation(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionTriggerReviewRequest(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
func (s *OrderService) actionArchiveOrder(_ *Order) fsm.Action {
    return func(_ context.Context, _ fsm.TransitionPayload) error { return nil }
}
```

## Database-Backed State Persistence

### Repository Interface and PostgreSQL Implementation

```go
package order

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "time"

    "github.com/example/fsm"
    _ "github.com/lib/pq"
)

// OrderRepository defines the persistence contract
type OrderRepository interface {
    GetByID(ctx context.Context, id string) (*Order, error)
    SaveTransition(ctx context.Context, t fsm.Transition) error
    GetTransitionHistory(ctx context.Context, orderID string) ([]fsm.Transition, error)
    UpdateState(ctx context.Context, orderID string, state fsm.State) error
}

// PostgresOrderRepository implements OrderRepository using PostgreSQL
type PostgresOrderRepository struct {
    db *sql.DB
}

func NewPostgresOrderRepository(db *sql.DB) *PostgresOrderRepository {
    return &PostgresOrderRepository{db: db}
}

// Schema for state transitions table
const createTransitionsTableSQL = `
CREATE TABLE IF NOT EXISTS order_transitions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id    UUID NOT NULL REFERENCES orders(id),
    from_state  VARCHAR(64) NOT NULL,
    to_state    VARCHAR(64) NOT NULL,
    event       VARCHAR(64) NOT NULL,
    actor       VARCHAR(256),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata    JSONB,
    error       TEXT,
    INDEX idx_order_transitions_order_id (order_id),
    INDEX idx_order_transitions_occurred_at (occurred_at)
);

CREATE TABLE IF NOT EXISTS orders (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id  UUID NOT NULL,
    status       VARCHAR(64) NOT NULL DEFAULT 'created',
    total_amount NUMERIC(12, 2) NOT NULL,
    currency     CHAR(3) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`

func (r *PostgresOrderRepository) SaveTransition(ctx context.Context, t fsm.Transition) error {
    metadata, err := json.Marshal(t.Metadata)
    if err != nil {
        return fmt.Errorf("marshaling transition metadata: %w", err)
    }

    _, err = r.db.ExecContext(ctx, `
        INSERT INTO order_transitions
            (order_id, from_state, to_state, event, actor, occurred_at, metadata, error)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        t.EntityID,
        string(t.FromState),
        string(t.ToState),
        string(t.Event),
        t.Actor,
        t.Timestamp,
        metadata,
        t.Error,
    )
    return err
}

func (r *PostgresOrderRepository) UpdateState(ctx context.Context, orderID string, state fsm.State) error {
    _, err := r.db.ExecContext(ctx, `
        UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
        string(state), orderID,
    )
    return err
}

func (r *PostgresOrderRepository) GetTransitionHistory(ctx context.Context, orderID string) ([]fsm.Transition, error) {
    rows, err := r.db.QueryContext(ctx, `
        SELECT id, order_id, from_state, to_state, event, actor, occurred_at, metadata, COALESCE(error, '')
        FROM order_transitions
        WHERE order_id = $1
        ORDER BY occurred_at ASC`,
        orderID,
    )
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var transitions []fsm.Transition
    for rows.Next() {
        var t fsm.Transition
        var metaJSON []byte
        var from, to, event string

        err := rows.Scan(
            &t.ID, &t.EntityID,
            &from, &to, &event,
            &t.Actor, &t.Timestamp, &metaJSON, &t.Error,
        )
        if err != nil {
            return nil, err
        }
        t.FromState = fsm.State(from)
        t.ToState = fsm.State(to)
        t.Event = fsm.Event(event)
        if len(metaJSON) > 0 {
            if err := json.Unmarshal(metaJSON, &t.Metadata); err != nil {
                return nil, err
            }
        }
        transitions = append(transitions, t)
    }
    return transitions, rows.Err()
}
```

### Transactional FSM Operations

Wrap the FSM trigger and database persistence in a single transaction to prevent state drift:

```go
func (s *OrderService) HandleEvent(ctx context.Context, orderID string, event fsm.Event, actor string) error {
    // Begin database transaction
    tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }
    defer tx.Rollback()

    // Load order with row lock to prevent concurrent transitions
    order, err := s.repo.GetByIDForUpdate(ctx, tx, orderID)
    if err != nil {
        return fmt.Errorf("loading order %s: %w", orderID, err)
    }

    // Restore FSM from history
    history, err := s.repo.GetTransitionHistoryTx(ctx, tx, orderID)
    if err != nil {
        return fmt.Errorf("loading transition history: %w", err)
    }

    machine, err := s.BuildOrderFSMWithHistory(order, history)
    if err != nil {
        return fmt.Errorf("building FSM: %w", err)
    }

    payload := fsm.TransitionPayload{
        EntityID:  orderID,
        Timestamp: time.Now().UTC(),
        Actor:     actor,
    }

    // Trigger the transition (executes guards and actions)
    if err := machine.Trigger(ctx, event, payload); err != nil {
        return fmt.Errorf("FSM transition failed: %w", err)
    }

    // Persist the new state
    newState := machine.Current()
    if err := s.repo.UpdateStateTx(ctx, tx, orderID, newState); err != nil {
        return fmt.Errorf("persisting state: %w", err)
    }

    // Save transition record
    history = machine.History()
    lastTransition := history[len(history)-1]
    if err := s.repo.SaveTransitionTx(ctx, tx, lastTransition); err != nil {
        return fmt.Errorf("saving transition record: %w", err)
    }

    return tx.Commit()
}
```

## Concurrent FSM Instances

For services handling thousands of entities simultaneously, a pool-based FSM manager avoids rebuilding FSMs on every request:

```go
package fsmmanager

import (
    "context"
    "sync"
    "time"

    "github.com/example/fsm"
)

type entry struct {
    machine    *fsm.FSM
    lastAccess time.Time
}

// Manager maintains a cache of FSM instances keyed by entity ID
type Manager struct {
    mu      sync.RWMutex
    cache   map[string]*entry
    loader  func(ctx context.Context, entityID string) (*fsm.FSM, error)
    ttl     time.Duration
    maxSize int
}

func NewManager(
    loader func(ctx context.Context, entityID string) (*fsm.FSM, error),
    ttl time.Duration,
    maxSize int,
) *Manager {
    m := &Manager{
        cache:   make(map[string]*entry),
        loader:  loader,
        ttl:     ttl,
        maxSize: maxSize,
    }
    go m.evictLoop()
    return m
}

func (m *Manager) Get(ctx context.Context, entityID string) (*fsm.FSM, error) {
    m.mu.RLock()
    e, ok := m.cache[entityID]
    m.mu.RUnlock()
    if ok {
        m.mu.Lock()
        e.lastAccess = time.Now()
        m.mu.Unlock()
        return e.machine, nil
    }

    machine, err := m.loader(ctx, entityID)
    if err != nil {
        return nil, err
    }

    m.mu.Lock()
    defer m.mu.Unlock()
    m.cache[entityID] = &entry{machine: machine, lastAccess: time.Now()}
    return machine, nil
}

func (m *Manager) Invalidate(entityID string) {
    m.mu.Lock()
    defer m.mu.Unlock()
    delete(m.cache, entityID)
}

func (m *Manager) evictLoop() {
    ticker := time.NewTicker(m.ttl / 2)
    defer ticker.Stop()
    for range ticker.C {
        m.mu.Lock()
        cutoff := time.Now().Add(-m.ttl)
        for id, e := range m.cache {
            if e.lastAccess.Before(cutoff) {
                delete(m.cache, id)
            }
        }
        m.mu.Unlock()
    }
}
```

## Testing FSMs

### Unit Testing Transitions

```go
package fsm_test

import (
    "context"
    "errors"
    "testing"
    "time"

    "github.com/example/fsm"
)

func buildTestFSM(t *testing.T, initial fsm.State) *fsm.FSM {
    t.Helper()
    machine, err := fsm.New(fsm.FSMConfig{
        InitialState: initial,
        EntityID:     "test-entity-001",
        Transitions: []fsm.TransitionRule{
            {
                From:  fsm.State("created"),
                Event: fsm.Event("Submit"),
                To:    fsm.State("pending"),
            },
            {
                From:  fsm.State("pending"),
                Event: fsm.Event("Approve"),
                To:    fsm.State("approved"),
            },
            {
                From:  fsm.State("pending"),
                Event: fsm.Event("Reject"),
                To:    fsm.State("rejected"),
            },
        },
    })
    if err != nil {
        t.Fatalf("building FSM: %v", err)
    }
    return machine
}

func TestValidTransition(t *testing.T) {
    machine := buildTestFSM(t, "created")
    ctx := context.Background()

    err := machine.Trigger(ctx, "Submit", fsm.TransitionPayload{Actor: "user-123"})
    if err != nil {
        t.Fatalf("expected successful transition, got: %v", err)
    }

    if machine.Current() != "pending" {
        t.Errorf("expected state 'pending', got %q", machine.Current())
    }
}

func TestInvalidTransition(t *testing.T) {
    machine := buildTestFSM(t, "created")
    ctx := context.Background()

    err := machine.Trigger(ctx, "Approve", fsm.TransitionPayload{})
    if err == nil {
        t.Fatal("expected error for invalid transition, got nil")
    }

    var invalidErr *fsm.InvalidTransitionError
    if !errors.As(err, &invalidErr) {
        t.Errorf("expected InvalidTransitionError, got %T: %v", err, err)
    }
}

func TestGuardRejection(t *testing.T) {
    rejectGuard := func(_ context.Context, _ fsm.TransitionPayload) (bool, error) {
        return false, nil
    }

    machine, err := fsm.New(fsm.FSMConfig{
        InitialState: "created",
        EntityID:     "test-entity-002",
        Transitions: []fsm.TransitionRule{
            {
                From:   "created",
                Event:  "Submit",
                To:     "pending",
                Guards: []fsm.Guard{rejectGuard},
            },
        },
    })
    if err != nil {
        t.Fatal(err)
    }

    err = machine.Trigger(context.Background(), "Submit", fsm.TransitionPayload{})
    if err == nil {
        t.Fatal("expected guard rejection error")
    }

    var guardErr *fsm.GuardRejectedError
    if !errors.As(err, &guardErr) {
        t.Errorf("expected GuardRejectedError, got %T", err)
    }
    // State must not have changed
    if machine.Current() != "created" {
        t.Errorf("state changed despite guard rejection: %s", machine.Current())
    }
}

func TestActionExecution(t *testing.T) {
    var actionCalled bool
    testAction := func(_ context.Context, payload fsm.TransitionPayload) error {
        actionCalled = true
        if payload.Actor != "system" {
            return errors.New("unexpected actor")
        }
        return nil
    }

    machine, _ := fsm.New(fsm.FSMConfig{
        InitialState: "created",
        EntityID:     "test-entity-003",
        Transitions: []fsm.TransitionRule{
            {
                From:    "created",
                Event:   "Process",
                To:      "processing",
                Actions: []fsm.Action{testAction},
            },
        },
    })

    err := machine.Trigger(context.Background(), "Process", fsm.TransitionPayload{Actor: "system"})
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if !actionCalled {
        t.Error("action was not called")
    }
}

func TestTransitionHistory(t *testing.T) {
    machine := buildTestFSM(t, "created")
    ctx := context.Background()

    _ = machine.Trigger(ctx, "Submit", fsm.TransitionPayload{Actor: "user-1", Timestamp: time.Now()})
    _ = machine.Trigger(ctx, "Approve", fsm.TransitionPayload{Actor: "admin-1", Timestamp: time.Now()})

    history := machine.History()
    if len(history) != 2 {
        t.Fatalf("expected 2 transitions, got %d", len(history))
    }

    if history[0].Event != "Submit" {
        t.Errorf("expected first event 'Submit', got %q", history[0].Event)
    }
    if history[1].ToState != "approved" {
        t.Errorf("expected final state 'approved', got %q", history[1].ToState)
    }
}

func TestOnErrorTransition(t *testing.T) {
    failingAction := func(_ context.Context, _ fsm.TransitionPayload) error {
        return errors.New("payment gateway timeout")
    }

    machine, _ := fsm.New(fsm.FSMConfig{
        InitialState: "pending",
        EntityID:     "test-entity-004",
        Transitions: []fsm.TransitionRule{
            {
                From:    "pending",
                Event:   "Pay",
                To:      "paid",
                OnError: "failed",
                Actions: []fsm.Action{failingAction},
            },
        },
    })

    err := machine.Trigger(context.Background(), "Pay", fsm.TransitionPayload{})
    if err == nil {
        t.Fatal("expected error from failing action")
    }

    if machine.Current() != "failed" {
        t.Errorf("expected state 'failed' after action error, got %q", machine.Current())
    }
}
```

### Table-Driven Transition Tests

```go
func TestOrderWorkflow(t *testing.T) {
    tests := []struct {
        name          string
        events        []fsm.Event
        expectedFinal fsm.State
        expectError   bool
    }{
        {
            name:          "happy path to delivered",
            events:        []fsm.Event{"Submit", "PaymentSuccess", "StartProcessing", "Ship", "Deliver"},
            expectedFinal: "delivered",
        },
        {
            name:          "payment failure then cancel",
            events:        []fsm.Event{"Submit", "PaymentFailed", "Cancel"},
            expectedFinal: "cancelled",
        },
        {
            name:          "cancel before payment",
            events:        []fsm.Event{"Submit", "Cancel"},
            expectedFinal: "cancelled",
        },
        {
            name:        "invalid event from created",
            events:      []fsm.Event{"Ship"},
            expectError: true,
        },
    }

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            machine := buildOrderFSM(t)
            ctx := context.Background()

            var lastErr error
            for _, event := range tc.events {
                lastErr = machine.Trigger(ctx, event, fsm.TransitionPayload{Actor: "test"})
                if lastErr != nil {
                    break
                }
            }

            if tc.expectError && lastErr == nil {
                t.Error("expected error, got nil")
            }
            if !tc.expectError && lastErr != nil {
                t.Errorf("unexpected error: %v", lastErr)
            }
            if !tc.expectError && machine.Current() != tc.expectedFinal {
                t.Errorf("expected final state %q, got %q", tc.expectedFinal, machine.Current())
            }
        })
    }
}
```

## Visualizing State Machines

Generate Graphviz DOT output for documentation:

```go
package fsm

import (
    "fmt"
    "strings"
)

// DOT generates a Graphviz DOT representation of the FSM
func DOT(rules []TransitionRule, initial State) string {
    var sb strings.Builder
    sb.WriteString("digraph FSM {\n")
    sb.WriteString("  rankdir=LR;\n")
    sb.WriteString(`  node [shape=circle];` + "\n")
    sb.WriteString(fmt.Sprintf(`  __start [shape=none, label=""];`+"\n"))
    sb.WriteString(fmt.Sprintf(`  __start -> "%s";`+"\n", initial))

    // Terminal states get double circle
    stateEdges := make(map[State][]State)
    for _, r := range rules {
        stateEdges[r.From] = append(stateEdges[r.From], r.To)
    }

    for _, r := range rules {
        sb.WriteString(fmt.Sprintf(
            `  "%s" -> "%s" [label="%s"];`+"\n",
            r.From, r.To, r.Event,
        ))
    }

    sb.WriteString("}\n")
    return sb.String()
}
```

```bash
# Generate and render the state diagram
go run ./cmd/fsm-viz -entity order > order-fsm.dot
dot -Tsvg order-fsm.dot -o order-fsm.svg
```

## HTTP Handler Integration

```go
package api

import (
    "encoding/json"
    "net/http"

    "github.com/gorilla/mux"
)

type OrderHandler struct {
    svc *OrderService
}

func (h *OrderHandler) HandleEvent(w http.ResponseWriter, r *http.Request) {
    vars := mux.Vars(r)
    orderID := vars["id"]

    var req struct {
        Event string `json:"event"`
        Data  map[string]interface{} `json:"data,omitempty"`
    }
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "invalid request body", http.StatusBadRequest)
        return
    }

    actor := r.Header.Get("X-User-ID")
    if actor == "" {
        http.Error(w, "missing X-User-ID header", http.StatusUnauthorized)
        return
    }

    event := fsm.Event(req.Event)
    if err := h.svc.HandleEvent(r.Context(), orderID, event, actor); err != nil {
        var invalidErr *fsm.InvalidTransitionError
        var guardErr *fsm.GuardRejectedError

        switch {
        case errors.As(err, &invalidErr):
            http.Error(w, err.Error(), http.StatusUnprocessableEntity)
        case errors.As(err, &guardErr):
            http.Error(w, "transition not allowed: guard condition not met", http.StatusConflict)
        default:
            http.Error(w, "internal error", http.StatusInternalServerError)
        }
        return
    }

    w.WriteHeader(http.StatusNoContent)
}
```

## Summary

FSMs in Go provide a structured approach to managing stateful business entities in production systems. The pattern separates transition logic from business rules through guards, isolates side effects into action functions, and produces auditable transition histories. By combining type-safe state/event definitions with database-backed persistence and serializable transactions, FSM-based services can handle concurrent access safely. The testing patterns shown enable both unit-level transition testing and full workflow integration testing, supporting confident refactoring as business rules evolve.
