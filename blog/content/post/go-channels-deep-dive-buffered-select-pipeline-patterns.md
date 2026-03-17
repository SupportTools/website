---
title: "Go Channels Deep Dive: Buffered vs Unbuffered, Select with Default, Channel Direction, Pipeline Patterns, and Closing Correctly"
date: 2032-01-18T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Channels", "Concurrency", "Goroutines", "Pipelines"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "An exhaustive guide to Go channels covering the mechanics of buffered and unbuffered channels, select statement patterns with and without defaults, channel directionality for API safety, pipeline composition patterns, fan-out/fan-in, and the rules for closing channels correctly without panics."
more_link: "yes"
url: "/go-channels-deep-dive-buffered-select-pipeline-patterns/"
---

Go channels are the language's primary mechanism for goroutine communication and synchronization. Their apparent simplicity conceals substantial depth - the difference between correct and subtly broken concurrent code often comes down to channel buffer size, who closes, and whether a select has a default case. This guide covers channels from first principles through production pipeline patterns.

<!--more-->

# Go Channels: Complete Production Guide

## Section 1: Channel Mechanics

### Memory Model Guarantees

Before diving into patterns, understanding what Go's memory model guarantees about channels is essential:

1. A send on a channel happens before the corresponding receive from that channel completes
2. The closing of a channel happens before a receive that returns a zero value because the channel is closed
3. A receive from an unbuffered channel happens before the send on that channel completes
4. The nth send on a channel with capacity C happens before the (n+C)th receive from that channel completes

These guarantees are what make channels suitable for synchronization, not just communication.

### Unbuffered Channels

An unbuffered channel (`make(chan T)`) has capacity 0. Every send blocks until a receiver is ready, and every receive blocks until a sender is ready. The two goroutines rendezvous at the channel.

```go
package main

import (
    "fmt"
    "time"
)

func main() {
    ch := make(chan int)

    go func() {
        fmt.Println("goroutine: about to send")
        ch <- 42  // blocks here until main goroutine receives
        fmt.Println("goroutine: send complete")
    }()

    time.Sleep(100 * time.Millisecond)
    fmt.Println("main: about to receive")
    v := <-ch  // synchronizes with the goroutine
    fmt.Println("main: received", v)
}

// Output:
// goroutine: about to send
// main: about to receive
// goroutine: send complete   <- happens AFTER receive due to memory model
// main: received 42
```

### Buffered Channels

A buffered channel (`make(chan T, n)`) has capacity n. Sends do not block until the buffer is full. Receives do not block until the buffer is empty.

```go
package main

import "fmt"

func main() {
    ch := make(chan int, 3)

    // These three sends don't block - buffer absorbs them
    ch <- 1
    ch <- 2
    ch <- 3
    fmt.Println("sent 3 items without blocking")

    // This send WOULD block - buffer is full
    // ch <- 4  // deadlock!

    fmt.Println(<-ch)  // 1
    fmt.Println(<-ch)  // 2
    fmt.Println(<-ch)  // 3
    // fmt.Println(<-ch)  // would block - buffer empty
}
```

### Choosing Buffer Size

Buffer size is a tradeoff between memory, latency, and throughput:

```go
// Pattern 1: Unbuffered - strict synchronization, zero buffering
// Use when: producer and consumer must rendezvous
// Use when: backpressure is required by design
done := make(chan struct{})

// Pattern 2: Buffer of 1 - "mailbox" pattern
// Use when: asynchronous notification (sender doesn't wait for processing)
// Prevents goroutine leak if receiver is slow to start
notify := make(chan struct{}, 1)

// Pattern 3: Fixed buffer - amortize latency spikes
// Use when: producer has bursty output but consumer has steady throughput
// Buffer = expected burst size
events := make(chan Event, 1000)

// Pattern 4: Semaphore pattern - limit concurrency
// Buffer size = max concurrent operations
sem := make(chan struct{}, 10)
for i := 0; i < 100; i++ {
    sem <- struct{}{}   // acquire
    go func() {
        defer func() { <-sem }()  // release
        doWork()
    }()
}
```

## Section 2: Channel Direction

Channel direction types restrict a channel to send-only or receive-only. They are a compile-time safety mechanism that makes APIs self-documenting.

```go
// Bidirectional - only use for creation
ch := make(chan int, 10)

// Send-only channel parameter
func producer(out chan<- int) {
    out <- 42
    // <-out  // compile error: cannot receive from send-only channel
}

// Receive-only channel parameter
func consumer(in <-chan int) {
    v := <-in
    // in <- 99  // compile error: cannot send on receive-only channel
    fmt.Println(v)
}

// Bidirectional channels convert to directional automatically
producer(ch)   // chan int -> chan<- int
consumer(ch)   // chan int -> <-chan int
```

### Directional Channels in Interfaces

```go
// EventBus interface uses channel direction to enforce protocol
type EventBus interface {
    Subscribe(topic string) <-chan Event   // caller can only receive
    Publish(topic string, e Event) error
}

type eventBus struct {
    mu          sync.RWMutex
    subscribers map[string][]chan Event
}

func (b *eventBus) Subscribe(topic string) <-chan Event {
    b.mu.Lock()
    defer b.mu.Unlock()

    ch := make(chan Event, 100)   // internal channel is bidirectional
    b.subscribers[topic] = append(b.subscribers[topic], ch)
    return ch   // return as receive-only - callers cannot send to it
}

func (b *eventBus) Publish(topic string, e Event) error {
    b.mu.RLock()
    subs := b.subscribers[topic]
    b.mu.RUnlock()

    for _, ch := range subs {
        select {
        case ch <- e:
        default:
            return fmt.Errorf("subscriber buffer full for topic %s", topic)
        }
    }
    return nil
}
```

### Return Channels for Async Results

A common pattern is returning a receive-only channel from a function that starts async work:

```go
// fetch starts an async HTTP request and returns a channel
// for the result. The channel is typed receive-only to prevent
// callers from accidentally sending to it.
func fetchAsync(ctx context.Context, url string) <-chan Result {
    ch := make(chan Result, 1)  // buffer 1 so goroutine can always send

    go func() {
        defer close(ch)
        resp, err := http.Get(url)
        if err != nil {
            ch <- Result{Err: err}
            return
        }
        defer resp.Body.Close()

        body, err := io.ReadAll(resp.Body)
        ch <- Result{Body: body, Err: err}
    }()

    return ch  // caller gets <-chan Result
}

func main() {
    ctx := context.Background()

    // Start multiple concurrent fetches
    results := []<-chan Result{
        fetchAsync(ctx, "https://api.example.com/users"),
        fetchAsync(ctx, "https://api.example.com/orders"),
        fetchAsync(ctx, "https://api.example.com/products"),
    }

    // Collect results
    for _, ch := range results {
        r := <-ch
        if r.Err != nil {
            log.Printf("Error: %v", r.Err)
            continue
        }
        process(r.Body)
    }
}
```

## Section 3: The select Statement

`select` is Go's mechanism for waiting on multiple channel operations simultaneously. It is the foundation of timeout handling, cancellation, and multiplexing.

### Basic Select

```go
func process(ctx context.Context, input <-chan Task, output chan<- Result) {
    for {
        select {
        case task, ok := <-input:
            if !ok {
                // input channel was closed
                return
            }
            result := doWork(task)
            output <- result

        case <-ctx.Done():
            // Context cancelled or deadline exceeded
            return
        }
    }
}
```

### Select with Default

Adding a `default` case makes select non-blocking:

```go
// Non-blocking send
func trySend(ch chan<- int, v int) bool {
    select {
    case ch <- v:
        return true
    default:
        return false  // channel would block
    }
}

// Non-blocking receive
func tryReceive(ch <-chan int) (int, bool) {
    select {
    case v := <-ch:
        return v, true
    default:
        return 0, false  // no value available
    }
}

// Non-blocking check if context is done
func isContextDone(ctx context.Context) bool {
    select {
    case <-ctx.Done():
        return true
    default:
        return false
    }
}
```

### Timeouts with select

```go
func withTimeout(ctx context.Context, ch <-chan Result, timeout time.Duration) (Result, error) {
    timer := time.NewTimer(timeout)
    defer timer.Stop()

    select {
    case result, ok := <-ch:
        if !ok {
            return Result{}, fmt.Errorf("channel closed")
        }
        return result, nil

    case <-timer.C:
        return Result{}, fmt.Errorf("operation timed out after %v", timeout)

    case <-ctx.Done():
        return Result{}, ctx.Err()
    }
}
```

### Select Fairness and Pseudo-Random Selection

When multiple cases are ready simultaneously, Go selects one uniformly at random. This is important for priority inversion avoidance:

```go
// If high-priority and low-priority are both ready,
// 50% of the time low-priority wins - this may not be what you want
select {
case msg := <-highPriority:
    handleHigh(msg)
case msg := <-lowPriority:
    handleLow(msg)
}

// Pattern: drain high-priority channel before checking low-priority
func processWithPriority(high, low <-chan Message) {
    for {
        // First: drain high priority completely
        for {
            select {
            case msg := <-high:
                handleHigh(msg)
                continue
            default:
                // high priority empty, proceed to regular select
            }
            break
        }

        // Then: wait for either channel
        select {
        case msg := <-high:
            handleHigh(msg)
        case msg := <-low:
            handleLow(msg)
        }
    }
}
```

## Section 4: Pipeline Patterns

A pipeline is a series of stages connected by channels. Each stage receives values from upstream, performs work, and sends results downstream. Pipelines enable elegant expression of data transformation workflows with built-in backpressure.

### Basic Three-Stage Pipeline

```go
package pipeline

import (
    "context"
    "fmt"
)

// Stage 1: Generate integers
func generate(ctx context.Context, nums ...int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for _, n := range nums {
            select {
            case out <- n:
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

// Stage 2: Square each value
func square(ctx context.Context, in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for v := range in {
            select {
            case out <- v * v:
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

// Stage 3: Filter out odd values
func filterEven(ctx context.Context, in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for v := range in {
            if v%2 == 0 {
                select {
                case out <- v:
                case <-ctx.Done():
                    return
                }
            }
        }
    }()
    return out
}

func main() {
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Compose the pipeline
    nums := generate(ctx, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
    squares := square(ctx, nums)
    evens := filterEven(ctx, squares)

    for v := range evens {
        fmt.Println(v)  // 4, 16, 36, 64, 100
    }
}
```

### Generic Pipeline Stage

```go
// MapStage applies a transformation function to each item
func MapStage[T, U any](ctx context.Context, in <-chan T, fn func(T) (U, error)) <-chan U {
    out := make(chan U, cap(in))
    go func() {
        defer close(out)
        for item := range in {
            result, err := fn(item)
            if err != nil {
                // Option 1: skip errors
                // Option 2: send to error channel
                // Option 3: cancel context on first error
                continue
            }
            select {
            case out <- result:
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

// FilterStage passes items through that match the predicate
func FilterStage[T any](ctx context.Context, in <-chan T, pred func(T) bool) <-chan T {
    out := make(chan T, cap(in))
    go func() {
        defer close(out)
        for item := range in {
            if pred(item) {
                select {
                case out <- item:
                case <-ctx.Done():
                    return
                }
            }
        }
    }()
    return out
}

// BatchStage collects items into slices of size n
func BatchStage[T any](ctx context.Context, in <-chan T, n int) <-chan []T {
    out := make(chan []T)
    go func() {
        defer close(out)
        batch := make([]T, 0, n)
        for {
            select {
            case item, ok := <-in:
                if !ok {
                    if len(batch) > 0 {
                        out <- batch
                    }
                    return
                }
                batch = append(batch, item)
                if len(batch) == n {
                    out <- batch
                    batch = make([]T, 0, n)
                }
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}
```

## Section 5: Fan-Out and Fan-In

Fan-out distributes work across multiple goroutines. Fan-in merges multiple channels into one.

### Fan-Out

```go
// FanOut distributes input across n worker goroutines
func FanOut[T, U any](
    ctx context.Context,
    in <-chan T,
    n int,
    worker func(context.Context, T) (U, error),
) []<-chan U {
    outputs := make([]<-chan U, n)
    for i := 0; i < n; i++ {
        outputs[i] = startWorker(ctx, in, worker)
    }
    return outputs
}

func startWorker[T, U any](
    ctx context.Context,
    in <-chan T,
    fn func(context.Context, T) (U, error),
) <-chan U {
    out := make(chan U, 10)
    go func() {
        defer close(out)
        for item := range in {
            result, err := fn(ctx, item)
            if err != nil {
                continue
            }
            select {
            case out <- result:
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}
```

### Fan-In (Merge)

```go
// Merge combines multiple input channels into one output channel
func Merge[T any](ctx context.Context, channels ...<-chan T) <-chan T {
    var wg sync.WaitGroup
    merged := make(chan T, len(channels)*10)

    output := func(ch <-chan T) {
        defer wg.Done()
        for item := range ch {
            select {
            case merged <- item:
            case <-ctx.Done():
                return
            }
        }
    }

    wg.Add(len(channels))
    for _, ch := range channels {
        go output(ch)
    }

    // Close merged channel when all inputs are done
    go func() {
        wg.Wait()
        close(merged)
    }()

    return merged
}
```

### Complete Fan-Out/Fan-In Example

```go
package main

import (
    "context"
    "fmt"
    "sync"
    "time"
)

type Task struct {
    ID   int
    Data string
}

type Result struct {
    TaskID   int
    Output   string
    Duration time.Duration
}

func processTask(ctx context.Context, t Task) (Result, error) {
    start := time.Now()
    // Simulate work
    time.Sleep(10 * time.Millisecond)
    return Result{
        TaskID:   t.ID,
        Output:   fmt.Sprintf("processed: %s", t.Data),
        Duration: time.Since(start),
    }, nil
}

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Generate tasks
    tasks := make(chan Task, 100)
    go func() {
        defer close(tasks)
        for i := 0; i < 100; i++ {
            tasks <- Task{ID: i, Data: fmt.Sprintf("data-%d", i)}
        }
    }()

    // Fan-out to 10 workers
    workerCount := 10
    resultChans := FanOut(ctx, tasks, workerCount, processTask)

    // Fan-in results
    results := Merge(ctx, resultChans...)

    // Collect
    var totalDuration time.Duration
    count := 0
    for result := range results {
        totalDuration += result.Duration
        count++
    }

    fmt.Printf("Processed %d tasks, avg duration: %v\n",
        count, totalDuration/time.Duration(count))
}
```

## Section 6: Closing Channels Correctly

Channel closing is the most common source of goroutine panics and deadlocks in Go code. The rules are simple but require discipline.

### The Rules

1. **Only the sender (producer) should close a channel** - Never close a channel from the receiver side
2. **Never close a nil channel** - This panics
3. **Never close a closed channel** - This panics
4. **Sending to a closed channel panics** - Ensure all senders stop before or via close signal

### The Done Channel Pattern

```go
// Use a separate done channel to signal senders to stop
func pipeline(ctx context.Context) {
    done := ctx.Done()  // or make(chan struct{}) and close manually
    ch := make(chan int, 100)

    // One sender goroutine - it closes ch when done
    go func() {
        defer close(ch)  // sender always closes
        for i := 0; ; i++ {
            select {
            case ch <- i:
            case <-done:
                return  // stop sending, close will run via defer
            }
        }
    }()

    // Receiver
    for v := range ch {
        process(v)
    }
}
```

### Multiple Senders: Use sync.WaitGroup

When multiple goroutines send to the same channel, none of them should close it directly - use a WaitGroup to close after all senders finish:

```go
func multiSender(ctx context.Context, inputs [][]Task) <-chan Task {
    out := make(chan Task, 100)
    var wg sync.WaitGroup

    for _, batch := range inputs {
        wg.Add(1)
        go func(tasks []Task) {
            defer wg.Done()
            for _, task := range tasks {
                select {
                case out <- task:
                case <-ctx.Done():
                    return
                }
            }
        }(batch)
    }

    // Close output when all senders finish
    go func() {
        wg.Wait()
        close(out)
    }()

    return out
}
```

### Safe Channel Close Helper

```go
// SafeClose closes a channel exactly once using sync.Once
type SafeChan[T any] struct {
    ch   chan T
    once sync.Once
}

func NewSafeChan[T any](size int) *SafeChan[T] {
    return &SafeChan[T]{ch: make(chan T, size)}
}

func (s *SafeChan[T]) Send(v T) (sent bool) {
    defer func() {
        if recover() != nil {
            sent = false
        }
    }()
    s.ch <- v
    return true
}

func (s *SafeChan[T]) Close() {
    s.once.Do(func() { close(s.ch) })
}

func (s *SafeChan[T]) Receive() <-chan T {
    return s.ch
}
```

### Range Over Channel

The most elegant way to receive until close:

```go
// Range automatically stops when channel is closed and drained
for item := range ch {
    process(item)
}
// Code here runs after ch is closed AND empty

// Equivalent to:
for {
    item, ok := <-ch
    if !ok {
        break
    }
    process(item)
}
```

## Section 7: Advanced Patterns

### Semaphore Pattern

```go
type Semaphore struct {
    ch chan struct{}
}

func NewSemaphore(n int) *Semaphore {
    return &Semaphore{ch: make(chan struct{}, n)}
}

func (s *Semaphore) Acquire() {
    s.ch <- struct{}{}
}

func (s *Semaphore) AcquireContext(ctx context.Context) error {
    select {
    case s.ch <- struct{}{}:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

func (s *Semaphore) Release() {
    <-s.ch
}

// Usage: limit concurrent database connections
db := NewSemaphore(10)

for _, id := range userIDs {
    if err := db.AcquireContext(ctx); err != nil {
        return err
    }
    go func(id int) {
        defer db.Release()
        fetchUser(ctx, id)
    }(id)
}
```

### Broadcast Pattern

Channels are point-to-point, not broadcast. For fan-out notification:

```go
type Broadcaster[T any] struct {
    mu          sync.RWMutex
    subscribers map[int]chan T
    nextID      int
}

func NewBroadcaster[T any]() *Broadcaster[T] {
    return &Broadcaster[T]{
        subscribers: make(map[int]chan T),
    }
}

func (b *Broadcaster[T]) Subscribe(bufSize int) (int, <-chan T) {
    b.mu.Lock()
    defer b.mu.Unlock()

    id := b.nextID
    b.nextID++
    ch := make(chan T, bufSize)
    b.subscribers[id] = ch
    return id, ch
}

func (b *Broadcaster[T]) Unsubscribe(id int) {
    b.mu.Lock()
    defer b.mu.Unlock()

    if ch, ok := b.subscribers[id]; ok {
        close(ch)
        delete(b.subscribers, id)
    }
}

func (b *Broadcaster[T]) Broadcast(v T) {
    b.mu.RLock()
    defer b.mu.RUnlock()

    for _, ch := range b.subscribers {
        select {
        case ch <- v:
        default:
            // Subscriber buffer full - drop or handle
        }
    }
}
```

### Request-Reply over Channels

```go
type Request[T, R any] struct {
    Payload  T
    Response chan<- R  // send-only response channel
}

// Dispatcher handles requests from multiple goroutines
func NewDispatcher[T, R any](handler func(T) R) (chan<- Request[T, R], func()) {
    ch := make(chan Request[T, R], 100)
    done := make(chan struct{})

    go func() {
        defer close(done)
        for req := range ch {
            result := handler(req.Payload)
            req.Response <- result
        }
    }()

    stop := func() {
        close(ch)
        <-done
    }

    return ch, stop
}

// Usage
dispatcher, stop := NewDispatcher[string, int](func(s string) int {
    return len(s)
})
defer stop()

// Make a request
replyCh := make(chan int, 1)
dispatcher <- Request[string, int]{
    Payload:  "hello world",
    Response: replyCh,
}
length := <-replyCh
fmt.Println(length)  // 11
```

### Context-Aware Channel Read with Timeout

```go
func receiveWithTimeout[T any](ch <-chan T, timeout time.Duration) (T, error) {
    timer := time.NewTimer(timeout)
    defer timer.Stop()

    select {
    case v, ok := <-ch:
        if !ok {
            var zero T
            return zero, fmt.Errorf("channel closed")
        }
        return v, nil
    case <-timer.C:
        var zero T
        return zero, fmt.Errorf("timeout after %v", timeout)
    }
}
```

## Section 8: Common Mistakes and How to Avoid Them

### Goroutine Leak from Blocked Channel

```go
// LEAK: goroutine blocks forever if nobody reads from ch
func startWorker() chan int {
    ch := make(chan int)  // unbuffered
    go func() {
        result := compute()
        ch <- result  // blocks if caller never reads
    }()
    return ch
}

// FIX 1: buffer size 1 ensures goroutine can always send
func startWorker() chan int {
    ch := make(chan int, 1)  // buffer of 1
    go func() {
        ch <- compute()  // never blocks
    }()
    return ch
}

// FIX 2: context cancellation
func startWorker(ctx context.Context) <-chan int {
    ch := make(chan int, 1)
    go func() {
        result := compute()
        select {
        case ch <- result:
        case <-ctx.Done():
        }
    }()
    return ch
}
```

### Double Close Panic

```go
// PANIC: closing an already-closed channel
func bad() {
    ch := make(chan int)
    close(ch)
    close(ch)  // panic: close of closed channel
}

// SAFE: use sync.Once
type onceChan struct {
    ch   chan int
    once sync.Once
}

func (c *onceChan) close() {
    c.once.Do(func() { close(c.ch) })
}
```

### Deadlock from Channel in Select Without Default

```go
// DEADLOCK: both goroutines wait for each other
func deadlock() {
    a := make(chan int)
    b := make(chan int)

    go func() {
        select {
        case v := <-a:
            b <- v
        }
    }()

    select {
    case v := <-b:  // waits for b, but goroutine waits for a
        a <- v
    }
}
```

Channels are powerful precisely because they make concurrent state transitions explicit and visible. The patterns in this guide - pipeline composition, fan-out/fan-in, semaphores, and careful closing discipline - form the building blocks of correct, high-performance concurrent Go programs.
