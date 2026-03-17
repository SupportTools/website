---
title: "Go Generics Constraints: Type Sets, Union Types, and Interface Satisfaction"
date: 2031-02-20T00:00:00-05:00
draft: false
tags: ["Go", "Generics", "Type System", "Programming", "Go 1.18", "Enterprise Go"]
categories:
- Go
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Go generics constraints including type set semantics, union type constraints, comparable, any vs interface{}, generic methods, and building type-safe collections for enterprise Go codebases."
more_link: "yes"
url: "/go-generics-constraints-type-sets-union-types-interface-satisfaction/"
---

Go 1.18 introduced generics with a constraint model based on type sets — a more expressive system than classical interface-based constraints. Understanding type sets is essential for writing correct, expressive, and performant generic code. This guide covers the mechanics of type set semantics, union constraints, the `comparable` built-in, and the practical patterns that enterprise Go teams use to build type-safe collections and abstractions.

<!--more-->

# Go Generics Constraints: Type Sets, Union Types, and Interface Satisfaction

## Section 1: Type Set Semantics

In Go generics, every constraint is an interface, and every interface defines a set of types. The type set of an interface is the set of all types that implement the interface.

For a classical interface:

```go
type Stringer interface {
    String() string
}
```

The type set contains every type that has a `String() string` method. This is the traditional meaning of "interface satisfaction."

But Go 1.18 extended interfaces with **type elements** — explicit sets of concrete types that can appear in a constraint:

```go
type Integer interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64
}
```

The type set of `Integer` contains every type whose underlying type is one of `int`, `int8`, `int16`, `int32`, or `int64`.

### Type Sets Are Sets — Not Behavioral Specifications

This distinction matters: a type set is not a description of what a type can do, it is a description of what types are allowed. An interface used as a constraint can combine both:

```go
type Number interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64 |
    ~float32 | ~float64

    // Methods are also part of the type set definition
    // (All types satisfying the union must also have this method)
    // NOTE: this would fail unless all listed types have this method
    // In practice, primitive unions typically have no method requirements
}
```

When you use an interface as a constraint in a type parameter, the compiler enforces that all operations performed on a value of that type parameter are valid for every type in the type set.

### Demonstrating Type Set Restriction

```go
package main

import "fmt"

// Ordered defines a type set of all ordered built-in types
type Ordered interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64 |
    ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr |
    ~float32 | ~float64 |
    ~string
}

// Min returns the smaller of two values — works for any Ordered type
func Min[T Ordered](a, b T) T {
    if a < b {
        return a
    }
    return b
}

// This works because < is defined for all types in the Ordered type set
func main() {
    fmt.Println(Min(3, 5))           // 3 (int)
    fmt.Println(Min(3.14, 2.71))     // 2.71 (float64)
    fmt.Println(Min("abc", "xyz"))   // abc (string)
    fmt.Println(Min(uint(10), uint(7))) // 7 (uint)
}
```

## Section 2: The ~ Tilde Operator — Underlying Types

The `~T` syntax means "any type whose underlying type is T." This is crucial for user-defined types based on primitives:

```go
package main

import "fmt"

type Celsius float64
type Fahrenheit float64
type Kelvin float64

// Temperature constraint — accepts any type based on float64
type Temperature interface {
    ~float64
}

func ConvertToKelvin[T Temperature](value T) float64 {
    return float64(value)
    // In practice you'd need type-specific conversion logic
}

// A more realistic use case: generic min/max for custom numeric types
type Percent float64
type Score int

type Numeric interface {
    ~int | ~int64 | ~float64 | ~float32
}

func Clamp[T Numeric](value, min, max T) T {
    if value < min {
        return min
    }
    if value > max {
        return max
    }
    return value
}

func main() {
    var p Percent = 150.0
    clamped := Clamp(p, Percent(0), Percent(100))
    fmt.Printf("Clamped percent: %.1f\n", clamped)  // 100.0

    var s Score = -5
    clampedScore := Clamp(s, Score(0), Score(100))
    fmt.Printf("Clamped score: %d\n", clampedScore) // 0
}
```

### Without ~ — Exact Type Only

```go
// Without ~ — only accepts exactly int, not custom types based on int
type ExactInt interface {
    int
}

type MyInt int

func ExactAdd[T ExactInt](a, b T) T { return a + b }

// This compiles:
// ExactAdd(1, 2)

// This does NOT compile — MyInt is not in the type set of ExactInt:
// var a, b MyInt = 1, 2
// ExactAdd(a, b)
```

## Section 3: Union Types and Operator Constraints

Union constraints restrict which operations are available by narrowing the type set:

```go
package constraints

// Signed integers only
type Signed interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64
}

// Unsigned integers only
type Unsigned interface {
    ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr
}

// All integers
type Integer interface {
    Signed | Unsigned
}

// All floats
type Float interface {
    ~float32 | ~float64
}

// Complex numbers
type Complex interface {
    ~complex64 | ~complex128
}

// All numeric types
type Number interface {
    Integer | Float | Complex
}
```

### Embedding Constraints

```go
package main

import "fmt"

// Re-export golang.org/x/exp/constraints patterns
type Ordered interface {
    Integer | Float | ~string
}

type Integer interface {
    Signed | Unsigned
}

type Signed interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64
}

type Unsigned interface {
    ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr
}

type Float interface {
    ~float32 | ~float64
}

// Sort three values
func Sort3[T Ordered](a, b, c T) (T, T, T) {
    if b < a {
        a, b = b, a
    }
    if c < b {
        b, c = c, b
    }
    if b < a {
        a, b = b, a
    }
    return a, b, c
}

func main() {
    a, b, c := Sort3(5, 2, 8)
    fmt.Println(a, b, c)  // 2 5 8

    x, y, z := Sort3("banana", "apple", "cherry")
    fmt.Println(x, y, z)  // apple banana cherry
}
```

## Section 4: The comparable Constraint

`comparable` is a built-in constraint that matches any type that supports `==` and `!=` operators. This includes:

- All basic types (bool, int family, float family, complex family, string, pointer)
- Arrays whose element type is comparable
- Structs whose fields are all comparable
- Interface types (comparable at runtime, but may panic on non-comparable dynamic types)

`comparable` does NOT include:
- Slices
- Maps
- Functions
- Structs containing slices/maps/functions

```go
package main

import "fmt"

// Generic Set using a map — requires comparable keys
type Set[T comparable] struct {
    items map[T]struct{}
}

func NewSet[T comparable](items ...T) *Set[T] {
    s := &Set[T]{
        items: make(map[T]struct{}, len(items)),
    }
    for _, item := range items {
        s.Add(item)
    }
    return s
}

func (s *Set[T]) Add(item T) {
    s.items[item] = struct{}{}
}

func (s *Set[T]) Remove(item T) {
    delete(s.items, item)
}

func (s *Set[T]) Contains(item T) bool {
    _, ok := s.items[item]
    return ok
}

func (s *Set[T]) Len() int {
    return len(s.items)
}

func (s *Set[T]) Union(other *Set[T]) *Set[T] {
    result := NewSet[T]()
    for k := range s.items {
        result.Add(k)
    }
    for k := range other.items {
        result.Add(k)
    }
    return result
}

func (s *Set[T]) Intersection(other *Set[T]) *Set[T] {
    result := NewSet[T]()
    for k := range s.items {
        if other.Contains(k) {
            result.Add(k)
        }
    }
    return result
}

func (s *Set[T]) Difference(other *Set[T]) *Set[T] {
    result := NewSet[T]()
    for k := range s.items {
        if !other.Contains(k) {
            result.Add(k)
        }
    }
    return result
}

func (s *Set[T]) ToSlice() []T {
    result := make([]T, 0, len(s.items))
    for k := range s.items {
        result = append(result, k)
    }
    return result
}

func main() {
    a := NewSet(1, 2, 3, 4, 5)
    b := NewSet(3, 4, 5, 6, 7)

    union := a.Union(b)
    fmt.Println("Union:", union.ToSlice())  // [1 2 3 4 5 6 7]

    intersection := a.Intersection(b)
    fmt.Println("Intersection:", intersection.ToSlice())  // [3 4 5]

    diff := a.Difference(b)
    fmt.Println("Difference (A-B):", diff.ToSlice())  // [1 2]

    // Works for strings too
    words := NewSet("apple", "banana", "cherry")
    fmt.Println("Contains 'banana':", words.Contains("banana"))  // true
    fmt.Println("Contains 'grape':", words.Contains("grape"))    // false
}
```

### comparable vs Interface Types

```go
package main

import "fmt"

// This compiles — interface types satisfy comparable
func IsEqual[T comparable](a, b T) bool {
    return a == b
}

// But comparing interface values can panic at runtime if the dynamic type
// is not comparable (e.g., if the interface holds a slice)
func SafeCompare[T comparable](a, b T) (equal bool, err error) {
    defer func() {
        if r := recover(); r != nil {
            err = fmt.Errorf("comparison panicked: %v", r)
        }
    }()
    return a == b, nil
}

func main() {
    // Safe with concrete types
    fmt.Println(IsEqual(42, 42))      // true
    fmt.Println(IsEqual("hi", "hi"))  // true

    // With interface types — works when values are comparable
    var a, b interface{} = 1, 1
    fmt.Println(IsEqual(a, b))  // true

    // Would panic at runtime if we compared two slices
    // var c, d interface{} = []int{1}, []int{1}
    // IsEqual(c, d)  // panic: runtime error
}
```

## Section 5: any vs interface{}

In Go 1.18+, `any` is an alias for `interface{}`. They are identical:

```go
// These are equivalent:
var x interface{} = 42
var y any = 42
```

In generic code, `any` is the widest possible constraint — it places no restrictions on the type parameter:

```go
package main

import "fmt"

// Identity works for any type
func Identity[T any](v T) T {
    return v
}

// Map applies a function to each element of a slice
func Map[T any, U any](slice []T, f func(T) U) []U {
    result := make([]U, len(slice))
    for i, v := range slice {
        result[i] = f(v)
    }
    return result
}

// Filter returns elements matching a predicate
func Filter[T any](slice []T, pred func(T) bool) []T {
    var result []T
    for _, v := range slice {
        if pred(v) {
            result = append(result, v)
        }
    }
    return result
}

// Reduce folds a slice into a single value
func Reduce[T any, U any](slice []T, initial U, f func(U, T) U) U {
    acc := initial
    for _, v := range slice {
        acc = f(acc, v)
    }
    return acc
}

func main() {
    nums := []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}

    // Double all values
    doubled := Map(nums, func(n int) int { return n * 2 })
    fmt.Println(doubled)  // [2 4 6 8 10 12 14 16 18 20]

    // Filter even numbers
    evens := Filter(nums, func(n int) bool { return n%2 == 0 })
    fmt.Println(evens)  // [2 4 6 8 10]

    // Sum
    sum := Reduce(nums, 0, func(acc, n int) int { return acc + n })
    fmt.Println(sum)  // 55

    // Convert to strings
    strs := Map(nums, func(n int) string { return fmt.Sprintf("%d", n) })
    fmt.Println(strs)  // [1 2 3 4 5 6 7 8 9 10]
}
```

### When to Use any vs Specific Constraints

```go
// Use any when you need maximum flexibility and only store/retrieve values
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
    last := s.items[len(s.items)-1]
    s.items = s.items[:len(s.items)-1]
    return last, true
}

// Use comparable when you need == or map key semantics
type Cache[K comparable, V any] struct {
    data map[K]V
}

func (c *Cache[K, V]) Get(key K) (V, bool) {
    v, ok := c.data[key]
    return v, ok
}

// Use Ordered when you need < > operators
func BinarySearch[T Ordered](slice []T, target T) int {
    lo, hi := 0, len(slice)-1
    for lo <= hi {
        mid := (lo + hi) / 2
        if slice[mid] == target {
            return mid
        } else if slice[mid] < target {
            lo = mid + 1
        } else {
            hi = mid - 1
        }
    }
    return -1
}
```

## Section 6: Generic Methods on Types

Go does not allow type parameters on methods directly. A method can only use the type parameters defined on the receiver's type:

```go
package main

import (
    "fmt"
    "sort"
)

// TypedSlice is a generic slice type with methods
type TypedSlice[T any] []T

func (s TypedSlice[T]) Len() int {
    return len(s)
}

func (s TypedSlice[T]) First() (T, bool) {
    if len(s) == 0 {
        var zero T
        return zero, false
    }
    return s[0], true
}

func (s TypedSlice[T]) Last() (T, bool) {
    if len(s) == 0 {
        var zero T
        return zero, false
    }
    return s[len(s)-1], true
}

func (s TypedSlice[T]) ForEach(f func(int, T)) {
    for i, v := range s {
        f(i, v)
    }
}

func (s TypedSlice[T]) Contains(f func(T) bool) bool {
    for _, v := range s {
        if f(v) {
            return true
        }
    }
    return false
}

// SortableSlice adds ordering to TypedSlice
type SortableSlice[T interface{ ~int | ~float64 | ~string }] []T

func (s SortableSlice[T]) Sort() SortableSlice[T] {
    result := make(SortableSlice[T], len(s))
    copy(result, s)
    sort.Slice(result, func(i, j int) bool {
        return result[i] < result[j]
    })
    return result
}

func (s SortableSlice[T]) Min() (T, bool) {
    if len(s) == 0 {
        var zero T
        return zero, false
    }
    min := s[0]
    for _, v := range s[1:] {
        if v < min {
            min = v
        }
    }
    return min, true
}

func (s SortableSlice[T]) Max() (T, bool) {
    if len(s) == 0 {
        var zero T
        return zero, false
    }
    max := s[0]
    for _, v := range s[1:] {
        if v > max {
            max = v
        }
    }
    return max, true
}

func main() {
    nums := SortableSlice[int]{5, 2, 8, 1, 9, 3}

    sorted := nums.Sort()
    fmt.Println("Sorted:", sorted)  // [1 2 3 5 8 9]

    min, _ := nums.Min()
    max, _ := nums.Max()
    fmt.Printf("Min: %d, Max: %d\n", min, max)  // Min: 1, Max: 9

    words := TypedSlice[string]{"hello", "world", "go"}
    words.ForEach(func(i int, s string) {
        fmt.Printf("[%d] = %s\n", i, s)
    })

    hasLong := words.Contains(func(s string) bool {
        return len(s) > 4
    })
    fmt.Println("Has long word:", hasLong)  // true
}
```

## Section 7: Building Type-Safe Collections

### Generic Ordered Map

```go
package collections

import (
    "cmp"
    "iter"
)

// OrderedMap maintains insertion order while providing O(1) lookups
type OrderedMap[K comparable, V any] struct {
    keys   []K
    values map[K]V
}

func NewOrderedMap[K comparable, V any]() *OrderedMap[K, V] {
    return &OrderedMap[K, V]{
        keys:   make([]K, 0),
        values: make(map[K]V),
    }
}

func (m *OrderedMap[K, V]) Set(key K, value V) {
    if _, exists := m.values[key]; !exists {
        m.keys = append(m.keys, key)
    }
    m.values[key] = value
}

func (m *OrderedMap[K, V]) Get(key K) (V, bool) {
    v, ok := m.values[key]
    return v, ok
}

func (m *OrderedMap[K, V]) Delete(key K) {
    if _, exists := m.values[key]; !exists {
        return
    }
    delete(m.values, key)
    for i, k := range m.keys {
        if k == key {
            m.keys = append(m.keys[:i], m.keys[i+1:]...)
            break
        }
    }
}

func (m *OrderedMap[K, V]) Keys() []K {
    result := make([]K, len(m.keys))
    copy(result, m.keys)
    return result
}

func (m *OrderedMap[K, V]) Values() []V {
    result := make([]V, len(m.keys))
    for i, k := range m.keys {
        result[i] = m.values[k]
    }
    return result
}

func (m *OrderedMap[K, V]) Len() int {
    return len(m.keys)
}

// All returns an iterator over key-value pairs (Go 1.23+)
func (m *OrderedMap[K, V]) All() iter.Seq2[K, V] {
    return func(yield func(K, V) bool) {
        for _, k := range m.keys {
            if !yield(k, m.values[k]) {
                return
            }
        }
    }
}
```

### Generic Priority Queue

```go
package collections

import "container/heap"

// PriorityQueue implements a generic min-heap
type PriorityQueue[T any] struct {
    items    []T
    lessFunc func(a, b T) bool
}

func NewPriorityQueue[T any](less func(a, b T) bool) *PriorityQueue[T] {
    pq := &PriorityQueue[T]{
        lessFunc: less,
    }
    heap.Init(pq)
    return pq
}

func (pq *PriorityQueue[T]) Len() int { return len(pq.items) }

func (pq *PriorityQueue[T]) Less(i, j int) bool {
    return pq.lessFunc(pq.items[i], pq.items[j])
}

func (pq *PriorityQueue[T]) Swap(i, j int) {
    pq.items[i], pq.items[j] = pq.items[j], pq.items[i]
}

func (pq *PriorityQueue[T]) Push(x interface{}) {
    pq.items = append(pq.items, x.(T))
}

func (pq *PriorityQueue[T]) Pop() interface{} {
    n := len(pq.items)
    item := pq.items[n-1]
    pq.items = pq.items[:n-1]
    return item
}

func (pq *PriorityQueue[T]) Enqueue(item T) {
    heap.Push(pq, item)
}

func (pq *PriorityQueue[T]) Dequeue() (T, bool) {
    if pq.Len() == 0 {
        var zero T
        return zero, false
    }
    return heap.Pop(pq).(T), true
}

func (pq *PriorityQueue[T]) Peek() (T, bool) {
    if pq.Len() == 0 {
        var zero T
        return zero, false
    }
    return pq.items[0], true
}
```

### Generic Ring Buffer

```go
package collections

import "fmt"

// RingBuffer is a fixed-capacity circular buffer
type RingBuffer[T any] struct {
    data     []T
    head     int
    tail     int
    count    int
    capacity int
}

func NewRingBuffer[T any](capacity int) *RingBuffer[T] {
    return &RingBuffer[T]{
        data:     make([]T, capacity),
        capacity: capacity,
    }
}

func (r *RingBuffer[T]) Write(item T) error {
    if r.count == r.capacity {
        return fmt.Errorf("ring buffer full (capacity: %d)", r.capacity)
    }
    r.data[r.tail] = item
    r.tail = (r.tail + 1) % r.capacity
    r.count++
    return nil
}

func (r *RingBuffer[T]) Read() (T, error) {
    if r.count == 0 {
        var zero T
        return zero, fmt.Errorf("ring buffer empty")
    }
    item := r.data[r.head]
    r.head = (r.head + 1) % r.capacity
    r.count--
    return item, nil
}

func (r *RingBuffer[T]) Peek() (T, error) {
    if r.count == 0 {
        var zero T
        return zero, fmt.Errorf("ring buffer empty")
    }
    return r.data[r.head], nil
}

func (r *RingBuffer[T]) Len() int      { return r.count }
func (r *RingBuffer[T]) Cap() int      { return r.capacity }
func (r *RingBuffer[T]) IsFull() bool  { return r.count == r.capacity }
func (r *RingBuffer[T]) IsEmpty() bool { return r.count == 0 }
```

## Section 8: Interface Embedding in Constraints

You can compose constraints from multiple interfaces:

```go
package main

import (
    "encoding/json"
    "fmt"
)

// Serializable types must support JSON marshaling
type Serializable interface {
    json.Marshaler
    json.Unmarshaler
}

// Identifiable types have a unique ID
type Identifiable[K comparable] interface {
    ID() K
}

// Entity combines identification and serialization
type Entity[K comparable] interface {
    Identifiable[K]
    Serializable
}

// Repository is a generic CRUD store for any Entity
type Repository[K comparable, V Entity[K]] struct {
    store map[K]V
}

func NewRepository[K comparable, V Entity[K]]() *Repository[K, V] {
    return &Repository[K, V]{
        store: make(map[K]V),
    }
}

func (r *Repository[K, V]) Save(entity V) {
    r.store[entity.ID()] = entity
}

func (r *Repository[K, V]) Find(id K) (V, bool) {
    v, ok := r.store[id]
    return v, ok
}

func (r *Repository[K, V]) Delete(id K) {
    delete(r.store, id)
}

func (r *Repository[K, V]) List() []V {
    result := make([]V, 0, len(r.store))
    for _, v := range r.store {
        result = append(result, v)
    }
    return result
}

// Example Entity implementation
type User struct {
    UserID string `json:"id"`
    Name   string `json:"name"`
    Email  string `json:"email"`
}

func (u User) ID() string { return u.UserID }

func (u User) MarshalJSON() ([]byte, error) {
    type Alias User
    return json.Marshal(Alias(u))
}

func (u *User) UnmarshalJSON(data []byte) error {
    type Alias User
    return json.Unmarshal(data, (*Alias)(u))
}

func main() {
    repo := NewRepository[string, *User]()

    repo.Save(&User{UserID: "1", Name: "Alice", Email: "alice@example.com"})
    repo.Save(&User{UserID: "2", Name: "Bob", Email: "bob@example.com"})

    user, ok := repo.Find("1")
    if ok {
        fmt.Printf("Found: %s (%s)\n", user.Name, user.Email)
    }

    all := repo.List()
    fmt.Printf("Total users: %d\n", len(all))
}
```

## Section 9: Generic Error Handling Patterns

```go
package result

import "fmt"

// Result is a generic Either monad for error handling
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

func Errf[T any](format string, args ...any) Result[T] {
    return Err[T](fmt.Errorf(format, args...))
}

func (r Result[T]) IsOk() bool    { return r.err == nil }
func (r Result[T]) IsErr() bool   { return r.err != nil }
func (r Result[T]) Error() error  { return r.err }

func (r Result[T]) Unwrap() T {
    if r.err != nil {
        panic(fmt.Sprintf("called Unwrap on error result: %v", r.err))
    }
    return r.value
}

func (r Result[T]) UnwrapOr(defaultValue T) T {
    if r.err != nil {
        return defaultValue
    }
    return r.value
}

func (r Result[T]) Must() T {
    if r.err != nil {
        panic(r.err)
    }
    return r.value
}

// Map transforms the value inside a Result
func Map[T any, U any](r Result[T], f func(T) U) Result[U] {
    if r.err != nil {
        return Err[U](r.err)
    }
    return Ok(f(r.value))
}

// FlatMap chains Results
func FlatMap[T any, U any](r Result[T], f func(T) Result[U]) Result[U] {
    if r.err != nil {
        return Err[U](r.err)
    }
    return f(r.value)
}

// Collect converts a slice of Results to a Result of slice
func Collect[T any](results []Result[T]) Result[[]T] {
    values := make([]T, 0, len(results))
    for i, r := range results {
        if r.err != nil {
            return Errf[[]T]("element %d failed: %w", i, r.err)
        }
        values = append(values, r.value)
    }
    return Ok(values)
}
```

### Usage Example

```go
package main

import (
    "fmt"
    "strconv"

    "yourmodule/result"
)

func parseID(s string) result.Result[int] {
    id, err := strconv.Atoi(s)
    if err != nil {
        return result.Errf[int]("invalid id %q: %w", s, err)
    }
    if id <= 0 {
        return result.Errf[int]("id must be positive, got %d", id)
    }
    return result.Ok(id)
}

func fetchUser(id int) result.Result[string] {
    // Simulate a database call
    users := map[int]string{1: "Alice", 2: "Bob"}
    user, ok := users[id]
    if !ok {
        return result.Errf[string]("user %d not found", id)
    }
    return result.Ok(user)
}

func main() {
    // Chain operations
    name := result.FlatMap(parseID("2"), fetchUser)
    fmt.Println(name.UnwrapOr("unknown"))  // Bob

    // Error propagation
    badResult := result.FlatMap(parseID("xyz"), fetchUser)
    fmt.Println(badResult.IsErr())         // true
    fmt.Println(badResult.Error())         // invalid id "xyz": ...

    // Map transforms
    upper := result.Map(
        result.FlatMap(parseID("1"), fetchUser),
        func(s string) string { return "[" + s + "]" },
    )
    fmt.Println(upper.Unwrap())  // [Alice]
}
```

## Section 10: Common Pitfalls and How to Avoid Them

### Pitfall 1: Type Parameters Cannot Be Used in Type Switches

```go
// This does NOT work — cannot use type parameter in type switch
func Describe[T any](v T) string {
    switch v := any(v).(type) {  // Must convert to any first
    case int:
        return fmt.Sprintf("int: %d", v)
    case string:
        return fmt.Sprintf("string: %s", v)
    default:
        return fmt.Sprintf("unknown: %v", v)
    }
}
// Note: converting to any() loses the generic typing — use this sparingly
```

### Pitfall 2: Cannot Instantiate T Directly

```go
// Wrong — cannot use new(T) when T is constrained to an interface
// that has pointer receivers
type Repository[T interface{ Load() error }] struct{}

// If T is *MyStruct, you need to handle this carefully:
func New[T any, PT interface {
    *T
    Load() error
}]() PT {
    t := new(T)
    pt := PT(t)
    return pt
}
```

### Pitfall 3: Nil Zero Values

```go
// The zero value of a type parameter may be nil (for pointer/interface types)
// Use a zero-value check pattern
func FirstNonZero[T comparable](values ...T) (T, bool) {
    var zero T
    for _, v := range values {
        if v != zero {
            return v, true
        }
    }
    return zero, false
}

// Usage
name, ok := FirstNonZero("", "Alice", "Bob")
fmt.Println(name, ok)  // Alice, true
```

### Pitfall 4: Method Constraints Cannot Refer to Type Parameters

```go
// This is NOT valid — methods cannot have their own type parameters
// type MyType[T any] struct{}
// func (m MyType[T]) Transform[U any](f func(T) U) U { ... }

// Instead, use a package-level function
func Transform[T any, U any](m MyType[T], f func(T) U) U {
    return f(m.value)
}
```

## Summary

Go generics with type set constraints offer a powerful model for writing reusable, type-safe code:

- **Type sets** define which types satisfy a constraint — both through union types and method requirements.
- **`~T` (tilde)** extends a constraint to include all types with the given underlying type, enabling generics to work with user-defined types.
- **`comparable`** is the right constraint when you need map keys or equality comparisons.
- **`any`** is the widest constraint — use it when you only need to store and retrieve values.
- **Union types** like `~int | ~float64 | ~string` enable arithmetic and comparison operators in generic functions.
- **Generic methods** are limited to using the receiver type's type parameters — use package-level functions for additional type parameters.
- **Type-safe collections** (Set, OrderedMap, PriorityQueue, RingBuffer) are among the highest-value applications of generics in enterprise codebases.

The golang.org/x/exp/constraints package provides the canonical definitions of Ordered, Integer, Float, and related constraints — use these instead of defining your own when they fit your needs.
