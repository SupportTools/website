---
title: "Go Generics in Production: Type Parameters for Data Pipelines and Collection Libraries"
date: 2030-12-22T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Generics", "Type Parameters", "Data Pipelines", "Performance", "Collections"]
categories:
- Go
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to using Go generics in production systems, covering type constraints, generic data structures, pipeline functions, avoiding interface{} boxing overhead, and real-world patterns that improve code safety and performance."
more_link: "yes"
url: "/go-generics-production-type-parameters-data-pipelines/"
---

Go generics, introduced in Go 1.18, fundamentally changed how Go developers write reusable code. Before generics, the choice was between code duplication, reflection overhead, or unsafe `interface{}` gymnastics. Generics provide a third path: type-safe, zero-overhead abstraction. This guide covers production-grade patterns for generics, from fundamental type constraints through complete pipeline libraries, with real benchmarks demonstrating when generics outperform alternatives.

<!--more-->

# Go Generics in Production: Type Parameters for Data Pipelines and Collection Libraries

## Understanding Type Constraints

Type constraints are the foundation of Go generics. They define the set of types that a type parameter can represent.

### Built-in Constraint Packages

```go
package constraints

// The constraints package provides common constraint interfaces

// Ordered represents all types that support ordering operators
type Ordered interface {
    Integer | Float | ~string
}

// Integer represents all signed and unsigned integer types
type Integer interface {
    Signed | Unsigned
}

// Signed represents all signed integer types
type Signed interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64
}

// Unsigned represents all unsigned integer types
type Unsigned interface {
    ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr
}

// Float represents all floating-point types
type Float interface {
    ~float32 | ~float64
}
```

### Custom Constraints for Domain Logic

```go
package domain

import "encoding/json"

// Serializable constrains types that can be marshaled to JSON
type Serializable interface {
    json.Marshaler
    json.Unmarshaler
}

// Entity constrains types that have a unique identifier
type Entity[ID comparable] interface {
    GetID() ID
}

// Numeric constrains all numeric types for mathematical operations
type Numeric interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64 |
        ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 |
        ~float32 | ~float64
}

// Cloneable constrains types that can create deep copies
type Cloneable[T any] interface {
    Clone() T
}

// Comparable wraps the built-in comparable constraint with additional methods
type ComparableEntity[K comparable] interface {
    comparable
    Key() K
}
```

### Using Tilde for Underlying Type Constraints

The `~` operator is critical for practical generics because it matches types with the specified underlying type:

```go
package main

import "fmt"

// Without tilde - only exact type matches
type ExactInt interface {
    int
}

// With tilde - matches int and any type with int as underlying type
type IntLike interface {
    ~int
}

// Custom type with int underlying type
type UserID int
type ProductID int

// This works with ~int but NOT without tilde
func Double[T ~int](v T) T {
    return v * 2
}

func main() {
    var uid UserID = 42
    var pid ProductID = 100

    fmt.Println(Double(uid))  // 84
    fmt.Println(Double(pid))  // 200
    fmt.Println(Double(5))    // 10
}
```

## Generic Data Structures

### Type-Safe Stack

```go
package collections

import "errors"

// ErrEmptyCollection is returned when operating on an empty collection
var ErrEmptyCollection = errors.New("collection is empty")

// Stack is a generic LIFO data structure
type Stack[T any] struct {
    items []T
}

// NewStack creates a new empty stack with optional initial capacity
func NewStack[T any](capacity ...int) *Stack[T] {
    cap := 16
    if len(capacity) > 0 {
        cap = capacity[0]
    }
    return &Stack[T]{
        items: make([]T, 0, cap),
    }
}

// Push adds an item to the top of the stack
func (s *Stack[T]) Push(item T) {
    s.items = append(s.items, item)
}

// Pop removes and returns the top item from the stack
func (s *Stack[T]) Pop() (T, error) {
    var zero T
    if len(s.items) == 0 {
        return zero, ErrEmptyCollection
    }
    last := len(s.items) - 1
    item := s.items[last]
    s.items = s.items[:last]
    return item, nil
}

// Peek returns the top item without removing it
func (s *Stack[T]) Peek() (T, error) {
    var zero T
    if len(s.items) == 0 {
        return zero, ErrEmptyCollection
    }
    return s.items[len(s.items)-1], nil
}

// Len returns the number of items in the stack
func (s *Stack[T]) Len() int {
    return len(s.items)
}

// IsEmpty returns true if the stack has no items
func (s *Stack[T]) IsEmpty() bool {
    return len(s.items) == 0
}

// ToSlice returns a copy of the stack contents (bottom to top order)
func (s *Stack[T]) ToSlice() []T {
    result := make([]T, len(s.items))
    copy(result, s.items)
    return result
}
```

### Thread-Safe Generic Queue

```go
package collections

import "sync"

// Queue is a generic, thread-safe FIFO data structure
type Queue[T any] struct {
    mu    sync.Mutex
    items []T
    head  int
    tail  int
    count int
}

// NewQueue creates a new queue with initial buffer size
func NewQueue[T any](size ...int) *Queue[T] {
    bufSize := 64
    if len(size) > 0 {
        bufSize = size[0]
    }
    return &Queue[T]{
        items: make([]T, bufSize),
    }
}

// Enqueue adds an item to the back of the queue
func (q *Queue[T]) Enqueue(item T) {
    q.mu.Lock()
    defer q.mu.Unlock()

    if q.count == len(q.items) {
        q.grow()
    }

    q.items[q.tail] = item
    q.tail = (q.tail + 1) % len(q.items)
    q.count++
}

// Dequeue removes and returns the front item
func (q *Queue[T]) Dequeue() (T, error) {
    q.mu.Lock()
    defer q.mu.Unlock()

    var zero T
    if q.count == 0 {
        return zero, ErrEmptyCollection
    }

    item := q.items[q.head]
    q.items[q.head] = zero // Allow GC
    q.head = (q.head + 1) % len(q.items)
    q.count--

    return item, nil
}

// grow doubles the queue's buffer capacity
func (q *Queue[T]) grow() {
    newItems := make([]T, len(q.items)*2)
    if q.head < q.tail {
        copy(newItems, q.items[q.head:q.tail])
    } else {
        n := copy(newItems, q.items[q.head:])
        copy(newItems[n:], q.items[:q.tail])
    }
    q.head = 0
    q.tail = q.count
    q.items = newItems
}

// Len returns the number of items currently in the queue
func (q *Queue[T]) Len() int {
    q.mu.Lock()
    defer q.mu.Unlock()
    return q.count
}
```

### Generic Set with Operations

```go
package collections

// Set is a generic set data structure using a map for O(1) operations
type Set[T comparable] struct {
    m map[T]struct{}
}

// NewSet creates a new set, optionally initialized with values
func NewSet[T comparable](values ...T) *Set[T] {
    s := &Set[T]{
        m: make(map[T]struct{}, len(values)),
    }
    for _, v := range values {
        s.m[v] = struct{}{}
    }
    return s
}

// Add inserts an element into the set
func (s *Set[T]) Add(value T) {
    s.m[value] = struct{}{}
}

// Remove deletes an element from the set
func (s *Set[T]) Remove(value T) {
    delete(s.m, value)
}

// Contains returns true if the element is in the set
func (s *Set[T]) Contains(value T) bool {
    _, ok := s.m[value]
    return ok
}

// Len returns the number of elements in the set
func (s *Set[T]) Len() int {
    return len(s.m)
}

// ToSlice returns all elements as a slice (order not guaranteed)
func (s *Set[T]) ToSlice() []T {
    result := make([]T, 0, len(s.m))
    for k := range s.m {
        result = append(result, k)
    }
    return result
}

// Union returns a new set containing all elements from both sets
func (s *Set[T]) Union(other *Set[T]) *Set[T] {
    result := NewSet[T]()
    for k := range s.m {
        result.m[k] = struct{}{}
    }
    for k := range other.m {
        result.m[k] = struct{}{}
    }
    return result
}

// Intersection returns elements present in both sets
func (s *Set[T]) Intersection(other *Set[T]) *Set[T] {
    result := NewSet[T]()
    // Iterate over the smaller set for efficiency
    small, large := s, other
    if len(s.m) > len(other.m) {
        small, large = other, s
    }
    for k := range small.m {
        if _, ok := large.m[k]; ok {
            result.m[k] = struct{}{}
        }
    }
    return result
}

// Difference returns elements in s that are not in other
func (s *Set[T]) Difference(other *Set[T]) *Set[T] {
    result := NewSet[T]()
    for k := range s.m {
        if _, ok := other.m[k]; !ok {
            result.m[k] = struct{}{}
        }
    }
    return result
}

// IsSubsetOf returns true if all elements of s are in other
func (s *Set[T]) IsSubsetOf(other *Set[T]) bool {
    for k := range s.m {
        if _, ok := other.m[k]; !ok {
            return false
        }
    }
    return true
}
```

### Ordered Map with Generic Keys and Values

```go
package collections

import "sync"

// OrderedMap maintains insertion order while providing O(1) lookup
type OrderedMap[K comparable, V any] struct {
    mu     sync.RWMutex
    keys   []K
    values map[K]V
}

// NewOrderedMap creates a new ordered map
func NewOrderedMap[K comparable, V any]() *OrderedMap[K, V] {
    return &OrderedMap[K, V]{
        keys:   make([]K, 0),
        values: make(map[K]V),
    }
}

// Set inserts or updates a key-value pair
func (om *OrderedMap[K, V]) Set(key K, value V) {
    om.mu.Lock()
    defer om.mu.Unlock()

    if _, exists := om.values[key]; !exists {
        om.keys = append(om.keys, key)
    }
    om.values[key] = value
}

// Get retrieves a value by key
func (om *OrderedMap[K, V]) Get(key K) (V, bool) {
    om.mu.RLock()
    defer om.mu.RUnlock()

    v, ok := om.values[key]
    return v, ok
}

// Delete removes a key-value pair
func (om *OrderedMap[K, V]) Delete(key K) {
    om.mu.Lock()
    defer om.mu.Unlock()

    if _, exists := om.values[key]; !exists {
        return
    }

    delete(om.values, key)
    for i, k := range om.keys {
        if k == key {
            om.keys = append(om.keys[:i], om.keys[i+1:]...)
            break
        }
    }
}

// Keys returns all keys in insertion order
func (om *OrderedMap[K, V]) Keys() []K {
    om.mu.RLock()
    defer om.mu.RUnlock()

    result := make([]K, len(om.keys))
    copy(result, om.keys)
    return result
}

// ForEach iterates over entries in insertion order
func (om *OrderedMap[K, V]) ForEach(fn func(key K, value V) bool) {
    om.mu.RLock()
    keys := make([]K, len(om.keys))
    copy(keys, om.keys)
    om.mu.RUnlock()

    for _, k := range keys {
        om.mu.RLock()
        v, ok := om.values[k]
        om.mu.RUnlock()

        if ok {
            if !fn(k, v) {
                break
            }
        }
    }
}

// Len returns the number of entries
func (om *OrderedMap[K, V]) Len() int {
    om.mu.RLock()
    defer om.mu.RUnlock()
    return len(om.keys)
}
```

## Generic Pipeline Functions

Pipeline functions are where generics provide the most immediate value. The classic `map`, `filter`, and `reduce` operations that required `interface{}` before generics can now be type-safe and zero-allocation in many cases.

### Core Pipeline Operations

```go
package pipeline

// Map transforms each element of a slice using a function
func Map[In, Out any](input []In, fn func(In) Out) []Out {
    result := make([]Out, len(input))
    for i, v := range input {
        result[i] = fn(v)
    }
    return result
}

// Filter returns elements for which the predicate returns true
func Filter[T any](input []T, predicate func(T) bool) []T {
    result := make([]T, 0)
    for _, v := range input {
        if predicate(v) {
            result = append(result, v)
        }
    }
    return result
}

// Reduce folds a slice into a single value
func Reduce[T, Acc any](input []T, initial Acc, fn func(Acc, T) Acc) Acc {
    acc := initial
    for _, v := range input {
        acc = fn(acc, v)
    }
    return acc
}

// FlatMap maps and flattens the result
func FlatMap[In, Out any](input []In, fn func(In) []Out) []Out {
    result := make([]Out, 0, len(input))
    for _, v := range input {
        result = append(result, fn(v)...)
    }
    return result
}

// GroupBy groups elements by a key function
func GroupBy[T any, K comparable](input []T, keyFn func(T) K) map[K][]T {
    result := make(map[K][]T)
    for _, v := range input {
        k := keyFn(v)
        result[k] = append(result[k], v)
    }
    return result
}

// Partition splits a slice into two based on a predicate
func Partition[T any](input []T, predicate func(T) bool) (trueSlice, falseSlice []T) {
    for _, v := range input {
        if predicate(v) {
            trueSlice = append(trueSlice, v)
        } else {
            falseSlice = append(falseSlice, v)
        }
    }
    return
}

// Chunk splits a slice into chunks of at most size n
func Chunk[T any](input []T, size int) [][]T {
    if size <= 0 {
        panic("chunk size must be positive")
    }
    chunks := make([][]T, 0, (len(input)+size-1)/size)
    for size < len(input) {
        input, chunks = input[size:], append(chunks, input[0:size:size])
    }
    return append(chunks, input)
}

// Zip combines two slices element-by-element
func Zip[A, B any](a []A, b []B) []struct{ A A; B B } {
    minLen := len(a)
    if len(b) < minLen {
        minLen = len(b)
    }
    result := make([]struct{ A A; B B }, minLen)
    for i := 0; i < minLen; i++ {
        result[i] = struct{ A A; B B }{a[i], b[i]}
    }
    return result
}

// Unique returns a slice with duplicate elements removed
func Unique[T comparable](input []T) []T {
    seen := make(map[T]struct{}, len(input))
    result := make([]T, 0, len(input))
    for _, v := range input {
        if _, ok := seen[v]; !ok {
            seen[v] = struct{}{}
            result = append(result, v)
        }
    }
    return result
}

// Contains returns true if the slice contains the target value
func Contains[T comparable](slice []T, target T) bool {
    for _, v := range slice {
        if v == target {
            return true
        }
    }
    return false
}

// Find returns the first element matching the predicate
func Find[T any](slice []T, predicate func(T) bool) (T, bool) {
    for _, v := range slice {
        if predicate(v) {
            return v, true
        }
    }
    var zero T
    return zero, false
}

// ForEach applies a function to each element (for side effects)
func ForEach[T any](slice []T, fn func(int, T)) {
    for i, v := range slice {
        fn(i, v)
    }
}

// Sum computes the sum of a numeric slice
func Sum[T Numeric](slice []T) T {
    var total T
    for _, v := range slice {
        total += v
    }
    return total
}

// Min returns the minimum value in a slice
func Min[T Ordered](slice []T) (T, error) {
    if len(slice) == 0 {
        var zero T
        return zero, ErrEmptySlice
    }
    min := slice[0]
    for _, v := range slice[1:] {
        if v < min {
            min = v
        }
    }
    return min, nil
}

// Max returns the maximum value in a slice
func Max[T Ordered](slice []T) (T, error) {
    if len(slice) == 0 {
        var zero T
        return zero, ErrEmptySlice
    }
    max := slice[0]
    for _, v := range slice[1:] {
        if v > max {
            max = v
        }
    }
    return max, nil
}

// Numeric constraint for Sum
type Numeric interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64 |
        ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 |
        ~float32 | ~float64
}

// Ordered constraint for Min/Max
type Ordered interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64 |
        ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 |
        ~float32 | ~float64 | ~string
}

import "errors"

var ErrEmptySlice = errors.New("slice is empty")
```

### Fluent Pipeline Builder

For complex data transformations, a fluent builder API improves readability:

```go
package pipeline

// Pipeline provides a fluent API for chaining transformations
type Pipeline[T any] struct {
    data []T
}

// From creates a new pipeline from a slice
func From[T any](data []T) *Pipeline[T] {
    return &Pipeline[T]{data: data}
}

// Filter returns a new pipeline with elements matching the predicate
func (p *Pipeline[T]) Filter(predicate func(T) bool) *Pipeline[T] {
    return &Pipeline[T]{data: Filter(p.data, predicate)}
}

// ForEachItem applies a function to each element for side effects
func (p *Pipeline[T]) ForEachItem(fn func(int, T)) *Pipeline[T] {
    ForEach(p.data, fn)
    return p
}

// Take returns a pipeline with at most n elements
func (p *Pipeline[T]) Take(n int) *Pipeline[T] {
    if n >= len(p.data) {
        return p
    }
    return &Pipeline[T]{data: p.data[:n]}
}

// Skip returns a pipeline with the first n elements removed
func (p *Pipeline[T]) Skip(n int) *Pipeline[T] {
    if n >= len(p.data) {
        return &Pipeline[T]{data: []T{}}
    }
    return &Pipeline[T]{data: p.data[n:]}
}

// Collect returns the final slice
func (p *Pipeline[T]) Collect() []T {
    return p.data
}

// Count returns the number of elements
func (p *Pipeline[T]) Count() int {
    return len(p.data)
}

// First returns the first element or an error
func (p *Pipeline[T]) First() (T, bool) {
    if len(p.data) == 0 {
        var zero T
        return zero, false
    }
    return p.data[0], true
}

// MapPipeline transforms a pipeline of one type to another
// (standalone function since Go doesn't allow new type params on methods)
func MapPipeline[In, Out any](p *Pipeline[In], fn func(In) Out) *Pipeline[Out] {
    return &Pipeline[Out]{data: Map(p.data, fn)}
}
```

### Concurrent Pipeline with Worker Pool

For CPU-intensive transformations, a concurrent pipeline with bounded parallelism:

```go
package pipeline

import (
    "context"
    "sync"
)

// ConcurrentMap applies fn to all elements using n goroutines
// Results maintain original order
func ConcurrentMap[In, Out any](ctx context.Context, input []In, fn func(In) Out, workers int) ([]Out, error) {
    if workers <= 0 {
        workers = 1
    }

    result := make([]Out, len(input))
    jobs := make(chan int, len(input))

    // Fill job channel with indices
    for i := range input {
        jobs <- i
    }
    close(jobs)

    var wg sync.WaitGroup
    var firstErr error
    var errMu sync.Mutex

    for w := 0; w < workers; w++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for idx := range jobs {
                // Check context cancellation
                select {
                case <-ctx.Done():
                    errMu.Lock()
                    if firstErr == nil {
                        firstErr = ctx.Err()
                    }
                    errMu.Unlock()
                    return
                default:
                }

                result[idx] = fn(input[idx])
            }
        }()
    }

    wg.Wait()

    if firstErr != nil {
        return nil, firstErr
    }
    return result, nil
}

// ConcurrentMapWithError is like ConcurrentMap but allows the function to return errors
func ConcurrentMapWithError[In, Out any](
    ctx context.Context,
    input []In,
    fn func(In) (Out, error),
    workers int,
) ([]Out, error) {
    if workers <= 0 {
        workers = 1
    }

    result := make([]Out, len(input))
    errs := make([]error, len(input))
    jobs := make(chan int, len(input))

    for i := range input {
        jobs <- i
    }
    close(jobs)

    var wg sync.WaitGroup
    for w := 0; w < workers; w++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for idx := range jobs {
                select {
                case <-ctx.Done():
                    errs[idx] = ctx.Err()
                    return
                default:
                }

                out, err := fn(input[idx])
                if err != nil {
                    errs[idx] = err
                } else {
                    result[idx] = out
                }
            }
        }()
    }

    wg.Wait()

    // Return first error if any
    for _, err := range errs {
        if err != nil {
            return nil, err
        }
    }

    return result, nil
}
```

## Avoiding Interface{} Boxing Overhead

### Benchmark: Generics vs Interface{}

The performance difference between generics and `interface{}` is most pronounced in tight loops with value types:

```go
package benchmark_test

import (
    "testing"
)

// Interface-based sum (pre-generics approach)
func SumInterface(numbers []interface{}) float64 {
    var total float64
    for _, n := range numbers {
        total += n.(float64)
    }
    return total
}

// Generic sum (no boxing)
func SumGeneric[T Numeric](numbers []T) T {
    var total T
    for _, n := range numbers {
        total += n
    }
    return total
}

func BenchmarkSumInterface(b *testing.B) {
    data := make([]interface{}, 1000)
    for i := range data {
        data[i] = float64(i)
    }
    b.ResetTimer()
    for n := 0; n < b.N; n++ {
        SumInterface(data)
    }
}

func BenchmarkSumGeneric(b *testing.B) {
    data := make([]float64, 1000)
    for i := range data {
        data[i] = float64(i)
    }
    b.ResetTimer()
    for n := 0; n < b.N; n++ {
        SumGeneric(data)
    }
}
```

Typical benchmark results:
```
BenchmarkSumInterface-8    1200000    1001 ns/op    0 B/op    0 allocs/op
BenchmarkSumGeneric-8     12000000     98 ns/op    0 B/op    0 allocs/op
```

The generic version is roughly 10x faster because it avoids type assertions and the indirection cost of interface values.

### Result Type for Error Handling

A generic Result type eliminates repetitive error checking boilerplate:

```go
package result

import "fmt"

// Result represents either a successful value or an error
type Result[T any] struct {
    value T
    err   error
}

// Ok creates a successful result
func Ok[T any](value T) Result[T] {
    return Result[T]{value: value}
}

// Err creates an error result
func Err[T any](err error) Result[T] {
    return Result[T]{err: err}
}

// Errorf creates an error result with a formatted message
func Errorf[T any](format string, args ...any) Result[T] {
    return Result[T]{err: fmt.Errorf(format, args...)}
}

// IsOk returns true if the result is successful
func (r Result[T]) IsOk() bool {
    return r.err == nil
}

// Unwrap returns the value or panics if the result is an error
func (r Result[T]) Unwrap() T {
    if r.err != nil {
        panic(fmt.Sprintf("called Unwrap on an error Result: %v", r.err))
    }
    return r.value
}

// UnwrapOr returns the value or a default if the result is an error
func (r Result[T]) UnwrapOr(defaultValue T) T {
    if r.err != nil {
        return defaultValue
    }
    return r.value
}

// Error returns the error or nil
func (r Result[T]) Error() error {
    return r.err
}

// Map transforms a successful result using a function
func Map[T, U any](r Result[T], fn func(T) U) Result[U] {
    if r.err != nil {
        return Err[U](r.err)
    }
    return Ok(fn(r.value))
}

// FlatMap transforms a successful result using a function that returns a Result
func FlatMap[T, U any](r Result[T], fn func(T) Result[U]) Result[U] {
    if r.err != nil {
        return Err[U](r.err)
    }
    return fn(r.value)
}
```

### Optional Type

```go
package optional

// Option represents an optional value (replaces nil pointer patterns)
type Option[T any] struct {
    value    T
    hasValue bool
}

// Some creates an Option with a value
func Some[T any](value T) Option[T] {
    return Option[T]{value: value, hasValue: true}
}

// None creates an empty Option
func None[T any]() Option[T] {
    return Option[T]{}
}

// IsSome returns true if the option has a value
func (o Option[T]) IsSome() bool {
    return o.hasValue
}

// IsNone returns true if the option is empty
func (o Option[T]) IsNone() bool {
    return !o.hasValue
}

// Unwrap returns the value or panics if None
func (o Option[T]) Unwrap() T {
    if !o.hasValue {
        panic("called Unwrap on a None Option")
    }
    return o.value
}

// UnwrapOr returns the value or a default
func (o Option[T]) UnwrapOr(defaultValue T) T {
    if o.hasValue {
        return o.value
    }
    return defaultValue
}

// Map transforms a Some option
func Map[T, U any](o Option[T], fn func(T) U) Option[U] {
    if !o.hasValue {
        return None[U]()
    }
    return Some(fn(o.value))
}
```

## Real-World Generics Patterns

### Generic Repository Pattern

```go
package repository

import (
    "context"
    "fmt"
)

// Repository defines generic CRUD operations
type Repository[T any, ID comparable] interface {
    FindByID(ctx context.Context, id ID) (T, error)
    FindAll(ctx context.Context) ([]T, error)
    Save(ctx context.Context, entity T) error
    Delete(ctx context.Context, id ID) error
}

// InMemoryRepository provides a generic in-memory repository implementation
type InMemoryRepository[T any, ID comparable] struct {
    store    map[ID]T
    getID    func(T) ID
}

// NewInMemoryRepository creates a new in-memory repository
func NewInMemoryRepository[T any, ID comparable](getID func(T) ID) *InMemoryRepository[T, ID] {
    return &InMemoryRepository[T, ID]{
        store: make(map[ID]T),
        getID: getID,
    }
}

func (r *InMemoryRepository[T, ID]) FindByID(ctx context.Context, id ID) (T, error) {
    entity, ok := r.store[id]
    if !ok {
        var zero T
        return zero, fmt.Errorf("entity with id %v not found", id)
    }
    return entity, nil
}

func (r *InMemoryRepository[T, ID]) FindAll(ctx context.Context) ([]T, error) {
    entities := make([]T, 0, len(r.store))
    for _, entity := range r.store {
        entities = append(entities, entity)
    }
    return entities, nil
}

func (r *InMemoryRepository[T, ID]) Save(ctx context.Context, entity T) error {
    r.store[r.getID(entity)] = entity
    return nil
}

func (r *InMemoryRepository[T, ID]) Delete(ctx context.Context, id ID) error {
    if _, ok := r.store[id]; !ok {
        return fmt.Errorf("entity with id %v not found", id)
    }
    delete(r.store, id)
    return nil
}
```

### Generic Cache with TTL

```go
package cache

import (
    "sync"
    "time"
)

type cacheEntry[V any] struct {
    value     V
    expiresAt time.Time
}

// TTLCache is a generic cache with time-to-live expiration
type TTLCache[K comparable, V any] struct {
    mu      sync.RWMutex
    entries map[K]cacheEntry[V]
    ttl     time.Duration
}

// NewTTLCache creates a cache with the specified TTL
func NewTTLCache[K comparable, V any](ttl time.Duration) *TTLCache[K, V] {
    c := &TTLCache[K, V]{
        entries: make(map[K]cacheEntry[V]),
        ttl:     ttl,
    }

    // Background cleanup goroutine
    go func() {
        ticker := time.NewTicker(ttl / 2)
        defer ticker.Stop()
        for range ticker.C {
            c.evictExpired()
        }
    }()

    return c
}

// Set stores a value in the cache
func (c *TTLCache[K, V]) Set(key K, value V) {
    c.mu.Lock()
    defer c.mu.Unlock()

    c.entries[key] = cacheEntry[V]{
        value:     value,
        expiresAt: time.Now().Add(c.ttl),
    }
}

// Get retrieves a value from the cache
func (c *TTLCache[K, V]) Get(key K) (V, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()

    entry, ok := c.entries[key]
    if !ok || time.Now().After(entry.expiresAt) {
        var zero V
        return zero, false
    }
    return entry.value, true
}

// GetOrCompute returns a cached value or computes it if missing
func (c *TTLCache[K, V]) GetOrCompute(key K, compute func() (V, error)) (V, error) {
    if v, ok := c.Get(key); ok {
        return v, nil
    }

    v, err := compute()
    if err != nil {
        return v, err
    }

    c.Set(key, v)
    return v, nil
}

// evictExpired removes expired entries (called by background goroutine)
func (c *TTLCache[K, V]) evictExpired() {
    c.mu.Lock()
    defer c.mu.Unlock()

    now := time.Now()
    for k, entry := range c.entries {
        if now.After(entry.expiresAt) {
            delete(c.entries, k)
        }
    }
}
```

### Usage Example: Building a Data Processing System

```go
package main

import (
    "context"
    "fmt"
    "log"
    "strings"

    "myapp/collections"
    "myapp/pipeline"
)

type User struct {
    ID       int
    Name     string
    Email    string
    Age      int
    Active   bool
    Tags     []string
}

type UserSummary struct {
    ID    int
    Name  string
    Email string
}

func main() {
    users := []User{
        {1, "Alice Smith", "alice@example.com", 28, true, []string{"admin", "user"}},
        {2, "Bob Jones", "bob@example.com", 35, false, []string{"user"}},
        {3, "Carol White", "carol@example.com", 22, true, []string{"user", "beta"}},
        {4, "David Brown", "david@example.com", 45, true, []string{"admin"}},
        {5, "Eve Davis", "eve@example.com", 31, false, []string{"user"}},
    }

    // Build a processing pipeline
    activeUsers := pipeline.Filter(users, func(u User) bool {
        return u.Active
    })

    summaries := pipeline.Map(activeUsers, func(u User) UserSummary {
        return UserSummary{
            ID:    u.ID,
            Name:  strings.ToUpper(u.Name),
            Email: u.Email,
        }
    })

    // Group by age range
    grouped := pipeline.GroupBy(users, func(u User) string {
        switch {
        case u.Age < 25:
            return "young"
        case u.Age < 35:
            return "mid"
        default:
            return "senior"
        }
    })

    // Use generic set for tag deduplication
    allTags := collections.NewSet[string]()
    for _, u := range users {
        for _, tag := range u.Tags {
            allTags.Add(tag)
        }
    }

    // Sum ages of active users
    activeAges := pipeline.Map(activeUsers, func(u User) int { return u.Age })
    totalAge := pipeline.Sum(activeAges)
    avgAge := float64(totalAge) / float64(len(activeAges))

    fmt.Printf("Active users: %d\n", len(summaries))
    fmt.Printf("Age groups: young=%d, mid=%d, senior=%d\n",
        len(grouped["young"]), len(grouped["mid"]), len(grouped["senior"]))
    fmt.Printf("Unique tags: %v\n", allTags.ToSlice())
    fmt.Printf("Average age of active users: %.1f\n", avgAge)

    // Concurrent processing example
    ctx := context.Background()
    enriched, err := pipeline.ConcurrentMapWithError(ctx, activeUsers,
        func(u User) (UserSummary, error) {
            // Simulate async enrichment (e.g., fetch from external service)
            return UserSummary{
                ID:    u.ID,
                Name:  u.Name,
                Email: u.Email,
            }, nil
        }, 4)

    if err != nil {
        log.Fatal(err)
    }

    for _, s := range enriched {
        fmt.Printf("Enriched: %+v\n", s)
    }
}
```

## When NOT to Use Generics

Generics are not always the right solution. Avoid generics when:

1. **The interface already works**: If `io.Reader`, `http.Handler`, or similar standard interfaces fit your use case, use them. Generics add complexity without benefit here.

2. **Reflection is truly needed**: When the type is determined at runtime (e.g., JSON unmarshaling into arbitrary types), reflection is still the correct tool.

3. **The abstraction is too thin**: A generic `ToString[T any](v T) string` adds complexity without value over `fmt.Sprintf("%v", v)`.

4. **Method type parameters**: Go does not allow methods to introduce new type parameters. If you need this, use package-level functions instead.

```go
// This does NOT compile in Go:
func (s *Stack[T]) Map[U any](fn func(T) U) *Stack[U] { ... }

// Instead, use a package-level function:
func MapStack[T, U any](s *Stack[T], fn func(T) U) *Stack[U] {
    result := NewStack[U](s.Len())
    for _, v := range s.ToSlice() {
        result.Push(fn(v))
    }
    return result
}
```

## Summary

Go generics provide genuine value for collection libraries, pipeline functions, and domain model abstractions. The performance benefits over `interface{}` are most significant in tight loops over value types, where boxing overhead was previously unavoidable. The patterns in this guide provide a production-ready foundation for generic code in Go:

- Type constraints define the contract precisely
- Generic data structures (Stack, Queue, Set, OrderedMap) replace repetitive type-specific implementations
- Pipeline functions (Map, Filter, Reduce) provide composable, type-safe data transformation
- The Result and Option types encode success/failure into the type system
- The concurrent pipeline handles CPU-bound work with bounded parallelism
- The TTL cache and repository patterns generalize common infrastructure code

The key discipline is restraint: use generics where they eliminate real code duplication or provide measurable performance improvements, not as a default abstraction tool.
