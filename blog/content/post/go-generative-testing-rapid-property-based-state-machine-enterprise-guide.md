---
title: "Go Generative Testing with rapid: Property-Based Testing, Generators, Shrinking, and State Machine Testing"
date: 2031-12-16T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "Property-Based Testing", "rapid", "State Machines", "Quality Assurance", "TDD"]
categories:
- Go
- Testing
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into property-based testing in Go using the rapid framework, covering generator composition, automatic shrinking, and state machine testing for complex enterprise systems."
more_link: "yes"
url: "/go-generative-testing-rapid-property-based-state-machine-enterprise-guide/"
---

Property-based testing is one of the most powerful quality assurance techniques available to software engineers, yet it remains underutilized in Go codebases. Where example-based tests verify that specific inputs produce specific outputs, property-based tests verify that invariants hold across an entire domain of generated inputs. The `pgregory.net/rapid` library brings first-class property-based testing to Go with composable generators, automatic counterexample shrinking, and a state machine testing framework that can model complex concurrent systems.

This guide covers rapid from first principles through advanced patterns used in enterprise Go services.

<!--more-->

# Go Generative Testing with rapid: Property-Based Testing, Generators, Shrinking, and State Machines

## Section 1: Why Property-Based Testing

### 1.1 The Limits of Example-Based Tests

Consider a function that encodes and decodes data:

```go
func TestRoundTrip(t *testing.T) {
    input := "hello world"
    encoded := Encode(input)
    decoded, err := Decode(encoded)
    if err != nil {
        t.Fatal(err)
    }
    if decoded != input {
        t.Errorf("round-trip failed: got %q, want %q", decoded, input)
    }
}
```

This test passes. But it only tests one string. What about empty strings, strings with Unicode, strings containing null bytes, strings longer than 64KB, strings that happen to look like the encoded format itself?

A property-based test states: "for all strings, encoding then decoding must return the original string."

```go
func TestRoundTripProperty(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        input := rapid.String().Draw(t, "input")
        encoded := Encode(input)
        decoded, err := Decode(encoded)
        if err != nil {
            t.Fatalf("decode error for input %q: %v", input, err)
        }
        if decoded != input {
            t.Errorf("round-trip failed: got %q, want %q", decoded, input)
        }
    })
}
```

rapid runs this test with hundreds of randomly generated strings, and if it finds a failure, it automatically shrinks the failing input to the minimal counterexample.

### 1.2 Installing rapid

```bash
go get pgregory.net/rapid@latest
```

rapid has zero external dependencies and integrates directly with `testing.T`.

## Section 2: Core Generator Primitives

### 2.1 Scalar Generators

```go
package generators_test

import (
    "testing"
    "pgregory.net/rapid"
)

func TestScalarGenerators(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        // Integer generators
        i := rapid.Int().Draw(t, "i")
        _ = i

        // Bounded integers
        small := rapid.IntRange(1, 100).Draw(t, "small")
        _ = small

        // Unsigned
        u := rapid.Uint64Range(0, 1<<32).Draw(t, "u")
        _ = u

        // Float
        f := rapid.Float64().Draw(t, "f")
        _ = f

        // String
        s := rapid.String().Draw(t, "s")
        _ = s

        // String with constraints
        alpha := rapid.StringMatching(`[a-zA-Z]+`).Draw(t, "alpha")
        _ = alpha

        // Boolean
        b := rapid.Bool().Draw(t, "b")
        _ = b

        // Byte slice
        data := rapid.SliceOf(rapid.Byte()).Draw(t, "data")
        _ = data
    })
}
```

### 2.2 Collection Generators

```go
func TestCollectionGenerators(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        // Slice of strings
        words := rapid.SliceOf(rapid.String()).Draw(t, "words")
        _ = words

        // Bounded slice
        items := rapid.SliceOfN(rapid.Int(), 1, 10).Draw(t, "items")
        _ = items

        // Map
        m := rapid.MapOf(
            rapid.StringMatching(`[a-z]+`),
            rapid.IntRange(0, 1000),
        ).Draw(t, "m")
        _ = m

        // Distinct values
        unique := rapid.SliceOfNDistinct(
            rapid.IntRange(0, 100),
            5, 10,
            func(v int) int { return v },
        ).Draw(t, "unique")
        _ = unique
    })
}
```

### 2.3 Custom Domain Generators

```go
// Domain model
type UserID string
type Email string
type Role string

const (
    RoleAdmin    Role = "admin"
    RoleEditor   Role = "editor"
    RoleViewer   Role = "viewer"
)

type User struct {
    ID    UserID
    Email Email
    Role  Role
    Age   int
}

// Generator functions
func GenUserID() *rapid.Generator[UserID] {
    return rapid.Custom(func(t *rapid.T) UserID {
        suffix := rapid.StringMatching(`[a-z0-9]{8}`).Draw(t, "id_suffix")
        return UserID("usr_" + suffix)
    })
}

func GenEmail() *rapid.Generator[Email] {
    return rapid.Custom(func(t *rapid.T) Email {
        localPart := rapid.StringMatching(`[a-z][a-z0-9]{2,15}`).Draw(t, "local")
        domain := rapid.SampledFrom([]string{
            "example.com", "test.org", "corp.internal",
        }).Draw(t, "domain")
        return Email(localPart + "@" + domain)
    })
}

func GenRole() *rapid.Generator[Role] {
    return rapid.SampledFrom([]Role{RoleAdmin, RoleEditor, RoleViewer})
}

func GenUser() *rapid.Generator[User] {
    return rapid.Custom(func(t *rapid.T) User {
        return User{
            ID:    GenUserID().Draw(t, "id"),
            Email: GenEmail().Draw(t, "email"),
            Role:  GenRole().Draw(t, "role"),
            Age:   rapid.IntRange(18, 120).Draw(t, "age"),
        }
    })
}

func TestUserValidation(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        user := GenUser().Draw(t, "user")
        // Property: all generated users should pass validation
        if err := ValidateUser(user); err != nil {
            t.Fatalf("generated user %+v failed validation: %v", user, err)
        }
    })
}
```

## Section 3: Defining and Testing Properties

### 3.1 Algebraic Properties

Many data structures and algorithms have algebraic properties that must hold universally:

```go
package algebra_test

import (
    "sort"
    "testing"
    "pgregory.net/rapid"
)

// Property: sorting is idempotent
func TestSortIdempotent(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        xs := rapid.SliceOf(rapid.Int()).Draw(t, "xs")

        once := make([]int, len(xs))
        copy(once, xs)
        sort.Ints(once)

        twice := make([]int, len(once))
        copy(twice, once)
        sort.Ints(twice)

        for i := range once {
            if once[i] != twice[i] {
                t.Fatalf("sort not idempotent at index %d: once=%v twice=%v", i, once, twice)
            }
        }
    })
}

// Property: sorted slice is ordered and has same elements as input
func TestSortOrdering(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        xs := rapid.SliceOf(rapid.IntRange(-1000, 1000)).Draw(t, "xs")

        sorted := make([]int, len(xs))
        copy(sorted, xs)
        sort.Ints(sorted)

        // All adjacent pairs must be ordered
        for i := 1; i < len(sorted); i++ {
            if sorted[i] < sorted[i-1] {
                t.Fatalf("not sorted at index %d: %v[%d]=%d > %v[%d]=%d",
                    i, sorted, i-1, sorted[i-1], sorted, i, sorted[i])
            }
        }

        // Same multiset (sum as a weak proxy for same elements)
        var sumIn, sumOut int
        for _, v := range xs { sumIn += v }
        for _, v := range sorted { sumOut += v }
        if sumIn != sumOut {
            t.Fatalf("sort changed elements: input sum=%d output sum=%d", sumIn, sumOut)
        }
    })
}
```

### 3.2 Encoding/Decoding Properties

```go
package codec_test

import (
    "encoding/json"
    "testing"
    "pgregory.net/rapid"
)

type Order struct {
    ID       string
    Items    []LineItem
    Total    float64
    Currency string
}

type LineItem struct {
    SKU      string
    Quantity int
    Price    float64
}

func GenLineItem() *rapid.Generator[LineItem] {
    return rapid.Custom(func(t *rapid.T) LineItem {
        return LineItem{
            SKU:      rapid.StringMatching(`[A-Z]{2}[0-9]{6}`).Draw(t, "sku"),
            Quantity: rapid.IntRange(1, 999).Draw(t, "qty"),
            Price:    rapid.Float64Range(0.01, 9999.99).Draw(t, "price"),
        }
    })
}

func GenOrder() *rapid.Generator[Order] {
    return rapid.Custom(func(t *rapid.T) Order {
        items := rapid.SliceOfN(GenLineItem(), 1, 20).Draw(t, "items")
        var total float64
        for _, item := range items {
            total += float64(item.Quantity) * item.Price
        }
        return Order{
            ID:       rapid.StringMatching(`ORD-[0-9]{8}`).Draw(t, "id"),
            Items:    items,
            Total:    total,
            Currency: rapid.SampledFrom([]string{"USD", "EUR", "GBP"}).Draw(t, "currency"),
        }
    })
}

func TestOrderJSONRoundTrip(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        original := GenOrder().Draw(t, "order")

        data, err := json.Marshal(original)
        if err != nil {
            t.Fatalf("marshal error: %v", err)
        }

        var decoded Order
        if err := json.Unmarshal(data, &decoded); err != nil {
            t.Fatalf("unmarshal error: %v", err)
        }

        if original.ID != decoded.ID {
            t.Errorf("ID mismatch: %q != %q", original.ID, decoded.ID)
        }
        if original.Currency != decoded.Currency {
            t.Errorf("currency mismatch: %q != %q", original.Currency, decoded.Currency)
        }
        if len(original.Items) != len(decoded.Items) {
            t.Errorf("item count mismatch: %d != %d", len(original.Items), len(decoded.Items))
        }
    })
}
```

### 3.3 Commutativity and Associativity

```go
// For a set implementation, union must be commutative and associative
type IntSet map[int]struct{}

func NewIntSet(vals ...int) IntSet {
    s := make(IntSet)
    for _, v := range vals {
        s[v] = struct{}{}
    }
    return s
}

func (s IntSet) Union(other IntSet) IntSet {
    result := make(IntSet)
    for k := range s { result[k] = struct{}{} }
    for k := range other { result[k] = struct{}{} }
    return result
}

func (s IntSet) Equals(other IntSet) bool {
    if len(s) != len(other) { return false }
    for k := range s {
        if _, ok := other[k]; !ok { return false }
    }
    return true
}

func GenIntSet() *rapid.Generator[IntSet] {
    return rapid.Custom(func(t *rapid.T) IntSet {
        elems := rapid.SliceOfN(rapid.IntRange(0, 50), 0, 20).Draw(t, "elems")
        return NewIntSet(elems...)
    })
}

func TestUnionCommutativity(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        a := GenIntSet().Draw(t, "a")
        b := GenIntSet().Draw(t, "b")

        ab := a.Union(b)
        ba := b.Union(a)

        if !ab.Equals(ba) {
            t.Errorf("union not commutative: A∪B=%v, B∪A=%v", ab, ba)
        }
    })
}

func TestUnionAssociativity(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        a := GenIntSet().Draw(t, "a")
        b := GenIntSet().Draw(t, "b")
        c := GenIntSet().Draw(t, "c")

        left := a.Union(b).Union(c)
        right := a.Union(b.Union(c))

        if !left.Equals(right) {
            t.Errorf("union not associative: (A∪B)∪C != A∪(B∪C)")
        }
    })
}
```

## Section 4: Automatic Shrinking

### 4.1 How Shrinking Works in rapid

When rapid finds a failing test case, it automatically attempts to simplify the input while preserving the failure. This process is called shrinking. rapid uses integrated shrinking, meaning each generator knows how to shrink its own output.

For example, if an integer generator produces the value 12345 and the test fails, rapid will try:
- 0, 1, -1, 2, -2, ..., 6172, 12344 — progressively simpler values

For slices, it will try removing elements and shrinking element values simultaneously.

```go
// Demonstrate shrinking: find the smallest failing input
func TestShrinkingDemo(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        xs := rapid.SliceOfN(rapid.IntRange(0, 1000), 1, 100).Draw(t, "xs")

        // Property: no element is divisible by 7
        // (will fail for many inputs, but shrinking will find the
        // minimal counterexample: a slice containing 7, or 14, etc.)
        for _, x := range xs {
            if x%7 == 0 && x != 0 {
                t.Fatalf("found value divisible by 7: %d in %v", x, xs)
            }
        }
    })
}
// After shrinking, the reported counterexample will be something like [7]
// rather than a large slice with many elements.
```

### 4.2 Custom Shrinking for Domain Types

For complex domain objects where the default shrinking is insufficient, implement custom shrink logic:

```go
type TreeNode struct {
    Value    int
    Children []*TreeNode
}

func GenTree(maxDepth int) *rapid.Generator[*TreeNode] {
    return rapid.Custom(func(t *rapid.T) *TreeNode {
        value := rapid.IntRange(0, 100).Draw(t, "value")
        node := &TreeNode{Value: value}

        if maxDepth > 0 {
            numChildren := rapid.IntRange(0, 3).Draw(t, "num_children")
            for i := 0; i < numChildren; i++ {
                child := GenTree(maxDepth - 1).Draw(t, fmt.Sprintf("child_%d", i))
                node.Children = append(node.Children, child)
            }
        }

        return node
    })
}

func countNodes(node *TreeNode) int {
    if node == nil { return 0 }
    count := 1
    for _, child := range node.Children {
        count += countNodes(child)
    }
    return count
}

func TestTreeProperty(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        tree := GenTree(5).Draw(t, "tree")

        // Property: in-order traversal produces same count as countNodes
        var collected []int
        var inOrder func(n *TreeNode)
        inOrder = func(n *TreeNode) {
            if n == nil { return }
            for _, c := range n.Children {
                inOrder(c)
            }
            collected = append(collected, n.Value)
        }
        inOrder(tree)

        if len(collected) != countNodes(tree) {
            t.Errorf("traversal count %d != node count %d",
                len(collected), countNodes(tree))
        }
    })
}
```

## Section 5: State Machine Testing

### 5.1 State Machine Testing Fundamentals

State machine testing models a system as a state machine where:
- **State** is the current snapshot of the system under test
- **Commands** are operations that transition the system between states
- **Invariants** are properties that must hold after every command

rapid's `MakeStateMachine` framework runs sequences of randomly generated commands against both your implementation and a reference model.

### 5.2 Testing a Key-Value Store

```go
package kvstore_test

import (
    "testing"
    "pgregory.net/rapid"
)

// System under test (a more complex implementation)
type KVStore struct {
    data    map[string]string
    maxSize int
}

func NewKVStore(maxSize int) *KVStore {
    return &KVStore{
        data:    make(map[string]string),
        maxSize: maxSize,
    }
}

func (s *KVStore) Set(key, value string) error {
    if len(s.data) >= s.maxSize && s.data[key] == "" {
        return fmt.Errorf("store is full")
    }
    s.data[key] = value
    return nil
}

func (s *KVStore) Get(key string) (string, bool) {
    v, ok := s.data[key]
    return v, ok
}

func (s *KVStore) Delete(key string) {
    delete(s.data, key)
}

func (s *KVStore) Size() int {
    return len(s.data)
}

// Reference model (simple, obviously correct implementation)
type KVModel struct {
    data map[string]string
}

func NewKVModel() *KVModel {
    return &KVModel{data: make(map[string]string)}
}

// State machine
type KVStateMachine struct {
    store *KVStore
    model *KVModel
}

func (sm *KVStateMachine) Init(t *rapid.T) {
    maxSize := rapid.IntRange(1, 20).Draw(t, "max_size")
    sm.store = NewKVStore(maxSize)
    sm.model = NewKVModel()
}

// Ensure invariants hold after each command
func (sm *KVStateMachine) Invariant(t *rapid.T) {
    // Invariant: store and model must agree on all keys
    for key, modelVal := range sm.model.data {
        storeVal, ok := sm.store.Get(key)
        if !ok {
            t.Errorf("key %q in model but not in store", key)
        } else if storeVal != modelVal {
            t.Errorf("key %q: model=%q store=%q", key, modelVal, storeVal)
        }
    }

    // Invariant: sizes must match
    if sm.store.Size() != len(sm.model.data) {
        t.Errorf("size mismatch: store=%d model=%d",
            sm.store.Size(), len(sm.model.data))
    }
}

// Command generators
func GenKey() *rapid.Generator[string] {
    // Use a small key space to increase collision probability
    return rapid.SampledFrom([]string{"a", "b", "c", "d", "e", "f", "g", "h"})
}

func GenValue() *rapid.Generator[string] {
    return rapid.StringMatching(`[a-z0-9]{1,20}`)
}

// Set command
func (sm *KVStateMachine) Set(t *rapid.T) {
    key := GenKey().Draw(t, "key")
    value := GenValue().Draw(t, "value")

    storeErr := sm.store.Set(key, value)

    if storeErr == nil {
        sm.model.data[key] = value
    }
    // If the store is full, we don't update the model
    // The invariant will catch any inconsistency
}

// Get command
func (sm *KVStateMachine) Get(t *rapid.T) {
    key := GenKey().Draw(t, "key")

    storeVal, storeOK := sm.store.Get(key)
    modelVal, modelOK := sm.model.data[key]

    if storeOK != modelOK {
        t.Errorf("Get(%q): store ok=%v model ok=%v", key, storeOK, modelOK)
    }
    if storeOK && storeVal != modelVal {
        t.Errorf("Get(%q): store=%q model=%q", key, storeVal, modelVal)
    }
}

// Delete command
func (sm *KVStateMachine) Delete(t *rapid.T) {
    key := GenKey().Draw(t, "key")
    sm.store.Delete(key)
    delete(sm.model.data, key)
}

func TestKVStoreStateMachine(t *testing.T) {
    rapid.Check(t, rapid.Run[*KVStateMachine]())
}
```

### 5.3 Testing a Distributed Counter (CRDT)

```go
// G-Counter CRDT - grows-only distributed counter
type GCounter struct {
    id      string
    counts  map[string]int
}

func NewGCounter(id string) *GCounter {
    return &GCounter{
        id:     id,
        counts: map[string]int{id: 0},
    }
}

func (c *GCounter) Increment() {
    c.counts[c.id]++
}

func (c *GCounter) Value() int {
    total := 0
    for _, v := range c.counts { total += v }
    return total
}

func (c *GCounter) Merge(other *GCounter) {
    for id, count := range other.counts {
        if count > c.counts[id] {
            c.counts[id] = count
        }
    }
}

type GCounterStateMachine struct {
    counters []*GCounter
    expected int // simple reference model
}

func (sm *GCounterStateMachine) Init(t *rapid.T) {
    n := rapid.IntRange(2, 5).Draw(t, "num_counters")
    sm.counters = make([]*GCounter, n)
    for i := range sm.counters {
        sm.counters[i] = NewGCounter(fmt.Sprintf("node-%d", i))
    }
    sm.expected = 0
}

func (sm *GCounterStateMachine) Invariant(t *rapid.T) {
    // After a full merge of all counters, the value should equal
    // the total number of increments performed
    if len(sm.counters) == 0 { return }

    merged := NewGCounter("merged")
    for _, c := range sm.counters {
        merged.Merge(c)
    }

    if merged.Value() != sm.expected {
        t.Errorf("merged value %d != expected %d", merged.Value(), sm.expected)
    }
}

func (sm *GCounterStateMachine) Increment(t *rapid.T) {
    idx := rapid.IntRange(0, len(sm.counters)-1).Draw(t, "node_idx")
    sm.counters[idx].Increment()
    sm.expected++
}

func (sm *GCounterStateMachine) Merge(t *rapid.T) {
    i := rapid.IntRange(0, len(sm.counters)-1).Draw(t, "from")
    j := rapid.IntRange(0, len(sm.counters)-1).Draw(t, "to")
    if i == j { return }
    // Merge node i into node j
    sm.counters[j].Merge(sm.counters[i])
    // No change to expected — merge doesn't add increments
}

func TestGCounterCRDT(t *testing.T) {
    rapid.Check(t, rapid.Run[*GCounterStateMachine]())
}
```

### 5.4 Testing HTTP API State Transitions

```go
// State machine for an HTTP order management API
type OrderAPIStateMachine struct {
    client   *httptest.Server
    orders   map[string]string // id -> status
    apiURL   string
}

type CreateOrderRequest struct {
    CustomerID string  `json:"customer_id"`
    Amount     float64 `json:"amount"`
}

type OrderResponse struct {
    ID     string `json:"id"`
    Status string `json:"status"`
}

func (sm *OrderAPIStateMachine) Init(t *rapid.T) {
    handler := SetupOrderHandler() // your real handler
    sm.client = httptest.NewServer(handler)
    sm.apiURL = sm.client.URL
    sm.orders = make(map[string]string)
}

func (sm *OrderAPIStateMachine) Cleanup() {
    sm.client.Close()
}

func (sm *OrderAPIStateMachine) CreateOrder(t *rapid.T) {
    req := CreateOrderRequest{
        CustomerID: rapid.StringMatching(`cust-[0-9]{4}`).Draw(t, "customer_id"),
        Amount:     rapid.Float64Range(1.0, 10000.0).Draw(t, "amount"),
    }

    body, _ := json.Marshal(req)
    resp, err := http.Post(sm.apiURL+"/orders", "application/json", bytes.NewReader(body))
    if err != nil {
        t.Fatalf("POST /orders failed: %v", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusCreated {
        t.Fatalf("expected 201, got %d", resp.StatusCode)
    }

    var order OrderResponse
    json.NewDecoder(resp.Body).Decode(&order)
    sm.orders[order.ID] = "pending"
}

func (sm *OrderAPIStateMachine) ConfirmOrder(t *rapid.T) {
    pendingOrders := sm.ordersWithStatus("pending")
    if len(pendingOrders) == 0 {
        t.Skip("no pending orders")
        return
    }

    id := rapid.SampledFrom(pendingOrders).Draw(t, "order_id")
    resp, err := http.Post(sm.apiURL+"/orders/"+id+"/confirm", "", nil)
    if err != nil {
        t.Fatalf("POST confirm failed: %v", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode == http.StatusOK {
        sm.orders[id] = "confirmed"
    }
}

func (sm *OrderAPIStateMachine) CancelOrder(t *rapid.T) {
    cancelableOrders := sm.ordersWithStatus("pending")
    if len(cancelableOrders) == 0 {
        t.Skip("no cancelable orders")
        return
    }

    id := rapid.SampledFrom(cancelableOrders).Draw(t, "order_id")
    req, _ := http.NewRequest(http.MethodDelete, sm.apiURL+"/orders/"+id, nil)
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        t.Fatalf("DELETE order failed: %v", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode == http.StatusOK {
        sm.orders[id] = "cancelled"
    }
}

func (sm *OrderAPIStateMachine) Invariant(t *rapid.T) {
    // Invariant: listing all orders returns consistent state
    resp, err := http.Get(sm.apiURL + "/orders")
    if err != nil {
        t.Fatalf("GET /orders failed: %v", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        t.Fatalf("GET /orders returned %d", resp.StatusCode)
    }

    var listedOrders []OrderResponse
    json.NewDecoder(resp.Body).Decode(&listedOrders)

    // All orders in model must exist in listing
    listedMap := make(map[string]string)
    for _, o := range listedOrders {
        listedMap[o.ID] = o.Status
    }

    for id, modelStatus := range sm.orders {
        apiStatus, ok := listedMap[id]
        if !ok {
            t.Errorf("order %q in model but not in API listing", id)
        } else if apiStatus != modelStatus {
            t.Errorf("order %q: model status=%q API status=%q",
                id, modelStatus, apiStatus)
        }
    }
}

func (sm *OrderAPIStateMachine) ordersWithStatus(status string) []string {
    var result []string
    for id, s := range sm.orders {
        if s == status { result = append(result, id) }
    }
    return result
}

func TestOrderAPIStateMachine(t *testing.T) {
    rapid.Check(t, rapid.Run[*OrderAPIStateMachine]())
}
```

## Section 6: Advanced Generator Patterns

### 6.1 Recursive Generators

```go
// Generate valid JSON values of arbitrary depth
func GenJSONValue(maxDepth int) *rapid.Generator[interface{}] {
    return rapid.Custom(func(t *rapid.T) interface{} {
        if maxDepth <= 0 {
            // At max depth, only generate primitives
            kind := rapid.IntRange(0, 3).Draw(t, "primitive_kind")
            switch kind {
            case 0:
                return rapid.Bool().Draw(t, "bool")
            case 1:
                return rapid.Float64Range(-1e6, 1e6).Draw(t, "number")
            case 2:
                return rapid.String().Draw(t, "string")
            default:
                return nil
            }
        }

        kind := rapid.IntRange(0, 5).Draw(t, "kind")
        switch kind {
        case 0:
            return rapid.Bool().Draw(t, "bool")
        case 1:
            return rapid.Float64Range(-1e6, 1e6).Draw(t, "number")
        case 2:
            return rapid.String().Draw(t, "string")
        case 3:
            return nil
        case 4:
            // Object
            n := rapid.IntRange(0, 5).Draw(t, "obj_len")
            m := make(map[string]interface{})
            for i := 0; i < n; i++ {
                key := rapid.StringMatching(`[a-z][a-z0-9_]{0,10}`).Draw(t, fmt.Sprintf("key_%d", i))
                val := GenJSONValue(maxDepth - 1).Draw(t, fmt.Sprintf("val_%d", i))
                m[key] = val
            }
            return m
        default:
            // Array
            n := rapid.IntRange(0, 5).Draw(t, "arr_len")
            arr := make([]interface{}, n)
            for i := range arr {
                arr[i] = GenJSONValue(maxDepth - 1).Draw(t, fmt.Sprintf("elem_%d", i))
            }
            return arr
        }
    })
}

func TestJSONMarshalUnmarshal(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        value := GenJSONValue(4).Draw(t, "json_value")

        data, err := json.Marshal(value)
        if err != nil {
            t.Fatalf("marshal failed: %v", err)
        }

        var decoded interface{}
        if err := json.Unmarshal(data, &decoded); err != nil {
            t.Fatalf("unmarshal failed: %v", err)
        }

        // Re-encode and compare bytes
        data2, err := json.Marshal(decoded)
        if err != nil {
            t.Fatalf("re-marshal failed: %v", err)
        }

        if !bytes.Equal(data, data2) {
            t.Errorf("double encoding produced different results:\n  first: %s\n  second: %s",
                data, data2)
        }
    })
}
```

### 6.2 Dependent Generators

```go
// Generate a valid range (start <= end)
func GenRange() *rapid.Generator[[2]int] {
    return rapid.Custom(func(t *rapid.T) [2]int {
        start := rapid.IntRange(0, 1000).Draw(t, "start")
        end := rapid.IntRange(start, 1000).Draw(t, "end")
        return [2]int{start, end}
    })
}

// Generate a valid time range
func GenTimeRange() *rapid.Generator[[2]time.Time] {
    return rapid.Custom(func(t *rapid.T) [2]time.Time {
        epoch := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC).Unix()
        now := time.Now().Unix()
        startUnix := rapid.Int64Range(epoch, now).Draw(t, "start_unix")
        endUnix := rapid.Int64Range(startUnix, now).Draw(t, "end_unix")
        return [2]time.Time{
            time.Unix(startUnix, 0).UTC(),
            time.Unix(endUnix, 0).UTC(),
        }
    })
}
```

### 6.3 Weighted Generators

```go
// Bias towards edge cases
func GenHTTPStatus() *rapid.Generator[int] {
    return rapid.OneOf(
        rapid.Just(200),                // Common success
        rapid.Just(201),
        rapid.Just(400),                // Client errors
        rapid.Just(401),
        rapid.Just(403),
        rapid.Just(404),
        rapid.Just(429),                // Rate limiting
        rapid.Just(500),                // Server errors
        rapid.Just(502),
        rapid.Just(503),
        rapid.IntRange(200, 599),       // Any valid HTTP status
    )
}
```

## Section 7: Integration with Go Testing Infrastructure

### 7.1 Running with -count for Reliability

```bash
# Run property tests 1000 times per test
go test -run TestProperty -count=1 -rapid.checks=1000 ./...

# Run with a fixed seed for reproducibility
go test -run TestProperty -rapid.seed=12345 ./...

# Verbose output showing generated values
go test -run TestProperty -v -rapid.verbose ./...
```

### 7.2 CI/CD Integration

```yaml
# .github/workflows/property-tests.yaml
name: Property Tests

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: '0 2 * * *'  # Nightly with more iterations

jobs:
  property-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'

      - name: Run property tests (CI)
        if: github.event_name != 'schedule'
        run: |
          go test -tags property \
            -run TestProperty \
            -rapid.checks=500 \
            -timeout 5m \
            ./...

      - name: Run property tests (nightly, extended)
        if: github.event_name == 'schedule'
        run: |
          go test -tags property \
            -run TestProperty \
            -rapid.checks=5000 \
            -timeout 60m \
            ./...
```

### 7.3 Reproducing Failures

When rapid finds a failure, it prints the seed. To reproduce:

```bash
# rapid outputs something like:
# Seed 9876543210: run with -rapid.seed=9876543210

go test -run TestOrderAPIStateMachine -rapid.seed=9876543210 -v
```

## Section 8: Performance Testing with rapid

```go
func BenchmarkPropertyTest(b *testing.B) {
    // rapid works with testing.B too
    t := &testing.T{}
    for i := 0; i < b.N; i++ {
        rapid.Check(t, func(t *rapid.T) {
            input := rapid.SliceOfN(rapid.Int(), 10, 100).Draw(t, "input")
            _ = ExpensiveSort(input)
        })
    }
}
```

## Summary

The `rapid` library enables a fundamentally different approach to testing Go services. Key takeaways:

- Use `rapid.Custom` to build domain-specific generators that reflect real business constraints
- Apply algebraic properties (idempotency, commutativity, round-trip) as your first property tests
- Use state machine testing with `rapid.Run` for stateful APIs and data structures
- Integrated shrinking in rapid means failures always report the minimal counterexample
- Property tests complement, not replace, example-based tests — use both

The investment in generator infrastructure pays recurring dividends as you discover edge cases that would take months to find through manual testing or production incidents.
