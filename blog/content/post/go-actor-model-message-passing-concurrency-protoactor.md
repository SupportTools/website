---
title: "Go Actor Model: Implementing Message-Passing Concurrency"
date: 2029-07-09T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Actor Model", "Concurrency", "protoactor-go", "Distributed Systems", "Message Passing"]
categories: ["Go", "Concurrency", "Distributed Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Implementing the actor model in Go using channels and protoactor-go: mailbox implementation, supervision trees, cluster sharding, and when to choose actors over goroutines for production concurrent systems."
more_link: "yes"
url: "/go-actor-model-message-passing-concurrency-protoactor/"
---

The actor model is a mathematical model of concurrent computation where the fundamental unit is an actor: an entity that can receive messages, create new actors, send messages to other actors, and determine how to respond to the next message it receives. While Go's goroutines and channels already provide powerful concurrency primitives, the actor model adds structure—supervision, location transparency, and fault isolation—that becomes critical in large distributed systems.

<!--more-->

# Go Actor Model: Implementing Message-Passing Concurrency

## The Actor Model Fundamentals

An actor is defined by three capabilities:
1. Process one message at a time (serial message handling)
2. Send messages to other actors (by address/reference)
3. Create new child actors

The critical insight: **actors never share state**. All communication happens via messages, eliminating the need for mutexes and enabling distribution across processes and machines.

### Actor vs Goroutine

Before reaching for actors, understand the tradeoff:

| Aspect | Goroutine + Channel | Actor (protoactor-go) |
|--------|--------------------|-----------------------|
| Overhead | ~2KB stack, minimal | Actor system overhead + PID management |
| Communication | Typed Go channels | Untyped interface{} messages (or protobuf) |
| Supervision | Manual error handling | Built-in supervisor strategies |
| Location transparency | Same process only | Local, remote, or cluster |
| Message ordering | FIFO per channel | FIFO per actor mailbox |
| Backpressure | Channel blocking | Mailbox overflow policies |
| Debugging | Stack traces | Actor hierarchy + message tracing |

**Use goroutines when:**
- Simple concurrent operations within a single process
- Performance-critical tight loops
- You control the entire lifecycle

**Use actors when:**
- Building systems where components need supervision and restart
- Distributing work across multiple machines
- You need location transparency (local/remote same interface)
- Complex state machines with many message types

## Building an Actor from Scratch with Channels

Before using a library, implementing a simple actor with channels illuminates the underlying concepts:

```go
package actor

import (
    "context"
    "fmt"
    "sync"
)

// Message is the fundamental unit of communication
type Message interface{}

// Actor processes messages serially
type Actor interface {
    Receive(ctx *Context)
}

// Context provides the actor with its environment
type Context struct {
    Message  Message
    Self     *PID
    Sender   *PID
    Children []*PID
    system   *ActorSystem
}

func (c *Context) Send(target *PID, msg Message) {
    c.system.send(target, msg, c.Self)
}

func (c *Context) Spawn(props *Props) *PID {
    return c.system.spawn(props, c.Self)
}

func (c *Context) Stop(pid *PID) {
    c.system.send(pid, &poisonPill{}, c.Self)
}

// PID is an actor reference (process identifier)
type PID struct {
    id      string
    mailbox chan envelope
}

type envelope struct {
    msg    Message
    sender *PID
}

type poisonPill struct{}

// Props is an actor factory
type Props struct {
    producer func() Actor
    mailboxSize int
}

func PropsFromFunc(f func(ctx *Context)) *Props {
    return &Props{
        producer: func() Actor {
            return &funcActor{f: f}
        },
        mailboxSize: 1000,
    }
}

func (p *Props) WithMailboxSize(size int) *Props {
    p.mailboxSize = size
    return p
}

type funcActor struct {
    f func(ctx *Context)
}

func (fa *funcActor) Receive(ctx *Context) {
    fa.f(ctx)
}

// ActorSystem manages all actors
type ActorSystem struct {
    mu      sync.RWMutex
    actors  map[string]*actorProcess
    counter uint64
}

type actorProcess struct {
    pid    *PID
    actor  Actor
    parent *PID
}

func NewActorSystem() *ActorSystem {
    return &ActorSystem{
        actors: make(map[string]*actorProcess),
    }
}

func (s *ActorSystem) Spawn(props *Props) *PID {
    return s.spawn(props, nil)
}

func (s *ActorSystem) spawn(props *Props, parent *PID) *PID {
    s.mu.Lock()
    s.counter++
    id := fmt.Sprintf("actor-%d", s.counter)
    s.mu.Unlock()

    pid := &PID{
        id:      id,
        mailbox: make(chan envelope, props.mailboxSize),
    }
    actor := props.producer()

    proc := &actorProcess{
        pid:    pid,
        actor:  actor,
        parent: parent,
    }

    s.mu.Lock()
    s.actors[id] = proc
    s.mu.Unlock()

    go s.processMailbox(proc)
    return pid
}

func (s *ActorSystem) processMailbox(proc *actorProcess) {
    defer func() {
        if r := recover(); r != nil {
            fmt.Printf("Actor %s panicked: %v\n", proc.pid.id, r)
            // In a real system: notify supervisor, restart based on strategy
            s.mu.Lock()
            delete(s.actors, proc.pid.id)
            s.mu.Unlock()
        }
    }()

    for env := range proc.pid.mailbox {
        if _, ok := env.msg.(*poisonPill); ok {
            s.mu.Lock()
            delete(s.actors, proc.pid.id)
            s.mu.Unlock()
            return
        }

        ctx := &Context{
            Message: env.msg,
            Self:    proc.pid,
            Sender:  env.sender,
            system:  s,
        }
        proc.actor.Receive(ctx)
    }
}

func (s *ActorSystem) send(target *PID, msg Message, sender *PID) {
    select {
    case target.mailbox <- envelope{msg: msg, sender: sender}:
    default:
        // Mailbox full - in production: apply backpressure strategy
        fmt.Printf("WARNING: Mailbox full for actor %s, dropping message\n", target.id)
    }
}

func (s *ActorSystem) Send(target *PID, msg Message) {
    s.send(target, msg, nil)
}
```

### Using the Custom Actor System

```go
package main

import (
    "fmt"
    "time"
    "yourmodule/actor"
)

type CounterState struct {
    count int
}

type Increment struct{ By int }
type GetCount struct{}
type CountResponse struct{ Count int }

func main() {
    system := actor.NewActorSystem()

    // Stateful counter actor
    var state CounterState

    counter := system.Spawn(actor.PropsFromFunc(func(ctx *actor.Context) {
        switch msg := ctx.Message.(type) {
        case *Increment:
            state.count += msg.By
        case *GetCount:
            if ctx.Sender != nil {
                system.Send(ctx.Sender, &CountResponse{Count: state.count})
            }
        }
    }))

    // Send messages
    for i := 0; i < 5; i++ {
        system.Send(counter, &Increment{By: i + 1})
    }

    // Response actor to receive the count
    done := make(chan int, 1)
    responder := system.Spawn(actor.PropsFromFunc(func(ctx *actor.Context) {
        if msg, ok := ctx.Message.(*CountResponse); ok {
            done <- msg.Count
        }
    }))

    system.Send(counter, &GetCount{})
    // Note: in real usage, send responder PID in the message
    _ = responder
    time.Sleep(100 * time.Millisecond)

    fmt.Printf("Counter value: %d\n", state.count) // Access directly for demo
}
```

## protoactor-go: Production Actor Framework

The `protoactor-go` library provides a production-grade actor system with local actors, virtual actors, cluster support, and remote messaging.

### Installation

```bash
go get github.com/asynkron/protoactor-go/actor
go get github.com/asynkron/protoactor-go/remote
go get github.com/asynkron/protoactor-go/cluster
```

### Basic protoactor-go Actors

```go
package main

import (
    "fmt"
    "time"

    "github.com/asynkron/protoactor-go/actor"
)

// Define messages as Go structs
type Hello struct{ Who string }
type Goodbye struct{ Who string }

// GreeterActor implements actor.Actor
type GreeterActor struct {
    greetCount int
}

func (g *GreeterActor) Receive(ctx actor.Context) {
    switch msg := ctx.Message().(type) {
    case *actor.Started:
        fmt.Println("GreeterActor started")
    case *actor.Stopping:
        fmt.Println("GreeterActor stopping")
    case *actor.Stopped:
        fmt.Println("GreeterActor stopped")
    case *Hello:
        g.greetCount++
        fmt.Printf("Hello, %s! (greeting #%d)\n", msg.Who, g.greetCount)
        // Reply to sender if request-response pattern
        if ctx.Sender() != nil {
            ctx.Respond(&Hello{Who: "GreeterActor"})
        }
    case *Goodbye:
        fmt.Printf("Goodbye, %s!\n", msg.Who)
    }
}

func main() {
    system := actor.NewActorSystem()
    rootCtx := system.Root

    props := actor.PropsFromProducer(func() actor.Actor {
        return &GreeterActor{}
    })

    pid := rootCtx.Spawn(props)

    rootCtx.Send(pid, &Hello{Who: "World"})
    rootCtx.Send(pid, &Hello{Who: "Go"})
    rootCtx.Send(pid, &Goodbye{Who: "All"})

    // Request-Response: synchronous ask
    result, err := rootCtx.RequestFuture(pid, &Hello{Who: "Future"}, 2*time.Second).Result()
    if err != nil {
        fmt.Printf("Error: %v\n", err)
    } else {
        fmt.Printf("Got response: %v\n", result)
    }

    rootCtx.Stop(pid)
    time.Sleep(100 * time.Millisecond)
}
```

### Mailbox Implementation

protoactor-go's mailbox is a concurrent queue that decouples message sending from processing. Custom mailboxes allow tuning throughput vs latency:

```go
package mailbox

import (
    "runtime"
    "sync/atomic"
    "unsafe"

    "github.com/asynkron/protoactor-go/actor"
    "github.com/asynkron/protoactor-go/mailbox"
)

// High-throughput bounded mailbox using lock-free ring buffer
type RingBufferMailbox struct {
    userMailbox     chan interface{}
    systemMailbox   chan interface{}
    schedulerStatus int32
    hasMoreMessages int32
    invoker         mailbox.MessageInvoker
    dispatcher      mailbox.Dispatcher
}

const (
    idle    int32 = 0
    running int32 = 1
)

func NewRingBufferMailbox(size int) mailbox.Mailbox {
    return &RingBufferMailbox{
        userMailbox:   make(chan interface{}, size),
        systemMailbox: make(chan interface{}, 8), // System messages get priority
    }
}

func (m *RingBufferMailbox) PostUserMessage(msg interface{}) {
    select {
    case m.userMailbox <- msg:
        m.schedule()
    default:
        // Mailbox full: apply configured overflow strategy
        // Options: drop oldest, drop newest, block, error
        panic(fmt.Sprintf("mailbox overflow: %T", msg))
    }
}

func (m *RingBufferMailbox) PostSystemMessage(msg interface{}) {
    m.systemMailbox <- msg // System messages never block
    m.schedule()
}

func (m *RingBufferMailbox) schedule() {
    if atomic.CompareAndSwapInt32(&m.schedulerStatus, idle, running) {
        m.dispatcher.Schedule(m.run)
    } else {
        atomic.StoreInt32(&m.hasMoreMessages, 1)
    }
}

func (m *RingBufferMailbox) run() {
    const batchSize = 100

    for {
        // System messages have priority
        select {
        case msg := <-m.systemMailbox:
            m.invoker.InvokeSystemMessage(msg)
            continue
        default:
        }

        // Process user messages in batches
        processed := 0
        for processed < batchSize {
            select {
            case msg := <-m.userMailbox:
                m.invoker.InvokeUserMessage(msg)
                processed++
            default:
                goto done
            }
        }

    done:
        atomic.StoreInt32(&m.schedulerStatus, idle)
        if atomic.SwapInt32(&m.hasMoreMessages, 0) == 1 {
            if atomic.CompareAndSwapInt32(&m.schedulerStatus, idle, running) {
                continue
            }
        }
        return
    }
}

func (m *RingBufferMailbox) RegisterHandlers(invoker mailbox.MessageInvoker, dispatcher mailbox.Dispatcher) {
    m.invoker = invoker
    m.dispatcher = dispatcher
}

func (m *RingBufferMailbox) Start() {}

// Using the custom mailbox
func newActorWithCustomMailbox() *actor.Props {
    return actor.PropsFromProducer(func() actor.Actor {
        return &GreeterActor{}
    }).WithMailbox(func() mailbox.Mailbox {
        return NewRingBufferMailbox(10000)
    })
}
```

### Supervision Trees

Supervision trees define how failures in child actors are handled by parent actors. This is where actors excel over goroutines: structured error recovery without ad-hoc try/catch:

```go
package supervision

import (
    "fmt"
    "time"

    "github.com/asynkron/protoactor-go/actor"
)

// WorkerActor that can fail
type WorkerActor struct {
    id       int
    failAt   int
    msgCount int
}

func (w *WorkerActor) Receive(ctx actor.Context) {
    switch msg := ctx.Message().(type) {
    case *actor.Started:
        fmt.Printf("Worker %d started\n", w.id)
    case *actor.Restarting:
        fmt.Printf("Worker %d restarting after failure\n", w.id)
    case *ProcessJob:
        w.msgCount++
        if w.msgCount == w.failAt {
            panic(fmt.Sprintf("Worker %d simulated failure at message %d", w.id, w.msgCount))
        }
        fmt.Printf("Worker %d processed job: %v\n", w.id, msg.Data)
    }
}

type ProcessJob struct {
    Data interface{}
}

// SupervisorActor manages worker lifecycle
type SupervisorActor struct {
    workers []*actor.PID
    current int
}

func (s *SupervisorActor) Receive(ctx actor.Context) {
    switch msg := ctx.Message().(type) {
    case *actor.Started:
        // Spawn worker pool
        for i := 0; i < 3; i++ {
            workerID := i
            props := actor.PropsFromProducer(func() actor.Actor {
                return &WorkerActor{id: workerID, failAt: 5}
            }).WithSupervisor(s.supervisorStrategy())

            pid := ctx.Spawn(props)
            s.workers = append(s.workers, pid)
        }
        fmt.Printf("Supervisor started %d workers\n", len(s.workers))

    case *ProcessJob:
        // Round-robin dispatch
        if len(s.workers) > 0 {
            target := s.workers[s.current%len(s.workers)]
            ctx.Send(target, msg)
            s.current++
        }

    case *actor.Terminated:
        // Worker terminated (not just stopped)
        fmt.Printf("Worker terminated: %v, restarting...\n", msg.Who)
        // Remove and re-add
        for i, pid := range s.workers {
            if pid.Equal(msg.Who) {
                s.workers = append(s.workers[:i], s.workers[i+1:]...)
                break
            }
        }
    }
}

// supervisorStrategy defines restart behavior for child failures
func (s *SupervisorActor) supervisorStrategy() actor.SupervisorStrategy {
    // OneForOne: only restart the failed child
    return actor.NewOneForOneStrategy(
        10,           // maxNrOfRetries: max restarts
        time.Minute,  // withinDuration: within this window
        func(reason interface{}) actor.Directive {
            fmt.Printf("Child failed with reason: %v\n", reason)
            switch reason.(type) {
            case *EscalateError:
                // Escalate to grandparent supervisor
                return actor.EscalateDirective
            case *TransientError:
                // Restart the child actor
                return actor.RestartDirective
            case *PermanentError:
                // Stop the child permanently
                return actor.StopDirective
            default:
                // Restart for unknown errors
                return actor.RestartDirective
            }
        },
    )
}

type EscalateError struct{ Msg string }
type TransientError struct{ Msg string }
type PermanentError struct{ Msg string }

// AllForOne: restart all children when one fails
func allForOneSupervisorStrategy() actor.SupervisorStrategy {
    return actor.NewAllForOneStrategy(
        3,
        time.Minute,
        func(reason interface{}) actor.Directive {
            return actor.RestartDirective
        },
    )
}

func RunSupervisedWorkers() {
    system := actor.NewActorSystem()
    rootCtx := system.Root

    supervisorProps := actor.PropsFromProducer(func() actor.Actor {
        return &SupervisorActor{}
    })

    supervisor := rootCtx.Spawn(supervisorProps)

    // Send jobs to supervisor for dispatching
    for i := 0; i < 20; i++ {
        rootCtx.Send(supervisor, &ProcessJob{Data: fmt.Sprintf("job-%d", i)})
        time.Sleep(50 * time.Millisecond)
    }

    time.Sleep(2 * time.Second)
    rootCtx.Stop(supervisor)
}
```

### Request-Response Pattern with Futures

```go
package patterns

import (
    "context"
    "fmt"
    "time"

    "github.com/asynkron/protoactor-go/actor"
)

// QueryRequest/Response pattern
type DatabaseQuery struct {
    SQL  string
    Args []interface{}
}

type DatabaseResult struct {
    Rows  []map[string]interface{}
    Error error
}

type DatabaseActor struct {
    // In production: connection pool, circuit breaker
}

func (d *DatabaseActor) Receive(ctx actor.Context) {
    switch msg := ctx.Message().(type) {
    case *DatabaseQuery:
        // Simulate async DB query
        result := d.executeQuery(msg)
        ctx.Respond(result)
    }
}

func (d *DatabaseActor) executeQuery(q *DatabaseQuery) *DatabaseResult {
    // Simulated query execution
    return &DatabaseResult{
        Rows: []map[string]interface{}{
            {"id": 1, "name": "example"},
        },
    }
}

// Service using the database actor
type UserService struct {
    dbActor *actor.PID
    system  *actor.ActorSystem
}

func (s *UserService) GetUser(ctx context.Context, userID int) (map[string]interface{}, error) {
    query := &DatabaseQuery{
        SQL:  "SELECT * FROM users WHERE id = ?",
        Args: []interface{}{userID},
    }

    // RequestFuture: send message and wait for response
    future := s.system.Root.RequestFuture(s.dbActor, query, 5*time.Second)

    select {
    case <-ctx.Done():
        return nil, ctx.Err()
    default:
    }

    result, err := future.Result()
    if err != nil {
        return nil, fmt.Errorf("database query timeout: %w", err)
    }

    dbResult := result.(*DatabaseResult)
    if dbResult.Error != nil {
        return nil, dbResult.Error
    }

    if len(dbResult.Rows) == 0 {
        return nil, fmt.Errorf("user %d not found", userID)
    }

    return dbResult.Rows[0], nil
}

// Pipeline pattern: chain actors for sequential processing
type Pipeline struct {
    stages []*actor.PID
    system *actor.ActorSystem
}

type PipelineMessage struct {
    Data    interface{}
    StageID int
    ReplyTo *actor.PID
}

func NewPipeline(system *actor.ActorSystem, stages ...func(actor.Context)) *Pipeline {
    p := &Pipeline{system: system}
    for _, stage := range stages {
        stageFunc := stage // capture
        props := actor.PropsFromFunc(stageFunc)
        p.stages = append(p.stages, system.Root.Spawn(props))
    }
    return p
}

func (p *Pipeline) Process(data interface{}) (*actor.Future, error) {
    if len(p.stages) == 0 {
        return nil, fmt.Errorf("empty pipeline")
    }

    // Create a reply-to actor (future pattern)
    future := actor.NewFuture(p.system, 10*time.Second)

    msg := &PipelineMessage{
        Data:    data,
        StageID: 0,
        ReplyTo: future.PID(),
    }

    p.system.Root.Send(p.stages[0], msg)
    return future, nil
}
```

### Cluster Sharding

For distributing actor state across a cluster:

```go
package cluster

import (
    "fmt"

    "github.com/asynkron/protoactor-go/actor"
    "github.com/asynkron/protoactor-go/cluster"
    "github.com/asynkron/protoactor-go/cluster/clusterproviders/consul"
    "github.com/asynkron/protoactor-go/remote"
)

// Define grain (virtual actor) interface via protobuf
// In production: generate from .proto file

// UserGrain represents a virtual actor for a specific user
type UserGrain struct {
    cluster.Grain
    userID   string
    balance  float64
    sessions int
}

type UserMessage struct {
    Kind    string
    Payload interface{}
}

type UserResponse struct {
    Success bool
    Data    interface{}
}

func (u *UserGrain) Init(id string) {
    u.userID = id
    fmt.Printf("UserGrain initialized for user: %s\n", id)
    // Load state from database here
}

func (u *UserGrain) Terminate() {
    fmt.Printf("UserGrain terminating for user: %s, saving state\n", u.userID)
    // Persist state to database here
}

func (u *UserGrain) ReceiveDefault(ctx actor.Context) {
    switch msg := ctx.Message().(type) {
    case *UserMessage:
        switch msg.Kind {
        case "login":
            u.sessions++
            ctx.Respond(&UserResponse{Success: true, Data: u.sessions})
        case "logout":
            if u.sessions > 0 {
                u.sessions--
            }
            ctx.Respond(&UserResponse{Success: true, Data: u.sessions})
        case "get_balance":
            ctx.Respond(&UserResponse{Success: true, Data: u.balance})
        }
    }
}

// Cluster setup
func SetupCluster(memberHost string, memberPort int) (*cluster.Cluster, error) {
    remoteConfig := remote.Configure(memberHost, memberPort)

    // Register grain kinds
    grainKind := cluster.NewKind("UserGrain",
        actor.PropsFromProducer(func() actor.Actor {
            return &UserGrain{}
        }),
    )

    // Use Consul for cluster membership (can also use Kubernetes, etcd)
    clusterProvider, err := consul.New()
    if err != nil {
        return nil, fmt.Errorf("consul provider: %w", err)
    }

    config := cluster.Configure(
        "my-cluster",
        clusterProvider,
        remote.NewIdentityStorageLookup(
            remote.NewRemoteIdentityStorage(),
        ),
        cluster.WithKinds(grainKind),
        cluster.WithRemoteConfig(remoteConfig),
    )

    c := cluster.New(actor.NewActorSystem(), config)
    c.StartMember()

    return c, nil
}

// Accessing cluster grains from any node
func AccessUserGrain(c *cluster.Cluster, userID string) {
    // The cluster routes to the correct node automatically
    // Grain is activated on-demand and deactivated when idle
    ctx := c.GetClusterIdentity(userID, "UserGrain")

    // Send message to virtual actor (location transparent)
    result, err := c.Request(ctx, &UserMessage{Kind: "login"}, nil)
    if err != nil {
        fmt.Printf("Error: %v\n", err)
        return
    }

    response := result.(*UserResponse)
    fmt.Printf("User %s sessions: %v\n", userID, response.Data)
}
```

### Consistent Hashing for Shard Distribution

```go
package sharding

import (
    "crypto/sha256"
    "encoding/binary"
    "fmt"
    "sort"
    "sync"
)

// ConsistentHashRing distributes actors across cluster nodes
type ConsistentHashRing struct {
    mu       sync.RWMutex
    ring     map[uint64]string // hash -> node address
    sorted   []uint64          // sorted hash keys
    replicas int               // virtual nodes per physical node
    nodes    map[string]bool   // physical nodes
}

func NewConsistentHashRing(replicas int) *ConsistentHashRing {
    return &ConsistentHashRing{
        ring:     make(map[uint64]string),
        nodes:    make(map[string]bool),
        replicas: replicas,
    }
}

func (r *ConsistentHashRing) AddNode(node string) {
    r.mu.Lock()
    defer r.mu.Unlock()

    r.nodes[node] = true
    for i := 0; i < r.replicas; i++ {
        key := r.hashKey(fmt.Sprintf("%s-%d", node, i))
        r.ring[key] = node
        r.sorted = append(r.sorted, key)
    }
    sort.Slice(r.sorted, func(i, j int) bool {
        return r.sorted[i] < r.sorted[j]
    })
}

func (r *ConsistentHashRing) RemoveNode(node string) {
    r.mu.Lock()
    defer r.mu.Unlock()

    delete(r.nodes, node)
    for i := 0; i < r.replicas; i++ {
        key := r.hashKey(fmt.Sprintf("%s-%d", node, i))
        delete(r.ring, key)
    }

    // Rebuild sorted slice
    r.sorted = r.sorted[:0]
    for key := range r.ring {
        r.sorted = append(r.sorted, key)
    }
    sort.Slice(r.sorted, func(i, j int) bool {
        return r.sorted[i] < r.sorted[j]
    })
}

func (r *ConsistentHashRing) GetNode(actorID string) string {
    r.mu.RLock()
    defer r.mu.RUnlock()

    if len(r.sorted) == 0 {
        return ""
    }

    key := r.hashKey(actorID)
    idx := sort.Search(len(r.sorted), func(i int) bool {
        return r.sorted[i] >= key
    })

    if idx == len(r.sorted) {
        idx = 0
    }

    return r.ring[r.sorted[idx]]
}

func (r *ConsistentHashRing) hashKey(s string) uint64 {
    h := sha256.Sum256([]byte(s))
    return binary.BigEndian.Uint64(h[:8])
}
```

## Actor Performance Benchmarks

```go
package benchmarks

import (
    "testing"
    "sync"

    "github.com/asynkron/protoactor-go/actor"
)

// Benchmark: Actor message throughput vs channel throughput

func BenchmarkActorMessageSend(b *testing.B) {
    system := actor.NewActorSystem()

    var wg sync.WaitGroup
    wg.Add(b.N)

    pid := system.Root.Spawn(
        actor.PropsFromFunc(func(ctx actor.Context) {
            if _, ok := ctx.Message().(int); ok {
                wg.Done()
            }
        }),
    )

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        system.Root.Send(pid, i)
    }
    wg.Wait()
}

func BenchmarkChannelSend(b *testing.B) {
    ch := make(chan int, 1000)
    var wg sync.WaitGroup
    wg.Add(b.N)

    go func() {
        for range ch {
            wg.Done()
        }
    }()

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        ch <- i
    }
    wg.Wait()
    close(ch)
}

// Typical results:
// BenchmarkActorMessageSend    ~5M ops/s
// BenchmarkChannelSend         ~50M ops/s
// Actor overhead: ~10x for pure throughput
// But actors provide supervision, clustering, location transparency
```

## Production Patterns

### Circuit Breaker Actor

```go
package patterns

import (
    "fmt"
    "time"

    "github.com/asynkron/protoactor-go/actor"
)

type CircuitState int

const (
    CircuitClosed   CircuitState = iota // Normal operation
    CircuitOpen                         // Failing, reject requests
    CircuitHalfOpen                     // Testing recovery
)

type CircuitBreakerActor struct {
    state        CircuitState
    failureCount int
    successCount int
    lastFailure  time.Time
    threshold    int
    timeout      time.Duration
    downstream   *actor.PID
}

type ServiceRequest struct {
    Payload interface{}
}

type ServiceResponse struct {
    Result interface{}
    Error  error
}

func (cb *CircuitBreakerActor) Receive(ctx actor.Context) {
    switch msg := ctx.Message().(type) {
    case *ServiceRequest:
        switch cb.state {
        case CircuitOpen:
            if time.Since(cb.lastFailure) > cb.timeout {
                cb.state = CircuitHalfOpen
                cb.successCount = 0
                cb.forwardRequest(ctx, msg)
            } else {
                ctx.Respond(&ServiceResponse{
                    Error: fmt.Errorf("circuit breaker open"),
                })
            }

        case CircuitHalfOpen, CircuitClosed:
            cb.forwardRequest(ctx, msg)
        }

    case *ServiceResponse:
        if msg.Error != nil {
            cb.recordFailure()
        } else {
            cb.recordSuccess()
        }
        // Forward response to original caller
        if ctx.Sender() != nil {
            ctx.Send(ctx.Sender(), msg)
        }
    }
}

func (cb *CircuitBreakerActor) forwardRequest(ctx actor.Context, req *ServiceRequest) {
    ctx.RequestWithCustomSender(cb.downstream, req, ctx.Self())
}

func (cb *CircuitBreakerActor) recordFailure() {
    cb.failureCount++
    cb.successCount = 0
    cb.lastFailure = time.Now()

    if cb.failureCount >= cb.threshold {
        cb.state = CircuitOpen
        fmt.Printf("Circuit breaker OPENED after %d failures\n", cb.failureCount)
    }
}

func (cb *CircuitBreakerActor) recordSuccess() {
    cb.failureCount = 0
    cb.successCount++

    if cb.state == CircuitHalfOpen && cb.successCount >= 3 {
        cb.state = CircuitClosed
        fmt.Println("Circuit breaker CLOSED - service recovered")
    }
}
```

## Summary

The actor model in Go provides a powerful concurrency abstraction beyond raw goroutines:

- **Custom channel-based actors** work well for simple supervision needs within a single process
- **protoactor-go** provides production-grade features: virtual actors, cluster sharding, supervision strategies, and remote messaging
- **Mailbox implementations** determine throughput characteristics; bounded mailboxes prevent unbounded memory growth
- **Supervision trees** encode failure handling as data, making fault tolerance explicit and testable
- **Cluster sharding** via consistent hashing distributes actor state across nodes with automatic routing

The ~10x throughput penalty vs raw channels is acceptable when you need supervision, restartability, or location transparency. For pure message-passing throughput within a process, channels remain the idiomatic Go choice.
