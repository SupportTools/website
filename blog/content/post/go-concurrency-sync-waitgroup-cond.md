---
title: "Practical Go Concurrency: Mastering WaitGroups and Condition Variables"
date: 2026-05-12T09:00:00-05:00
draft: false
tags: ["go", "golang", "concurrency", "waitgroup", "sync.Cond", "goroutines"]
categories: ["Programming", "Go", "Concurrency"]
---

Go's approach to concurrency is one of its most powerful features, offering a balance of simplicity and capability that few other languages can match. At the core of Go's concurrency model are goroutines—lightweight threads managed by the Go runtime—and a rich set of synchronization primitives to coordinate them. In this article, we'll explore two essential synchronization tools: `sync.WaitGroup` and `sync.Cond`, with practical examples to demonstrate their use in real-world scenarios.

## Understanding Go's Concurrency Model

Before diving into specific synchronization primitives, it's helpful to understand Go's underlying concurrency model. Go follows the Communicating Sequential Processes (CSP) paradigm, where concurrent components communicate by passing messages rather than sharing memory. This approach helps reduce the complexity and bugs associated with traditional lock-based concurrency.

The foundation of Go's concurrency consists of:

1. **Goroutines**: Lightweight threads that are managed by the Go runtime rather than the operating system
2. **Channels**: Typed conduits for communication between goroutines
3. **Synchronization primitives**: Tools like `WaitGroup`, `Mutex`, and `Cond` for coordinating goroutines

## Concurrency vs. Parallelism

While these terms are often used interchangeably, they represent distinct concepts:

- **Concurrency**: The ability to handle multiple tasks at once, but not necessarily simultaneously. It's about structure and composition.
- **Parallelism**: The ability to execute multiple tasks at the exact same time, typically by using multiple processors or cores.

Go's concurrency model is designed to handle both effectively. Goroutines enable concurrency through their lightweight nature, while the Go runtime scheduler can distribute them across multiple OS threads to achieve parallelism when appropriate.

## The sync.WaitGroup Pattern

`sync.WaitGroup` is one of the most commonly used synchronization primitives in Go. It allows one goroutine to wait for a collection of other goroutines to finish execution.

### How WaitGroup Works

A `WaitGroup` maintains a counter that represents the number of goroutines being waited for:

1. The counter is incremented using `Add(delta int)` before launching goroutines
2. Each goroutine calls `Done()` when it completes, which decrements the counter
3. The waiting goroutine calls `Wait()`, which blocks until the counter reaches zero

### Basic WaitGroup Example

```go
package main

import (
    "fmt"
    "sync"
    "time"
)

func worker(id int, wg *sync.WaitGroup) {
    defer wg.Done() // Ensures the WaitGroup counter is decremented even if the function panics
    
    fmt.Printf("Worker %d starting\n", id)
    time.Sleep(time.Second) // Simulate work
    fmt.Printf("Worker %d finished\n", id)
}

func main() {
    var wg sync.WaitGroup
    
    // Launch 5 workers
    for i := 1; i <= 5; i++ {
        wg.Add(1)
        go worker(i, &wg)
    }
    
    // Wait for all workers to complete
    wg.Wait()
    fmt.Println("All workers have completed their tasks")
}
```

This pattern is ideal for scenarios where you need to distribute work across multiple goroutines and wait for all of them to complete before proceeding.

### WaitGroup Best Practices

1. **Always pass WaitGroup by pointer**: A WaitGroup contains a mutex, so it should not be copied.

```go
// Correct: Pass by pointer
go worker(i, &wg)

// Incorrect: Copying the WaitGroup
go func(wg sync.WaitGroup) { // This creates a copy
    defer wg.Done()
    // Work...
}(wg)
```

2. **Use defer for Done()**: This ensures the counter is decremented even if the function returns early or panics.

```go
func worker(wg *sync.WaitGroup) {
    defer wg.Done()
    
    if someCondition {
        return // Early return still triggers wg.Done()
    }
    // Normal execution...
}
```

3. **Add before starting goroutines**: Increment the counter before launching goroutines to avoid race conditions.

```go
// Correct
wg.Add(1)
go worker(&wg)

// Risky - potential race condition
go func() {
    wg.Add(1) // The main goroutine might call Wait() before this executes
    // Work...
    wg.Done()
}()
```

4. **Check for balanced Add/Done calls**: Ensure that for every `Add(n)`, there are exactly `n` calls to `Done()`.

## Advanced WaitGroup Patterns

### Fan-Out, Fan-In Pattern

This pattern involves distributing work across multiple goroutines (fan-out) and then collecting their results (fan-in):

```go
func processItems(items []Item) []Result {
    var wg sync.WaitGroup
    resultCh := make(chan Result, len(items))
    
    // Fan out: Process each item concurrently
    for _, item := range items {
        wg.Add(1)
        go func(item Item) {
            defer wg.Done()
            result := processItem(item)
            resultCh <- result
        }(item)
    }
    
    // Wait for all processing to complete
    go func() {
        wg.Wait()
        close(resultCh) // Signal that no more results will be sent
    }()
    
    // Fan in: Collect all results
    var results []Result
    for result := range resultCh {
        results = append(results, result)
    }
    
    return results
}
```

### Bounded Concurrency with WaitGroup

While goroutines are lightweight, it's often a good practice to limit their number for resource-intensive tasks:

```go
func processLargeDataset(items []Item, concurrency int) []Result {
    var (
        wg sync.WaitGroup
        mu sync.Mutex // Protects the results slice
    )
    
    results := make([]Result, 0, len(items))
    semaphore := make(chan struct{}, concurrency) // Limits concurrent goroutines
    
    for _, item := range items {
        wg.Add(1)
        
        // Acquire semaphore
        semaphore <- struct{}{}
        
        go func(item Item) {
            defer func() {
                // Release semaphore
                <-semaphore
                wg.Done()
            }()
            
            // Process item
            result := processItem(item)
            
            // Safely append to results
            mu.Lock()
            results = append(results, result)
            mu.Unlock()
        }(item)
    }
    
    wg.Wait()
    return results
}
```

## Understanding sync.Cond

While `WaitGroup` is excellent for waiting on multiple goroutines to complete, sometimes you need more sophisticated coordination. This is where `sync.Cond` comes in—it allows goroutines to wait for or announce the occurrence of an event.

`sync.Cond` is particularly useful for implementing producer-consumer patterns, where consumers need to wait until data is available.

### Key Methods of sync.Cond

1. **Wait()**: Blocks the calling goroutine until it receives a notification via `Signal()` or `Broadcast()`. Note that `Wait()` automatically releases the associated mutex while waiting and reacquires it before returning.
2. **Signal()**: Wakes up one goroutine waiting on the condition.
3. **Broadcast()**: Wakes up all goroutines waiting on the condition.

### Basic usage of sync.Cond

```go
package main

import (
    "fmt"
    "sync"
    "time"
)

func main() {
    var mu sync.Mutex
    cond := sync.NewCond(&mu)
    done := false
    
    // Start a worker that waits for a signal
    go func() {
        // Lock the mutex before entering Wait
        mu.Lock()
        
        // While the condition is not met, wait for a signal
        for !done {
            fmt.Println("Worker: waiting for condition...")
            cond.Wait() // Releases lock while waiting, reacquires it when woken up
        }
        
        fmt.Println("Worker: condition met, proceeding!")
        mu.Unlock()
    }()
    
    // Sleep to ensure the worker has time to reach the Wait state
    time.Sleep(time.Second)
    
    // Signal the condition has changed
    mu.Lock()
    done = true
    cond.Signal() // Wake up one waiting goroutine
    mu.Unlock()
    
    // Give worker time to process the signal
    time.Sleep(time.Second)
}
```

## Practical Example: A Bounded Buffer with sync.Cond

Let's implement a classic producer-consumer pattern with a bounded buffer using `sync.Cond`:

```go
package main

import (
    "fmt"
    "sync"
    "time"
)

type BoundedBuffer struct {
    buffer    []interface{}
    size      int
    mutex     sync.Mutex
    notEmpty  *sync.Cond
    notFull   *sync.Cond
}

func NewBoundedBuffer(size int) *BoundedBuffer {
    buf := &BoundedBuffer{
        buffer: make([]interface{}, 0, size),
        size:   size,
    }
    buf.notEmpty = sync.NewCond(&buf.mutex)
    buf.notFull = sync.NewCond(&buf.mutex)
    return buf
}

func (b *BoundedBuffer) Put(item interface{}) {
    b.mutex.Lock()
    defer b.mutex.Unlock()
    
    // Wait until there's room in the buffer
    for len(b.buffer) == b.size {
        b.notFull.Wait()
    }
    
    // Add item to buffer
    b.buffer = append(b.buffer, item)
    fmt.Printf("Produced: %v (buffer size: %d)\n", item, len(b.buffer))
    
    // Signal that the buffer is not empty
    b.notEmpty.Signal()
}

func (b *BoundedBuffer) Get() interface{} {
    b.mutex.Lock()
    defer b.mutex.Unlock()
    
    // Wait until buffer is not empty
    for len(b.buffer) == 0 {
        b.notEmpty.Wait()
    }
    
    // Remove an item from the buffer
    item := b.buffer[0]
    b.buffer = b.buffer[1:]
    fmt.Printf("Consumed: %v (buffer size: %d)\n", item, len(b.buffer))
    
    // Signal that the buffer is not full
    b.notFull.Signal()
    
    return item
}

func main() {
    buffer := NewBoundedBuffer(3)
    
    // Start consumers
    var wg sync.WaitGroup
    for i := 0; i < 2; i++ {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()
            for j := 0; j < 3; j++ {
                item := buffer.Get()
                fmt.Printf("Consumer %d got: %v\n", id, item)
                time.Sleep(100 * time.Millisecond)
            }
        }(i)
    }
    
    // Produce items
    for i := 0; i < 6; i++ {
        buffer.Put(i)
        time.Sleep(50 * time.Millisecond)
    }
    
    wg.Wait()
}
```

This implementation:

1. Uses two condition variables: `notEmpty` for consumers waiting for items, and `notFull` for producers waiting for space
2. Ensures thread safety with a mutex
3. Uses wait loops with for-conditions to handle spurious wakeups

## Real-World Use Case: Rate-Limited API Client

Let's implement a practical API client that respects rate limits using our concurrency primitives:

```go
package main

import (
    "fmt"
    "sync"
    "time"
)

type RateLimitedClient struct {
    requestsPerSecond int
    mu                sync.Mutex
    cond              *sync.Cond
    tokens            int
    lastRefill        time.Time
}

func NewRateLimitedClient(rps int) *RateLimitedClient {
    client := &RateLimitedClient{
        requestsPerSecond: rps,
        tokens:            rps,
        lastRefill:        time.Now(),
    }
    client.cond = sync.NewCond(&client.mu)
    
    // Start token refill goroutine
    go client.refillTokens()
    
    return client
}

func (c *RateLimitedClient) refillTokens() {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()
    
    for range ticker.C {
        c.mu.Lock()
        c.tokens = c.requestsPerSecond
        c.lastRefill = time.Now()
        c.cond.Broadcast() // Wake up all waiting goroutines
        c.mu.Unlock()
    }
}

func (c *RateLimitedClient) DoRequest(id int) error {
    c.mu.Lock()
    defer c.mu.Unlock()
    
    // Wait for a token to become available
    for c.tokens == 0 {
        fmt.Printf("Request %d waiting for token...\n", id)
        c.cond.Wait()
    }
    
    // Consume a token
    c.tokens--
    fmt.Printf("Request %d acquired token. %d tokens remaining.\n", id, c.tokens)
    
    // In a real client, you'd make the API call here
    return nil
}

func main() {
    client := NewRateLimitedClient(3) // 3 requests per second
    
    var wg sync.WaitGroup
    for i := 1; i <= 10; i++ {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()
            client.DoRequest(id)
        }(i)
    }
    
    wg.Wait()
    fmt.Println("All requests completed")
}
```

This client:

1. Uses `sync.Cond` to coordinate access to a limited resource (API rate limit tokens)
2. Automatically refills tokens on a schedule
3. Uses `WaitGroup` to track the completion of all requests

## Choosing Between Concurrency Primitives

With various synchronization tools available in Go, it's important to understand when to use each:

1. **Use Channels When**:
   - Communicating between goroutines
   - Implementing pipelines
   - Distributing work
   - Signaling completion (for simple cases)

2. **Use sync.WaitGroup When**:
   - Waiting for multiple goroutines to complete
   - Implementing fan-out, fan-in patterns
   - When you don't need to communicate results between goroutines

3. **Use sync.Cond When**:
   - Implementing producer-consumer patterns
   - Multiple goroutines need to wait for a condition
   - You need to broadcast a change to multiple waiting goroutines

4. **Use sync.Mutex/RWMutex When**:
   - Protecting access to shared memory
   - Simple locking requirements
   - Need for read/write distinction (with RWMutex)

## Common Pitfalls and Best Practices

### Deadlocks

Deadlocks occur when goroutines are blocked forever, waiting for a condition that will never happen:

```go
func deadlockExample() {
    var wg sync.WaitGroup
    wg.Add(1)
    // Oops, no goroutine calls wg.Done()
    wg.Wait() // Program will hang here forever
}
```

To avoid deadlocks:
- Ensure balanced WaitGroup Add/Done calls
- Always check for circular wait conditions
- Use timeouts where appropriate

### Race Conditions

Race conditions occur when multiple goroutines access shared data without proper synchronization:

```go
func raceConditionExample() {
    counter := 0
    var wg sync.WaitGroup
    
    for i := 0; i < 1000; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            counter++ // Race condition: Unsynchronized access
        }()
    }
    
    wg.Wait()
    fmt.Println(counter) // Will likely be less than 1000
}
```

To detect race conditions, use the race detector:

```bash
go run -race main.go
```

### Context Cancellation

For operations that might need to be cancelled, consider using `context.Context` alongside WaitGroups:

```go
func cancelableOperation(ctx context.Context) {
    var wg sync.WaitGroup
    
    for i := 0; i < 10; i++ {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()
            
            select {
            case <-ctx.Done():
                fmt.Printf("Worker %d cancelled\n", id)
                return
            case <-time.After(time.Second):
                fmt.Printf("Worker %d completed\n", id)
            }
        }(i)
    }
    
    // Create a separate goroutine to wait for completion
    done := make(chan struct{})
    go func() {
        wg.Wait()
        close(done)
    }()
    
    // Wait for either completion or cancellation
    select {
    case <-done:
        fmt.Println("All workers completed successfully")
    case <-ctx.Done():
        fmt.Println("Operation cancelled, waiting for workers to clean up...")
        <-done // Still wait for workers to acknowledge cancellation
    }
}
```

## Conclusion

Go's concurrency model, with its lightweight goroutines and rich set of synchronization primitives, makes it exceptionally well-suited for building concurrent and parallel applications. Understanding tools like `sync.WaitGroup` and `sync.Cond` allows you to coordinate goroutines effectively and build robust, high-performance systems.

Remember these key principles:

1. Use the simplest concurrency primitive that meets your needs
2. Prefer communicating through channels over sharing memory
3. Always ensure proper synchronization for shared resources
4. Test for race conditions regularly
5. Consider failure modes and cancellation scenarios

By mastering these concepts and tools, you'll be well-equipped to leverage Go's powerful concurrency features in your applications.