---
title: "Go Generics in Production: Type Parameters, Constraints, and Real-World Patterns"
date: 2030-01-05T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Generics", "Type Parameters", "Performance", "Software Architecture"]
categories: ["Go", "Software Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go generics usage in enterprise codebases, covering type constraints, generic data structures, performance implications, and when to use vs avoid generics."
more_link: "yes"
url: "/go-generics-production-type-parameters-constraints-patterns/"
---

Go 1.18 introduced generics after years of debate in the community, and the feature has matured significantly by Go 1.22. For enterprise teams, generics represent a powerful tool for eliminating code duplication in data structure implementations, utility functions, and framework code — but also a potential source of complexity if overused. This guide provides the practical knowledge needed to use generics effectively in production Go codebases.

We will cover the full generics type system including type parameters, constraints using interfaces, constraint satisfaction rules, type inference, and the standard library's `constraints` and `slices` packages. More importantly, we will examine real patterns that appear in production enterprise code and provide clear guidance on when generics add value versus when they add unnecessary complexity.

<!--more-->

# Go Generics in Production: Type Parameters, Constraints, and Real-World Patterns

## Understanding the Problem Generics Solve

Before generics, Go developers had three options when writing type-agnostic code:

1. **Interface{} / any**: Works at runtime but loses type safety and requires type assertions
2. **Code generation**: `go generate` with templates produces type-safe code but requires tooling and adds build complexity
3. **Copy-paste duplication**: Each type gets its own implementation, violating DRY principles

```go
// Pre-generics: unsafe any-based approach
func MapSlice(slice []any, fn func(any) any) []any {
    result := make([]any, len(slice))
    for i, v := range slice {
        result[i] = fn(v)
    }
    return result
}

// Usage loses type safety
result := MapSlice([]any{1, 2, 3}, func(v any) any {
    return v.(int) * 2  // Panic if not int
})
```

Generics solve this by allowing the compiler to enforce type safety while keeping a single implementation:

```go
// With generics: type-safe and reusable
func MapSlice[T, U any](slice []T, fn func(T) U) []U {
    result := make([]U, len(slice))
    for i, v := range slice {
        result[i] = fn(v)
    }
    return result
}

// Usage is type-safe - compiler catches type mismatches
doubled := MapSlice([]int{1, 2, 3}, func(v int) int { return v * 2 })
strs := MapSlice([]int{1, 2, 3}, func(v int) string { return fmt.Sprintf("%d", v) })
```

## Type Parameters and Constraints

### Basic Syntax

Type parameters are declared in square brackets after the function or type name:

```go
// Function with single type parameter
func Min[T constraints.Ordered](a, b T) T {
    if a < b {
        return a
    }
    return b
}

// Function with multiple type parameters
func Zip[A, B any](as []A, bs []B) []struct{ A A; B B } {
    minLen := len(as)
    if len(bs) < minLen {
        minLen = len(bs)
    }
    result := make([]struct{ A A; B B }, minLen)
    for i := range minLen {
        result[i] = struct{ A A; B B }{as[i], bs[i]}
    }
    return result
}

// Generic type (struct)
type Stack[T any] struct {
    items []T
}

func (s *Stack[T]) Push(item T) {
    s.items = append(s.items, item)
}

func (s *Stack[T]) Pop() (T, bool) {
    var zero T
    if len(s.items) == 0 {
        return zero, false
    }
    item := s.items[len(s.items)-1]
    s.items = s.items[:len(s.items)-1]
    return item, true
}

func (s *Stack[T]) Peek() (T, bool) {
    var zero T
    if len(s.items) == 0 {
        return zero, false
    }
    return s.items[len(s.items)-1], true
}

func (s *Stack[T]) Len() int {
    return len(s.items)
}
```

### Constraints: The Type Constraint System

Constraints are interfaces that restrict which types can be used as type arguments. Go's constraint system is built on interfaces with a powerful extension: type sets.

```go
// Traditional interface constraint - any type implementing this interface
type Stringer interface {
    String() string
}

// Type set constraint - only these exact types
type Integer interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64 |
        ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr
}

// The ~ operator means "underlying type is"
// This allows custom types based on int to satisfy the constraint:
type MyInt int

func PrintInt[T Integer](v T) {
    fmt.Printf("%d\n", v)  // Works because T is integer-like
}

// MyInt has underlying type int, so it satisfies Integer
var x MyInt = 42
PrintInt(x)  // Valid
```

### Building Custom Constraints

```go
package constraints

import "golang.org/x/exp/constraints"

// Number encompasses all numeric types
type Number interface {
    constraints.Integer | constraints.Float
}

// Comparable types that can also be printed
type ComparableStringer interface {
    comparable
    String() string
}

// Constraint for map keys - must be comparable
type MapKey interface {
    comparable
}

// Constraint requiring both ordering and string representation
type OrderedStringer interface {
    constraints.Ordered
    String() string
}

// Numeric constraint with math operations
type Numeric interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64 |
        ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 |
        ~float32 | ~float64
}

// Sum returns the sum of a slice of any numeric type
func Sum[T Numeric](slice []T) T {
    var total T
    for _, v := range slice {
        total += v
    }
    return total
}

// Mean returns the arithmetic mean, always as float64
func Mean[T Numeric](slice []T) float64 {
    if len(slice) == 0 {
        return 0
    }
    var total T
    for _, v := range slice {
        total += v
    }
    return float64(total) / float64(len(slice))
}
```

### Type Inference

Go's type inference eliminates the need to specify type arguments in most cases:

```go
// Explicit type arguments (rarely needed)
result := MapSlice[int, string]([]int{1, 2, 3}, strconv.Itoa)

// Type inference - compiler deduces T=int, U=string from arguments
result := MapSlice([]int{1, 2, 3}, strconv.Itoa)

// Type inference on methods requires full type instantiation
s := Stack[int]{}  // Must specify type for generic types
s.Push(1)          // Method calls can infer from receiver
```

## Production-Ready Generic Data Structures

### Generic Result Type

The Result monad pattern eliminates error-check boilerplate in pipelines:

```go
// result/result.go
package result

// Result represents either a successful value or an error
type Result[T any] struct {
    value T
    err   error
}

// Ok creates a successful Result
func Ok[T any](value T) Result[T] {
    return Result[T]{value: value}
}

// Err creates a failed Result
func Err[T any](err error) Result[T] {
    return Result[T]{err: err}
}

// IsOk returns true if the Result is successful
func (r Result[T]) IsOk() bool {
    return r.err == nil
}

// Unwrap returns the value, panicking if error
func (r Result[T]) Unwrap() T {
    if r.err != nil {
        panic(fmt.Sprintf("called Unwrap on error Result: %v", r.err))
    }
    return r.value
}

// UnwrapOr returns the value or a default
func (r Result[T]) UnwrapOr(defaultValue T) T {
    if r.err != nil {
        return defaultValue
    }
    return r.value
}

// Unpack returns value and error (for idiomatic Go usage)
func (r Result[T]) Unpack() (T, error) {
    return r.value, r.err
}

// Map transforms the value inside a successful Result
func Map[T, U any](r Result[T], fn func(T) U) Result[U] {
    if r.err != nil {
        return Err[U](r.err)
    }
    return Ok(fn(r.value))
}

// FlatMap chains Results, stopping at first error
func FlatMap[T, U any](r Result[T], fn func(T) Result[U]) Result[U] {
    if r.err != nil {
        return Err[U](r.err)
    }
    return fn(r.value)
}

// Collect transforms []Result[T] to Result[[]T]
func Collect[T any](results []Result[T]) Result[[]T] {
    values := make([]T, 0, len(results))
    for _, r := range results {
        if r.err != nil {
            return Err[[]T](r.err)
        }
        values = append(values, r.value)
    }
    return Ok(values)
}
```

Usage in production code:

```go
func processUserIDs(ids []string) ([]User, error) {
    // Without generics: error-check after each step
    results := make([]result.Result[User], len(ids))
    for i, id := range ids {
        results[i] = result.FlatMap(
            parseUserID(id),                    // Result[UserID]
            func(uid UserID) result.Result[User] {
                return fetchUser(uid)            // Result[User]
            },
        )
    }
    return result.Collect(results).Unpack()
}
```

### Generic Cache with TTL

```go
// cache/cache.go
package cache

import (
    "sync"
    "time"
)

type entry[V any] struct {
    value     V
    expiresAt time.Time
}

// Cache is a generic thread-safe cache with TTL support
type Cache[K comparable, V any] struct {
    mu      sync.RWMutex
    entries map[K]entry[V]
    ttl     time.Duration
}

// New creates a new Cache with the given TTL
func New[K comparable, V any](ttl time.Duration) *Cache[K, V] {
    c := &Cache[K, V]{
        entries: make(map[K]entry[V]),
        ttl:     ttl,
    }
    go c.evictionLoop()
    return c
}

// Set stores a value in the cache
func (c *Cache[K, V]) Set(key K, value V) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.entries[key] = entry[V]{
        value:     value,
        expiresAt: time.Now().Add(c.ttl),
    }
}

// Get retrieves a value from the cache
func (c *Cache[K, V]) Get(key K) (V, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    e, ok := c.entries[key]
    if !ok || time.Now().After(e.expiresAt) {
        var zero V
        return zero, false
    }
    return e.value, true
}

// GetOrSet returns the cached value or calls fn to compute it
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

// Delete removes a key from the cache
func (c *Cache[K, V]) Delete(key K) {
    c.mu.Lock()
    defer c.mu.Unlock()
    delete(c.entries, key)
}

// Len returns the number of entries (including expired)
func (c *Cache[K, V]) Len() int {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return len(c.entries)
}

func (c *Cache[K, V]) evictionLoop() {
    ticker := time.NewTicker(c.ttl / 2)
    defer ticker.Stop()
    for range ticker.C {
        c.evictExpired()
    }
}

func (c *Cache[K, V]) evictExpired() {
    now := time.Now()
    c.mu.Lock()
    defer c.mu.Unlock()
    for k, e := range c.entries {
        if now.After(e.expiresAt) {
            delete(c.entries, k)
        }
    }
}
```

### Generic Event Bus

```go
// eventbus/eventbus.go
package eventbus

import (
    "sync"
)

// Handler is a function that processes events of type T
type Handler[T any] func(event T)

// Bus is a type-safe event bus
type Bus[T any] struct {
    mu       sync.RWMutex
    handlers map[string][]Handler[T]
}

// NewBus creates a new event bus
func NewBus[T any]() *Bus[T] {
    return &Bus[T]{
        handlers: make(map[string][]Handler[T]),
    }
}

// Subscribe registers a handler for events of the given topic
func (b *Bus[T]) Subscribe(topic string, handler Handler[T]) func() {
    b.mu.Lock()
    defer b.mu.Unlock()
    b.handlers[topic] = append(b.handlers[topic], handler)

    // Return unsubscribe function
    return func() {
        b.mu.Lock()
        defer b.mu.Unlock()
        handlers := b.handlers[topic]
        for i, h := range handlers {
            // Compare function pointers - this won't work with closures
            // In production, use subscriber IDs instead
            _ = h
            _ = i
        }
    }
}

// Publish sends an event to all handlers for the given topic
func (b *Bus[T]) Publish(topic string, event T) {
    b.mu.RLock()
    handlers := make([]Handler[T], len(b.handlers[topic]))
    copy(handlers, b.handlers[topic])
    b.mu.RUnlock()

    for _, h := range handlers {
        h(event)
    }
}

// PublishAsync publishes events asynchronously
func (b *Bus[T]) PublishAsync(topic string, event T) {
    b.mu.RLock()
    handlers := make([]Handler[T], len(b.handlers[topic]))
    copy(handlers, b.handlers[topic])
    b.mu.RUnlock()

    for _, h := range handlers {
        go h(event)
    }
}
```

### Generic Pipeline with Concurrent Stages

```go
// pipeline/pipeline.go
package pipeline

import (
    "context"
    "sync"
)

// Stage transforms items of type I to type O
type Stage[I, O any] func(ctx context.Context, input I) (O, error)

// Map applies a transformation to each item in a channel
func Map[I, O any](
    ctx context.Context,
    input <-chan I,
    workers int,
    fn Stage[I, O],
) (<-chan O, <-chan error) {
    output := make(chan O, workers)
    errs := make(chan error, 1)

    var wg sync.WaitGroup
    for range workers {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for item := range input {
                select {
                case <-ctx.Done():
                    return
                default:
                }
                result, err := fn(ctx, item)
                if err != nil {
                    select {
                    case errs <- err:
                    default:
                    }
                    return
                }
                select {
                case output <- result:
                case <-ctx.Done():
                    return
                }
            }
        }()
    }

    go func() {
        wg.Wait()
        close(output)
        close(errs)
    }()

    return output, errs
}

// Filter removes items that do not satisfy the predicate
func Filter[T any](
    ctx context.Context,
    input <-chan T,
    predicate func(T) bool,
) <-chan T {
    output := make(chan T)
    go func() {
        defer close(output)
        for item := range input {
            select {
            case <-ctx.Done():
                return
            default:
                if predicate(item) {
                    select {
                    case output <- item:
                    case <-ctx.Done():
                        return
                    }
                }
            }
        }
    }()
    return output
}

// Batch groups items into slices of at most size n
func Batch[T any](input <-chan T, size int) <-chan []T {
    output := make(chan []T)
    go func() {
        defer close(output)
        batch := make([]T, 0, size)
        for item := range input {
            batch = append(batch, item)
            if len(batch) >= size {
                output <- batch
                batch = make([]T, 0, size)
            }
        }
        if len(batch) > 0 {
            output <- batch
        }
    }()
    return output
}

// Drain collects all values from a channel into a slice
func Drain[T any](ch <-chan T) []T {
    var result []T
    for v := range ch {
        result = append(result, v)
    }
    return result
}
```

## Real-World Production Patterns

### Repository Pattern with Generics

```go
// repository/repository.go
package repository

import (
    "context"
    "database/sql"
    "fmt"
)

// Entity is a constraint for database entities
type Entity interface {
    GetID() string
}

// Repository provides generic CRUD operations
type Repository[T Entity] struct {
    db        *sql.DB
    tableName string
    scanner   func(*sql.Row) (T, error)
    inserter  func(T) (string, []any)
    updater   func(T) (string, []any)
}

// NewRepository creates a new generic repository
func NewRepository[T Entity](
    db *sql.DB,
    tableName string,
    scanner func(*sql.Row) (T, error),
    inserter func(T) (string, []any),
    updater func(T) (string, []any),
) *Repository[T] {
    return &Repository[T]{
        db:        db,
        tableName: tableName,
        scanner:   scanner,
        inserter:  inserter,
        updater:   updater,
    }
}

// FindByID retrieves a single entity by ID
func (r *Repository[T]) FindByID(ctx context.Context, id string) (T, error) {
    query := fmt.Sprintf("SELECT * FROM %s WHERE id = $1", r.tableName)
    row := r.db.QueryRowContext(ctx, query, id)
    return r.scanner(row)
}

// Save inserts or updates an entity
func (r *Repository[T]) Save(ctx context.Context, entity T) error {
    query, args := r.inserter(entity)
    _, err := r.db.ExecContext(ctx, query, args...)
    return err
}

// Delete removes an entity by ID
func (r *Repository[T]) Delete(ctx context.Context, id string) error {
    query := fmt.Sprintf("DELETE FROM %s WHERE id = $1", r.tableName)
    _, err := r.db.ExecContext(ctx, query, id)
    return err
}

// FindAll retrieves all entities with optional limit
func (r *Repository[T]) FindAll(ctx context.Context, limit, offset int) ([]T, error) {
    query := fmt.Sprintf(
        "SELECT * FROM %s ORDER BY created_at DESC LIMIT $1 OFFSET $2",
        r.tableName,
    )
    rows, err := r.db.QueryContext(ctx, query, limit, offset)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var entities []T
    for rows.Next() {
        // Note: scanner takes *sql.Row, but we need to handle *sql.Rows
        // In practice, you'd have separate scanner functions
        _ = rows
    }
    return entities, rows.Err()
}
```

### Generic HTTP Handler Helpers

```go
// httputil/decode.go
package httputil

import (
    "encoding/json"
    "fmt"
    "net/http"
)

// DecodeBody decodes a JSON request body into type T
func DecodeBody[T any](r *http.Request) (T, error) {
    var v T
    if err := json.NewDecoder(r.Body).Decode(&v); err != nil {
        return v, fmt.Errorf("decoding request body: %w", err)
    }
    return v, nil
}

// WriteJSON writes a value as JSON response
func WriteJSON[T any](w http.ResponseWriter, status int, v T) error {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    return json.NewEncoder(w).Encode(v)
}

// HandleFunc creates a type-safe HTTP handler from a function
func HandleFunc[Req, Resp any](
    fn func(r *http.Request, req Req) (Resp, int, error),
) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        req, err := DecodeBody[Req](r)
        if err != nil {
            WriteJSON(w, http.StatusBadRequest, map[string]string{
                "error": err.Error(),
            })
            return
        }

        resp, status, err := fn(r, req)
        if err != nil {
            WriteJSON(w, status, map[string]string{
                "error": err.Error(),
            })
            return
        }

        WriteJSON(w, status, resp)
    }
}

// Example usage:
type CreateUserRequest struct {
    Name  string `json:"name"`
    Email string `json:"email"`
}

type CreateUserResponse struct {
    ID    string `json:"id"`
    Name  string `json:"name"`
    Email string `json:"email"`
}

func createUserHandler(userService UserService) http.HandlerFunc {
    return HandleFunc(func(r *http.Request, req CreateUserRequest) (CreateUserResponse, int, error) {
        user, err := userService.Create(r.Context(), req.Name, req.Email)
        if err != nil {
            return CreateUserResponse{}, http.StatusInternalServerError, err
        }
        return CreateUserResponse{
            ID:    user.ID,
            Name:  user.Name,
            Email: user.Email,
        }, http.StatusCreated, nil
    })
}
```

### Functional Options with Generics

```go
// options/options.go
package options

// Option is a function that modifies a configuration
type Option[T any] func(*T)

// Apply applies options to a configuration pointer
func Apply[T any](config *T, opts ...Option[T]) {
    for _, opt := range opts {
        opt(config)
    }
}

// NewWith creates a new instance with options applied
func NewWith[T any](defaults T, opts ...Option[T]) T {
    Apply(&defaults, opts...)
    return defaults
}

// Example: HTTP client configuration
type HTTPClientConfig struct {
    Timeout     time.Duration
    MaxRetries  int
    BaseURL     string
    Headers     map[string]string
    TLSInsecure bool
}

func WithTimeout(d time.Duration) Option[HTTPClientConfig] {
    return func(c *HTTPClientConfig) {
        c.Timeout = d
    }
}

func WithMaxRetries(n int) Option[HTTPClientConfig] {
    return func(c *HTTPClientConfig) {
        c.MaxRetries = n
    }
}

func WithHeader(key, value string) Option[HTTPClientConfig] {
    return func(c *HTTPClientConfig) {
        if c.Headers == nil {
            c.Headers = make(map[string]string)
        }
        c.Headers[key] = value
    }
}

// Usage
config := NewWith(HTTPClientConfig{
    Timeout:    30 * time.Second,
    MaxRetries: 3,
},
    WithTimeout(60*time.Second),
    WithHeader("Authorization", "Bearer "+token),
    WithHeader("X-Request-ID", requestID),
)
```

## Performance Considerations

### Benchmarking Generics vs Interface

```go
// benchmarks_test.go
package benchmarks

import (
    "testing"
)

// Generic implementation
func SumGeneric[T interface{ ~int | ~float64 }](values []T) T {
    var total T
    for _, v := range values {
        total += v
    }
    return total
}

// Interface-based implementation
func SumInterface(values []any) float64 {
    var total float64
    for _, v := range values {
        switch n := v.(type) {
        case int:
            total += float64(n)
        case float64:
            total += n
        }
    }
    return total
}

// Specific implementation (baseline)
func SumInt(values []int) int {
    var total int
    for _, v := range values {
        total += v
    }
    return total
}

var data = func() []int {
    d := make([]int, 1000)
    for i := range d {
        d[i] = i
    }
    return d
}()

func BenchmarkSumGeneric(b *testing.B) {
    for b.Loop() {
        SumGeneric(data)
    }
}

func BenchmarkSumInt(b *testing.B) {
    for b.Loop() {
        SumInt(data)
    }
}

var anyData = func() []any {
    d := make([]any, 1000)
    for i := range d {
        d[i] = i
    }
    return d
}()

func BenchmarkSumInterface(b *testing.B) {
    for b.Loop() {
        SumInterface(anyData)
    }
}
```

Typical benchmark results:
```
BenchmarkSumGeneric-8    15234782   78.5 ns/op    0 B/op    0 allocs/op
BenchmarkSumInt-8        15891234   75.3 ns/op    0 B/op    0 allocs/op
BenchmarkSumInterface-8   3421987   350.2 ns/op   0 B/op    0 allocs/op
```

Generic implementations typically achieve performance identical to type-specific implementations because the compiler generates monomorphized code for each type instantiation. Interface-based implementations incur overhead from dynamic dispatch and type assertions.

### Monomorphization and Binary Size

Go's generics use monomorphization with GC shape stenciling, which means:
- Each unique type argument produces specialized code (fast at runtime)
- Binary size increases proportionally to the number of type instantiations
- The compiler shares stencils for types with the same GC shape (pointer types share a stencil)

```go
// This generates ONE stencil for all pointer types
func SwapPointers[T any](a, b **T) {
    *a, *b = *b, *a
}

// This generates MULTIPLE stencils: one for int, one for float64, one for string
func Triple[T int | float64 | string](v T) T {
    // ... not actually meaningful for all types
    return v
}
```

## When to Use vs Avoid Generics

### Use Generics When

**1. Writing general-purpose data structures:**
```go
// Good: Generic data structures are the primary use case
type OrderedMap[K constraints.Ordered, V any] struct { ... }
type PriorityQueue[T any] struct { ... }
type RingBuffer[T any] struct { ... }
```

**2. Implementing collection operations:**
```go
// Good: slices/maps operations benefit enormously from generics
func Filter[T any](slice []T, pred func(T) bool) []T
func GroupBy[T any, K comparable](slice []T, key func(T) K) map[K][]T
func Reduce[T, U any](slice []T, initial U, fn func(U, T) U) U
```

**3. Type-safe wrappers around unsafe operations:**
```go
// Good: Eliminates type assertions at call sites
type AtomicValue[T any] struct { v atomic.Value }
func (a *AtomicValue[T]) Load() T { return a.v.Load().(T) }
func (a *AtomicValue[T]) Store(v T) { a.v.Store(v) }
```

### Avoid Generics When

**1. The function already works well with interfaces:**
```go
// Bad: io.Writer is already a perfect abstraction
func WriteGeneric[W io.Writer](w W, data []byte) error {
    _, err := w.Write(data)
    return err
}

// Good: Just use the interface
func Write(w io.Writer, data []byte) error {
    _, err := w.Write(data)
    return err
}
```

**2. Business logic with domain-specific types:**
```go
// Bad: Generics don't add value here - Order and Invoice are specific types
func ProcessGeneric[T OrderOrInvoice](item T) error { ... }

// Good: Separate functions or a proper interface
func ProcessOrder(order *Order) error { ... }
func ProcessInvoice(invoice *Invoice) error { ... }
```

**3. When the implementation would differ per type anyway:**
```go
// Bad: The implementation must branch on T anyway
func Serialize[T string | int | bool](v T) string {
    // You need a type switch here, which defeats the purpose
    switch any(v).(type) {
    case string:
        return v.(string)  // Unsafe type assertion
    case int:
        return strconv.Itoa(v.(int))  // Unsafe type assertion
    }
    return ""
}

// Good: Use explicit functions or fmt.Sprintf
func SerializeString(v string) string { return v }
func SerializeInt(v int) string { return strconv.Itoa(v) }
```

## Standard Library Generic Functions

Go 1.21+ includes generic functions in the standard library:

```go
import (
    "slices"
    "maps"
    "cmp"
)

// slices package
numbers := []int{3, 1, 4, 1, 5, 9, 2, 6}
sorted := slices.Sorted(slices.Values(numbers))  // Go 1.23+
idx, found := slices.BinarySearch(sorted, 5)
slices.Sort(numbers)
slices.SortFunc(numbers, func(a, b int) int { return cmp.Compare(a, b) })
max := slices.Max(numbers)
min := slices.Min(numbers)
contains := slices.Contains(numbers, 42)
idx2 := slices.Index(numbers, 5)
reversed := slices.Clone(numbers)
slices.Reverse(reversed)

// maps package
m := map[string]int{"a": 1, "b": 2, "c": 3}
keys := slices.Collect(maps.Keys(m))
values := slices.Collect(maps.Values(m))
clone := maps.Clone(m)
maps.DeleteFunc(clone, func(k string, v int) bool { return v < 2 })

// cmp package
result := cmp.Compare(3, 5)  // -1, 0, or 1
isOrdered := cmp.Less(3, 5)  // true
```

## Key Takeaways

Go generics are now a mature, production-ready feature. The key insights for enterprise teams are:

**Use generics for infrastructure and utility code**: Data structures, collection operations, type-safe wrappers, and pipeline abstractions benefit enormously from generics. These are the foundational patterns that appear in every codebase.

**Keep generics out of business logic**: Domain-specific code should use explicit types. The added abstraction of generics rarely pays off when the types are well-known and the logic is specific to those types.

**Generics match the performance of specific implementations**: The compiler generates monomorphized code, so you do not pay a runtime cost for using generics correctly.

**Type constraints are interfaces**: Understanding that constraints are a superset of interfaces (adding type set unions with `|`) makes the constraint system click. You already know how to use interfaces; generics extends that knowledge.

**The standard library is your guide**: The `slices`, `maps`, and `cmp` packages in Go 1.21+ demonstrate the idiomatic use of generics. Study them to understand the intended patterns before building your own.
