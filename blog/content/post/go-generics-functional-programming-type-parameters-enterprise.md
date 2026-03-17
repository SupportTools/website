---
title: "Go Generics: Functional Programming Patterns with Type Parameters"
date: 2029-02-25T00:00:00-05:00
draft: false
tags: ["Go", "Generics", "Functional Programming", "Type Parameters", "Patterns"]
categories:
- Go
- Development
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Go generics focusing on functional programming patterns — Map, Filter, Reduce, Option types, Result types, and composable data transformation pipelines using type parameters and type constraints."
more_link: "yes"
url: "/go-generics-functional-programming-type-parameters-enterprise/"
---

Go generics, introduced in Go 1.18, enable type-safe abstractions that previously required either code generation, interface{} boxing, or copy-paste duplication. The functional programming patterns that generics enable — Map, Filter, Reduce, and their compositions — are particularly valuable for data transformation pipelines, where strong typing catches entire classes of bugs at compile time rather than at runtime.

This guide focuses on practical functional patterns that improve code safety and readability in production Go systems: type-parameterized collections, Option and Result types for explicit error handling, and composable transformation pipelines that leverage the Go type system rather than fighting it.

<!--more-->

## Type Constraints: The Foundation

Type constraints define the set of types that a type parameter may be instantiated with. Understanding constraints is prerequisite to writing useful generic code.

```go
package constraints

import "golang.org/x/exp/constraints"

// Ordered is the set of types that support < > <= >= comparisons.
// This is defined in golang.org/x/exp/constraints and will be in the
// standard library in a future Go version.
type Ordered interface {
    constraints.Integer | constraints.Float | ~string
}

// Number is the set of numeric types.
type Number interface {
    constraints.Integer | constraints.Float
}

// Comparable is any type that supports == and != (all Go types, effectively).
// The built-in comparable constraint is used for map keys.

// Stringer is any type with a String() method.
type Stringer interface {
    String() string
}

// MapKey is the constraint for types usable as map keys.
// Equivalent to the built-in comparable.
type MapKey = comparable

// Cloneable is a type that can produce a deep copy of itself.
type Cloneable[T any] interface {
    Clone() T
}

// Validator is a type that can validate itself.
type Validator interface {
    Validate() error
}

// Example: generic Min function works on any ordered type.
func Min[T Ordered](a, b T) T {
    if a < b {
        return a
    }
    return b
}

// Clamp restricts a value to a range.
func Clamp[T Ordered](val, lo, hi T) T {
    return Max(lo, Min(val, hi))
}

func Max[T Ordered](a, b T) T {
    if a > b {
        return a
    }
    return b
}
```

## Map, Filter, Reduce

These three functions form the foundation of functional data transformation.

```go
package fp

// Map transforms each element of a slice by applying fn.
func Map[I, O any](s []I, fn func(I) O) []O {
    result := make([]O, len(s))
    for i, v := range s {
        result[i] = fn(v)
    }
    return result
}

// MapErr is like Map but fn may return an error.
// Returns the first error encountered.
func MapErr[I, O any](s []I, fn func(I) (O, error)) ([]O, error) {
    result := make([]O, 0, len(s))
    for _, v := range s {
        out, err := fn(v)
        if err != nil {
            return nil, err
        }
        result = append(result, out)
    }
    return result, nil
}

// Filter returns elements of s for which pred returns true.
func Filter[T any](s []T, pred func(T) bool) []T {
    result := make([]T, 0)
    for _, v := range s {
        if pred(v) {
            result = append(result, v)
        }
    }
    return result
}

// Reduce aggregates a slice into a single value.
// initial is the starting accumulator value.
func Reduce[T, A any](s []T, initial A, fn func(A, T) A) A {
    acc := initial
    for _, v := range s {
        acc = fn(acc, v)
    }
    return acc
}

// FlatMap applies fn to each element and concatenates the results.
func FlatMap[I, O any](s []I, fn func(I) []O) []O {
    result := make([]O, 0, len(s))
    for _, v := range s {
        result = append(result, fn(v)...)
    }
    return result
}

// GroupBy partitions a slice into a map keyed by the result of fn.
func GroupBy[T any, K comparable](s []T, fn func(T) K) map[K][]T {
    result := make(map[K][]T)
    for _, v := range s {
        k := fn(v)
        result[k] = append(result[k], v)
    }
    return result
}

// Partition splits a slice into two slices: those for which pred is true,
// and those for which it is false.
func Partition[T any](s []T, pred func(T) bool) (truthy, falsy []T) {
    for _, v := range s {
        if pred(v) {
            truthy = append(truthy, v)
        } else {
            falsy = append(falsy, v)
        }
    }
    return
}

// Chunk splits a slice into chunks of at most size n.
func Chunk[T any](s []T, n int) [][]T {
    if n <= 0 {
        panic("chunk size must be positive")
    }
    result := make([][]T, 0, (len(s)+n-1)/n)
    for len(s) > 0 {
        if len(s) < n {
            n = len(s)
        }
        result = append(result, s[:n])
        s = s[n:]
    }
    return result
}

// Zip combines two slices into a slice of pairs.
// The result length equals the length of the shorter input.
func Zip[A, B any](as []A, bs []B) []Pair[A, B] {
    n := min(len(as), len(bs))
    result := make([]Pair[A, B], n)
    for i := 0; i < n; i++ {
        result[i] = Pair[A, B]{First: as[i], Second: bs[i]}
    }
    return result
}

type Pair[A, B any] struct {
    First  A
    Second B
}

func min(a, b int) int {
    if a < b {
        return a
    }
    return b
}
```

## Option Type: Explicit Absence

Go's zero values and nil pointers communicate absence implicitly, but they require documentation and defensive nil checks scattered throughout the code. An Option type makes presence/absence explicit in the type system.

```go
package option

// Option represents an optional value of type T.
// Some(v) holds a value; None is empty.
type Option[T any] struct {
    value    T
    hasValue bool
}

// Some wraps a value in an Option.
func Some[T any](v T) Option[T] {
    return Option[T]{value: v, hasValue: true}
}

// None returns an empty Option.
func None[T any]() Option[T] {
    return Option[T]{}
}

// IsSome returns true if the option holds a value.
func (o Option[T]) IsSome() bool { return o.hasValue }

// IsNone returns true if the option is empty.
func (o Option[T]) IsNone() bool { return !o.hasValue }

// Unwrap returns the value or panics if None.
// Use only when you are certain the option is Some.
func (o Option[T]) Unwrap() T {
    if !o.hasValue {
        panic("option.Unwrap called on None")
    }
    return o.value
}

// UnwrapOr returns the value if Some, otherwise returns the default.
func (o Option[T]) UnwrapOr(defaultVal T) T {
    if o.hasValue {
        return o.value
    }
    return defaultVal
}

// UnwrapOrElse returns the value if Some, otherwise calls fn and returns its result.
func (o Option[T]) UnwrapOrElse(fn func() T) T {
    if o.hasValue {
        return o.value
    }
    return fn()
}

// Map applies fn to the inner value if Some, returns None otherwise.
func Map[T, U any](o Option[T], fn func(T) U) Option[U] {
    if o.hasValue {
        return Some(fn(o.value))
    }
    return None[U]()
}

// FlatMap applies fn (which returns an Option) to the inner value if Some.
func FlatMap[T, U any](o Option[T], fn func(T) Option[U]) Option[U] {
    if o.hasValue {
        return fn(o.value)
    }
    return None[U]()
}

// Usage example: database lookup with optional result.
func findUser(db *sql.DB, id int64) Option[User] {
    var u User
    err := db.QueryRow("SELECT id, name, email FROM users WHERE id = $1", id).
        Scan(&u.ID, &u.Name, &u.Email)
    if err == sql.ErrNoRows {
        return None[User]()
    }
    if err != nil {
        // In production, you'd return Result[User] here.
        return None[User]()
    }
    return Some(u)
}

// Chain operations safely — no nil checks required.
func getUserEmail(db *sql.DB, userID int64) Option[string] {
    return Map(findUser(db, userID), func(u User) string {
        return u.Email
    })
}
```

## Result Type: Explicit Error Propagation

Go's multiple return values for error handling work well at the function level but become verbose when chaining transformations. A Result type encapsulates the success/error state.

```go
package result

// Result holds either a successful value or an error.
type Result[T any] struct {
    value T
    err   error
}

// Ok wraps a successful value.
func Ok[T any](v T) Result[T] {
    return Result[T]{value: v}
}

// Err wraps an error.
func Err[T any](err error) Result[T] {
    return Result[T]{err: err}
}

// IsOk returns true if the result holds a value.
func (r Result[T]) IsOk() bool { return r.err == nil }

// IsErr returns true if the result holds an error.
func (r Result[T]) IsErr() bool { return r.err != nil }

// Unwrap returns the value or panics with the error.
func (r Result[T]) Unwrap() T {
    if r.err != nil {
        panic(fmt.Sprintf("result.Unwrap called on Err: %v", r.err))
    }
    return r.value
}

// UnwrapErr returns the error or panics if Ok.
func (r Result[T]) UnwrapErr() error {
    if r.err == nil {
        panic("result.UnwrapErr called on Ok")
    }
    return r.err
}

// UnwrapOr returns the value if Ok, otherwise returns the default.
func (r Result[T]) UnwrapOr(defaultVal T) T {
    if r.err == nil {
        return r.value
    }
    return defaultVal
}

// Map applies fn to the inner value if Ok, propagates Err otherwise.
func Map[T, U any](r Result[T], fn func(T) U) Result[U] {
    if r.err != nil {
        return Err[U](r.err)
    }
    return Ok(fn(r.value))
}

// FlatMap applies fn (which returns a Result) if Ok.
// This is the "bind" operation, enabling Result chaining.
func FlatMap[T, U any](r Result[T], fn func(T) Result[U]) Result[U] {
    if r.err != nil {
        return Err[U](r.err)
    }
    return fn(r.value)
}

// TryApply converts a function that returns (T, error) into a Result-returning function.
func TryApply[I, O any](fn func(I) (O, error)) func(I) Result[O] {
    return func(v I) Result[O] {
        out, err := fn(v)
        if err != nil {
            return Err[O](err)
        }
        return Ok(out)
    }
}

// Sequence converts a slice of Results into a Result containing a slice.
// Returns the first error encountered.
func Sequence[T any](results []Result[T]) Result[[]T] {
    values := make([]T, 0, len(results))
    for _, r := range results {
        if r.err != nil {
            return Err[[]T](r.err)
        }
        values = append(values, r.value)
    }
    return Ok(values)
}

// Pipeline usage — chaining transformations with error propagation.
func processUserRequest(rawJSON []byte) Result[ProcessedResponse] {
    return FlatMap(
        FlatMap(
            parseRequest(rawJSON),
            validateRequest,
        ),
        executeRequest,
    )
}

func parseRequest(data []byte) Result[Request] {
    var req Request
    if err := json.Unmarshal(data, &req); err != nil {
        return Err[Request](fmt.Errorf("parsing request: %w", err))
    }
    return Ok(req)
}

func validateRequest(req Request) Result[Request] {
    if req.UserID <= 0 {
        return Err[Request](fmt.Errorf("invalid user_id: %d", req.UserID))
    }
    return Ok(req)
}

func executeRequest(req Request) Result[ProcessedResponse] {
    // Business logic...
    return Ok(ProcessedResponse{Status: "ok"})
}
```

## Generic Collections: Type-Safe Data Structures

```go
package collections

import "sync"

// Set is an unordered collection of unique comparable values.
type Set[T comparable] struct {
    m map[T]struct{}
}

func NewSet[T comparable](initial ...T) *Set[T] {
    s := &Set[T]{m: make(map[T]struct{}, len(initial))}
    for _, v := range initial {
        s.Add(v)
    }
    return s
}

func (s *Set[T]) Add(v T)           { s.m[v] = struct{}{} }
func (s *Set[T]) Remove(v T)        { delete(s.m, v) }
func (s *Set[T]) Contains(v T) bool { _, ok := s.m[v]; return ok }
func (s *Set[T]) Len() int          { return len(s.m) }

func (s *Set[T]) Intersection(other *Set[T]) *Set[T] {
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

func (s *Set[T]) Slice() []T {
    result := make([]T, 0, len(s.m))
    for k := range s.m {
        result = append(result, k)
    }
    return result
}

// SyncMap is a generic, type-safe wrapper around sync.Map.
type SyncMap[K comparable, V any] struct {
    m sync.Map
}

func (m *SyncMap[K, V]) Store(key K, val V) {
    m.m.Store(key, val)
}

func (m *SyncMap[K, V]) Load(key K) (V, bool) {
    v, ok := m.m.Load(key)
    if !ok {
        var zero V
        return zero, false
    }
    return v.(V), true
}

func (m *SyncMap[K, V]) LoadOrStore(key K, val V) (V, bool) {
    actual, loaded := m.m.LoadOrStore(key, val)
    return actual.(V), loaded
}

func (m *SyncMap[K, V]) Delete(key K) {
    m.m.Delete(key)
}

func (m *SyncMap[K, V]) Range(fn func(K, V) bool) {
    m.m.Range(func(k, v any) bool {
        return fn(k.(K), v.(V))
    })
}
```

## Functional Pipeline Builder

```go
package pipeline

// Pipeline is a composable series of transformations on type T.
type Pipeline[T any] struct {
    transforms []func(T) (T, error)
}

// NewPipeline creates an empty pipeline.
func NewPipeline[T any]() *Pipeline[T] {
    return &Pipeline[T]{}
}

// Then appends a transformation that may fail.
func (p *Pipeline[T]) Then(fn func(T) (T, error)) *Pipeline[T] {
    return &Pipeline[T]{transforms: append(p.transforms, fn)}
}

// ThenMap appends an infallible transformation.
func (p *Pipeline[T]) ThenMap(fn func(T) T) *Pipeline[T] {
    return p.Then(func(v T) (T, error) { return fn(v), nil })
}

// Execute runs all transformations in order, returning on the first error.
func (p *Pipeline[T]) Execute(input T) (T, error) {
    current := input
    for _, fn := range p.transforms {
        next, err := fn(current)
        if err != nil {
            return current, err
        }
        current = next
    }
    return current, nil
}

// Typed pipeline for request processing.
type RequestPipeline = Pipeline[*http.Request]

func buildRequestPipeline() *RequestPipeline {
    return NewPipeline[*http.Request]().
        ThenMap(addRequestID).
        ThenMap(addTimestamp).
        Then(validateContentType).
        Then(enforceRateLimit)
}

func addRequestID(r *http.Request) *http.Request {
    ctx := context.WithValue(r.Context(), requestIDKey, uuid.New().String())
    return r.WithContext(ctx)
}

func addTimestamp(r *http.Request) *http.Request {
    ctx := context.WithValue(r.Context(), timestampKey, time.Now())
    return r.WithContext(ctx)
}

func validateContentType(r *http.Request) (*http.Request, error) {
    if r.Method == http.MethodPost {
        ct := r.Header.Get("Content-Type")
        if ct != "application/json" {
            return r, fmt.Errorf("unsupported content type: %s", ct)
        }
    }
    return r, nil
}

func enforceRateLimit(r *http.Request) (*http.Request, error) {
    // Rate limiting logic...
    return r, nil
}
```

## Benchmarking Generic vs. Non-Generic Code

```go
package benchmark_test

import (
    "testing"
)

// BenchmarkMapGeneric measures the overhead of the generic Map function.
func BenchmarkMapGeneric(b *testing.B) {
    input := make([]int, 1000)
    for i := range input {
        input[i] = i
    }

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _ = Map(input, func(v int) int { return v * 2 })
    }
}

// BenchmarkMapInline is the baseline: an inline for loop.
func BenchmarkMapInline(b *testing.B) {
    input := make([]int, 1000)
    for i := range input {
        input[i] = i
    }

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        result := make([]int, len(input))
        for j, v := range input {
            result[j] = v * 2
        }
        _ = result
    }
}
```

Go generics enable functional programming patterns that were previously impractical due to verbosity or runtime overhead. The patterns in this guide — Map/Filter/Reduce, Option, Result, and composable pipelines — reduce the surface area for nil pointer dereferences, unhandled errors, and type assertion panics while making the intent of data transformation code explicit and readable.
