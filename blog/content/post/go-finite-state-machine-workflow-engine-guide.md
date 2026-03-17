---
title: "Finite State Machines and Workflow Engines in Go: Production Patterns"
date: 2028-10-20T00:00:00-05:00
draft: false
tags: ["Go", "State Machine", "Workflow", "Architecture", "Design Patterns"]
categories:
- Go
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "Build production-grade finite state machines and workflow engines in Go, covering state/event tables, guard conditions, PostgreSQL persistence, event sourcing for audit trails, parallel workflow execution, and Temporal integration."
more_link: "yes"
url: "/go-finite-state-machine-workflow-engine-guide/"
---

Complex business processes — order fulfillment, payment processing, document approval workflows, deployment pipelines — are poorly modeled as ad-hoc conditional logic scattered across service code. A finite state machine (FSM) makes the valid states, legal transitions, and associated actions explicit and auditable. When you need durability and retries across long-running processes, a workflow engine builds on FSM principles to add persistence, history, and failure recovery.

This guide builds a complete Go FSM from first principles, adds PostgreSQL persistence with event sourcing, scales it into a minimal workflow engine supporting sequential and parallel steps, and shows when to reach for Temporal for durable workflow orchestration.

<!--more-->

# Finite State Machines and Workflow Engines in Go: Production Patterns

## FSM Core: State, Event, and Transition Table

A FSM has three components:
- **States**: the complete set of valid conditions for an entity
- **Events**: things that happen to trigger state changes
- **Transitions**: which event in which state produces which new state

```go
// internal/fsm/fsm.go
package fsm

import (
	"context"
	"fmt"
	"sync"
)

// State represents a node in the state graph.
type State string

// Event represents a trigger that causes state transitions.
type Event string

// Guard is a condition that must be true for a transition to proceed.
// Returns an error if the transition should be blocked.
type Guard func(ctx context.Context, from State, event Event, entity any) error

// Action is a side effect executed when a transition fires.
type Action func(ctx context.Context, from, to State, event Event, entity any) error

// Transition defines a valid state change.
type Transition struct {
	From   State
	Event  Event
	To     State
	Guard  Guard  // nil means always allowed
	Action Action // nil means no side effect
}

// FSM is a finite state machine.
type FSM struct {
	mu          sync.RWMutex
	current     State
	transitions map[transitionKey]Transition
	onEnter     map[State]Action // called when entering a state
	onExit      map[State]Action // called when exiting a state
}

type transitionKey struct {
	From  State
	Event Event
}

// New creates a new FSM with the given initial state and transition table.
func New(initial State, transitions []Transition) *FSM {
	f := &FSM{
		current:     initial,
		transitions: make(map[transitionKey]Transition),
		onEnter:     make(map[State]Action),
		onExit:      make(map[State]Action),
	}
	for _, t := range transitions {
		key := transitionKey{From: t.From, Event: t.Event}
		f.transitions[key] = t
	}
	return f
}

// OnEnter registers a callback for when the FSM enters a state.
func (f *FSM) OnEnter(state State, action Action) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.onEnter[state] = action
}

// OnExit registers a callback for when the FSM exits a state.
func (f *FSM) OnExit(state State, action Action) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.onExit[state] = action
}

// Current returns the current state.
func (f *FSM) Current() State {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.current
}

// Can returns true if the given event is valid in the current state.
func (f *FSM) Can(event Event) bool {
	f.mu.RLock()
	defer f.mu.RUnlock()
	_, ok := f.transitions[transitionKey{From: f.current, Event: event}]
	return ok
}

// Fire attempts to transition using the given event.
// ctx and entity are passed to guards and actions for context.
func (f *FSM) Fire(ctx context.Context, event Event, entity any) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	key := transitionKey{From: f.current, Event: event}
	t, ok := f.transitions[key]
	if !ok {
		return fmt.Errorf("no transition for event %q in state %q", event, f.current)
	}

	// Run guard — reject the transition if the condition is not met
	if t.Guard != nil {
		if err := t.Guard(ctx, f.current, event, entity); err != nil {
			return fmt.Errorf("transition guard failed: %w", err)
		}
	}

	// Exit the current state
	if exitFn, ok := f.onExit[f.current]; ok {
		if err := exitFn(ctx, f.current, t.To, event, entity); err != nil {
			return fmt.Errorf("onExit %q failed: %w", f.current, err)
		}
	}

	// Execute the transition action
	if t.Action != nil {
		if err := t.Action(ctx, f.current, t.To, event, entity); err != nil {
			return fmt.Errorf("transition action failed: %w", err)
		}
	}

	prev := f.current
	f.current = t.To

	// Enter the new state
	if enterFn, ok := f.onEnter[t.To]; ok {
		if err := enterFn(ctx, prev, t.To, event, entity); err != nil {
			// State has already changed — log but don't revert
			return fmt.Errorf("onEnter %q failed (state changed to %q): %w", t.To, t.To, err)
		}
	}

	return nil
}

// ValidTransitions returns all events valid in the current state.
func (f *FSM) ValidTransitions() []Event {
	f.mu.RLock()
	defer f.mu.RUnlock()

	var events []Event
	for key := range f.transitions {
		if key.From == f.current {
			events = append(events, key.Event)
		}
	}
	return events
}
```

## Order FSM Example

```go
// internal/order/fsm.go
package order

import (
	"context"
	"fmt"
	"time"

	"github.com/yourorg/shop/internal/fsm"
)

// Order states
const (
	StateCreated    fsm.State = "created"
	StatePending    fsm.State = "pending_payment"
	StatePaid       fsm.State = "paid"
	StateFulfilling fsm.State = "fulfilling"
	StateShipped    fsm.State = "shipped"
	StateDelivered  fsm.State = "delivered"
	StateCancelled  fsm.State = "cancelled"
	StateRefunded   fsm.State = "refunded"
)

// Order events
const (
	EventSubmit    fsm.Event = "submit"
	EventPayment   fsm.Event = "payment_received"
	EventFulfill   fsm.Event = "start_fulfillment"
	EventShip      fsm.Event = "ship"
	EventDeliver   fsm.Event = "delivered"
	EventCancel    fsm.Event = "cancel"
	EventRefund    fsm.Event = "refund"
	EventTimeout   fsm.Event = "payment_timeout"
)

// Order is the entity managed by the FSM.
type Order struct {
	ID          string
	CustomerID  string
	Items       []OrderItem
	TotalAmount int64  // cents
	PaymentRef  string
	ShipmentRef string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type OrderItem struct {
	SKU      string
	Quantity int
	Price    int64
}

// NewOrderFSM creates a configured FSM for an order.
func NewOrderFSM(paymentSvc PaymentService, warehouseSvc WarehouseService) *fsm.FSM {
	transitions := []fsm.Transition{
		{
			From:  StateCreated,
			Event: EventSubmit,
			To:    StatePending,
			Action: func(ctx context.Context, from, to fsm.State, event fsm.Event, entity any) error {
				order := entity.(*Order)
				// Initiate payment authorization
				ref, err := paymentSvc.AuthorizePayment(ctx, order.CustomerID, order.TotalAmount)
				if err != nil {
					return fmt.Errorf("payment authorization failed: %w", err)
				}
				order.PaymentRef = ref
				return nil
			},
		},
		{
			From:  StatePending,
			Event: EventPayment,
			To:    StatePaid,
		},
		{
			From:  StatePending,
			Event: EventTimeout,
			To:    StateCancelled,
		},
		{
			From:  StatePending,
			Event: EventCancel,
			To:    StateCancelled,
		},
		{
			From:  StatePaid,
			Event: EventFulfill,
			To:    StateFulfilling,
			// Guard: only start fulfillment if all items are in stock
			Guard: func(ctx context.Context, from fsm.State, event fsm.Event, entity any) error {
				order := entity.(*Order)
				for _, item := range order.Items {
					available, err := warehouseSvc.CheckStock(ctx, item.SKU, item.Quantity)
					if err != nil {
						return fmt.Errorf("stock check failed for %s: %w", item.SKU, err)
					}
					if !available {
						return fmt.Errorf("insufficient stock for SKU %s", item.SKU)
					}
				}
				return nil
			},
			Action: func(ctx context.Context, from, to fsm.State, event fsm.Event, entity any) error {
				order := entity.(*Order)
				return warehouseSvc.ReserveItems(ctx, order.ID, order.Items)
			},
		},
		{
			From:  StateFulfilling,
			Event: EventShip,
			To:    StateShipped,
			Action: func(ctx context.Context, from, to fsm.State, event fsm.Event, entity any) error {
				order := entity.(*Order)
				ref, err := warehouseSvc.CreateShipment(ctx, order.ID)
				if err != nil {
					return err
				}
				order.ShipmentRef = ref
				return nil
			},
		},
		{
			From:  StateShipped,
			Event: EventDeliver,
			To:    StateDelivered,
		},
		{
			From:  StatePaid,
			Event: EventCancel,
			To:    StateCancelled,
			Action: func(ctx context.Context, from, to fsm.State, event fsm.Event, entity any) error {
				order := entity.(*Order)
				return paymentSvc.VoidAuthorization(ctx, order.PaymentRef)
			},
		},
		{
			From:  StateDelivered,
			Event: EventRefund,
			To:    StateRefunded,
			Action: func(ctx context.Context, from, to fsm.State, event fsm.Event, entity any) error {
				order := entity.(*Order)
				return paymentSvc.Refund(ctx, order.PaymentRef, order.TotalAmount)
			},
		},
	}

	machine := fsm.New(StateCreated, transitions)

	// Log state entries for audit trail
	for _, state := range []fsm.State{
		StateCreated, StatePending, StatePaid, StateFulfilling,
		StateShipped, StateDelivered, StateCancelled, StateRefunded,
	} {
		s := state // capture for closure
		machine.OnEnter(s, func(ctx context.Context, from, to fsm.State, event fsm.Event, entity any) error {
			order := entity.(*Order)
			order.UpdatedAt = time.Now()
			// In production: write event to the orders_events table
			return nil
		})
	}

	return machine
}
```

## Persisting FSM State to PostgreSQL with Event Sourcing

Event sourcing stores every state transition as an immutable event rather than overwriting the current state. This gives a complete audit trail and the ability to reconstruct state at any point in time.

```go
// internal/order/repository.go
package order

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/yourorg/shop/internal/fsm"
)

// Event represents a persisted state transition.
type Event struct {
	ID         int64
	OrderID    string
	FromState  fsm.State
	ToState    fsm.State
	Event      fsm.Event
	Metadata   json.RawMessage
	OccurredAt time.Time
}

// OrderRepository manages order persistence.
type OrderRepository struct {
	db *sql.DB
}

func NewOrderRepository(db *sql.DB) *OrderRepository {
	return &OrderRepository{db: db}
}

// Schema — run once during migration
const schema = `
CREATE TABLE IF NOT EXISTS orders (
    id           TEXT PRIMARY KEY,
    customer_id  TEXT NOT NULL,
    state        TEXT NOT NULL,
    total_amount BIGINT NOT NULL,
    payment_ref  TEXT,
    shipment_ref TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS order_events (
    id          BIGSERIAL PRIMARY KEY,
    order_id    TEXT NOT NULL REFERENCES orders(id),
    from_state  TEXT NOT NULL,
    to_state    TEXT NOT NULL,
    event       TEXT NOT NULL,
    metadata    JSONB,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_events_order_id ON order_events(order_id, occurred_at);
`

// Save persists the order state and records the transition event atomically.
func (r *OrderRepository) Save(ctx context.Context, order *Order, prevState, nextState fsm.State, event fsm.Event) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// Optimistic locking: increment version, fail if another process updated it
	result, err := tx.ExecContext(ctx, `
		UPDATE orders SET
			state        = $1,
			payment_ref  = $2,
			shipment_ref = $3,
			updated_at   = NOW(),
			version      = version + 1
		WHERE id = $4 AND state = $5
	`, string(nextState), order.PaymentRef, order.ShipmentRef, order.ID, string(prevState))
	if err != nil {
		return fmt.Errorf("update order: %w", err)
	}

	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("concurrent update detected — order %s state changed by another process", order.ID)
	}

	// Append the event
	meta, _ := json.Marshal(map[string]any{
		"payment_ref":  order.PaymentRef,
		"shipment_ref": order.ShipmentRef,
	})

	_, err = tx.ExecContext(ctx, `
		INSERT INTO order_events (order_id, from_state, to_state, event, metadata)
		VALUES ($1, $2, $3, $4, $5)
	`, order.ID, string(prevState), string(nextState), string(event), meta)
	if err != nil {
		return fmt.Errorf("insert event: %w", err)
	}

	return tx.Commit()
}

// Upsert inserts or updates an order.
func (r *OrderRepository) Upsert(ctx context.Context, order *Order) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO orders (id, customer_id, state, total_amount, created_at, updated_at)
		VALUES ($1, $2, $3, $4, NOW(), NOW())
		ON CONFLICT (id) DO UPDATE SET
			state        = EXCLUDED.state,
			updated_at   = NOW()
	`, order.ID, order.CustomerID, StateCreated, order.TotalAmount)
	return err
}

// GetByID loads the current order state.
func (r *OrderRepository) GetByID(ctx context.Context, id string) (*Order, fsm.State, error) {
	var order Order
	var state string
	err := r.db.QueryRowContext(ctx, `
		SELECT id, customer_id, state, total_amount, COALESCE(payment_ref,''), COALESCE(shipment_ref,'')
		FROM orders WHERE id = $1
	`, id).Scan(&order.ID, &order.CustomerID, &state, &order.TotalAmount, &order.PaymentRef, &order.ShipmentRef)
	if err == sql.ErrNoRows {
		return nil, "", fmt.Errorf("order %s not found", id)
	}
	return &order, fsm.State(state), err
}

// EventHistory returns all events for an order in chronological order.
func (r *OrderRepository) EventHistory(ctx context.Context, orderID string) ([]Event, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, order_id, from_state, to_state, event, metadata, occurred_at
		FROM order_events
		WHERE order_id = $1
		ORDER BY occurred_at ASC
	`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []Event
	for rows.Next() {
		var e Event
		var fromState, toState, ev string
		if err := rows.Scan(&e.ID, &e.OrderID, &fromState, &toState, &ev, &e.Metadata, &e.OccurredAt); err != nil {
			return nil, err
		}
		e.FromState = fsm.State(fromState)
		e.ToState = fsm.State(toState)
		e.Event = fsm.Event(ev)
		events = append(events, e)
	}
	return events, rows.Err()
}
```

## Workflow Engine: Sequential and Parallel Steps

A workflow engine runs multi-step processes where steps may be sequential or parallel, may fail and need retries, and span long durations.

```go
// internal/workflow/engine.go
package workflow

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// StepStatus represents the execution state of a workflow step.
type StepStatus string

const (
	StatusPending   StepStatus = "pending"
	StatusRunning   StepStatus = "running"
	StatusSucceeded StepStatus = "succeeded"
	StatusFailed    StepStatus = "failed"
	StatusSkipped   StepStatus = "skipped"
)

// StepFunc is the function executed by a workflow step.
type StepFunc func(ctx context.Context, input map[string]any) (map[string]any, error)

// Step defines a single unit of work in a workflow.
type Step struct {
	Name        string
	Fn          StepFunc
	DependsOn   []string       // names of steps that must complete before this one
	MaxRetries  int
	RetryDelay  time.Duration
	Timeout     time.Duration
	Condition   func(output map[string]any) bool // if false, skip this step
}

// StepResult tracks the outcome of a step execution.
type StepResult struct {
	Status     StepStatus
	Output     map[string]any
	Error      error
	StartedAt  time.Time
	FinishedAt time.Time
	Attempts   int
}

// Workflow is an ordered collection of steps.
type Workflow struct {
	Name  string
	Steps []Step
}

// WorkflowEngine executes workflows.
type WorkflowEngine struct{}

// Execute runs the workflow, returning results for each step.
// Steps with no dependencies run in parallel; dependent steps wait for their prerequisites.
func (e *WorkflowEngine) Execute(ctx context.Context, wf *Workflow, initialInput map[string]any) (map[string]*StepResult, error) {
	results := make(map[string]*StepResult)
	resultsMu := sync.Mutex{}
	outputs := make(map[string]map[string]any)
	outputsMu := sync.Mutex{}

	// Merge initial input into outputs under the special key "input"
	outputsMu.Lock()
	outputs["input"] = initialInput
	outputsMu.Unlock()

	// Build a dependency graph and identify execution order
	stepMap := make(map[string]*Step)
	for i := range wf.Steps {
		stepMap[wf.Steps[i].Name] = &wf.Steps[i]
	}

	// topological sort with parallel execution using channels
	completed := make(map[string]chan struct{})
	for _, step := range wf.Steps {
		completed[step.Name] = make(chan struct{})
	}

	var wg sync.WaitGroup
	for _, step := range wf.Steps {
		s := step // capture
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer close(completed[s.Name])

			// Wait for all dependencies to complete
			for _, dep := range s.DependsOn {
				select {
				case <-completed[dep]:
					// Check if dependency succeeded
					resultsMu.Lock()
					depResult := results[dep]
					resultsMu.Unlock()
					if depResult != nil && depResult.Status == StatusFailed {
						resultsMu.Lock()
						results[s.Name] = &StepResult{
							Status: StatusSkipped,
							Error:  fmt.Errorf("dependency %q failed", dep),
						}
						resultsMu.Unlock()
						return
					}
				case <-ctx.Done():
					return
				}
			}

			// Build merged input from dependency outputs
			mergedInput := make(map[string]any)
			outputsMu.Lock()
			for k, v := range outputs["input"] {
				mergedInput[k] = v
			}
			for _, dep := range s.DependsOn {
				for k, v := range outputs[dep] {
					mergedInput[dep+"."+k] = v
				}
			}
			outputsMu.Unlock()

			// Check condition
			if s.Condition != nil && !s.Condition(mergedInput) {
				resultsMu.Lock()
				results[s.Name] = &StepResult{Status: StatusSkipped}
				resultsMu.Unlock()
				return
			}

			// Execute with retries
			result := e.executeStep(ctx, &s, mergedInput)

			resultsMu.Lock()
			results[s.Name] = result
			resultsMu.Unlock()

			if result.Status == StatusSucceeded && result.Output != nil {
				outputsMu.Lock()
				outputs[s.Name] = result.Output
				outputsMu.Unlock()
			}
		}()
	}

	wg.Wait()
	return results, nil
}

func (e *WorkflowEngine) executeStep(ctx context.Context, step *Step, input map[string]any) *StepResult {
	result := &StepResult{
		Status:    StatusRunning,
		StartedAt: time.Now(),
	}

	maxRetries := step.MaxRetries
	if maxRetries <= 0 {
		maxRetries = 1
	}
	retryDelay := step.RetryDelay
	if retryDelay == 0 {
		retryDelay = 5 * time.Second
	}

	for attempt := 1; attempt <= maxRetries; attempt++ {
		result.Attempts = attempt

		stepCtx := ctx
		var cancel context.CancelFunc
		if step.Timeout > 0 {
			stepCtx, cancel = context.WithTimeout(ctx, step.Timeout)
			defer cancel()
		}

		output, err := step.Fn(stepCtx, input)
		if err == nil {
			result.Status = StatusSucceeded
			result.Output = output
			result.FinishedAt = time.Now()
			return result
		}

		result.Error = err
		if attempt < maxRetries {
			select {
			case <-time.After(retryDelay * time.Duration(attempt)): // exponential backoff
			case <-ctx.Done():
				result.Status = StatusFailed
				result.FinishedAt = time.Now()
				return result
			}
		}
	}

	result.Status = StatusFailed
	result.FinishedAt = time.Now()
	return result
}
```

## Example: Deployment Workflow

```go
// Deployment pipeline: build → test → push → canary → full rollout
func buildDeploymentWorkflow(image, version string) *workflow.Workflow {
	return &workflow.Workflow{
		Name: "deploy-" + version,
		Steps: []workflow.Step{
			{
				Name:    "build",
				Timeout: 10 * time.Minute,
				Fn: func(ctx context.Context, input map[string]any) (map[string]any, error) {
					digest, err := buildImage(ctx, image, version)
					return map[string]any{"digest": digest}, err
				},
			},
			{
				Name:       "unit-tests",
				DependsOn:  []string{"build"},
				MaxRetries: 2,
				Timeout:    5 * time.Minute,
				Fn: func(ctx context.Context, input map[string]any) (map[string]any, error) {
					return nil, runTests(ctx, input["build.digest"].(string), "unit")
				},
			},
			{
				Name:      "integration-tests",
				DependsOn: []string{"build"},
				Timeout:   15 * time.Minute,
				Fn: func(ctx context.Context, input map[string]any) (map[string]any, error) {
					return nil, runTests(ctx, input["build.digest"].(string), "integration")
				},
			},
			{
				Name:      "push",
				DependsOn: []string{"unit-tests", "integration-tests"},
				Fn: func(ctx context.Context, input map[string]any) (map[string]any, error) {
					return nil, pushImage(ctx, input["build.digest"].(string))
				},
			},
			{
				Name:       "canary-deploy",
				DependsOn:  []string{"push"},
				MaxRetries: 3,
				RetryDelay: 30 * time.Second,
				Fn: func(ctx context.Context, input map[string]any) (map[string]any, error) {
					return nil, deployCanary(ctx, image, version, 10) // 10% traffic
				},
			},
			{
				Name:      "canary-validation",
				DependsOn: []string{"canary-deploy"},
				Timeout:   5 * time.Minute,
				Fn: func(ctx context.Context, input map[string]any) (map[string]any, error) {
					errorRate, err := measureCanaryErrorRate(ctx, version)
					if err != nil {
						return nil, err
					}
					if errorRate > 0.01 {
						return nil, fmt.Errorf("canary error rate %.2f%% exceeds threshold", errorRate*100)
					}
					return map[string]any{"error_rate": errorRate}, nil
				},
			},
			{
				Name:      "full-rollout",
				DependsOn: []string{"canary-validation"},
				Condition: func(output map[string]any) bool {
					// Only roll out if canary error rate is acceptable
					if rate, ok := output["canary-validation.error_rate"].(float64); ok {
						return rate < 0.01
					}
					return true
				},
				Fn: func(ctx context.Context, input map[string]any) (map[string]any, error) {
					return nil, deployFull(ctx, image, version)
				},
			},
		},
	}
}
```

## Testing FSMs Exhaustively

Good FSM testing exercises every valid transition and verifies that invalid events are rejected:

```go
// order_fsm_test.go
package order_test

import (
	"context"
	"testing"

	"github.com/yourorg/shop/internal/order"
)

func TestOrderFSMTransitions(t *testing.T) {
	tests := []struct {
		name        string
		initial     string
		events      []string
		wantFinal   string
		wantErr     bool
	}{
		{
			name:      "happy path to delivered",
			initial:   "created",
			events:    []string{"submit", "payment_received", "start_fulfillment", "ship", "delivered"},
			wantFinal: "delivered",
		},
		{
			name:      "cancel before payment",
			initial:   "created",
			events:    []string{"submit", "cancel"},
			wantFinal: "cancelled",
		},
		{
			name:    "invalid: ship before payment",
			initial: "created",
			events:  []string{"submit", "ship"},
			wantErr: true,
		},
		{
			name:    "invalid: refund before delivery",
			initial: "created",
			events:  []string{"submit", "payment_received", "start_fulfillment", "ship", "refund"},
			wantErr: true,
		},
		{
			name:      "timeout path",
			initial:   "created",
			events:    []string{"submit", "payment_timeout"},
			wantFinal: "cancelled",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := &order.Order{ID: "test-001", TotalAmount: 10000}
			machine := order.NewOrderFSM(
				&mockPaymentService{},
				&mockWarehouseService{stockAvailable: true},
			)

			var lastErr error
			for _, event := range tt.events {
				lastErr = machine.Fire(context.Background(), fsm.Event(event), o)
				if lastErr != nil && !tt.wantErr {
					t.Fatalf("unexpected error on event %q: %v", event, lastErr)
				}
				if lastErr != nil {
					break
				}
			}

			if tt.wantErr && lastErr == nil {
				t.Error("expected error but got none")
			}
			if !tt.wantErr && tt.wantFinal != "" {
				if got := string(machine.Current()); got != tt.wantFinal {
					t.Errorf("final state = %q, want %q", got, tt.wantFinal)
				}
			}
		})
	}
}

// GenerateTransitionMatrix produces a table of all valid state/event combinations.
// Run this test with -v to see the full transition matrix.
func TestTransitionMatrix(t *testing.T) {
	allStates := []fsm.State{
		order.StateCreated, order.StatePending, order.StatePaid,
		order.StateFulfilling, order.StateShipped, order.StateDelivered,
		order.StateCancelled, order.StateRefunded,
	}
	allEvents := []fsm.Event{
		order.EventSubmit, order.EventPayment, order.EventFulfill,
		order.EventShip, order.EventDeliver, order.EventCancel,
		order.EventRefund, order.EventTimeout,
	}

	t.Logf("%-20s | %-20s | %-10s", "State", "Event", "Valid")
	for _, state := range allStates {
		for _, event := range allEvents {
			// Create FSM in the specific state and check if event is valid
			machine := order.NewOrderFSM(/* ... */)
			// Jump to test state (test-only helper)
			valid := machine.CanFromState(state, event)
			if valid {
				t.Logf("%-20s | %-20s | YES", state, event)
			}
		}
	}
}
```

## When to Use Temporal

The home-built FSM and workflow engine above work well for processes that complete within a single request/response cycle or that can tolerate process restarts with database-recovered state. They struggle with:

- **Long-running workflows** (hours, days) where you cannot keep state in memory
- **Human-in-the-loop steps** (waiting for approval) that span many hours
- **Retry storms** (complex retry policies across distributed failure modes)
- **Workflow versioning** (changing workflow logic without breaking in-flight workflows)

Temporal solves all of these. A Temporal workflow is a plain Go function that runs durably — if the process crashes and restarts, Temporal replays the event history to restore the function's execution state:

```go
// temporal/workflows/deploy.go
package workflows

import (
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

func DeployWorkflow(ctx workflow.Context, params DeployParams) error {
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 3,
			InitialInterval: 10 * time.Second,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// Each activity is durably checkpointed
	var buildDigest string
	if err := workflow.ExecuteActivity(ctx, BuildImageActivity, params).Get(ctx, &buildDigest); err != nil {
		return err
	}

	// Run tests in parallel
	testCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
	})
	unitFut := workflow.ExecuteActivity(testCtx, RunTestsActivity, buildDigest, "unit")
	integFut := workflow.ExecuteActivity(testCtx, RunTestsActivity, buildDigest, "integration")

	if err := unitFut.Get(ctx, nil); err != nil {
		return err
	}
	if err := integFut.Get(ctx, nil); err != nil {
		return err
	}

	// Wait for human approval signal (can wait hours — state is persisted by Temporal)
	approvalCh := workflow.GetSignalChannel(ctx, "deployment-approval")
	var approval ApprovalSignal
	approvalCh.Receive(ctx, &approval)
	if !approval.Approved {
		return temporal.NewApplicationError("deployment rejected", "REJECTED")
	}

	return workflow.ExecuteActivity(ctx, DeployActivity, buildDigest, params.Version).Get(ctx, nil)
}
```

Use your home-built FSM for bounded, fast processes. Use Temporal when processes span more than a few minutes, involve external approvals, or require complex retry semantics that you do not want to reinvent.

## Mermaid Diagram from FSM Definition

Generate visual documentation from your transition table:

```go
// DotGraph generates a Graphviz DOT representation of the FSM.
func DotGraph(transitions []fsm.Transition) string {
	var sb strings.Builder
	sb.WriteString("digraph {\n")
	sb.WriteString("  rankdir=LR;\n")
	sb.WriteString("  node [shape=box];\n")
	for _, t := range transitions {
		sb.WriteString(fmt.Sprintf("  %q -> %q [label=%q];\n", t.From, t.To, t.Event))
	}
	sb.WriteString("}\n")
	return sb.String()
}
```

Explicit state machines — where every valid state, every valid event, and every valid transition is declared in one place — make business logic auditable, testable, and safe from impossible state combinations. The time spent modeling the FSM pays back when debugging production incidents: instead of reasoning about scattered conditional branches, you look at a transition table and ask which path led to this state.
