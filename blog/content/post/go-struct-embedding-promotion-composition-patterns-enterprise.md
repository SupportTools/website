---
title: "Go Struct Embedding and Promotion: Composition Patterns for Enterprise Code"
date: 2031-02-23T00:00:00-05:00
draft: false
tags: ["Go", "Struct Embedding", "Composition", "Design Patterns", "Enterprise Go", "Interfaces"]
categories:
- Go
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go struct embedding mechanics, method promotion, interface embedding for mocking, composition vs inheritance trade-offs, embedding in generated code, and avoiding common embedding pitfalls in enterprise Go codebases."
more_link: "yes"
url: "/go-struct-embedding-promotion-composition-patterns-enterprise/"
---

Go lacks classical inheritance, but struct embedding provides a powerful composition mechanism that achieves most of the same goals with less coupling and better testability. Understanding embedding mechanics — method promotion, shadowing, interface embedding, and zero-value initialization — separates novice Go code from production-grade enterprise code.

This guide covers the full embedding model with real-world patterns for enterprise applications: HTTP middleware, storage backends, domain models, and generated code.

<!--more-->

# Go Struct Embedding and Promotion: Composition Patterns for Enterprise Code

## Section 1: Embedding Mechanics

When you embed a type in a struct, you get the embedded type's fields and methods promoted to the outer struct:

```go
package main

import "fmt"

type Animal struct {
    Name string
    Age  int
}

func (a Animal) Speak() string {
    return fmt.Sprintf("I am %s, age %d", a.Name, a.Age)
}

func (a Animal) Description() string {
    return fmt.Sprintf("Animal{Name:%q, Age:%d}", a.Name, a.Age)
}

type Dog struct {
    Animal          // Embedded — no field name, just the type
    Breed string
}

func main() {
    d := Dog{
        Animal: Animal{Name: "Rex", Age: 3},
        Breed:  "German Shepherd",
    }

    // Promoted fields — accessible directly
    fmt.Println(d.Name)   // Rex
    fmt.Println(d.Age)    // 3

    // Promoted methods — callable directly
    fmt.Println(d.Speak())       // I am Rex, age 3
    fmt.Println(d.Description()) // Animal{Name:"Rex", Age:3}

    // Also accessible via the embedded field name (type name)
    fmt.Println(d.Animal.Speak())  // Same result
    fmt.Println(d.Animal.Name)     // Rex
}
```

### Method Promotion Rules

Methods are promoted to the outer struct if:
1. The embedded type is not a pointer, and the method has a value receiver.
2. The embedded type IS a pointer, and the method has either a value or pointer receiver.

```go
type Base struct{}

func (b Base) ValueMethod() string  { return "value receiver" }
func (b *Base) PointerMethod() string { return "pointer receiver" }

type ValueEmbed struct {
    Base  // Embed by value
}

type PointerEmbed struct {
    *Base  // Embed by pointer
}

func main() {
    v := ValueEmbed{Base: Base{}}
    fmt.Println(v.ValueMethod())    // OK — value receiver on value embed
    fmt.Println(v.PointerMethod())  // OK — Go auto-takes address

    p := PointerEmbed{Base: &Base{}}
    fmt.Println(p.ValueMethod())    // OK — value receiver on pointer embed
    fmt.Println(p.PointerMethod())  // OK — pointer receiver on pointer embed
}
```

## Section 2: Method Shadowing

When the outer struct defines a method with the same name as a promoted method, the outer method takes precedence:

```go
package main

import "fmt"

type Logger struct {
    prefix string
}

func (l Logger) Log(msg string) {
    fmt.Printf("[%s] %s\n", l.prefix, msg)
}

func (l Logger) Error(msg string) {
    fmt.Printf("[%s] ERROR: %s\n", l.prefix, msg)
}

type AuditLogger struct {
    Logger
    auditFile string
}

// Shadows Logger.Log — called instead of Logger.Log
func (al AuditLogger) Log(msg string) {
    // Write to audit file
    fmt.Printf("AUDIT: writing to %s: %s\n", al.auditFile, msg)
    // Call the underlying logger
    al.Logger.Log(msg)
}

// AuditLogger.Error is NOT shadowed — promotes from Logger

func main() {
    al := AuditLogger{
        Logger:    Logger{prefix: "app"},
        auditFile: "/var/log/audit.log",
    }

    al.Log("user logged in")
    // AUDIT: writing to /var/log/audit.log: user logged in
    // [app] user logged in

    al.Error("connection failed")
    // [app] ERROR: connection failed  (promoted from Logger)

    // Access the embedded logger directly to bypass shadowing
    al.Logger.Log("direct log")
    // [app] direct log
}
```

### Shadowing Pitfall: Interface Satisfaction

Shadowing can break interface satisfaction if you're not careful:

```go
type Greeter interface {
    Greet() string
}

type EnglishGreeter struct{}
func (e EnglishGreeter) Greet() string { return "Hello" }

type SpecialGreeter struct {
    EnglishGreeter
}

// SpecialGreeter satisfies Greeter via promotion
var _ Greeter = SpecialGreeter{}

// BUT: if SpecialGreeter defines its own Greet with wrong signature:
// func (s SpecialGreeter) Greet(name string) string { ... }
// This would NOT satisfy Greeter (different signature)
// and would hide EnglishGreeter's Greet
```

## Section 3: Multiple Embedding and Ambiguity

Embedding multiple types with the same method name creates ambiguity:

```go
type Reader struct{}
func (r Reader) Close() error { return nil }

type Writer struct{}
func (w Writer) Close() error { return nil }

type ReadWriter struct {
    Reader
    Writer
}

// rw := ReadWriter{}
// rw.Close()  // COMPILE ERROR: ambiguous selector rw.Close
// Must use explicit selector:
// rw.Reader.Close()
// rw.Writer.Close()
```

Resolve ambiguity by providing an explicit method:

```go
type ReadWriter struct {
    Reader
    Writer
}

// Explicit method resolves ambiguity
func (rw ReadWriter) Close() error {
    if err := rw.Reader.Close(); err != nil {
        return err
    }
    return rw.Writer.Close()
}
```

## Section 4: Embedding Interfaces for Mocking and Testing

One of the most powerful embedding patterns is embedding an interface in a struct. This allows partial mock implementations without implementing every method:

```go
package main

import (
    "context"
    "fmt"
    "io"
)

// Large interface — 15 methods
type StorageBackend interface {
    Get(ctx context.Context, key string) ([]byte, error)
    Put(ctx context.Context, key string, value []byte) error
    Delete(ctx context.Context, key string) error
    List(ctx context.Context, prefix string) ([]string, error)
    Exists(ctx context.Context, key string) (bool, error)
    Copy(ctx context.Context, src, dst string) error
    Move(ctx context.Context, src, dst string) error
    GetMetadata(ctx context.Context, key string) (map[string]string, error)
    SetMetadata(ctx context.Context, key string, meta map[string]string) error
    Stream(ctx context.Context, key string) (io.ReadCloser, error)
    Upload(ctx context.Context, key string, r io.Reader) error
    GetSize(ctx context.Context, key string) (int64, error)
    ListWithMeta(ctx context.Context, prefix string) ([]StorageItem, error)
    Ping(ctx context.Context) error
    Close() error
}

type StorageItem struct {
    Key  string
    Size int64
}

// Mock struct that embeds the interface
// Any unimplemented method will panic when called (desired in tests)
type MockStorageBackend struct {
    StorageBackend  // Embed the interface — nil by default, panics if called

    // Only implement methods needed for the test
    GetFunc    func(ctx context.Context, key string) ([]byte, error)
    PutFunc    func(ctx context.Context, key string, value []byte) error
    PingFunc   func(ctx context.Context) error
    CloseFunc  func() error
}

func (m *MockStorageBackend) Get(ctx context.Context, key string) ([]byte, error) {
    if m.GetFunc == nil {
        return nil, fmt.Errorf("Get not implemented in mock")
    }
    return m.GetFunc(ctx, key)
}

func (m *MockStorageBackend) Put(ctx context.Context, key string, value []byte) error {
    if m.PutFunc == nil {
        return fmt.Errorf("Put not implemented in mock")
    }
    return m.PutFunc(ctx, key, value)
}

func (m *MockStorageBackend) Ping(ctx context.Context) error {
    if m.PingFunc == nil {
        return nil  // Default: success
    }
    return m.PingFunc(ctx)
}

func (m *MockStorageBackend) Close() error {
    if m.CloseFunc == nil {
        return nil
    }
    return m.CloseFunc()
}

// Service that depends on StorageBackend
type CacheService struct {
    backend StorageBackend
}

func NewCacheService(backend StorageBackend) *CacheService {
    return &CacheService{backend: backend}
}

func (cs *CacheService) GetOrSet(ctx context.Context, key string, loader func() ([]byte, error)) ([]byte, error) {
    data, err := cs.backend.Get(ctx, key)
    if err == nil {
        return data, nil
    }
    data, err = loader()
    if err != nil {
        return nil, fmt.Errorf("loader failed: %w", err)
    }
    if putErr := cs.backend.Put(ctx, key, data); putErr != nil {
        // Log but don't fail
        fmt.Printf("cache write failed: %v\n", putErr)
    }
    return data, nil
}

// Test example
func ExampleCacheServiceTest() {
    ctx := context.Background()

    store := map[string][]byte{}
    mock := &MockStorageBackend{
        GetFunc: func(ctx context.Context, key string) ([]byte, error) {
            v, ok := store[key]
            if !ok {
                return nil, fmt.Errorf("not found: %s", key)
            }
            return v, nil
        },
        PutFunc: func(ctx context.Context, key string, value []byte) error {
            store[key] = value
            return nil
        },
    }

    svc := NewCacheService(mock)

    // First call — loader runs
    data, err := svc.GetOrSet(ctx, "my-key", func() ([]byte, error) {
        return []byte("computed-value"), nil
    })
    fmt.Printf("First call: %s, err=%v\n", data, err)

    // Second call — returns cached value
    data, err = svc.GetOrSet(ctx, "my-key", func() ([]byte, error) {
        return []byte("this-should-not-run"), nil
    })
    fmt.Printf("Second call: %s, err=%v\n", data, err)
}
```

## Section 5: HTTP Handler Composition Pattern

Embedding is ideal for building composable HTTP middleware and handler chains:

```go
package main

import (
    "encoding/json"
    "log"
    "net/http"
    "time"
)

// BaseHandler provides common functionality for all HTTP handlers
type BaseHandler struct {
    logger  *log.Logger
    timeout time.Duration
}

func (h *BaseHandler) JSON(w http.ResponseWriter, status int, v interface{}) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    if err := json.NewEncoder(w).Encode(v); err != nil {
        h.logger.Printf("JSON encode error: %v", err)
    }
}

func (h *BaseHandler) Error(w http.ResponseWriter, status int, message string) {
    h.JSON(w, status, map[string]string{"error": message})
}

func (h *BaseHandler) NotFound(w http.ResponseWriter) {
    h.Error(w, http.StatusNotFound, "resource not found")
}

func (h *BaseHandler) InternalError(w http.ResponseWriter, err error) {
    h.logger.Printf("internal error: %v", err)
    h.Error(w, http.StatusInternalServerError, "internal server error")
}

// AuthHandler adds authentication capabilities
type AuthHandler struct {
    BaseHandler
    tokenSecret string
}

func (h *AuthHandler) RequireAuth(next http.HandlerFunc) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        token := r.Header.Get("Authorization")
        if token == "" {
            h.Error(w, http.StatusUnauthorized, "authentication required")
            return
        }
        // Validate token...
        next(w, r)
    }
}

// MetricsHandler adds metrics recording
type MetricsHandler struct {
    BaseHandler
    // metrics recorder would go here
}

func (h *MetricsHandler) RecordRequest(method, path string, duration time.Duration, status int) {
    h.logger.Printf("method=%s path=%s duration=%s status=%d",
        method, path, duration.Round(time.Millisecond), status)
}

// UserHandler is a concrete handler that uses all the base capabilities
type UserHandler struct {
    AuthHandler    // Embeds auth + base
    MetricsHandler // Embeds metrics + base (AMBIGUITY — see below)
    userService UserService
}

// Note: UserHandler has ambiguous methods from BaseHandler being embedded twice
// Solution: Use composition instead of double embedding:

type UserHandlerV2 struct {
    BaseHandler
    auth    *AuthHandler
    metrics *MetricsHandler
    userService UserService
}

func (h *UserHandlerV2) GetUser(w http.ResponseWriter, r *http.Request) {
    start := time.Now()

    userID := r.PathValue("id")
    if userID == "" {
        h.NotFound(w)
        return
    }

    user, err := h.userService.Get(r.Context(), userID)
    if err != nil {
        h.InternalError(w, err)
        return
    }

    h.JSON(w, http.StatusOK, user)
    h.metrics.RecordRequest(r.Method, r.URL.Path, time.Since(start), http.StatusOK)
}

type UserService interface {
    Get(ctx interface{}, id string) (interface{}, error)
}
```

## Section 6: Domain Model Composition

```go
package domain

import (
    "time"
)

// BaseEntity provides common fields for all domain entities
type BaseEntity struct {
    ID        string    `json:"id" db:"id"`
    CreatedAt time.Time `json:"created_at" db:"created_at"`
    UpdatedAt time.Time `json:"updated_at" db:"updated_at"`
    Version   int       `json:"version" db:"version"`
}

func (e *BaseEntity) Touch() {
    e.UpdatedAt = time.Now()
    e.Version++
}

func (e BaseEntity) IsNew() bool {
    return e.ID == ""
}

// SoftDeletable adds soft delete capability
type SoftDeletable struct {
    DeletedAt *time.Time `json:"deleted_at,omitempty" db:"deleted_at"`
}

func (s *SoftDeletable) Delete() {
    now := time.Now()
    s.DeletedAt = &now
}

func (s SoftDeletable) IsDeleted() bool {
    return s.DeletedAt != nil
}

// Auditable adds audit trail fields
type Auditable struct {
    CreatedBy string `json:"created_by" db:"created_by"`
    UpdatedBy string `json:"updated_by" db:"updated_by"`
}

func (a *Auditable) SetCreator(userID string) {
    a.CreatedBy = userID
    a.UpdatedBy = userID
}

func (a *Auditable) SetUpdater(userID string) {
    a.UpdatedBy = userID
}

// Organization is a concrete domain entity
type Organization struct {
    BaseEntity                   // Promoted: ID, CreatedAt, UpdatedAt, Version, Touch(), IsNew()
    SoftDeletable                // Promoted: DeletedAt, Delete(), IsDeleted()
    Auditable                    // Promoted: CreatedBy, UpdatedBy, SetCreator(), SetUpdater()

    Name        string `json:"name" db:"name"`
    Slug        string `json:"slug" db:"slug"`
    PlanType    string `json:"plan_type" db:"plan_type"`
    MaxUsers    int    `json:"max_users" db:"max_users"`
}

// User entity using the same embedded types
type User struct {
    BaseEntity
    SoftDeletable
    Auditable

    Email          string  `json:"email" db:"email"`
    Name           string  `json:"name" db:"name"`
    OrganizationID string  `json:"organization_id" db:"organization_id"`
    Role           string  `json:"role" db:"role"`
    LastLoginAt    *time.Time `json:"last_login_at,omitempty" db:"last_login_at"`
}

// Convenient initialization helper
func NewOrganization(name, slug, creatorID string) *Organization {
    org := &Organization{
        Name:     name,
        Slug:     slug,
        PlanType: "free",
        MaxUsers: 5,
    }
    org.SetCreator(creatorID)
    return org
}
```

## Section 7: Embedding for Decorator Pattern

The decorator pattern wraps a type to add behavior. Embedding makes this concise:

```go
package main

import (
    "context"
    "fmt"
    "time"
)

// Database interface
type Database interface {
    Query(ctx context.Context, sql string, args ...interface{}) ([]map[string]interface{}, error)
    Exec(ctx context.Context, sql string, args ...interface{}) (int64, error)
    Begin(ctx context.Context) (Transaction, error)
    Close() error
}

type Transaction interface {
    Query(ctx context.Context, sql string, args ...interface{}) ([]map[string]interface{}, error)
    Exec(ctx context.Context, sql string, args ...interface{}) (int64, error)
    Commit() error
    Rollback() error
}

// MetricsDatabase wraps a Database and records metrics for every operation
type MetricsDatabase struct {
    Database                         // Embed the interface
    recorder func(op string, d time.Duration, err error)
}

func NewMetricsDatabase(db Database, recorder func(op string, d time.Duration, err error)) *MetricsDatabase {
    return &MetricsDatabase{
        Database: db,
        recorder: recorder,
    }
}

func (m *MetricsDatabase) Query(ctx context.Context, sql string, args ...interface{}) ([]map[string]interface{}, error) {
    start := time.Now()
    rows, err := m.Database.Query(ctx, sql, args...)
    m.recorder("query", time.Since(start), err)
    return rows, err
}

func (m *MetricsDatabase) Exec(ctx context.Context, sql string, args ...interface{}) (int64, error) {
    start := time.Now()
    affected, err := m.Database.Exec(ctx, sql, args...)
    m.recorder("exec", time.Since(start), err)
    return affected, err
}

// Begin still works via embedding — returns the underlying Transaction
// If you want a MetricsTransaction wrapper, override Begin here

// RetryDatabase wraps a Database with retry logic
type RetryDatabase struct {
    Database
    maxRetries int
    delay      time.Duration
}

func NewRetryDatabase(db Database, maxRetries int, delay time.Duration) *RetryDatabase {
    return &RetryDatabase{
        Database:   db,
        maxRetries: maxRetries,
        delay:      delay,
    }
}

func (r *RetryDatabase) Exec(ctx context.Context, sql string, args ...interface{}) (int64, error) {
    var (
        affected int64
        err      error
    )
    for attempt := 0; attempt <= r.maxRetries; attempt++ {
        if attempt > 0 {
            select {
            case <-ctx.Done():
                return 0, ctx.Err()
            case <-time.After(r.delay * time.Duration(attempt)):
            }
        }
        affected, err = r.Database.Exec(ctx, sql, args...)
        if err == nil {
            return affected, nil
        }
        if !isRetryableError(err) {
            return 0, err
        }
    }
    return 0, fmt.Errorf("max retries exceeded: %w", err)
}

func isRetryableError(err error) bool {
    // Check for transient errors (deadlock, serialization failure, etc.)
    return false // simplified
}

// Stack multiple decorators
func NewProductionDatabase(base Database) Database {
    withRetry := NewRetryDatabase(base, 3, 100*time.Millisecond)
    withMetrics := NewMetricsDatabase(withRetry, func(op string, d time.Duration, err error) {
        // Record to Prometheus
        fmt.Printf("db.%s duration=%s err=%v\n", op, d.Round(time.Millisecond), err)
    })
    return withMetrics
}
```

## Section 8: sync.Mutex Embedding for Thread-Safe Types

Embedding sync.Mutex is a Go idiom for building safe concurrent data structures:

```go
package main

import (
    "sync"
    "time"
)

// SafeCounter embeds sync.Mutex for lockable counter
type SafeCounter struct {
    sync.Mutex
    count int64
}

func (c *SafeCounter) Increment() {
    c.Lock()
    defer c.Unlock()
    c.count++
}

func (c *SafeCounter) Add(n int64) {
    c.Lock()
    defer c.Unlock()
    c.count += n
}

func (c *SafeCounter) Value() int64 {
    c.Lock()
    defer c.Unlock()
    return c.count
}

// SafeMap is a generic thread-safe map using sync.RWMutex
type SafeMap[K comparable, V any] struct {
    sync.RWMutex
    data map[K]V
}

func NewSafeMap[K comparable, V any]() *SafeMap[K, V] {
    return &SafeMap[K, V]{data: make(map[K]V)}
}

func (m *SafeMap[K, V]) Set(key K, value V) {
    m.Lock()
    defer m.Unlock()
    m.data[key] = value
}

func (m *SafeMap[K, V]) Get(key K) (V, bool) {
    m.RLock()
    defer m.RUnlock()
    v, ok := m.data[key]
    return v, ok
}

func (m *SafeMap[K, V]) Delete(key K) {
    m.Lock()
    defer m.Unlock()
    delete(m.data, key)
}

func (m *SafeMap[K, V]) Len() int {
    m.RLock()
    defer m.RUnlock()
    return len(m.data)
}

// Cache with TTL — uses sync.Mutex embedding
type CacheEntry[V any] struct {
    value     V
    expiresAt time.Time
}

type TTLCache[K comparable, V any] struct {
    sync.RWMutex
    data map[K]CacheEntry[V]
    ttl  time.Duration
}

func NewTTLCache[K comparable, V any](ttl time.Duration) *TTLCache[K, V] {
    c := &TTLCache[K, V]{
        data: make(map[K]CacheEntry[V]),
        ttl:  ttl,
    }
    go c.janitor()
    return c
}

func (c *TTLCache[K, V]) Set(key K, value V) {
    c.Lock()
    defer c.Unlock()
    c.data[key] = CacheEntry[V]{
        value:     value,
        expiresAt: time.Now().Add(c.ttl),
    }
}

func (c *TTLCache[K, V]) Get(key K) (V, bool) {
    c.RLock()
    entry, ok := c.data[key]
    c.RUnlock()
    if !ok || time.Now().After(entry.expiresAt) {
        var zero V
        return zero, false
    }
    return entry.value, true
}

func (c *TTLCache[K, V]) janitor() {
    ticker := time.NewTicker(c.ttl / 2)
    defer ticker.Stop()
    for range ticker.C {
        c.evict()
    }
}

func (c *TTLCache[K, V]) evict() {
    now := time.Now()
    c.Lock()
    defer c.Unlock()
    for k, v := range c.data {
        if now.After(v.expiresAt) {
            delete(c.data, k)
        }
    }
}
```

## Section 9: Embedding in Generated Code

Protocol buffer generated code uses embedding extensively. Understanding this helps when customizing proto-generated types:

```go
// Typical protobuf-generated code (simplified)
package proto

type BaseMessage struct {
    state         protoimpl.MessageState
    sizeCache     protoimpl.SizeCache
    unknownFields protoimpl.UnknownFields
}

// Generated type with embedding
type UserProto struct {
    BaseMessage           // Embedded — provides Marshal/Unmarshal via promoted methods
    state     protoimpl.MessageState
    sizeCache protoimpl.SizeCache

    Id    string `protobuf:"bytes,1,opt,name=id" json:"id,omitempty"`
    Name  string `protobuf:"bytes,2,opt,name=name" json:"name,omitempty"`
    Email string `protobuf:"bytes,3,opt,name=email" json:"email,omitempty"`
}
```

### Extending Generated Types with Embedding

```go
package app

// Never modify generated proto code directly.
// Instead, embed the proto type to add domain logic:

type UserModel struct {
    *proto.UserProto          // Embedded proto type

    // Additional domain fields (not in proto)
    passwordHash string
    createdAt    time.Time
}

func NewUserModel(p *proto.UserProto) *UserModel {
    return &UserModel{
        UserProto: p,
        createdAt: time.Now(),
    }
}

// Add domain methods on top of the proto type
func (u *UserModel) SetPassword(plaintext string) error {
    hash, err := bcrypt.GenerateFromPassword([]byte(plaintext), bcrypt.DefaultCost)
    if err != nil {
        return err
    }
    u.passwordHash = string(hash)
    return nil
}

func (u *UserModel) CheckPassword(plaintext string) bool {
    return bcrypt.CompareHashAndPassword([]byte(u.passwordHash), []byte(plaintext)) == nil
}

// Promoted fields from UserProto work normally:
// u.Id, u.Name, u.Email
// u.ProtoReflect(), u.String(), etc.
```

## Section 10: Common Embedding Pitfalls and Solutions

### Pitfall 1: Copying Embedded Mutex

```go
// WRONG — copying a struct that contains a sync.Mutex
type Counter struct {
    sync.Mutex
    count int
}

func processCounter(c Counter) { // BUG: c is a copy — mutex is copied too
    c.Lock()
    defer c.Unlock()
    c.count++
}

// CORRECT — pass by pointer
func processCounterCorrect(c *Counter) {
    c.Lock()
    defer c.Unlock()
    c.count++
}
```

### Pitfall 2: Nil Pointer Dereference with Pointer Embedding

```go
type Connection struct {
    *net.TCPConn  // Embedded pointer — can be nil
    id   string
}

// Safe access pattern
func (c *Connection) RemoteAddr() string {
    if c.TCPConn == nil {
        return "disconnected"
    }
    return c.TCPConn.RemoteAddr().String()
}
```

### Pitfall 3: Unexpected Interface Satisfaction

```go
type Writer struct{}
func (w *Writer) Write(p []byte) (n int, err error) { return len(p), nil }

type Service struct {
    *Writer  // Embedded pointer
}

// Service accidentally satisfies io.Writer because of the embedded *Writer
// This can cause surprising behavior if Service is passed to functions
// that accept io.Writer

var _ io.Writer = &Service{}  // compiles — possibly unintended

// To prevent this, use a field name instead of embedding:
type ServiceSafe struct {
    writer *Writer  // Named field — NOT promoted
}
```

### Pitfall 4: Embedding Breaks Encapsulation

```go
// PROBLEM: Everything from Base is exported with the outer type
type Base struct {
    InternalCounter int  // This becomes accessible as Outer.InternalCounter
    internalState  string // This is NOT accessible (unexported)
}

type Outer struct {
    Base
    PublicField string
}

o := Outer{}
o.InternalCounter = 5  // Accessible — potentially breaking encapsulation
```

### Pattern: Selective Promotion via Wrapper

When you want method promotion but not field exposure:

```go
type baseImpl struct {
    counter int
    state   string
}

func (b *baseImpl) process() { b.counter++ }
func (b *baseImpl) Counter() int { return b.counter }

// Expose only the Counter method, not the struct fields
type Service struct {
    impl *baseImpl
}

func (s *Service) Counter() int {
    return s.impl.Counter()
}

func (s *Service) Process() {
    s.impl.process()
}
```

## Section 11: Composition vs Inheritance — The Go Perspective

Go made a deliberate choice: composition over inheritance. Here's why embedding is better than hypothetical inheritance for enterprise code:

```go
// --- Hypothetical inheritance (not Go) ---
// class DatabaseRepo extends BaseRepo {
//   override Save(entity) { ... }
//   // Problem: deeply coupled to BaseRepo's implementation
//   // Hard to mock in tests
//   // Hard to swap implementations
// }

// --- Go composition ---
type BaseRepo struct {
    db Database
}

func (r *BaseRepo) BeginTx(ctx context.Context) (Transaction, error) {
    return r.db.Begin(ctx)
}

type UserRepo struct {
    BaseRepo  // Gets BeginTx and db for free

    // Can override any behavior by defining the method:
}

func (r *UserRepo) Save(ctx context.Context, user *User) error {
    // Uses r.db from BaseRepo
    _, err := r.db.Exec(ctx,
        "INSERT INTO users (id, name, email) VALUES ($1, $2, $3)",
        user.ID, user.Name, user.Email)
    return err
}

// Testing — inject a mock Database
func TestUserRepo(t *testing.T) {
    mockDB := &MockDatabase{/* ... */}
    repo := &UserRepo{BaseRepo: BaseRepo{db: mockDB}}
    // Test without any real database
}
```

## Summary

Go struct embedding is a composable, flat alternative to class hierarchies. The key patterns for enterprise code:

1. **Embed by value** for zero-cost composition when the embedded type is value-type safe (no mutexes, no uncopyable state).
2. **Embed by pointer** when the embedded type must be shared, nil-checkable, or contains a mutex.
3. **Embed interfaces** to create partial mocks and decorators without implementing every method.
4. **Shadow methods** deliberately to override behavior — but call the promoted method via the explicit field name when you want to add behavior on top.
5. **Avoid double embedding** of types with overlapping method sets — resolve ambiguity explicitly.
6. **Never copy structs** containing embedded sync.Mutex or sync.RWMutex — use pointer receivers throughout.
7. **Domain model embedding** of `BaseEntity`, `SoftDeletable`, and `Auditable` types eliminates repetition across dozens of domain objects.

The idiomatic Go approach is to embed for code reuse, define narrow interfaces for abstraction, and use function parameters over embedded state when behavior needs to vary independently at runtime.
