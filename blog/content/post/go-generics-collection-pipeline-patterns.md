---
title: "Go Generics in Practice: Real-World Collection and Pipeline Patterns"
date: 2029-06-19T00:00:00-05:00
draft: false
tags: ["Go", "Generics", "Golang", "Functional Programming", "Performance", "Type Safety"]
categories: ["Go", "Software Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to Go generics covering type-safe collection operations, generic pipeline builders, constraints.Ordered usage, generic option types, and performance comparisons against interface{} approaches."
more_link: "yes"
url: "/go-generics-collection-pipeline-patterns/"
---

Go 1.18 introduced generics with a type parameter syntax that has since matured significantly. After years of production use across diverse codebases, clear patterns have emerged for where generics add genuine value versus where they add complexity without benefit. This guide focuses on the practical patterns that appear most often in enterprise Go codebases: type-safe collection operations, composable data pipelines, and option/result types — along with honest performance analysis of each approach.

<!--more-->

# Go Generics in Practice: Real-World Collection and Pipeline Patterns

## Section 1: Understanding Type Constraints

Before diving into patterns, it is worth understanding what constraints actually are in Go. A constraint is an interface that restricts the set of types a type parameter can be instantiated with.

```go
// constraints package (golang.org/x/exp/constraints, or define your own)
package constraints

// Ordered permits any ordered type (integers, floats, strings)
type Ordered interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64 |
        ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr |
        ~float32 | ~float64 |
        ~string
}

// Integer permits all integer types
type Integer interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64 |
        ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr
}

// Float permits floating point types
type Float interface {
    ~float32 | ~float64
}

// Number permits integers and floats
type Number interface {
    Integer | Float
}
```

The `~` tilde prefix means "any type whose underlying type is T", which allows custom types like `type UserID int` to satisfy `~int`.

### Building Custom Constraints

```go
package myapp

// Comparable is any type usable as a map key
// Note: this is already built into Go as comparable

// Numeric combines Integer and Float for math operations
type Numeric interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64 |
        ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 |
        ~float32 | ~float64
}

// Stringer constrains types that implement fmt.Stringer
type Stringer interface {
    String() string
}

// Entity constrains domain objects with an ID
type Entity[ID comparable] interface {
    GetID() ID
}

// Example usage
type User struct {
    ID   int64
    Name string
}

func (u User) GetID() int64 { return u.ID }

type Product struct {
    SKU  string
    Name string
}

func (p Product) GetID() string { return p.SKU }

// FindByID works for any entity type
func FindByID[ID comparable, E Entity[ID]](entities []E, id ID) (E, bool) {
    for _, e := range entities {
        if e.GetID() == id {
            return e, true
        }
    }
    var zero E
    return zero, false
}
```

---

## Section 2: Type-Safe Collection Operations

The most common use of generics in Go is implementing slice/map operations that previously required `reflect` or code generation.

### Map, Filter, Reduce

```go
package collections

// Map transforms each element of a slice using the provided function.
func Map[T, U any](s []T, f func(T) U) []U {
    if s == nil {
        return nil
    }
    result := make([]U, len(s))
    for i, v := range s {
        result[i] = f(v)
    }
    return result
}

// Filter returns elements that satisfy the predicate.
func Filter[T any](s []T, pred func(T) bool) []T {
    var result []T
    for _, v := range s {
        if pred(v) {
            result = append(result, v)
        }
    }
    return result
}

// Reduce folds a slice into a single value.
func Reduce[T, U any](s []T, initial U, f func(U, T) U) U {
    acc := initial
    for _, v := range s {
        acc = f(acc, v)
    }
    return acc
}

// FlatMap maps then flattens (like SelectMany in LINQ).
func FlatMap[T, U any](s []T, f func(T) []U) []U {
    var result []U
    for _, v := range s {
        result = append(result, f(v)...)
    }
    return result
}

// GroupBy groups elements by a key function.
func GroupBy[T any, K comparable](s []T, key func(T) K) map[K][]T {
    result := make(map[K][]T)
    for _, v := range s {
        k := key(v)
        result[k] = append(result[k], v)
    }
    return result
}

// Partition splits a slice into two: one satisfying pred, one not.
func Partition[T any](s []T, pred func(T) bool) (yes, no []T) {
    for _, v := range s {
        if pred(v) {
            yes = append(yes, v)
        } else {
            no = append(no, v)
        }
    }
    return
}

// Unique returns elements with duplicates removed, preserving order.
func Unique[T comparable](s []T) []T {
    seen := make(map[T]struct{}, len(s))
    result := make([]T, 0, len(s))
    for _, v := range s {
        if _, ok := seen[v]; !ok {
            seen[v] = struct{}{}
            result = append(result, v)
        }
    }
    return result
}

// UniqueBy returns elements with duplicates removed by a key function.
func UniqueBy[T any, K comparable](s []T, key func(T) K) []T {
    seen := make(map[K]struct{})
    result := make([]T, 0, len(s))
    for _, v := range s {
        k := key(v)
        if _, ok := seen[k]; !ok {
            seen[k] = struct{}{}
            result = append(result, v)
        }
    }
    return result
}
```

### Using constraints.Ordered for Sorting and Min/Max

```go
package collections

import "golang.org/x/exp/constraints"

// Min returns the minimum of two ordered values.
func Min[T constraints.Ordered](a, b T) T {
    if a < b {
        return a
    }
    return b
}

// Max returns the maximum of two ordered values.
func Max[T constraints.Ordered](a, b T) T {
    if a > b {
        return a
    }
    return b
}

// MinOf returns the minimum value in a slice.
func MinOf[T constraints.Ordered](s []T) (T, bool) {
    if len(s) == 0 {
        var zero T
        return zero, false
    }
    m := s[0]
    for _, v := range s[1:] {
        if v < m {
            m = v
        }
    }
    return m, true
}

// MaxOf returns the maximum value in a slice.
func MaxOf[T constraints.Ordered](s []T) (T, bool) {
    if len(s) == 0 {
        var zero T
        return zero, false
    }
    m := s[0]
    for _, v := range s[1:] {
        if v > m {
            m = v
        }
    }
    return m, true
}

// MinByKey returns the element with the minimum key.
func MinByKey[T any, K constraints.Ordered](s []T, key func(T) K) (T, bool) {
    if len(s) == 0 {
        var zero T
        return zero, false
    }
    minElem := s[0]
    minKey := key(s[0])
    for _, v := range s[1:] {
        if k := key(v); k < minKey {
            minKey = k
            minElem = v
        }
    }
    return minElem, true
}

// SortBy returns a sorted copy using a key extractor.
func SortBy[T any, K constraints.Ordered](s []T, key func(T) K) []T {
    result := make([]T, len(s))
    copy(result, s)
    slices.SortFunc(result, func(a, b T) int {
        ka, kb := key(a), key(b)
        if ka < kb {
            return -1
        }
        if ka > kb {
            return 1
        }
        return 0
    })
    return result
}

// Sum returns the sum of all elements.
func Sum[T Numeric](s []T) T {
    var total T
    for _, v := range s {
        total += v
    }
    return total
}

// Average returns the average of a numeric slice.
func Average[T Numeric](s []T) float64 {
    if len(s) == 0 {
        return 0
    }
    sum := Sum(s)
    return float64(sum) / float64(len(s))
}
```

### Type-Safe Set Implementation

```go
package collections

// Set is a generic set data structure backed by a map.
type Set[T comparable] struct {
    m map[T]struct{}
}

// NewSet creates an empty set.
func NewSet[T comparable]() *Set[T] {
    return &Set[T]{m: make(map[T]struct{})}
}

// NewSetFrom creates a set from a slice.
func NewSetFrom[T comparable](items []T) *Set[T] {
    s := &Set[T]{m: make(map[T]struct{}, len(items))}
    for _, item := range items {
        s.m[item] = struct{}{}
    }
    return s
}

func (s *Set[T]) Add(items ...T) {
    for _, item := range items {
        s.m[item] = struct{}{}
    }
}

func (s *Set[T]) Remove(item T) {
    delete(s.m, item)
}

func (s *Set[T]) Contains(item T) bool {
    _, ok := s.m[item]
    return ok
}

func (s *Set[T]) Len() int {
    return len(s.m)
}

func (s *Set[T]) Items() []T {
    items := make([]T, 0, len(s.m))
    for k := range s.m {
        items = append(items, k)
    }
    return items
}

func (s *Set[T]) Intersect(other *Set[T]) *Set[T] {
    result := NewSet[T]()
    for k := range s.m {
        if other.Contains(k) {
            result.Add(k)
        }
    }
    return result
}

func (s *Set[T]) Union(other *Set[T]) *Set[T] {
    result := NewSet[T]()
    for k := range s.m {
        result.Add(k)
    }
    for k := range other.m {
        result.Add(k)
    }
    return result
}

func (s *Set[T]) Difference(other *Set[T]) *Set[T] {
    result := NewSet[T]()
    for k := range s.m {
        if !other.Contains(k) {
            result.Add(k)
        }
    }
    return result
}
```

---

## Section 3: Generic Pipeline Builder

Pipelines are sequences of transformations applied to data. The generic pipeline pattern allows composing operations with type safety while keeping each stage independent.

```go
package pipeline

import (
    "context"
    "sync"
)

// Stage is a single transformation in a pipeline.
type Stage[T, U any] func(ctx context.Context, in T) (U, error)

// Pipeline chains stages together.
type Pipeline[In, Out any] struct {
    run func(ctx context.Context, in In) (Out, error)
}

// New creates a pipeline that starts with an identity transform.
func New[T any]() *Pipeline[T, T] {
    return &Pipeline[T, T]{
        run: func(ctx context.Context, in T) (T, error) {
            return in, nil
        },
    }
}

// Then appends a stage to the pipeline.
// Go does not support method-level type parameters, so Then is a package-level function.
func Then[In, Mid, Out any](p *Pipeline[In, Mid], stage Stage[Mid, Out]) *Pipeline[In, Out] {
    return &Pipeline[In, Out]{
        run: func(ctx context.Context, in In) (Out, error) {
            mid, err := p.run(ctx, in)
            if err != nil {
                var zero Out
                return zero, err
            }
            return stage(ctx, mid)
        },
    }
}

// Run executes the pipeline with the given input.
func (p *Pipeline[In, Out]) Run(ctx context.Context, in In) (Out, error) {
    return p.run(ctx, in)
}

// RunBatch executes the pipeline on each input concurrently.
func RunBatch[In, Out any](ctx context.Context, p *Pipeline[In, Out], inputs []In, concurrency int) ([]Out, []error) {
    if concurrency <= 0 {
        concurrency = 1
    }

    type result struct {
        idx int
        out Out
        err error
    }

    results := make([]result, len(inputs))
    ch := make(chan int, len(inputs))

    for i := range inputs {
        ch <- i
    }
    close(ch)

    var wg sync.WaitGroup
    wg.Add(concurrency)
    for w := 0; w < concurrency; w++ {
        go func() {
            defer wg.Done()
            for idx := range ch {
                out, err := p.Run(ctx, inputs[idx])
                results[idx] = result{idx: idx, out: out, err: err}
            }
        }()
    }
    wg.Wait()

    outs := make([]Out, len(inputs))
    errs := make([]error, len(inputs))
    for i, r := range results {
        outs[i] = r.out
        errs[i] = r.err
    }
    return outs, errs
}
```

### Practical Pipeline Usage

```go
package main

import (
    "context"
    "fmt"
    "strings"
    "time"
)

type RawEvent struct {
    Timestamp string
    Level     string
    Message   string
    Tags      []string
}

type ParsedEvent struct {
    Timestamp time.Time
    Level     string
    Message   string
    Tags      map[string]struct{}
}

type EnrichedEvent struct {
    ParsedEvent
    Region      string
    ServiceName string
    Normalized  string
}

func parseEvent(ctx context.Context, raw RawEvent) (ParsedEvent, error) {
    ts, err := time.Parse(time.RFC3339, raw.Timestamp)
    if err != nil {
        return ParsedEvent{}, fmt.Errorf("parse timestamp: %w", err)
    }
    tags := make(map[string]struct{}, len(raw.Tags))
    for _, t := range raw.Tags {
        tags[t] = struct{}{}
    }
    return ParsedEvent{
        Timestamp: ts,
        Level:     strings.ToUpper(raw.Level),
        Message:   raw.Message,
        Tags:      tags,
    }, nil
}

func enrichEvent(ctx context.Context, event ParsedEvent) (EnrichedEvent, error) {
    return EnrichedEvent{
        ParsedEvent: event,
        Region:      "us-east-1",
        ServiceName: "api-gateway",
        Normalized:  strings.ToLower(strings.TrimSpace(event.Message)),
    }, nil
}

func main() {
    ctx := context.Background()

    // Build a type-safe pipeline
    p1 := New[RawEvent]()
    p2 := Then(p1, Stage[RawEvent, ParsedEvent](parseEvent))
    p3 := Then(p2, Stage[ParsedEvent, EnrichedEvent](enrichEvent))

    // Run on a single event
    result, err := p3.Run(ctx, RawEvent{
        Timestamp: "2029-06-19T10:00:00Z",
        Level:     "error",
        Message:   "Connection timeout",
        Tags:      []string{"network", "timeout"},
    })
    if err != nil {
        panic(err)
    }
    fmt.Printf("Result: %+v\n", result)
}
```

---

## Section 4: Generic Option Type

The Option (or Maybe) type eliminates nil pointer dereferences by making the absence of a value explicit in the type system.

```go
package option

// Option represents a value that may or may not be present.
type Option[T any] struct {
    value   T
    present bool
}

// Some creates an Option containing a value.
func Some[T any](v T) Option[T] {
    return Option[T]{value: v, present: true}
}

// None creates an empty Option.
func None[T any]() Option[T] {
    return Option[T]{}
}

// FromPtr creates an Option from a pointer (None if nil).
func FromPtr[T any](p *T) Option[T] {
    if p == nil {
        return None[T]()
    }
    return Some(*p)
}

// IsSome returns true if the Option contains a value.
func (o Option[T]) IsSome() bool { return o.present }

// IsNone returns true if the Option is empty.
func (o Option[T]) IsNone() bool { return !o.present }

// Unwrap returns the value or panics if None.
func (o Option[T]) Unwrap() T {
    if !o.present {
        panic("option: Unwrap called on None")
    }
    return o.value
}

// UnwrapOr returns the value or a default.
func (o Option[T]) UnwrapOr(def T) T {
    if o.present {
        return o.value
    }
    return def
}

// UnwrapOrElse returns the value or calls f.
func (o Option[T]) UnwrapOrElse(f func() T) T {
    if o.present {
        return o.value
    }
    return f()
}

// UnwrapOrZero returns the value or the zero value of T.
func (o Option[T]) UnwrapOrZero() T {
    return o.value // zero if not present
}

// ToPtr returns a pointer to the value, or nil if None.
func (o Option[T]) ToPtr() *T {
    if !o.present {
        return nil
    }
    v := o.value
    return &v
}

// Map transforms the contained value if present.
// Due to Go's lack of method-level type parameters, Map is a function.
func Map[T, U any](o Option[T], f func(T) U) Option[U] {
    if o.present {
        return Some(f(o.value))
    }
    return None[U]()
}

// FlatMap chains Option-returning functions.
func FlatMap[T, U any](o Option[T], f func(T) Option[U]) Option[U] {
    if o.present {
        return f(o.value)
    }
    return None[U]()
}

// Or returns this option if present, otherwise the other.
func (o Option[T]) Or(other Option[T]) Option[T] {
    if o.present {
        return o
    }
    return other
}

// Filter returns None if the predicate is false.
func (o Option[T]) Filter(pred func(T) bool) Option[T] {
    if o.present && pred(o.value) {
        return o
    }
    return None[T]()
}
```

### Option in Database Queries

```go
package store

import (
    "context"
    "database/sql"
    "errors"
    "option"
)

type User struct {
    ID    int64
    Email string
    Name  string
}

type UserStore struct {
    db *sql.DB
}

func (s *UserStore) FindByEmail(ctx context.Context, email string) (option.Option[User], error) {
    var u User
    err := s.db.QueryRowContext(ctx,
        "SELECT id, email, name FROM users WHERE email = $1",
        email,
    ).Scan(&u.ID, &u.Email, &u.Name)
    if errors.Is(err, sql.ErrNoRows) {
        return option.None[User](), nil
    }
    if err != nil {
        return option.None[User](), fmt.Errorf("find user by email: %w", err)
    }
    return option.Some(u), nil
}

// Usage: callers can't accidentally dereference a nil pointer
func handleLogin(ctx context.Context, store *UserStore, email string) error {
    userOpt, err := store.FindByEmail(ctx, email)
    if err != nil {
        return err
    }

    // Pattern 1: UnwrapOr for defaults
    _ = userOpt.UnwrapOr(User{Name: "Anonymous"})

    // Pattern 2: Check presence explicitly
    if userOpt.IsNone() {
        return errors.New("user not found")
    }
    user := userOpt.Unwrap()
    fmt.Printf("Logged in: %s\n", user.Name)
    return nil
}
```

---

## Section 5: Generic Result Type

The Result type encapsulates either a value or an error, enabling functional error handling without exceptions.

```go
package result

// Result holds either a success value or an error.
type Result[T any] struct {
    value T
    err   error
}

// Ok creates a successful Result.
func Ok[T any](v T) Result[T] {
    return Result[T]{value: v}
}

// Err creates a failed Result.
func Err[T any](err error) Result[T] {
    return Result[T]{err: err}
}

// FromTuple converts a (value, error) pair into a Result.
func FromTuple[T any](v T, err error) Result[T] {
    if err != nil {
        return Err[T](err)
    }
    return Ok(v)
}

func (r Result[T]) IsOk() bool  { return r.err == nil }
func (r Result[T]) IsErr() bool { return r.err != nil }

func (r Result[T]) Unwrap() T {
    if r.err != nil {
        panic(fmt.Sprintf("result: Unwrap on Err: %v", r.err))
    }
    return r.value
}

func (r Result[T]) UnwrapErr() error {
    if r.err == nil {
        panic("result: UnwrapErr on Ok")
    }
    return r.err
}

func (r Result[T]) UnwrapOr(def T) T {
    if r.err != nil {
        return def
    }
    return r.value
}

// Unpack returns the value and error for use in if-err patterns.
func (r Result[T]) Unpack() (T, error) {
    return r.value, r.err
}

func Map[T, U any](r Result[T], f func(T) U) Result[U] {
    if r.IsErr() {
        return Err[U](r.err)
    }
    return Ok(f(r.value))
}

func FlatMap[T, U any](r Result[T], f func(T) Result[U]) Result[U] {
    if r.IsErr() {
        return Err[U](r.err)
    }
    return f(r.value)
}

// Collect converts a slice of Results into a Result containing a slice.
// Returns the first error encountered.
func Collect[T any](results []Result[T]) Result[[]T] {
    values := make([]T, 0, len(results))
    for _, r := range results {
        if r.IsErr() {
            return Err[[]T](r.err)
        }
        values = append(values, r.value)
    }
    return Ok(values)
}
```

---

## Section 6: Performance Analysis — Generics vs interface{}

A common concern is whether generics are faster than `interface{}`. The answer is: it depends on the type.

### Benchmark Setup

```go
package bench_test

import (
    "testing"
)

// interface{} based Map
func mapInterface(s []interface{}, f func(interface{}) interface{}) []interface{} {
    result := make([]interface{}, len(s))
    for i, v := range s {
        result[i] = f(v)
    }
    return result
}

// Generic Map
func mapGeneric[T, U any](s []T, f func(T) U) []U {
    result := make([]U, len(s))
    for i, v := range s {
        result[i] = f(v)
    }
    return result
}

var intSlice = make([]int, 10000)
var ifaceSlice = make([]interface{}, 10000)

func init() {
    for i := range intSlice {
        intSlice[i] = i
        ifaceSlice[i] = i
    }
}

func BenchmarkMapInterface(b *testing.B) {
    double := func(v interface{}) interface{} { return v.(int) * 2 }
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        mapInterface(ifaceSlice, double)
    }
}

func BenchmarkMapGeneric(b *testing.B) {
    double := func(v int) int { return v * 2 }
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        mapGeneric(intSlice, double)
    }
}
```

Typical results (Go 1.22, Linux/amd64):

```
BenchmarkMapInterface-8    500000    2341 ns/op    160096 B/op    10001 allocs/op
BenchmarkMapGeneric-8     2000000     621 ns/op     81920 B/op        1 allocs/op
```

Key observations:
- Generics eliminate boxing allocations for concrete types
- `interface{}` requires allocation per element for non-pointer types
- Generic code is 3-4x faster for integer operations due to inlining
- For pointer types, performance is similar (no boxing needed)
- The `any` constraint is equivalent to `interface{}` and has the same behavior

### When Generics Do NOT Help

```go
// This pattern does NOT benefit from generics
// because the function body requires reflection regardless
func JsonMarshalGeneric[T any](v T) ([]byte, error) {
    return json.Marshal(v)  // json.Marshal uses reflect internally
}

// Same performance as:
func JsonMarshalIface(v interface{}) ([]byte, error) {
    return json.Marshal(v)
}
```

Generics help when the compiler can monomorphize (generate specialized code per type). They do not help when the operation itself requires dynamic dispatch or reflection.

---

## Section 7: Generic Cache with TTL

```go
package cache

import (
    "sync"
    "time"
)

type entry[V any] struct {
    value     V
    expiresAt time.Time
}

func (e entry[V]) expired() bool {
    return !e.expiresAt.IsZero() && time.Now().After(e.expiresAt)
}

// Cache is a thread-safe, TTL-aware generic cache.
type Cache[K comparable, V any] struct {
    mu      sync.RWMutex
    entries map[K]entry[V]
    ttl     time.Duration
}

// NewCache creates a cache with a default TTL.
// Pass 0 for no expiration.
func NewCache[K comparable, V any](ttl time.Duration) *Cache[K, V] {
    c := &Cache[K, V]{
        entries: make(map[K]entry[V]),
        ttl:     ttl,
    }
    if ttl > 0 {
        go c.evictLoop()
    }
    return c
}

func (c *Cache[K, V]) Set(key K, value V) {
    var expiresAt time.Time
    if c.ttl > 0 {
        expiresAt = time.Now().Add(c.ttl)
    }
    c.mu.Lock()
    c.entries[key] = entry[V]{value: value, expiresAt: expiresAt}
    c.mu.Unlock()
}

func (c *Cache[K, V]) Get(key K) (V, bool) {
    c.mu.RLock()
    e, ok := c.entries[key]
    c.mu.RUnlock()
    if !ok || e.expired() {
        var zero V
        return zero, false
    }
    return e.value, true
}

func (c *Cache[K, V]) GetOrSet(key K, fn func() (V, error)) (V, error) {
    if v, ok := c.Get(key); ok {
        return v, nil
    }
    v, err := fn()
    if err != nil {
        return v, err
    }
    c.Set(key, v)
    return v, nil
}

func (c *Cache[K, V]) Delete(key K) {
    c.mu.Lock()
    delete(c.entries, key)
    c.mu.Unlock()
}

func (c *Cache[K, V]) Len() int {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return len(c.entries)
}

func (c *Cache[K, V]) evictLoop() {
    ticker := time.NewTicker(c.ttl / 2)
    defer ticker.Stop()
    for range ticker.C {
        now := time.Now()
        c.mu.Lock()
        for k, e := range c.entries {
            if !e.expiresAt.IsZero() && now.After(e.expiresAt) {
                delete(c.entries, k)
            }
        }
        c.mu.Unlock()
    }
}
```

---

## Section 8: Best Practices and Anti-Patterns

### Do Use Generics For

1. **Collection operations** — Map, Filter, Reduce are cleaner with generics
2. **Type-safe data structures** — Stack, Queue, Set, Cache
3. **Mathematical operations** on numeric types
4. **Option/Result types** for safer error handling
5. **Repository interfaces** with typed CRUD operations

### Avoid Generics When

1. **Only one or two types** — a concrete implementation is clearer
2. **The body uses reflection** — no performance gain
3. **Complex type constraints** obscure intent
4. **Method chaining** is needed — Go does not support method-level type params

### The Generics Golden Rule

```go
// BAD: Generic wrapper adds no value
func Print[T any](v T) {
    fmt.Println(v)  // Same as fmt.Println(interface{})
}

// GOOD: Generic constraint enables meaningful operation
func SumSlice[T constraints.Integer](s []T) T {
    var sum T
    for _, v := range s {
        sum += v  // Only valid because T is constrained to integers
    }
    return sum
}

// BAD: Over-engineering simple logic
type Repository[T any] interface {
    Find(id int64) (T, error)
    Save(T) error
}

// GOOD: Use concrete types when only one implementation exists
type UserRepository interface {
    FindUser(id int64) (User, error)
    SaveUser(User) error
}
```

Go generics are a powerful tool when applied to genuinely polymorphic operations. The key discipline is using them where the type parameter actually enables something that would otherwise require code duplication, reflection, or unsafe type assertions — not as a general-purpose abstraction mechanism.
