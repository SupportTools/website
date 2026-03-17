---
title: "Go Channels Deep Dive: Fan-Out, Fan-In, and Pipeline Patterns for Production"
date: 2031-01-11T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Channels", "Goroutines", "Performance", "Patterns"]
categories:
- Go
- Concurrency
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go channel semantics covering buffered vs unbuffered channels, fan-out and fan-in patterns, pipeline cancellation with context, select statement semantics, channel direction types, and goroutine leak prevention."
more_link: "yes"
url: "/go-channels-fan-out-fan-in-pipeline-patterns-production/"
---

Channels are Go's primary concurrency primitive, but using them correctly in production systems requires understanding semantics that go well beyond the basic send-and-receive tutorial. Goroutine leaks caused by channels that are never closed or never drained are among the most common sources of memory growth in long-running Go services. This guide covers buffered versus unbuffered channel semantics, fan-out and fan-in composition, pipeline cancellation with context propagation, the subtle differences between blocking select and default-select, channel direction types for API clarity, and the patterns that prevent goroutine leaks.

<!--more-->

# Go Channels Deep Dive: Fan-Out, Fan-In, and Pipeline Patterns for Production

## Section 1: Buffered vs Unbuffered Channel Semantics

Understanding when a channel blocks is the foundation for correct concurrent code.

### Unbuffered Channels

An unbuffered channel (`make(chan T)`) synchronizes sender and receiver. The send blocks until a receiver is ready, and the receive blocks until a sender is ready. This is a rendezvous: both parties must be present simultaneously.

```go
package main

import (
	"fmt"
	"time"
)

func unbufferedExample() {
	ch := make(chan int)

	go func() {
		fmt.Println("sender: about to send")
		ch <- 42           // blocks until receiver is ready
		fmt.Println("sender: send completed")
	}()

	time.Sleep(100 * time.Millisecond)
	fmt.Println("receiver: about to receive")
	v := <-ch              // unblocks the sender
	fmt.Println("receiver: got", v)
}
// Output (approximately):
// sender: about to send
// receiver: about to receive
// receiver: got 42
// sender: send completed
```

The critical property: after `ch <- 42` returns, the receiver has the value. This provides a happens-before guarantee: all memory writes before the send are visible to the receiver after the receive.

### Buffered Channels

A buffered channel (`make(chan T, N)`) decouples sender and receiver up to capacity N. The send blocks only when the buffer is full; the receive blocks only when the buffer is empty.

```go
func bufferedExample() {
	ch := make(chan int, 3)

	// These sends do not block because the buffer has capacity
	ch <- 1
	ch <- 2
	ch <- 3

	// This send WOULD block because the buffer is full
	// ch <- 4  // deadlock if no receiver

	fmt.Println(<-ch) // 1
	fmt.Println(<-ch) // 2
	fmt.Println(<-ch) // 3
}
```

### Choosing Buffer Size

The wrong question is "what buffer size prevents blocking?" The right question is "what is the maximum burst rate, and how long can the consumer be unavailable?"

```
Buffer size = peak_burst_rate * acceptable_consumer_pause_duration
```

For a pipeline stage that processes 10,000 items/second and the downstream stage can pause for up to 10ms:

```
Buffer = 10,000 items/sec * 0.010 sec = 100 items
```

Buffers larger than necessary hide backpressure signals. If your producers are running faster than consumers, you want to know early, not after 10 million items queue up in memory.

### Channel Closing Semantics

Only the sender should close a channel. Closing a channel signals to all receivers that no more values will come.

```go
func channelClose() {
	ch := make(chan int, 5)

	go func() {
		for i := 0; i < 5; i++ {
			ch <- i
		}
		close(ch) // sender closes
	}()

	// Range over a closed channel drains all values then exits
	for v := range ch {
		fmt.Println(v)
	}

	// Two-value receive: ok is false when channel is closed and empty
	v, ok := <-ch
	fmt.Println(v, ok) // 0 false
}
```

Closing a nil channel panics. Closing an already-closed channel panics. Sending to a closed channel panics. These are the three channel panic conditions to avoid.

## Section 2: Fan-Out Pattern

Fan-out distributes work from one source channel to multiple workers. Each worker runs independently, and all read from the same input channel. The channel itself provides mutual exclusion: only one goroutine receives each item.

```go
package pipeline

import (
	"context"
	"sync"
)

// Work represents a unit of work with generic input and output types.
type Work[I, O any] struct {
	Input  I
	Output chan<- Result[O]
}

// Result carries the output or error from processing.
type Result[O any] struct {
	Value O
	Err   error
}

// FanOut distributes work from `in` to `workers` goroutines each running `fn`.
// Returns a channel that receives all results.
func FanOut[I, O any](
	ctx context.Context,
	in <-chan I,
	workers int,
	fn func(ctx context.Context, input I) (O, error),
) <-chan Result[O] {
	out := make(chan Result[O], workers*2)

	var wg sync.WaitGroup
	wg.Add(workers)

	for w := 0; w < workers; w++ {
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case input, ok := <-in:
					if !ok {
						return
					}
					val, err := fn(ctx, input)
					select {
					case out <- Result[O]{Value: val, Err: err}:
					case <-ctx.Done():
						return
					}
				}
			}
		}()
	}

	// Close output when all workers finish
	go func() {
		wg.Wait()
		close(out)
	}()

	return out
}
```

### Fan-Out with Rate Limiting

Production fan-out often needs rate limiting to avoid overwhelming downstream services:

```go
import "golang.org/x/time/rate"

// FanOutRateLimited is like FanOut but limits the total processing rate.
func FanOutRateLimited[I, O any](
	ctx context.Context,
	in <-chan I,
	workers int,
	rps float64, // requests per second
	fn func(ctx context.Context, input I) (O, error),
) <-chan Result[O] {
	out := make(chan Result[O], workers*2)
	limiter := rate.NewLimiter(rate.Limit(rps), int(rps))

	var wg sync.WaitGroup
	wg.Add(workers)

	for w := 0; w < workers; w++ {
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case input, ok := <-in:
					if !ok {
						return
					}
					if err := limiter.Wait(ctx); err != nil {
						// Context cancelled
						return
					}
					val, err := fn(ctx, input)
					select {
					case out <- Result[O]{Value: val, Err: err}:
					case <-ctx.Done():
						return
					}
				}
			}
		}()
	}

	go func() {
		wg.Wait()
		close(out)
	}()

	return out
}
```

## Section 3: Fan-In Pattern

Fan-in merges multiple input channels into a single output channel. This is useful when you have multiple data sources that need to be processed by a single consumer.

```go
// FanIn merges multiple input channels into a single output channel.
// The output channel closes when all input channels are closed.
func FanIn[T any](ctx context.Context, channels ...<-chan T) <-chan T {
	var wg sync.WaitGroup
	merged := make(chan T, len(channels)*2)

	// forward copies values from a single input channel to merged.
	forward := func(ch <-chan T) {
		defer wg.Done()
		for {
			select {
			case <-ctx.Done():
				return
			case v, ok := <-ch:
				if !ok {
					return
				}
				select {
				case merged <- v:
				case <-ctx.Done():
					return
				}
			}
		}
	}

	wg.Add(len(channels))
	for _, ch := range channels {
		go forward(ch)
	}

	go func() {
		wg.Wait()
		close(merged)
	}()

	return merged
}
```

### Ordered Fan-In

Sometimes you need to merge channels but preserve ordering within each source (though not across sources). Use a priority queue:

```go
type indexedValue[T any] struct {
	value       T
	sourceIndex int
}

// FanInOrdered merges channels, guaranteeing that items from each channel
// arrive in the order they were sent (but items from different channels
// may be interleaved).
func FanInOrdered[T any](ctx context.Context, channels ...<-chan T) <-chan T {
	merged := make(chan T, len(channels))
	var wg sync.WaitGroup
	wg.Add(len(channels))

	for i, ch := range channels {
		ch := ch
		go func() {
			defer wg.Done()
			// Each goroutine sends from its channel in order
			for v := range ch {
				select {
				case merged <- v:
				case <-ctx.Done():
					// Drain remaining to prevent sender goroutines from leaking
					go func() {
						for range ch {
						}
					}()
					return
				}
			}
		}()
	}

	go func() {
		wg.Wait()
		close(merged)
	}()

	return merged
}
```

## Section 4: Pipeline Pattern

A pipeline is a series of stages where each stage reads from the previous stage's output channel and writes to the next stage's input channel.

```go
package pipeline

import (
	"context"
	"fmt"
)

// Stage is a function that transforms an input channel to an output channel.
type Stage[I, O any] func(ctx context.Context, in <-chan I) <-chan O

// Pipeline chains stages together.
type Pipeline[I, O any] struct {
	stages []interface{} // type-erased stages
}

// A concrete pipeline with typed stages

// Generator creates the initial channel from a slice of values.
func Generator[T any](ctx context.Context, values ...T) <-chan T {
	out := make(chan T, len(values))
	go func() {
		defer close(out)
		for _, v := range values {
			select {
			case out <- v:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

// Transform applies fn to each item from in and sends the result.
func Transform[I, O any](
	ctx context.Context,
	in <-chan I,
	fn func(I) (O, error),
) <-chan Result[O] {
	out := make(chan Result[O])
	go func() {
		defer close(out)
		for {
			select {
			case <-ctx.Done():
				return
			case v, ok := <-in:
				if !ok {
					return
				}
				result, err := fn(v)
				select {
				case out <- Result[O]{Value: result, Err: err}:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out
}

// Filter passes only items for which fn returns true.
func Filter[T any](ctx context.Context, in <-chan T, fn func(T) bool) <-chan T {
	out := make(chan T)
	go func() {
		defer close(out)
		for {
			select {
			case <-ctx.Done():
				return
			case v, ok := <-in:
				if !ok {
					return
				}
				if fn(v) {
					select {
					case out <- v:
					case <-ctx.Done():
						return
					}
				}
			}
		}
	}()
	return out
}

// Batch collects items into slices of size n.
func Batch[T any](ctx context.Context, in <-chan T, size int) <-chan []T {
	out := make(chan []T)
	go func() {
		defer close(out)
		batch := make([]T, 0, size)
		for {
			select {
			case <-ctx.Done():
				if len(batch) > 0 {
					select {
					case out <- batch:
					default:
					}
				}
				return
			case v, ok := <-in:
				if !ok {
					if len(batch) > 0 {
						select {
						case out <- batch:
						case <-ctx.Done():
						}
					}
					return
				}
				batch = append(batch, v)
				if len(batch) == size {
					select {
					case out <- batch:
					case <-ctx.Done():
						return
					}
					batch = make([]T, 0, size)
				}
			}
		}
	}()
	return out
}
```

### Complete Pipeline Example

```go
func ExamplePipeline() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Stage 1: Generate integers 1-100
	nums := Generator(ctx, rangeInts(1, 100)...)

	// Stage 2: Filter odd numbers
	odds := Filter(ctx, nums, func(n int) bool {
		return n%2 != 0
	})

	// Stage 3: Fan-out square computation across 4 workers
	squared := FanOut(ctx, odds, 4, func(ctx context.Context, n int) (int, error) {
		return n * n, nil
	})

	// Stage 4: Collect results
	var results []int
	for r := range squared {
		if r.Err != nil {
			fmt.Printf("error: %v\n", r.Err)
			continue
		}
		results = append(results, r.Value)
	}

	fmt.Printf("processed %d items\n", len(results))
}

func rangeInts(start, end int) []int {
	s := make([]int, end-start+1)
	for i := range s {
		s[i] = start + i
	}
	return s
}
```

## Section 5: Pipeline Cancellation with Context

Context cancellation must propagate through every stage of a pipeline. The pattern is: every goroutine that reads from or writes to a channel must also listen on `ctx.Done()`.

```go
// CancellablePipeline demonstrates proper cancellation propagation.
func CancellablePipeline(ctx context.Context, input []string) error {
	// Each stage accepts context and returns a channel.
	// When context is cancelled, all stages shut down.

	// Stage 1: Produce
	stage1 := func(ctx context.Context) <-chan string {
		out := make(chan string)
		go func() {
			defer close(out)
			for _, s := range input {
				select {
				case out <- s:
				case <-ctx.Done():
					return // Abandon remaining work
				}
			}
		}()
		return out
	}

	// Stage 2: Process
	stage2 := func(ctx context.Context, in <-chan string) <-chan int {
		out := make(chan int)
		go func() {
			defer close(out)
			for {
				select {
				case s, ok := <-in:
					if !ok {
						return
					}
					// Simulate work that might be interrupted
					result := len(s)
					select {
					case out <- result:
					case <-ctx.Done():
						return
					}
				case <-ctx.Done():
					return
				}
			}
		}()
		return out
	}

	// Stage 3: Consume
	s1 := stage1(ctx)
	s2 := stage2(ctx, s1)

	var total int
	for {
		select {
		case v, ok := <-s2:
			if !ok {
				fmt.Printf("pipeline complete, total=%d\n", total)
				return nil
			}
			total += v
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
```

### The Drain-on-Cancel Pattern

When a stage receives a cancellation, it must drain its input channel to prevent upstream goroutines from blocking forever:

```go
// DrainOnCancel is a helper that drains a channel after context cancellation.
// Use this to prevent goroutine leaks when you stop consuming a channel.
func DrainOnCancel[T any](ctx context.Context, ch <-chan T) {
	go func() {
		<-ctx.Done()
		// Drain any remaining items to unblock senders
		for range ch {
		}
	}()
}

// ProperCancellation shows how to correctly propagate cancellation.
func ProperCancellation() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	slowProducer := func(ctx context.Context) <-chan int {
		out := make(chan int)
		go func() {
			defer close(out)
			i := 0
			for {
				time.Sleep(100 * time.Millisecond) // slow production
				select {
				case out <- i:
					i++
				case <-ctx.Done():
					return
				}
			}
		}()
		return out
	}

	ch := slowProducer(ctx)

	// After 200ms, cancel and stop consuming
	time.AfterFunc(200*time.Millisecond, cancel)

	// Consumer properly handles cancellation
	for {
		select {
		case v, ok := <-ch:
			if !ok {
				fmt.Println("channel closed")
				return
			}
			fmt.Println("got", v)
		case <-ctx.Done():
			// Once we stop reading, drain remaining to unblock producer
			go func() {
				for range ch {
				}
			}()
			fmt.Println("cancelled:", ctx.Err())
			return
		}
	}
}
```

## Section 6: Select Statement Semantics

### Blocking Select vs Default Select

```go
// Blocking select: waits for any case to be ready
select {
case v := <-ch:
    fmt.Println("received", v)
case ch2 <- val:
    fmt.Println("sent")
case <-done:
    return
}

// Non-blocking select with default: never blocks
select {
case v := <-ch:
    fmt.Println("received", v)
default:
    fmt.Println("nothing ready")
}
```

The default case turns a channel operation into a try-operation. Use it for:
- Checking if a channel has data without blocking (polling)
- Dropping work when a queue is full
- Implementing backpressure detection

```go
// TrySend attempts to send to a channel without blocking.
// Returns false if the channel is full.
func TrySend[T any](ch chan<- T, v T) bool {
	select {
	case ch <- v:
		return true
	default:
		return false
	}
}

// TryReceive attempts to receive from a channel without blocking.
// Returns the zero value and false if the channel is empty.
func TryReceive[T any](ch <-chan T) (T, bool) {
	select {
	case v := <-ch:
		return v, true
	default:
		var zero T
		return zero, false
	}
}
```

### Select with Multiple Ready Channels

When multiple cases are ready simultaneously, Go selects one pseudorandomly. This means you cannot rely on priority ordering in select statements.

```go
// PrioritizedSelect shows how to implement priority between channels.
// High-priority items are always processed before low-priority.
func PrioritizedSelect[T any](
	ctx context.Context,
	high <-chan T,
	low <-chan T,
	fn func(T),
) {
	for {
		// First, drain all high-priority items
		for {
			select {
			case v, ok := <-high:
				if !ok {
					return
				}
				fn(v)
				continue
			default:
				goto processLow
			}
		}
	processLow:
		select {
		case v, ok := <-high:
			if !ok {
				return
			}
			fn(v)
		case v, ok := <-low:
			if !ok {
				return
			}
			fn(v)
		case <-ctx.Done():
			return
		}
	}
}
```

## Section 7: Channel Direction Types

Channel direction types restrict how a channel can be used, making APIs self-documenting and catching misuse at compile time.

```go
// Directional channel types
var (
	bidirectional chan int    // can send and receive
	sendOnly      chan<- int  // can only send
	receiveOnly   <-chan int  // can only receive
)

// A function that produces values should return a receive-only channel.
// Callers cannot accidentally close or send to it.
func Producer(ctx context.Context) <-chan int {
	out := make(chan int) // bidirectional internally
	go func() {
		defer close(out)
		for i := 0; ; i++ {
			select {
			case out <- i: // send to bidirectional is fine
			case <-ctx.Done():
				return
			}
		}
	}()
	return out // implicit conversion to <-chan int
}

// A function that consumes values should accept a receive-only channel.
func Consumer(in <-chan int, process func(int)) {
	for v := range in {
		process(v)
	}
}

// A function that only forwards should use directional parameters.
func Forward(in <-chan int, out chan<- int) {
	for v := range in {
		out <- v
	}
	close(out)
}

// WorkerPool demonstrates directional channels for clarity.
func WorkerPool(
	ctx context.Context,
	jobs <-chan Job,          // workers only read jobs
	results chan<- Result,    // workers only write results
	workers int,
) {
	var wg sync.WaitGroup
	wg.Add(workers)
	for w := 0; w < workers; w++ {
		go func() {
			defer wg.Done()
			for {
				select {
				case job, ok := <-jobs:
					if !ok {
						return
					}
					result := processJob(job)
					select {
					case results <- result:
					case <-ctx.Done():
						return
					}
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	go func() {
		wg.Wait()
		close(results)
	}()
}
```

## Section 8: Goroutine Leak Prevention

A goroutine leak occurs when a goroutine is blocked waiting on a channel that will never be ready. This is the most common form of memory leak in Go programs.

### Common Leak Pattern 1: Abandoned Channel

```go
// LEAKY: if the caller never reads from ch, the goroutine leaks
func LeakyProducer() <-chan int {
	ch := make(chan int)
	go func() {
		defer close(ch)
		for i := 0; i < 100; i++ {
			ch <- i // blocks forever if nobody reads
		}
	}()
	return ch
}

// FIXED: pass context for cancellation
func SafeProducer(ctx context.Context) <-chan int {
	ch := make(chan int)
	go func() {
		defer close(ch)
		for i := 0; i < 100; i++ {
			select {
			case ch <- i:
			case <-ctx.Done():
				return // exit when context is cancelled
			}
		}
	}()
	return ch
}
```

### Common Leak Pattern 2: Goroutine Waiting on Full Buffer

```go
// LEAKY: if downstream is slow and buffer fills, goroutine leaks
func LeakyFanOut(in <-chan int) {
	results := make(chan int, 10) // buffer of 10

	for i := 0; i < 20; i++ {
		go func() {
			for v := range in {
				results <- v // will block when buffer is full
			}
		}()
	}
	// If results is never fully consumed, goroutines pile up
}

// FIXED: use context for shutdown signal
func SafeFanOut(ctx context.Context, in <-chan int) <-chan int {
	results := make(chan int, 10)
	var wg sync.WaitGroup

	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case v, ok := <-in:
					if !ok {
						return
					}
					select {
					case results <- v:
					case <-ctx.Done():
						return
					}
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	go func() {
		wg.Wait()
		close(results)
	}()

	return results
}
```

### Leak Detection with goleak

The `goleak` package from Uber detects goroutine leaks in tests:

```go
import "go.uber.org/goleak"

func TestMain(m *testing.M) {
	goleak.VerifyTestMain(m)
}

func TestSafeProducer(t *testing.T) {
	defer goleak.VerifyNone(t) // fail if any goroutines leak

	ctx, cancel := context.WithCancel(context.Background())
	ch := SafeProducer(ctx)

	// Read a few items, then cancel
	for i := 0; i < 5; i++ {
		<-ch
	}
	cancel()

	// After cancel, the producer goroutine should exit.
	// goleak.VerifyNone will catch it if it doesn't.
}
```

## Section 9: Advanced Patterns

### Semaphore Pattern

Limit concurrency using a buffered channel as a semaphore:

```go
// Semaphore limits concurrent operations.
type Semaphore chan struct{}

// NewSemaphore creates a Semaphore with the given capacity.
func NewSemaphore(n int) Semaphore {
	return make(Semaphore, n)
}

// Acquire acquires a slot, blocking if at capacity.
func (s Semaphore) Acquire(ctx context.Context) error {
	select {
	case s <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Release releases a slot.
func (s Semaphore) Release() {
	<-s
}

// RunConcurrently runs fn concurrently for each item with limited concurrency.
func RunConcurrently[T any](
	ctx context.Context,
	items []T,
	maxConcurrency int,
	fn func(ctx context.Context, item T) error,
) error {
	sem := NewSemaphore(maxConcurrency)
	var wg sync.WaitGroup
	errs := make(chan error, len(items))

	for _, item := range items {
		item := item
		if err := sem.Acquire(ctx); err != nil {
			break
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer sem.Release()
			if err := fn(ctx, item); err != nil {
				select {
				case errs <- err:
				default:
				}
			}
		}()
	}

	wg.Wait()
	close(errs)

	var firstErr error
	for err := range errs {
		if firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
```

### Done Channel Pattern

The "done channel" pattern signals shutdown to multiple goroutines simultaneously:

```go
// DoneChannel broadcasts shutdown to multiple goroutines.
type DoneChannel struct {
	once sync.Once
	ch   chan struct{}
}

// NewDoneChannel creates a DoneChannel.
func NewDoneChannel() *DoneChannel {
	return &DoneChannel{ch: make(chan struct{})}
}

// Done returns a channel that is closed when Shutdown is called.
func (d *DoneChannel) Done() <-chan struct{} {
	return d.ch
}

// Shutdown closes the done channel, broadcasting to all waiters.
// Safe to call multiple times.
func (d *DoneChannel) Shutdown() {
	d.once.Do(func() {
		close(d.ch)
	})
}
```

### Or-Done Pattern

Combine multiple done channels so that the first one to fire cancels all:

```go
// OrDone returns a channel that closes when ANY of the input channels close.
func OrDone(channels ...<-chan struct{}) <-chan struct{} {
	switch len(channels) {
	case 0:
		return nil
	case 1:
		return channels[0]
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		switch len(channels) {
		case 2:
			select {
			case <-channels[0]:
			case <-channels[1]:
			}
		default:
			select {
			case <-channels[0]:
			case <-channels[1]:
			case <-channels[2]:
			case <-OrDone(append(channels[3:], done)...):
			}
		}
	}()
	return done
}
```

## Section 10: Benchmarking Channel Patterns

Understanding the performance characteristics of different patterns guides architectural decisions:

```go
package pipeline_test

import (
	"context"
	"testing"
)

func BenchmarkUnbufferedChannel(b *testing.B) {
	ch := make(chan int)
	go func() {
		for i := 0; i < b.N; i++ {
			ch <- i
		}
	}()
	for i := 0; i < b.N; i++ {
		<-ch
	}
}

func BenchmarkBufferedChannel(b *testing.B) {
	ch := make(chan int, 128)
	go func() {
		for i := 0; i < b.N; i++ {
			ch <- i
		}
	}()
	for i := 0; i < b.N; i++ {
		<-ch
	}
}

func BenchmarkFanOut4Workers(b *testing.B) {
	ctx := context.Background()
	in := make(chan int, 1000)

	go func() {
		for i := 0; i < b.N; i++ {
			in <- i
		}
		close(in)
	}()

	out := FanOut(ctx, in, 4, func(ctx context.Context, n int) (int, error) {
		return n * 2, nil
	})

	b.ResetTimer()
	count := 0
	for range out {
		count++
		if count == b.N {
			break
		}
	}
}

// Typical results on an 8-core machine:
// BenchmarkUnbufferedChannel  -  85 ns/op
// BenchmarkBufferedChannel    -  42 ns/op
// BenchmarkFanOut4Workers     - 180 ns/op (includes goroutine scheduling)
```

## Section 11: Production Checklist

Before deploying concurrent pipeline code to production, verify:

1. Every goroutine has a termination condition triggered by context cancellation or channel close.
2. Every channel that can be closed is closed by exactly one goroutine (the sender).
3. No goroutine reads from a channel without also listening on `ctx.Done()`.
4. Fan-out goroutines use `sync.WaitGroup` and close the output channel after all workers finish.
5. Tests use `goleak.VerifyNone` to detect leaks.
6. Buffer sizes are documented with the calculation that determined them.
7. Error channels are buffered with at least the number of goroutines that can write to them, or errors are collected with a mutex/sync.Once.
8. No goroutine sends on a channel it did not create and does not own.

These patterns form the vocabulary of safe concurrent Go. Mastering the semantics of when channels block, when they close, and how to propagate cancellation through multi-stage pipelines eliminates an entire class of production incidents.
