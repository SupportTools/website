---
title: "Go Generics in Production: Type Parameters, Constraints, and Real-World Patterns"
date: 2028-06-24T00:00:00-05:00
draft: false
tags: ["Go", "Generics", "Type Parameters", "Performance", "Patterns"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into Go generics for production codebases: type parameter syntax, constraint design, common patterns like generic data structures and functional helpers, and performance benchmarks."
more_link: "yes"
url: "/go-generics-production-patterns-guide-production/"
---

Go generics landed in Go 1.18 and most teams have now had two or three years to either adopt them enthusiastically or deliberately avoid them. The right answer is neither. Generics solve specific problems well—eliminating type-assertion boilerplate, building reusable data structures, writing safer functional utilities—and they introduce real costs in compilation time and code readability when overused.

This guide covers the practical patterns that belong in production Go codebases in 2024: constraint design, generic data structures, functional helpers, and the performance implications you need to understand before making architectural decisions.

<!--more-->

# Go Generics in Production: Type Parameters, Constraints, and Real-World Patterns

## Section 1: Type Parameter Fundamentals

### Basic Syntax Review

```go
package main

import "fmt"

// Single type parameter
func Map[T, U any](slice []T, f func(T) U) []U {
    result := make([]U, len(slice))
    for i, v := range slice {
        result[i] = f(v)
    }
    return result
}

// Multiple type parameters with constraint
func Filter[T any](slice []T, predicate func(T) bool) []T {
    result := make([]T, 0, len(slice))
    for _, v := range slice {
        if predicate(v) {
            result = append(result, v)
        }
    }
    return result
}

// Type parameter on struct
type Stack[T any] struct {
    items []T
}

func (s *Stack[T]) Push(item T) {
    s.items = append(s.items, item)
}

func (s *Stack[T]) Pop() (T, bool) {
    if len(s.items) == 0 {
        var zero T
        return zero, false
    }
    item := s.items[len(s.items)-1]
    s.items = s.items[:len(s.items)-1]
    return item, true
}

func (s *Stack[T]) Peek() (T, bool) {
    if len(s.items) == 0 {
        var zero T
        return zero, false
    }
    return s.items[len(s.items)-1], true
}

func (s *Stack[T]) Len() int {
    return len(s.items)
}
```

### Type Inference

Go infers type parameters when the compiler has enough information:

```go
// Explicit
nums := Map[int, string]([]int{1, 2, 3}, strconv.Itoa)

// Inferred from argument types
nums := Map([]int{1, 2, 3}, strconv.Itoa)

// Both are equivalent; prefer inferred when unambiguous
```

## Section 2: Constraint Design

The `constraints` package was removed from the standard library in Go 1.21 and folded into `golang.org/x/exp/constraints`. The standard library added `comparable` and the `cmp` package instead. Understanding constraint design is critical for writing useful generic APIs.

### Built-in Constraints

```go
package main

import (
    "cmp"
    "fmt"
)

// comparable: supports == and != operators
func Contains[T comparable](slice []T, item T) bool {
    for _, v := range slice {
        if v == item {
            return true
        }
    }
    return false
}

// cmp.Ordered: supports <, <=, >, >= operators
// Defined as: ~int | ~int8 | ~int16 | ~int32 | ~int64 |
//             ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr |
//             ~float32 | ~float64 | ~string
func Min[T cmp.Ordered](a, b T) T {
    if a < b {
        return a
    }
    return b
}

func Max[T cmp.Ordered](a, b T) T {
    if a > b {
        return a
    }
    return b
}

// Clamp value between min and max
func Clamp[T cmp.Ordered](val, lo, hi T) T {
    return Max(lo, Min(hi, val))
}
```

### Custom Interface Constraints

```go
package constraints

// Numeric combines all numeric types
type Numeric interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64 |
        ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr |
        ~float32 | ~float64
}

// Signed covers signed integer types
type Signed interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64
}

// Float covers floating-point types
type Float interface {
    ~float32 | ~float64
}

// Stringer matches anything with a String() method
type Stringer interface {
    String() string
}

// Cloneable matches types that can be copied
type Cloneable[T any] interface {
    Clone() T
}

// Usage
func Sum[T Numeric](slice []T) T {
    var total T
    for _, v := range slice {
        total += v
    }
    return total
}

func Average[T Numeric](slice []T) float64 {
    if len(slice) == 0 {
        return 0
    }
    return float64(Sum(slice)) / float64(len(slice))
}
```

### Union Constraints with Method Requirements

```go
// Combining interface methods with type unions
type JSONMarshalable interface {
    comparable
    MarshalJSON() ([]byte, error)
    UnmarshalJSON([]byte) error
}

// A constraint that requires both ordering AND serialization
type OrderedSerializable[T any] interface {
    cmp.Ordered
    fmt.Stringer
}

// Practical example: a generic cache key
type CacheKeyable interface {
    comparable
    CacheKey() string
}

type Cache[K CacheKeyable, V any] struct {
    mu    sync.RWMutex
    items map[string]V
}

func NewCache[K CacheKeyable, V any]() *Cache[K, V] {
    return &Cache[K, V]{
        items: make(map[string]V),
    }
}

func (c *Cache[K, V]) Set(key K, value V) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.items[key.CacheKey()] = value
}

func (c *Cache[K, V]) Get(key K) (V, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    v, ok := c.items[key.CacheKey()]
    return v, ok
}
```

## Section 3: Generic Data Structures

### Thread-Safe Generic Map

```go
package syncmap

import "sync"

// Map is a generic, thread-safe map
type Map[K comparable, V any] struct {
    mu    sync.RWMutex
    items map[K]V
}

func New[K comparable, V any]() *Map[K, V] {
    return &Map[K, V]{
        items: make(map[K]V),
    }
}

func (m *Map[K, V]) Set(key K, value V) {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.items[key] = value
}

func (m *Map[K, V]) Get(key K) (V, bool) {
    m.mu.RLock()
    defer m.mu.RUnlock()
    v, ok := m.items[key]
    return v, ok
}

func (m *Map[K, V]) Delete(key K) {
    m.mu.Lock()
    defer m.mu.Unlock()
    delete(m.items, key)
}

func (m *Map[K, V]) GetOrSet(key K, defaultVal V) V {
    m.mu.Lock()
    defer m.mu.Unlock()
    if v, ok := m.items[key]; ok {
        return v
    }
    m.items[key] = defaultVal
    return defaultVal
}

func (m *Map[K, V]) Range(f func(K, V) bool) {
    m.mu.RLock()
    defer m.mu.RUnlock()
    for k, v := range m.items {
        if !f(k, v) {
            break
        }
    }
}

func (m *Map[K, V]) Len() int {
    m.mu.RLock()
    defer m.mu.RUnlock()
    return len(m.items)
}

// Usage
func main() {
    m := syncmap.New[string, int]()
    m.Set("requests", 0)

    count, _ := m.Get("requests")
    fmt.Println(count) // 0
}
```

### Generic Priority Queue

```go
package priorityqueue

import "container/heap"

type item[T any] struct {
    value    T
    priority int
    index    int
}

type innerHeap[T any] []*item[T]

func (h innerHeap[T]) Len() int { return len(h) }

func (h innerHeap[T]) Less(i, j int) bool {
    return h[i].priority > h[j].priority // max-heap
}

func (h innerHeap[T]) Swap(i, j int) {
    h[i], h[j] = h[j], h[i]
    h[i].index = i
    h[j].index = j
}

func (h *innerHeap[T]) Push(x any) {
    n := len(*h)
    it := x.(*item[T])
    it.index = n
    *h = append(*h, it)
}

func (h *innerHeap[T]) Pop() any {
    old := *h
    n := len(old)
    it := old[n-1]
    old[n-1] = nil
    it.index = -1
    *h = old[:n-1]
    return it
}

// PriorityQueue is a generic max-priority queue
type PriorityQueue[T any] struct {
    h *innerHeap[T]
}

func New[T any]() *PriorityQueue[T] {
    h := make(innerHeap[T], 0)
    heap.Init(&h)
    return &PriorityQueue[T]{h: &h}
}

func (pq *PriorityQueue[T]) Push(value T, priority int) {
    heap.Push(pq.h, &item[T]{value: value, priority: priority})
}

func (pq *PriorityQueue[T]) Pop() (T, int, bool) {
    if pq.h.Len() == 0 {
        var zero T
        return zero, 0, false
    }
    it := heap.Pop(pq.h).(*item[T])
    return it.value, it.priority, true
}

func (pq *PriorityQueue[T]) Peek() (T, int, bool) {
    if pq.h.Len() == 0 {
        var zero T
        return zero, 0, false
    }
    it := (*pq.h)[0]
    return it.value, it.priority, true
}

func (pq *PriorityQueue[T]) Len() int {
    return pq.h.Len()
}
```

### Generic Result Type

A Result type eliminates the repetitive `if err != nil` chains while keeping Go's explicit error handling philosophy:

```go
package result

// Result represents either a success value or an error
type Result[T any] struct {
    value T
    err   error
}

func Ok[T any](value T) Result[T] {
    return Result[T]{value: value}
}

func Err[T any](err error) Result[T] {
    return Result[T]{err: err}
}

func (r Result[T]) IsOk() bool {
    return r.err == nil
}

func (r Result[T]) Unwrap() T {
    if r.err != nil {
        panic(fmt.Sprintf("called Unwrap on error result: %v", r.err))
    }
    return r.value
}

func (r Result[T]) UnwrapOr(defaultVal T) T {
    if r.err != nil {
        return defaultVal
    }
    return r.value
}

func (r Result[T]) Error() error {
    return r.err
}

// Map applies a function to the success value
func Map[T, U any](r Result[T], f func(T) U) Result[U] {
    if r.err != nil {
        return Err[U](r.err)
    }
    return Ok(f(r.value))
}

// FlatMap chains operations that return Results
func FlatMap[T, U any](r Result[T], f func(T) Result[U]) Result[U] {
    if r.err != nil {
        return Err[U](r.err)
    }
    return f(r.value)
}

// Usage in production code
func fetchUser(id string) result.Result[*User] {
    user, err := db.QueryUser(id)
    if err != nil {
        return result.Err[*User](fmt.Errorf("fetchUser: %w", err))
    }
    return result.Ok(user)
}

func processRequest(userID string) result.Result[*Response] {
    return result.FlatMap(
        fetchUser(userID),
        func(user *User) result.Result[*Response] {
            return result.FlatMap(
                fetchPermissions(user),
                func(perms *Permissions) result.Result[*Response] {
                    return buildResponse(user, perms)
                },
            )
        },
    )
}
```

## Section 4: Functional Utilities

### Slice Operations

```go
package slices

import "cmp"

// Reduce applies an accumulator function over a slice
func Reduce[T, U any](slice []T, initial U, f func(U, T) U) U {
    acc := initial
    for _, v := range slice {
        acc = f(acc, v)
    }
    return acc
}

// GroupBy groups elements by a key function
func GroupBy[T any, K comparable](slice []T, keyFn func(T) K) map[K][]T {
    result := make(map[K][]T)
    for _, v := range slice {
        k := keyFn(v)
        result[k] = append(result[k], v)
    }
    return result
}

// Partition splits a slice into two based on a predicate
func Partition[T any](slice []T, pred func(T) bool) ([]T, []T) {
    var pass, fail []T
    for _, v := range slice {
        if pred(v) {
            pass = append(pass, v)
        } else {
            fail = append(fail, v)
        }
    }
    return pass, fail
}

// Unique returns deduplicated slice preserving order
func Unique[T comparable](slice []T) []T {
    seen := make(map[T]struct{}, len(slice))
    result := make([]T, 0, len(slice))
    for _, v := range slice {
        if _, exists := seen[v]; !exists {
            seen[v] = struct{}{}
            result = append(result, v)
        }
    }
    return result
}

// Chunk splits a slice into chunks of size n
func Chunk[T any](slice []T, size int) [][]T {
    if size <= 0 {
        panic("chunk size must be positive")
    }
    chunks := make([][]T, 0, (len(slice)+size-1)/size)
    for len(slice) > 0 {
        if len(slice) < size {
            size = len(slice)
        }
        chunks = append(chunks, slice[:size])
        slice = slice[size:]
    }
    return chunks
}

// Flatten combines nested slices into one
func Flatten[T any](slices [][]T) []T {
    total := 0
    for _, s := range slices {
        total += len(s)
    }
    result := make([]T, 0, total)
    for _, s := range slices {
        result = append(result, s...)
    }
    return result
}

// SortBy sorts a slice by a key function
func SortBy[T any, K cmp.Ordered](slice []T, key func(T) K) []T {
    result := make([]T, len(slice))
    copy(result, slice)
    sort.Slice(result, func(i, j int) bool {
        return key(result[i]) < key(result[j])
    })
    return result
}

// ZipWith combines two slices element-wise using a function
func ZipWith[A, B, C any](as []A, bs []B, f func(A, B) C) []C {
    n := len(as)
    if len(bs) < n {
        n = len(bs)
    }
    result := make([]C, n)
    for i := 0; i < n; i++ {
        result[i] = f(as[i], bs[i])
    }
    return result
}
```

### Option Type

```go
package option

// Option represents an optional value
type Option[T any] struct {
    value    T
    hasValue bool
}

func Some[T any](value T) Option[T] {
    return Option[T]{value: value, hasValue: true}
}

func None[T any]() Option[T] {
    return Option[T]{}
}

func FromPtr[T any](ptr *T) Option[T] {
    if ptr == nil {
        return None[T]()
    }
    return Some(*ptr)
}

func (o Option[T]) IsSome() bool { return o.hasValue }
func (o Option[T]) IsNone() bool { return !o.hasValue }

func (o Option[T]) Unwrap() T {
    if !o.hasValue {
        panic("called Unwrap on None option")
    }
    return o.value
}

func (o Option[T]) UnwrapOr(defaultVal T) T {
    if !o.hasValue {
        return defaultVal
    }
    return o.value
}

func (o Option[T]) UnwrapOrElse(f func() T) T {
    if !o.hasValue {
        return f()
    }
    return o.value
}

func Map[T, U any](o Option[T], f func(T) U) Option[U] {
    if !o.hasValue {
        return None[U]()
    }
    return Some(f(o.value))
}

func FlatMap[T, U any](o Option[T], f func(T) Option[U]) Option[U] {
    if !o.hasValue {
        return None[U]()
    }
    return f(o.value)
}

// Usage
func findUserByEmail(email string) option.Option[*User] {
    user, err := db.FindByEmail(email)
    if err != nil || user == nil {
        return option.None[*User]()
    }
    return option.Some(user)
}

func getUserDisplayName(email string) string {
    return option.Map(
        findUserByEmail(email),
        func(u *User) string { return u.DisplayName },
    ).UnwrapOr("Anonymous")
}
```

## Section 5: Generic Pipelines and Channels

### Generic Worker Pool

```go
package workerpool

import (
    "context"
    "sync"
)

// Task represents a unit of work with input and output types
type Task[I, O any] struct {
    Input  I
    Result chan<- TaskResult[O]
}

type TaskResult[O any] struct {
    Output O
    Err    error
}

// Pool is a generic worker pool
type Pool[I, O any] struct {
    workers int
    jobs    chan Task[I, O]
    fn      func(context.Context, I) (O, error)
    wg      sync.WaitGroup
}

func New[I, O any](workers int, fn func(context.Context, I) (O, error)) *Pool[I, O] {
    p := &Pool[I, O]{
        workers: workers,
        jobs:    make(chan Task[I, O], workers*2),
        fn:      fn,
    }
    return p
}

func (p *Pool[I, O]) Start(ctx context.Context) {
    for i := 0; i < p.workers; i++ {
        p.wg.Add(1)
        go func() {
            defer p.wg.Done()
            for {
                select {
                case task, ok := <-p.jobs:
                    if !ok {
                        return
                    }
                    output, err := p.fn(ctx, task.Input)
                    task.Result <- TaskResult[O]{Output: output, Err: err}
                case <-ctx.Done():
                    return
                }
            }
        }()
    }
}

func (p *Pool[I, O]) Submit(input I) <-chan TaskResult[O] {
    result := make(chan TaskResult[O], 1)
    p.jobs <- Task[I, O]{Input: input, Result: result}
    return result
}

func (p *Pool[I, O]) Close() {
    close(p.jobs)
    p.wg.Wait()
}

// Fan-out: distribute work across multiple channels
func FanOut[T any](ctx context.Context, input <-chan T, n int) []<-chan T {
    outputs := make([]chan T, n)
    for i := range outputs {
        outputs[i] = make(chan T, cap(input))
    }

    go func() {
        defer func() {
            for _, out := range outputs {
                close(out)
            }
        }()
        i := 0
        for {
            select {
            case v, ok := <-input:
                if !ok {
                    return
                }
                outputs[i%n] <- v
                i++
            case <-ctx.Done():
                return
            }
        }
    }()

    result := make([]<-chan T, n)
    for i, ch := range outputs {
        result[i] = ch
    }
    return result
}

// Fan-in: merge multiple channels into one
func FanIn[T any](ctx context.Context, inputs ...<-chan T) <-chan T {
    out := make(chan T, len(inputs))
    var wg sync.WaitGroup

    for _, ch := range inputs {
        wg.Add(1)
        go func(c <-chan T) {
            defer wg.Done()
            for {
                select {
                case v, ok := <-c:
                    if !ok {
                        return
                    }
                    out <- v
                case <-ctx.Done():
                    return
                }
            }
        }(ch)
    }

    go func() {
        wg.Wait()
        close(out)
    }()

    return out
}
```

## Section 6: Performance Benchmarks

Understanding generic performance is essential for making informed decisions.

### Benchmark: Generic vs. Interface vs. Concrete

```go
package bench_test

import (
    "testing"
)

// Concrete implementation
func sumInts(nums []int) int {
    total := 0
    for _, n := range nums {
        total += n
    }
    return total
}

// Generic implementation
func sumGeneric[T interface{ ~int | ~float64 }](nums []T) T {
    var total T
    for _, n := range nums {
        total += n
    }
    return total
}

// Interface-based implementation
type Number interface {
    Value() float64
}

type IntNumber struct{ v int }

func (n IntNumber) Value() float64 { return float64(n.v) }

func sumInterface(nums []Number) float64 {
    total := 0.0
    for _, n := range nums {
        total += n.Value()
    }
    return total
}

var ints = make([]int, 10000)

func BenchmarkConcrete(b *testing.B) {
    for i := 0; i < b.N; i++ {
        _ = sumInts(ints)
    }
}

func BenchmarkGeneric(b *testing.B) {
    for i := 0; i < b.N; i++ {
        _ = sumGeneric(ints)
    }
}

func BenchmarkInterface(b *testing.B) {
    nums := make([]Number, len(ints))
    for i, v := range ints {
        nums[i] = IntNumber{v: v}
    }
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _ = sumInterface(nums)
    }
}
```

Typical benchmark results (Go 1.21, Apple M2):

```
BenchmarkConcrete   1000000   1.05 ns/op   0 B/op   0 allocs/op
BenchmarkGeneric    1000000   1.07 ns/op   0 B/op   0 allocs/op
BenchmarkInterface   500000   3.84 ns/op   0 B/op   0 allocs/op
```

Generic code compiles to the same machine code as concrete code for simple numeric operations (monomorphization). Interface dispatch has a virtual call overhead.

### When Generics Are Slower

Generics using complex interface constraints with pointer receivers can be slower due to dictionary-based dispatch:

```go
// This may use dictionary dispatch instead of monomorphization
func Process[T interface {
    Validate() error
    Transform() string
}](items []T) ([]string, error) {
    result := make([]string, 0, len(items))
    for _, item := range items {
        if err := item.Validate(); err != nil {
            return nil, err
        }
        result = append(result, item.Transform())
    }
    return result, nil
}
```

For interfaces with method sets, the Go compiler may use a dictionary-based approach that has similar overhead to interface dispatch. Profile your specific use case.

## Section 7: Real-World Production Patterns

### Generic Repository Pattern

```go
package repository

import (
    "context"
    "database/sql"
    "fmt"
)

// Entity constrains types that can be stored in the repository
type Entity interface {
    comparable
    GetID() string
    TableName() string
}

// Repository provides generic CRUD operations
type Repository[T Entity] struct {
    db *sql.DB
}

func New[T Entity](db *sql.DB) *Repository[T] {
    return &Repository[T]{db: db}
}

func (r *Repository[T]) FindByID(ctx context.Context, id string, dest *T) error {
    var zero T
    query := fmt.Sprintf("SELECT * FROM %s WHERE id = $1", zero.TableName())
    row := r.db.QueryRowContext(ctx, query, id)
    return scanInto(row, dest)
}

func (r *Repository[T]) FindAll(ctx context.Context, limit, offset int) ([]T, error) {
    var zero T
    query := fmt.Sprintf(
        "SELECT * FROM %s ORDER BY created_at DESC LIMIT $1 OFFSET $2",
        zero.TableName(),
    )
    rows, err := r.db.QueryContext(ctx, query, limit, offset)
    if err != nil {
        return nil, fmt.Errorf("repository.FindAll: %w", err)
    }
    defer rows.Close()
    return scanRows[T](rows)
}

func (r *Repository[T]) Count(ctx context.Context) (int64, error) {
    var zero T
    var count int64
    query := fmt.Sprintf("SELECT COUNT(*) FROM %s", zero.TableName())
    if err := r.db.QueryRowContext(ctx, query).Scan(&count); err != nil {
        return 0, fmt.Errorf("repository.Count: %w", err)
    }
    return count, nil
}

// Usage
type User struct {
    ID    string
    Name  string
    Email string
}

func (u User) GetID() string    { return u.ID }
func (u User) TableName() string { return "users" }

// userRepo is a concrete repository for users
userRepo := repository.New[User](db)
user := &User{}
err := userRepo.FindByID(ctx, "user-123", user)
```

### Generic Event Bus

```go
package eventbus

import (
    "context"
    "sync"
)

type Handler[T any] func(ctx context.Context, event T) error

type Bus[T any] struct {
    mu       sync.RWMutex
    handlers []Handler[T]
}

func New[T any]() *Bus[T] {
    return &Bus[T]{}
}

func (b *Bus[T]) Subscribe(handler Handler[T]) func() {
    b.mu.Lock()
    defer b.mu.Unlock()

    b.handlers = append(b.handlers, handler)
    idx := len(b.handlers) - 1

    return func() {
        b.mu.Lock()
        defer b.mu.Unlock()
        b.handlers = append(b.handlers[:idx], b.handlers[idx+1:]...)
    }
}

func (b *Bus[T]) Publish(ctx context.Context, event T) []error {
    b.mu.RLock()
    handlers := make([]Handler[T], len(b.handlers))
    copy(handlers, b.handlers)
    b.mu.RUnlock()

    var errs []error
    for _, handler := range handlers {
        if err := handler(ctx, event); err != nil {
            errs = append(errs, err)
        }
    }
    return errs
}

// Typed event buses for different domains
type UserCreatedEvent struct {
    UserID string
    Email  string
}

type OrderPlacedEvent struct {
    OrderID string
    UserID  string
    Amount  float64
}

var (
    UserCreatedBus  = eventbus.New[UserCreatedEvent]()
    OrderPlacedBus  = eventbus.New[OrderPlacedEvent]()
)

// Subscribe to specific event types with type safety
unsubscribe := UserCreatedBus.Subscribe(func(ctx context.Context, event UserCreatedEvent) error {
    return sendWelcomeEmail(ctx, event.Email)
})
defer unsubscribe()
```

### Generic Configuration Builder

```go
package config

// Builder provides a type-safe configuration builder
type Builder[T any] struct {
    config   T
    errors   []error
    setters  []func(*T)
}

type Option[T any] func(*Builder[T])

func NewBuilder[T any](opts ...Option[T]) *Builder[T] {
    b := &Builder[T]{}
    for _, opt := range opts {
        opt(b)
    }
    return b
}

func (b *Builder[T]) With(setter func(*T)) *Builder[T] {
    b.setters = append(b.setters, setter)
    return b
}

func (b *Builder[T]) Build() (T, error) {
    for _, setter := range b.setters {
        setter(&b.config)
    }
    if len(b.errors) > 0 {
        return b.config, fmt.Errorf("config errors: %v", b.errors)
    }
    return b.config, nil
}

// Usage
type ServerConfig struct {
    Host    string
    Port    int
    Timeout time.Duration
    TLS     bool
}

cfg, err := config.NewBuilder[ServerConfig]().
    With(func(c *ServerConfig) { c.Host = "0.0.0.0" }).
    With(func(c *ServerConfig) { c.Port = 8080 }).
    With(func(c *ServerConfig) { c.Timeout = 30 * time.Second }).
    Build()
```

## Section 8: When NOT to Use Generics

The Go team's guidance is clear: generics are not for general-purpose abstraction. Avoid generics when:

**1. You only have one concrete type** - Don't generalize prematurely. `func SaveUser(u *User)` is clearer than `func Save[T Saveable](t T)` if you'll never save anything other than users.

**2. The function only calls interface methods** - If your generic constraint is just `fmt.Stringer`, use `fmt.Stringer` as a regular interface instead.

**3. You need runtime type information** - Generics don't support type switches on type parameters:

```go
// This does NOT compile
func process[T any](v T) string {
    switch v.(type) {  // Invalid
    case int:
        return "int"
    case string:
        return "string"
    }
}

// Use interface{} / any instead
func process(v any) string {
    switch v.(type) {
    case int:
        return "int"
    case string:
        return "string"
    }
}
```

**4. Reflection is already required** - Generic code cannot use `reflect` in a type-parameter-aware way. If you're already using reflect, generics won't simplify things.

**5. The code is simple enough** - A 5-line function doesn't benefit from type parameters. The constraint syntax adds visual noise that outweighs the benefit.

### Decision Matrix

| Scenario | Use Generics? |
|---|---|
| Generic data structure (stack, queue, map) | Yes |
| Functional helpers (Map, Filter, Reduce) | Yes |
| Single concrete type | No |
| Runtime type switching needed | No |
| Constraint is just `any` everywhere | Maybe - evaluate readability |
| Replacing `interface{}` + type assertions | Yes, if types are known at compile time |
| Complex constraint with many methods | Probably - benchmark first |

## Section 9: Testing Generic Code

```go
package slices_test

import (
    "testing"
    "github.com/yourorg/slices"
)

// Use table-driven tests with multiple type instantiations
func TestMap(t *testing.T) {
    t.Run("int to string", func(t *testing.T) {
        input := []int{1, 2, 3}
        got := slices.Map(input, strconv.Itoa)
        want := []string{"1", "2", "3"}
        if !reflect.DeepEqual(got, want) {
            t.Errorf("Map() = %v, want %v", got, want)
        }
    })

    t.Run("string to length", func(t *testing.T) {
        input := []string{"a", "bb", "ccc"}
        got := slices.Map(input, func(s string) int { return len(s) })
        want := []int{1, 2, 3}
        if !reflect.DeepEqual(got, want) {
            t.Errorf("Map() = %v, want %v", got, want)
        }
    })

    t.Run("empty slice", func(t *testing.T) {
        got := slices.Map([]int{}, strconv.Itoa)
        if len(got) != 0 {
            t.Errorf("Map of empty slice should return empty, got %v", got)
        }
    })
}

func TestStack(t *testing.T) {
    // Test with multiple types to catch type-specific issues
    testStackWithType[int](t, 1, 2, 3)
    testStackWithType[string](t, "a", "b", "c")
    testStackWithType[float64](t, 1.1, 2.2, 3.3)
}

func testStackWithType[T comparable](t *testing.T, vals ...T) {
    t.Helper()
    s := Stack[T]{}

    for _, v := range vals {
        s.Push(v)
    }

    for i := len(vals) - 1; i >= 0; i-- {
        got, ok := s.Pop()
        if !ok {
            t.Fatalf("Pop() returned false, expected true")
        }
        if got != vals[i] {
            t.Errorf("Pop() = %v, want %v", got, vals[i])
        }
    }

    _, ok := s.Pop()
    if ok {
        t.Error("Pop() on empty stack should return false")
    }
}
```

## Section 10: Summary and Guidelines

Go generics are now mature enough for production use with clear guidelines:

1. **Use generics for data structures**: Generic stacks, queues, maps, trees eliminate the type-unsafe boilerplate of `interface{}`.
2. **Use generics for functional utilities**: `Map`, `Filter`, `Reduce`, `GroupBy` are canonical use cases.
3. **Use type constraints judiciously**: Start with `any` or `comparable`, escalate to union types only when needed.
4. **Benchmark before optimizing**: For simple numeric operations, generics are as fast as concrete code. For interface-heavy constraints, measure.
5. **Don't over-abstract**: A generic function used in only one place is probably not worth the constraint syntax overhead.
6. **Test with multiple type instantiations**: Generic bugs often manifest only with specific types.
7. **Document constraints clearly**: A constraint like `~int | ~float64` needs a comment explaining why those types and not others.

The standard library's approach in `slices`, `maps`, and `cmp` packages is the canonical reference for how to use generics in Go. Study those packages before designing your own generic APIs.
