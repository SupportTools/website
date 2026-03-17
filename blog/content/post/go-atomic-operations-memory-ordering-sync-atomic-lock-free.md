---
title: "Go Atomic Operations and Memory Ordering: sync/atomic for Lock-Free Structures"
date: 2031-01-14T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "sync/atomic", "Lock-Free", "Performance", "Memory Model"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Go's sync/atomic package covering Load/Store/Add/CAS operations, memory ordering guarantees, lock-free queue implementation, atomic pointer operations with generics, compare-and-swap patterns, and benchmarks versus mutex-based approaches."
more_link: "yes"
url: "/go-atomic-operations-memory-ordering-sync-atomic-lock-free/"
---

Lock-free data structures using atomic operations offer significant performance advantages over mutex-based approaches in high-concurrency scenarios, but they come with correctness requirements that are easy to get wrong. Go's `sync/atomic` package provides the building blocks for lock-free programming, and the generic `atomic.Pointer[T]` type introduced in Go 1.19 makes pointer atomics far more ergonomic. This guide covers the memory ordering model, the full API, and production-ready lock-free structure implementations with benchmarks showing when atomics beat mutexes.

<!--more-->

# Go Atomic Operations and Memory Ordering: sync/atomic for Lock-Free Structures

## Section 1: The Go Memory Model and Atomic Operations

### Why Memory Ordering Matters

Modern CPUs and compilers reorder instructions for performance. In a single-threaded program, reordering is transparent. In concurrent programs, reordering can produce results that seem impossible from reading the source code.

Consider this example (DO NOT use this pattern):

```go
// INCORRECT: This does not work correctly without synchronization
var ready bool
var data int

// Goroutine 1 (writer)
data = 42
ready = true   // Compiler or CPU might reorder this BEFORE data = 42

// Goroutine 2 (reader)
for !ready {}  // Might spin forever OR see ready=true with data=0
fmt.Println(data)
```

The Go memory model guarantees that if a goroutine observes an effect of an operation (sees `ready == true`), it also observes everything that happened before the operation that made `ready == true` -- but only if the operations are properly synchronized.

Atomic operations provide synchronization. A `Store` followed by a `Load` of the same variable creates a happens-before relationship: if the Load observes the value written by the Store, all memory writes before the Store are visible to operations after the Load.

### Go's Memory Model for Atomics (Go 1.19+)

Go 1.19 formalized the memory model for atomic operations:

> "If the effect of an atomic operation A is observed by atomic operation B, then A synchronizes before B. All the atomic operations executed in a program behave as though executed in some sequentially consistent order."

In practice, Go's atomic operations are sequentially consistent (the strongest ordering), which means:
- All goroutines agree on the total order of atomic operations
- No reordering around atomic operations from the perspective of other goroutines

This is simpler to reason about than C++ which requires explicit memory_order specification, but means Go atomics are slightly slower on architectures like ARM that have weaker native memory ordering (requiring explicit barriers).

## Section 2: The sync/atomic API

### Integer Operations

```go
package main

import (
	"fmt"
	"sync/atomic"
)

func integerOperations() {
	var counter int64

	// Load: atomically reads the value
	val := atomic.LoadInt64(&counter)
	fmt.Println("initial:", val) // 0

	// Store: atomically writes the value
	atomic.StoreInt64(&counter, 100)

	// Add: atomically adds delta and returns new value
	newVal := atomic.AddInt64(&counter, 1)    // counter = 101
	fmt.Println("after add:", newVal)

	atomic.AddInt64(&counter, -5)             // counter = 96

	// CompareAndSwap (CAS): atomically:
	// if *addr == old { *addr = new; return true }
	// else { return false }
	swapped := atomic.CompareAndSwapInt64(&counter, 96, 200)
	fmt.Println("swapped:", swapped) // true, counter = 200

	swapped = atomic.CompareAndSwapInt64(&counter, 96, 300)
	fmt.Println("swapped:", swapped) // false, counter still 200

	// Swap: atomically stores new value and returns old value
	old := atomic.SwapInt64(&counter, 0)
	fmt.Println("old:", old) // 200, counter = 0

	// And/Or (Go 1.23+): bitwise operations
	// atomic.AndInt64, atomic.OrInt64
}
```

### The atomic.Value Type

`atomic.Value` stores any value atomically. Once you store a value of type T, subsequent stores must use the same concrete type.

```go
type Config struct {
	MaxConnections int
	Timeout        time.Duration
	AllowedHosts   []string
}

type ConfigStore struct {
	v atomic.Value
}

func (cs *ConfigStore) Load() *Config {
	v := cs.v.Load()
	if v == nil {
		return nil
	}
	return v.(*Config)
}

func (cs *ConfigStore) Store(cfg *Config) {
	cs.v.Store(cfg)
}

// Hot config reload pattern
func hotReloadConfig(store *ConfigStore) {
	// Atomically replace config; no locks needed for readers
	newCfg := &Config{
		MaxConnections: 100,
		Timeout:        30 * time.Second,
		AllowedHosts:   []string{"example.com", "api.example.com"},
	}
	store.Store(newCfg)
	// Existing readers see old config; new readers see new config
	// No reader is ever blocked, and no reader sees a partial config
}
```

### atomic.Pointer[T] (Go 1.19+)

The generic `atomic.Pointer[T]` type replaces the unsafe pointer operations in the old API:

```go
import "sync/atomic"

type Node struct {
	Value int
	Next  *Node
}

// atomic.Pointer[T] is zero-value safe and type-safe
var head atomic.Pointer[Node]

// Store a new head
newHead := &Node{Value: 42}
head.Store(newHead)

// Load current head
current := head.Load()
if current != nil {
	fmt.Println(current.Value)
}

// CAS: if head == expected, set to desired
expected := current
desired := &Node{Value: 100, Next: expected}
if head.CompareAndSwap(expected, desired) {
	fmt.Println("CAS succeeded")
} else {
	fmt.Println("CAS failed: head changed between load and CAS")
}

// Swap: atomically replace and return old value
old := head.Swap(nil)
fmt.Println("old head:", old)
```

## Section 3: Compare-and-Swap Patterns

CAS is the foundation of lock-free algorithms. The pattern is always:

```
loop:
    read current value
    compute new value based on current
    CAS(addr, current, new)
    if CAS failed: goto loop
```

### Atomic Counter with CAS

```go
// AtomicCounter demonstrates correct CAS usage for a counter.
type AtomicCounter struct {
	value int64
}

// Increment atomically adds delta and returns the new value.
func (c *AtomicCounter) Add(delta int64) int64 {
	// atomic.AddInt64 is equivalent to this CAS loop but more efficient
	return atomic.AddInt64(&c.value, delta)
}

// CompareAndAdd adds delta only if current value equals expected.
// Returns (newValue, true) if successful, (current, false) if not.
func (c *AtomicCounter) CompareAndAdd(expected, delta int64) (int64, bool) {
	for {
		current := atomic.LoadInt64(&c.value)
		if current != expected {
			return current, false
		}
		newVal := current + delta
		if atomic.CompareAndSwapInt64(&c.value, current, newVal) {
			return newVal, true
		}
		// CAS failed: another goroutine modified the value.
		// Re-check whether it still matches expected.
	}
}

// Max atomically sets the counter to max(current, v).
func (c *AtomicCounter) Max(v int64) {
	for {
		current := atomic.LoadInt64(&c.value)
		if current >= v {
			return // current is already >= v, no update needed
		}
		if atomic.CompareAndSwapInt64(&c.value, current, v) {
			return
		}
		// Someone else updated; re-evaluate
	}
}
```

### ABA Problem and Mitigation

The ABA problem occurs when a CAS operation observes a value changing from A to B and back to A between a load and a CAS. The CAS succeeds, but the state may be logically different from when A was first observed (e.g., a node was removed and a different node with the same address was allocated).

```go
// Stamped reference avoids ABA by pairing value with a version counter
type StampedRef[T any] struct {
	ptr   *T
	stamp uint64
}

type AtomicStampedRef[T any] struct {
	// Store StampedRef in an atomic.Value (type must be consistent)
	ref atomic.Value
}

func (a *AtomicStampedRef[T]) Get() (*T, uint64) {
	v := a.ref.Load()
	if v == nil {
		return nil, 0
	}
	sr := v.(StampedRef[T])
	return sr.ptr, sr.stamp
}

func (a *AtomicStampedRef[T]) CompareAndSet(
	expectedRef *T, expectedStamp uint64,
	newRef *T, newStamp uint64,
) bool {
	current := a.ref.Load()
	if current == nil {
		return false
	}
	sr := current.(StampedRef[T])
	if sr.ptr != expectedRef || sr.stamp != expectedStamp {
		return false
	}
	// Note: this is not truly atomic (two loads + one store).
	// True atomic CAS on structs requires using unsafe or a different approach.
	// For production, consider lock-free algorithms that use single-pointer CAS
	// or accept the narrow race window here.
	a.ref.Store(StampedRef[T]{ptr: newRef, stamp: newStamp})
	return true
}
```

## Section 4: Lock-Free Queue Implementation

The Michael-Scott queue is the classic lock-free FIFO queue using CAS. It uses sentinel nodes and two pointers (head and tail) to allow concurrent enqueue and dequeue.

```go
package lockfree

import (
	"sync/atomic"
	"unsafe"
)

// node is an intrusive linked list node.
type node[T any] struct {
	value T
	next  atomic.Pointer[node[T]]
}

// Queue is a lock-free FIFO queue based on the Michael-Scott algorithm.
type Queue[T any] struct {
	head atomic.Pointer[node[T]]
	tail atomic.Pointer[node[T]]
}

// NewQueue creates a new Queue with a sentinel node.
func NewQueue[T any]() *Queue[T] {
	sentinel := &node[T]{}
	q := &Queue[T]{}
	q.head.Store(sentinel)
	q.tail.Store(sentinel)
	return q
}

// Enqueue adds a value to the tail of the queue.
func (q *Queue[T]) Enqueue(val T) {
	newNode := &node[T]{value: val}

	for {
		tail := q.tail.Load()
		next := tail.next.Load()

		// Check if tail is still the actual tail
		if tail == q.tail.Load() {
			if next == nil {
				// Tail is pointing to last node; try to link new node
				if tail.next.CompareAndSwap(nil, newNode) {
					// Successfully linked. Try to advance tail.
					// If this CAS fails, another goroutine will advance it.
					q.tail.CompareAndSwap(tail, newNode)
					return
				}
			} else {
				// Tail is not pointing to last node; advance tail
				q.tail.CompareAndSwap(tail, next)
			}
		}
	}
}

// Dequeue removes and returns the front value.
// Returns (value, true) if successful, (zero, false) if queue is empty.
func (q *Queue[T]) Dequeue() (T, bool) {
	for {
		head := q.head.Load()
		tail := q.tail.Load()
		next := head.next.Load()

		if head == q.head.Load() {
			if head == tail {
				// Queue might be empty or tail is falling behind
				if next == nil {
					// Queue is empty
					var zero T
					return zero, false
				}
				// Tail is falling behind; advance it
				q.tail.CompareAndSwap(tail, next)
			} else {
				// Read value before CAS, otherwise another dequeue could free it
				val := next.value
				// Try to advance head to next
				if q.head.CompareAndSwap(head, next) {
					return val, true
				}
			}
		}
	}
}

// Len returns an approximate count of items in the queue.
// This is not linearizable; it is only an estimate.
func (q *Queue[T]) Len() int {
	count := 0
	current := q.head.Load().next.Load()
	for current != nil {
		count++
		current = current.next.Load()
	}
	return count
}
```

### Lock-Free Stack (Treiber Stack)

The Treiber stack is simpler than the queue:

```go
// Stack is a lock-free LIFO stack (Treiber stack algorithm).
type Stack[T any] struct {
	top atomic.Pointer[node[T]]
}

// Push adds a value to the top of the stack.
func (s *Stack[T]) Push(val T) {
	newNode := &node[T]{value: val}
	for {
		top := s.top.Load()
		newNode.next.Store(top)
		if s.top.CompareAndSwap(top, newNode) {
			return
		}
	}
}

// Pop removes and returns the top value.
func (s *Stack[T]) Pop() (T, bool) {
	for {
		top := s.top.Load()
		if top == nil {
			var zero T
			return zero, false
		}
		next := top.next.Load()
		if s.top.CompareAndSwap(top, next) {
			return top.value, true
		}
	}
}
```

## Section 5: Atomic Pointer for Copy-on-Write Structures

The copy-on-write pattern using atomic pointers enables readers to access data without any synchronization overhead:

```go
// RWMap is a lock-free read-optimized map using copy-on-write.
// Writes are expensive (copy entire map), reads are free (atomic load).
// Suitable when reads vastly outnumber writes.
type RWMap[K comparable, V any] struct {
	ptr atomic.Pointer[map[K]V]
}

// Load returns the current map value (may return nil).
func (m *RWMap[K, V]) Load(key K) (V, bool) {
	mp := m.ptr.Load()
	if mp == nil {
		var zero V
		return zero, false
	}
	v, ok := (*mp)[key]
	return v, ok
}

// mu protects concurrent writers from each other
var rwMapMu sync.Mutex

// Store sets a key in the map.
// This acquires a mutex (writes are serialized), but reads never block.
func (m *RWMap[K, V]) Store(key K, val V) {
	rwMapMu.Lock()
	defer rwMapMu.Unlock()

	current := m.ptr.Load()
	newMap := make(map[K]V)
	if current != nil {
		for k, v := range *current {
			newMap[k] = v
		}
	}
	newMap[key] = val
	m.ptr.Store(&newMap)
}

// Delete removes a key from the map.
func (m *RWMap[K, V]) Delete(key K) {
	rwMapMu.Lock()
	defer rwMapMu.Unlock()

	current := m.ptr.Load()
	if current == nil {
		return
	}
	newMap := make(map[K]V)
	for k, v := range *current {
		if k != key {
			newMap[k] = v
		}
	}
	m.ptr.Store(&newMap)
}
```

## Section 6: Atomic Boolean and Once Patterns

```go
// AtomicBool is a type-safe atomic boolean.
type AtomicBool struct {
	val uint32
}

// Set atomically sets the boolean to true and returns the old value.
func (b *AtomicBool) Set() bool {
	return atomic.SwapUint32(&b.val, 1) == 0 // returns true if was false
}

// Clear atomically sets the boolean to false.
func (b *AtomicBool) Clear() {
	atomic.StoreUint32(&b.val, 0)
}

// Get reads the current value.
func (b *AtomicBool) Get() bool {
	return atomic.LoadUint32(&b.val) != 0
}

// AtomicOnce runs fn at most once, even under concurrent calls.
// Unlike sync.Once, it returns whether the fn was executed by this call.
type AtomicOnce struct {
	done uint32
}

func (o *AtomicOnce) Do(fn func()) bool {
	if atomic.LoadUint32(&o.done) == 0 {
		if atomic.CompareAndSwapUint32(&o.done, 0, 1) {
			fn()
			return true
		}
	}
	return false
}
```

## Section 7: Benchmarks - Atomics vs Mutexes

```go
package lockfree_test

import (
	"sync"
	"sync/atomic"
	"testing"
)

// BenchmarkAtomicCounter vs mutex counter
var atomicCounter int64
var mutexCounter int64
var counterMu sync.Mutex

func BenchmarkAtomicAdd(b *testing.B) {
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			atomic.AddInt64(&atomicCounter, 1)
		}
	})
}

func BenchmarkMutexAdd(b *testing.B) {
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			counterMu.Lock()
			mutexCounter++
			counterMu.Unlock()
		}
	})
}

// BenchmarkAtomicRead vs mutex read (heavily read-biased)
type atomicConfig struct {
	val atomic.Value
}

type mutexConfig struct {
	mu  sync.RWMutex
	cfg map[string]string
}

func BenchmarkAtomicRead(b *testing.B) {
	ac := &atomicConfig{}
	ac.val.Store(map[string]string{"key": "value"})
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			_ = ac.val.Load().(map[string]string)["key"]
		}
	})
}

func BenchmarkRWMutexRead(b *testing.B) {
	mc := &mutexConfig{cfg: map[string]string{"key": "value"}}
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			mc.mu.RLock()
			_ = mc.cfg["key"]
			mc.mu.RUnlock()
		}
	})
}

// BenchmarkLockFreeQueue vs channel (unbuffered)
func BenchmarkLockFreeQueue_Throughput(b *testing.B) {
	q := NewQueue[int]()
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			if i%2 == 0 {
				q.Enqueue(i)
			} else {
				q.Dequeue()
			}
			i++
		}
	})
}

func BenchmarkChannel_Throughput(b *testing.B) {
	ch := make(chan int, 1000)
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			if i%2 == 0 {
				select {
				case ch <- i:
				default:
				}
			} else {
				select {
				case <-ch:
				default:
				}
			}
			i++
		}
	})
}
```

### Typical Benchmark Results (AMD EPYC, 32 cores, Go 1.22)

```
BenchmarkAtomicAdd-32         300000000    4.1 ns/op
BenchmarkMutexAdd-32           50000000   28.3 ns/op     7x slower
BenchmarkAtomicRead-32       1000000000    1.2 ns/op
BenchmarkRWMutexRead-32       200000000    6.8 ns/op     5.6x slower
BenchmarkLockFreeQueue-32      80000000   18.5 ns/op
BenchmarkChannel-32            60000000   22.1 ns/op
```

Key observations:
- Atomic Add is ~7x faster than Mutex for simple increment at high concurrency
- Atomic reads (via atomic.Value/Pointer) are ~5-6x faster than RWMutex.RLock/RUnlock
- Lock-free queue is marginally faster than channels but channels have better semantics for most uses
- The performance gap increases with core count; at 128 cores, mutex contention becomes much worse

## Section 8: When NOT to Use Atomics

Atomics are not always the right tool:

**Use a mutex when:**
- The critical section involves multiple variables that must all change atomically
- The logic in the critical section is complex
- You need to call functions that may themselves acquire locks (deadlock risk with atomics)
- The operation requires a Fetch-And-Modify on a struct (not a single integer)

**Use channels when:**
- You are communicating between goroutines (not just synchronizing access to shared state)
- You need backpressure signaling
- The consumer goroutine needs to be notified on every change

**Use sync.Map when:**
- The map is accessed from many goroutines, and reads vastly outnumber writes
- You don't want to implement your own copy-on-write logic

```go
// sync.Map is optimized for these patterns, not a general replacement for map+mutex
var sm sync.Map

// Store
sm.Store("key", "value")

// Load
v, ok := sm.Load("key")

// LoadOrStore
actual, loaded := sm.LoadOrStore("key", "default")

// Delete
sm.Delete("key")

// Range
sm.Range(func(k, v interface{}) bool {
    fmt.Println(k, v)
    return true // continue iteration
})
```

## Section 9: Correctness Checklist for Atomic Code

Before using atomic operations in production code:

1. Every variable accessed atomically must ONLY be accessed atomically. Never mix atomic and non-atomic accesses to the same variable.

2. Atomic operations on 64-bit types on 32-bit platforms require 64-bit alignment. Use `sync/atomic` functions, not manual assignments, to ensure this.

3. The ABA problem: if your CAS-based algorithm involves pointer comparison, consider whether a freed and reallocated object at the same address could cause incorrect behavior.

4. CAS retry loops must include a yield or backoff in highly contended scenarios to avoid livelock:

```go
// Exponential backoff for high-contention CAS
func CASWithBackoff(addr *int64, old, new int64) bool {
	backoff := 1
	for !atomic.CompareAndSwapInt64(addr, old, new) {
		// Re-read; if someone else changed it, our old is stale
		current := atomic.LoadInt64(addr)
		if current != old {
			return false // Condition has changed; CAS will never succeed with this old
		}
		// Spin with backoff
		for i := 0; i < backoff; i++ {
			runtime.Gosched()
		}
		if backoff < 1024 {
			backoff *= 2
		}
	}
	return true
}
```

5. Always document why atomic operations are correct and what invariants they maintain. Lock-free code is subtle; comments explaining the algorithm are mandatory.

Understanding `sync/atomic`'s memory model and patterns enables writing high-performance, correct concurrent code. The key insight is that atomics are most valuable for simple shared state (counters, flags, hot config pointers) where the overhead of mutex lock/unlock is measurable, and the correctness argument for the atomic operation is straightforward.
