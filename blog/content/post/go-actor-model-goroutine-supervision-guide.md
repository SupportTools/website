---
title: "Actor Model in Go: Goroutine Supervision and Message-Passing Architectures"
date: 2028-11-16T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Actor Model", "Architecture", "Goroutines"]
categories:
- Go
- Concurrency
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to the actor model in Go covering goroutine supervision trees, message-passing with channels, dead letter channels, backpressure handling, Proto.Actor library usage, and deterministic testing of concurrent actor systems."
more_link: "yes"
url: "/go-actor-model-goroutine-supervision-guide/"
---

Go's goroutines and channels naturally map to the actor model's core concepts: each actor is a goroutine with a mailbox (channel), and actors communicate exclusively by sending messages. But Go's goroutine model lacks built-in supervision: if a goroutine panics, the runtime crashes the entire program unless the panic is recovered. This guide implements supervision trees from first principles, adds dead letter channels for undeliverable messages, handles backpressure, and shows how to test these systems deterministically.

<!--more-->

# Actor Model in Go: Goroutine Supervision and Message-Passing Architectures

## Actor Model vs Shared-Memory Concurrency

Traditional concurrent programs share memory and use mutexes to prevent concurrent access. This works but produces code where the invariants are difficult to reason about: any goroutine can corrupt shared state if a lock is missed.

The actor model eliminates shared mutable state. Each actor:
- Has private state that no other actor can directly access
- Receives messages through a mailbox (buffered channel)
- Processes one message at a time (serial state transitions)
- Communicates only by sending messages to other actors

```
Shared-memory model:
Goroutine A ──read/write──► Shared State ◄──read/write── Goroutine B
                             (mutex required)

Actor model:
Actor A ──message──► [Mailbox B] ──► Actor B (processes serially)
Actor B ──message──► [Mailbox A] ──► Actor A (processes serially)
```

Go's goroutines and channels provide the primitives. What they don't provide is supervision: a mechanism to restart failed actors, limit restart frequency, and decide whether a failure should propagate up the tree.

## Basic Actor Implementation

```go
// actor/actor.go
package actor

import (
	"context"
	"fmt"
	"log"
	"runtime/debug"
	"time"
)

// Message is the envelope for all inter-actor communication
type Message struct {
	Type    string
	Payload interface{}
	ReplyTo chan<- Message  // for request-reply patterns
}

// ActorFunc is the function that processes messages
type ActorFunc func(ctx context.Context, msg Message) error

// Actor represents a running goroutine with a mailbox
type Actor struct {
	name     string
	mailbox  chan Message
	fn       ActorFunc
	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{}
	panicCh  chan interface{}  // sends panic values to supervisor
}

func NewActor(name string, mailboxSize int, fn ActorFunc) *Actor {
	ctx, cancel := context.WithCancel(context.Background())
	return &Actor{
		name:    name,
		mailbox: make(chan Message, mailboxSize),
		fn:      fn,
		ctx:     ctx,
		cancel:  cancel,
		done:    make(chan struct{}),
		panicCh: make(chan interface{}, 1),
	}
}

func (a *Actor) Start() {
	go a.run()
}

func (a *Actor) run() {
	defer close(a.done)
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[actor:%s] panic: %v\n%s", a.name, r, debug.Stack())
			select {
			case a.panicCh <- r:
			default:
				// Supervisor not listening; log and continue
				log.Printf("[actor:%s] unhandled panic, supervisor not listening", a.name)
			}
		}
	}()

	for {
		select {
		case <-a.ctx.Done():
			log.Printf("[actor:%s] context cancelled, shutting down", a.name)
			return
		case msg := <-a.mailbox:
			if err := a.fn(a.ctx, msg); err != nil {
				log.Printf("[actor:%s] message processing error: %v", a.name, err)
				// Non-fatal errors: log and continue
			}
		}
	}
}

func (a *Actor) Send(msg Message) error {
	select {
	case a.mailbox <- msg:
		return nil
	default:
		return fmt.Errorf("actor %s: mailbox full (capacity %d)", a.name, cap(a.mailbox))
	}
}

// SendWithTimeout attempts to send with a deadline
func (a *Actor) SendWithTimeout(msg Message, timeout time.Duration) error {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case a.mailbox <- msg:
		return nil
	case <-timer.C:
		return fmt.Errorf("actor %s: send timeout after %v", a.name, timeout)
	}
}

func (a *Actor) Stop() {
	a.cancel()
	<-a.done
}

func (a *Actor) PanicCh() <-chan interface{} {
	return a.panicCh
}

func (a *Actor) Name() string {
	return a.name
}
```

## Supervision Tree: One-for-One Strategy

In a one-for-one strategy, when a child actor fails, only that child is restarted (not siblings):

```go
// supervisor/one_for_one.go
package supervisor

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/myorg/actor"
)

type RestartStrategy int

const (
	OneForOne  RestartStrategy = iota // restart only the failed actor
	OneForAll                         // restart all actors when one fails
)

type ChildSpec struct {
	Name        string
	MailboxSize int
	Fn          actor.ActorFunc
	MaxRestarts int           // max restarts within RestartWindow
	RestartWindow time.Duration
}

type SupervisorOpts struct {
	Strategy    RestartStrategy
	MaxRestarts int
	Window      time.Duration
}

type Supervisor struct {
	opts     SupervisorOpts
	children map[string]*managedActor
	mu       sync.RWMutex
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup

	// Dead letter channel: receives messages that couldn't be delivered
	DeadLetters chan actor.Message
}

type managedActor struct {
	spec         ChildSpec
	actor        *actor.Actor
	restartCount int
	restartTimes []time.Time
}

func NewSupervisor(ctx context.Context, opts SupervisorOpts) *Supervisor {
	ctx, cancel := context.WithCancel(ctx)
	return &Supervisor{
		opts:        opts,
		children:    make(map[string]*managedActor),
		ctx:         ctx,
		cancel:      cancel,
		DeadLetters: make(chan actor.Message, 1000),
	}
}

func (s *Supervisor) AddChild(spec ChildSpec) {
	s.mu.Lock()
	defer s.mu.Unlock()

	managed := &managedActor{spec: spec}
	managed.actor = actor.NewActor(spec.Name, spec.MailboxSize, spec.Fn)
	managed.actor.Start()
	s.children[spec.Name] = managed

	s.wg.Add(1)
	go s.monitorChild(managed)
}

func (s *Supervisor) monitorChild(managed *managedActor) {
	defer s.wg.Done()

	for {
		select {
		case <-s.ctx.Done():
			managed.actor.Stop()
			return

		case panicVal := <-managed.actor.PanicCh():
			log.Printf("[supervisor] child %s panicked: %v", managed.spec.Name, panicVal)

			if !s.shouldRestart(managed) {
				log.Printf("[supervisor] child %s exceeded restart limit, not restarting",
					managed.spec.Name)
				return
			}

			switch s.opts.Strategy {
			case OneForOne:
				s.restartActor(managed)
			case OneForAll:
				s.restartAllChildren()
			}
		}
	}
}

func (s *Supervisor) shouldRestart(managed *managedActor) bool {
	now := time.Now()
	window := managed.spec.RestartWindow
	if window == 0 {
		window = time.Minute
	}
	maxRestarts := managed.spec.MaxRestarts
	if maxRestarts == 0 {
		maxRestarts = 3
	}

	// Remove restart timestamps outside the window
	cutoff := now.Add(-window)
	var recent []time.Time
	for _, t := range managed.restartTimes {
		if t.After(cutoff) {
			recent = append(recent, t)
		}
	}
	managed.restartTimes = recent

	if len(recent) >= maxRestarts {
		return false
	}
	return true
}

func (s *Supervisor) restartActor(managed *managedActor) {
	managed.restartTimes = append(managed.restartTimes, time.Now())
	managed.restartCount++

	log.Printf("[supervisor] restarting child %s (attempt %d)",
		managed.spec.Name, managed.restartCount)

	// Drain remaining mailbox messages to dead letters
	for {
		select {
		case msg := <-managed.actor.PanicCh():
			_ = msg
		default:
			goto drained
		}
	}
drained:

	newActor := actor.NewActor(managed.spec.Name, managed.spec.MailboxSize, managed.spec.Fn)
	newActor.Start()

	s.mu.Lock()
	managed.actor = newActor
	s.mu.Unlock()

	// Watch the new actor
	go s.monitorChild(managed)
}

func (s *Supervisor) restartAllChildren() {
	s.mu.RLock()
	names := make([]string, 0, len(s.children))
	for name := range s.children {
		names = append(names, name)
	}
	s.mu.RUnlock()

	for _, name := range names {
		s.mu.RLock()
		managed := s.children[name]
		s.mu.RUnlock()
		managed.actor.Stop()
		s.restartActor(managed)
	}
}

func (s *Supervisor) Send(actorName string, msg actor.Message) error {
	s.mu.RLock()
	managed, ok := s.children[actorName]
	s.mu.RUnlock()

	if !ok {
		// Actor not found: send to dead letters
		select {
		case s.DeadLetters <- msg:
		default:
			log.Printf("[supervisor] dead letter channel full, dropping message to %s", actorName)
		}
		return fmt.Errorf("actor %s not found", actorName)
	}

	if err := managed.actor.Send(msg); err != nil {
		// Mailbox full: send to dead letters
		select {
		case s.DeadLetters <- msg:
		default:
			log.Printf("[supervisor] dead letter channel full, dropping message")
		}
		return err
	}
	return nil
}

func (s *Supervisor) Stop() {
	s.cancel()
	s.wg.Wait()
}
```

## Dead Letter Channel

The dead letter channel captures messages that cannot be delivered (actor not found, mailbox full, actor stopped). This is essential for debugging and ensuring no messages are silently lost:

```go
// deadletter/monitor.go
package deadletter

import (
	"encoding/json"
	"log"
	"sync/atomic"
	"time"

	"github.com/myorg/actor"
)

type Monitor struct {
	letters     chan actor.Message
	count       atomic.Int64
	byType      sync.Map  // map[string]*atomic.Int64
}

func NewMonitor(capacity int) *Monitor {
	return &Monitor{
		letters: make(chan actor.Message, capacity),
	}
}

func (m *Monitor) Channel() chan<- actor.Message {
	return m.letters
}

func (m *Monitor) Start() {
	go func() {
		for msg := range m.letters {
			m.count.Add(1)

			// Track by message type
			val, _ := m.byType.LoadOrStore(msg.Type, &atomic.Int64{})
			val.(*atomic.Int64).Add(1)

			// Log in structured format
			payload, _ := json.Marshal(msg.Payload)
			log.Printf("[dead-letter] type=%s payload=%s total=%d",
				msg.Type, string(payload), m.count.Load())

			// If a reply was expected, send an error response
			if msg.ReplyTo != nil {
				select {
				case msg.ReplyTo <- actor.Message{
					Type:    "Error",
					Payload: "message undeliverable: actor not available",
				}:
				default:
				}
			}
		}
	}()
}

func (m *Monitor) Stats() map[string]int64 {
	stats := make(map[string]int64)
	stats["total"] = m.count.Load()
	m.byType.Range(func(k, v interface{}) bool {
		stats[k.(string)] = v.(*atomic.Int64).Load()
		return true
	})
	return stats
}
```

## Backpressure and Mailbox Overflow Handling

When a slow actor receives more messages than it can process, its mailbox fills. There are three strategies:

```go
// Strategy 1: Drop oldest (circular buffer mailbox)
type CircularMailbox struct {
	mu     sync.Mutex
	buf    []actor.Message
	head   int
	tail   int
	size   int
	count  int
	drops  atomic.Int64
}

func NewCircularMailbox(size int) *CircularMailbox {
	return &CircularMailbox{
		buf:  make([]actor.Message, size),
		size: size,
	}
}

func (m *CircularMailbox) Push(msg actor.Message) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.count == m.size {
		// Overwrite oldest message (head)
		m.head = (m.head + 1) % m.size
		m.count--
		m.drops.Add(1)
	}

	m.buf[m.tail] = msg
	m.tail = (m.tail + 1) % m.size
	m.count++
}

func (m *CircularMailbox) Pop() (actor.Message, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.count == 0 {
		return actor.Message{}, false
	}

	msg := m.buf[m.head]
	m.head = (m.head + 1) % m.size
	m.count--
	return msg, true
}

// Strategy 2: Blocking send with timeout (caller-side backpressure)
type BackpressureActor struct {
	actor    *actor.Actor
	timeout  time.Duration
	rejected atomic.Int64
}

func (a *BackpressureActor) Send(msg actor.Message) error {
	err := a.actor.SendWithTimeout(msg, a.timeout)
	if err != nil {
		a.rejected.Add(1)
		return err
	}
	return nil
}

// Strategy 3: Producer rate limiting based on consumer throughput
type RateLimitedProducer struct {
	consumer *actor.Actor
	limiter  *rate.Limiter
}

func NewRateLimitedProducer(consumer *actor.Actor, rps float64) *RateLimitedProducer {
	return &RateLimitedProducer{
		consumer: consumer,
		limiter:  rate.NewLimiter(rate.Limit(rps), int(rps)),
	}
}

func (p *RateLimitedProducer) Send(ctx context.Context, msg actor.Message) error {
	if err := p.limiter.Wait(ctx); err != nil {
		return fmt.Errorf("rate limit: %w", err)
	}
	return p.consumer.Send(msg)
}
```

## Proto.Actor: Production Actor Library for Go

Proto.Actor provides a production-grade actor system with location transparency (actors can be on different machines), persistence, and clustering:

```go
// protoactor/order_actor.go
package protoactor

import (
	"fmt"
	"log"

	"github.com/asynkron/protoactor-go/actor"
	"github.com/myorg/messages"
)

// OrderActor processes order-related messages
type OrderActor struct {
	db     OrderDB
	orders map[string]*Order
}

func (a *OrderActor) Receive(ctx actor.Context) {
	switch msg := ctx.Message().(type) {
	case *actor.Started:
		log.Println("OrderActor started")
		a.orders = make(map[string]*Order)

	case *messages.CreateOrder:
		order := &Order{
			ID:         msg.OrderId,
			CustomerID: msg.CustomerId,
			Items:      msg.Items,
			Status:     "pending",
		}
		a.orders[order.ID] = order

		// Respond to sender
		ctx.Respond(&messages.OrderCreated{
			OrderId: order.ID,
			Status:  "pending",
		})

		// Spawn child actor for order processing
		props := actor.PropsFromProducer(func() actor.Actor {
			return &OrderProcessorActor{orderID: order.ID}
		})
		child := ctx.Spawn(props)
		ctx.Send(child, &messages.ProcessOrder{OrderId: order.ID})

	case *messages.GetOrder:
		order, ok := a.orders[msg.OrderId]
		if !ok {
			ctx.Respond(&messages.OrderNotFound{OrderId: msg.OrderId})
			return
		}
		ctx.Respond(&messages.OrderResponse{
			OrderId: order.ID,
			Status:  order.Status,
		})

	case *actor.Stopping:
		log.Println("OrderActor stopping")

	case *actor.Stopped:
		log.Println("OrderActor stopped")

	case *actor.Restarting:
		log.Println("OrderActor restarting after failure")
	}
}

// Main setup
func SetupActorSystem() {
	system := actor.NewActorSystem()

	// Define supervision strategy
	decider := func(reason interface{}) actor.Directive {
		switch reason.(type) {
		case *EphemeralError:
			return actor.RestartDirective  // restart on transient errors
		case *FatalError:
			return actor.StopDirective     // stop on fatal errors
		default:
			return actor.EscalateDirective // escalate unknown failures
		}
	}

	supervisionStrategy := actor.NewOneForOneStrategy(
		3,             // max restarts
		1000,          // within 1000ms
		decider,
	)

	props := actor.
		PropsFromProducer(func() actor.Actor {
			return &OrderActor{db: newOrderDB()}
		}).
		WithSupervisor(supervisionStrategy).
		WithMailbox(mailbox.UnboundedWithSuspend()) // suspend mailbox during restart

	pid := system.Root.Spawn(props)

	// Send a message and wait for response
	future := system.Root.RequestFuture(pid, &messages.CreateOrder{
		OrderId:    "order-001",
		CustomerId: "cust-001",
	}, 5*time.Second)

	result, err := future.Result()
	if err != nil {
		log.Fatalf("request failed: %v", err)
	}
	log.Printf("Order created: %v", result)
}
```

## Request-Reply Pattern with Channels

Actors often need to send a request and wait for a response:

```go
// request-reply with timeout
func RequestReply(
	ctx context.Context,
	actor *Actor,
	request actor.Message,
	timeout time.Duration,
) (actor.Message, error) {
	replyCh := make(chan actor.Message, 1)
	request.ReplyTo = replyCh

	if err := actor.SendWithTimeout(request, timeout); err != nil {
		return actor.Message{}, fmt.Errorf("send failed: %w", err)
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case reply := <-replyCh:
		return reply, nil
	case <-timer.C:
		return actor.Message{}, fmt.Errorf("timeout waiting for reply from %s", actor.Name())
	case <-ctx.Done():
		return actor.Message{}, ctx.Err()
	}
}
```

## Testing Actors with a Deterministic Scheduler

The challenge with actor tests is non-determinism: goroutines run in any order, making tests flaky. Use a deterministic test scheduler that controls message delivery order:

```go
// testing/deterministic_scheduler.go
package testing

import (
	"sync"
	"testing"

	"github.com/myorg/actor"
)

// TestActor captures received messages for assertions
type TestActor struct {
	mu       sync.Mutex
	received []actor.Message
	t        *testing.T
}

func NewTestActor(t *testing.T) *TestActor {
	return &TestActor{t: t}
}

func (a *TestActor) Fn() actor.ActorFunc {
	return func(ctx context.Context, msg actor.Message) error {
		a.mu.Lock()
		defer a.mu.Unlock()
		a.received = append(a.received, msg)
		return nil
	}
}

func (a *TestActor) WaitForMessage(t *testing.T, msgType string, timeout time.Duration) actor.Message {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		for _, msg := range a.received {
			if msg.Type == msgType {
				a.mu.Unlock()
				return msg
			}
		}
		a.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for message type %s", msgType)
	return actor.Message{}
}

func (a *TestActor) AssertReceived(t *testing.T, msgTypes ...string) {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()

	received := make(map[string]bool)
	for _, msg := range a.received {
		received[msg.Type] = true
	}

	for _, expected := range msgTypes {
		if !received[expected] {
			t.Errorf("expected to receive message type %s, but did not", expected)
		}
	}
}

func (a *TestActor) AssertNotReceived(t *testing.T, msgType string) {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()

	for _, msg := range a.received {
		if msg.Type == msgType {
			t.Errorf("expected NOT to receive message type %s, but did", msgType)
			return
		}
	}
}

// Full actor system test
func TestSupervisorRestartOnPanic(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var callCount atomic.Int32
	panicOnFirst := func(ctx context.Context, msg actor.Message) error {
		count := callCount.Add(1)
		if count == 1 {
			panic("simulated panic on first call")
		}
		return nil
	}

	sup := NewSupervisor(ctx, SupervisorOpts{
		Strategy: OneForOne,
	})

	sup.AddChild(ChildSpec{
		Name:          "test-actor",
		MailboxSize:   10,
		Fn:            panicOnFirst,
		MaxRestarts:   3,
		RestartWindow: time.Minute,
	})

	// First message triggers panic
	sup.Send("test-actor", actor.Message{Type: "trigger"})

	// Wait for restart
	time.Sleep(100 * time.Millisecond)

	// Second message should succeed after restart
	sup.Send("test-actor", actor.Message{Type: "trigger"})
	time.Sleep(50 * time.Millisecond)

	if callCount.Load() < 2 {
		t.Errorf("expected at least 2 calls (1 panic + 1 success), got %d",
			callCount.Load())
	}

	sup.Stop()
}

func TestDeadLetterCapture(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	sup := NewSupervisor(ctx, SupervisorOpts{Strategy: OneForOne})

	// Send to nonexistent actor
	msg := actor.Message{Type: "orphan", Payload: "test"}
	err := sup.Send("nonexistent-actor", msg)

	if err == nil {
		t.Fatal("expected error sending to nonexistent actor")
	}

	// Check dead letter was captured
	select {
	case dl := <-sup.DeadLetters:
		if dl.Type != "orphan" {
			t.Errorf("expected dead letter type 'orphan', got '%s'", dl.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("expected dead letter within 1 second")
	}
}
```

## Comparing with Erlang/Akka Supervision

| Feature | Erlang OTP | Akka (Scala/Java) | Go (custom) | Proto.Actor |
|---|---|---|---|---|
| Supervision strategies | one_for_one, one_for_all, rest_for_one, simple_one_for_one | OneForOneStrategy, AllForOneStrategy | Custom | OneForOne, AllForOne |
| Message delivery | At-most-once (default), at-least-once (with persistence) | At-most-once (local), configurable remote | At-most-once | At-most-once, persistence available |
| Location transparency | Yes (Erlang distribution) | Yes (Akka Cluster) | No (without Proto.Actor) | Yes (virtual actors) |
| Let-it-crash philosophy | Core principle | Supported | Manual recovery required | Supported |
| Binary pattern matching | Yes | No | No | No |
| Hot code loading | Yes | No | No | No |
| Memory overhead per actor | ~400 bytes | ~300 bytes + JVM overhead | 8KB (goroutine stack) | ~200 bytes |

Go's goroutine stacks start at 8KB versus Erlang's ~400 bytes per process, making Go actors 20x heavier per unit. For most applications this is irrelevant, but at millions of concurrent actors, Erlang remains the better choice.

## Practical Application: Connection Pool Actor

```go
// pool/connection_pool_actor.go
package pool

type ConnPoolActor struct {
	conns   chan net.Conn
	addr    string
	maxSize int
}

type BorrowRequest struct{}
type ReturnConn struct{ Conn net.Conn }
type ConnResponse struct {
	Conn net.Conn
	Err  error
}

func (a *ConnPoolActor) Receive(ctx actor.Context) {
	switch msg := ctx.Message().(type) {
	case *actor.Started:
		a.conns = make(chan net.Conn, a.maxSize)
		// Pre-warm the pool
		for i := 0; i < 5; i++ {
			conn, _ := net.Dial("tcp", a.addr)
			a.conns <- conn
		}

	case *BorrowRequest:
		select {
		case conn := <-a.conns:
			ctx.Respond(&ConnResponse{Conn: conn})
		default:
			// Create new connection if pool empty
			conn, err := net.Dial("tcp", a.addr)
			ctx.Respond(&ConnResponse{Conn: conn, Err: err})
		}

	case *ReturnConn:
		if msg.Conn != nil {
			select {
			case a.conns <- msg.Conn:
				// Returned to pool
			default:
				// Pool full, close the connection
				msg.Conn.Close()
			}
		}
	}
}
```

## Summary

The actor model in Go provides a structured way to manage concurrency without shared mutable state. The core implementation requires:

1. Goroutines as actors with buffered channels as mailboxes
2. Panic recovery in every actor goroutine, reporting to a supervisor channel
3. Supervisor goroutines that implement restart strategies (one-for-one or one-for-all) with configurable restart limits
4. Dead letter channels to capture undeliverable messages for debugging
5. Backpressure via bounded mailboxes with explicit overflow handling (drop, block, or rate-limit)

For production systems requiring location transparency and cluster-level actor distribution, Proto.Actor provides a complete framework. For simpler single-process systems, the patterns shown here provide the essential supervision properties without external dependencies.

Testing actors deterministically requires explicit synchronization points — either testing.T assertions on captured messages or timeouts that are generous enough to accommodate CI runner variability.
