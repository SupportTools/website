---
title: "Go Interface Design: Minimal Interfaces, Composition, and Testing Boundaries"
date: 2031-01-07T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Interfaces", "Design Patterns", "Testing", "Architecture", "Software Design"]
categories:
- Go
- Software Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go interface design principles, covering interface segregation, io.Reader/Writer composition, testing with fakes vs mocks, avoiding interface pollution, and designing for testability in large services."
more_link: "yes"
url: "/go-interface-design-minimal-interfaces-composition-testing-boundaries/"
---

Go's implicit interface satisfaction is one of its most powerful features, but it is also one of the most misunderstood. Teams coming from Java or C# often define large interfaces upfront, create explicit `implements` declarations, and inject everything through interfaces — patterns that work in those languages but produce bloated, hard-to-test Go code. This guide covers the Go approach to interfaces: define small, focused interfaces at the point of consumption (not the point of implementation), compose larger behaviors from small pieces, and use interface-based testing to build highly testable services without the ceremony of mock frameworks.

<!--more-->

# Go Interface Design: Minimal Interfaces, Composition, and Testing Boundaries

## Section 1: The Go Interface Philosophy

Go's interface system has one fundamental difference from Java/C#: interfaces are satisfied implicitly, without declaration. A type satisfies an interface simply by having the right methods. This changes the design dynamics entirely:

```go
// In Java/C#: interfaces are defined at the implementation site
// public class PostgresUserStore : IUserStore { ... }

// In Go: interfaces are defined at the CONSUMPTION site
// The implementation knows nothing about the interface
type PostgresUserStore struct { db *sql.DB }

func (s *PostgresUserStore) GetUser(ctx context.Context, id string) (*User, error) {
    // implementation...
    return nil, nil
}

// The HTTP handler defines the interface it needs
type UserHandler struct {
    // Consumer defines exactly the interface it requires
    store interface {
        GetUser(ctx context.Context, id string) (*User, error)
    }
}
```

Rob Pike's law: "The bigger the interface, the weaker the abstraction." Small interfaces in Go are more powerful because they apply to more types.

## Section 2: The Standard Library Pattern — Small, Composable Interfaces

The standard library is the best teacher for Go interface design. Study it carefully.

### 2.1 io.Reader and io.Writer

The most elegant interfaces in Go:

```go
// io.Reader — only one method
type Reader interface {
    Read(p []byte) (n int, err error)
}

// io.Writer — only one method
type Writer interface {
    Write(p []byte) (n int, err error)
}
```

These two interfaces with one method each are the foundation of Go's I/O system. Everything that reads or writes data — files, network connections, HTTP bodies, compression streams, encryption layers, buffers — satisfies these interfaces.

Because they are small, you can compose them:

```go
// io.ReadWriter is the combination — also just an interface
type ReadWriter interface {
    Reader
    Writer
}

// io.ReadWriteCloser adds Close
type ReadWriteCloser interface {
    Reader
    Writer
    Closer
}
```

### 2.2 Writing Code That Uses io.Reader

The power of small interfaces: any function that accepts `io.Reader` works with files, HTTP bodies, network sockets, gzip streams, or test bytes.Buffer:

```go
// csvparser/parser.go
package csvparser

import (
	"bufio"
	"encoding/csv"
	"io"
)

// ParseOrders reads CSV-formatted orders from any io.Reader.
// Works with: os.File, http.Response.Body, strings.NewReader,
//             gzip.Reader, bytes.Buffer, net.Conn...
func ParseOrders(r io.Reader) ([]Order, error) {
	reader := csv.NewReader(bufio.NewReader(r))
	reader.TrimLeadingSpace = true

	var orders []Order
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("parse error: %w", err)
		}

		order, err := recordToOrder(record)
		if err != nil {
			return nil, err
		}
		orders = append(orders, order)
	}
	return orders, nil
}

// Usage examples:
// From file:
// f, _ := os.Open("orders.csv")
// orders, _ := ParseOrders(f)
//
// From HTTP body:
// orders, _ := ParseOrders(resp.Body)
//
// From test string:
// orders, _ := ParseOrders(strings.NewReader("id,amount\n1,99.99\n"))
//
// From gzip-compressed file:
// gz, _ := gzip.NewReader(f)
// orders, _ := ParseOrders(gz)
```

## Section 3: Interface Segregation in Practice

Interface Segregation Principle: no type should be forced to depend on methods it does not use. In Go, this means defining interfaces with only the methods your code actually calls.

### 3.1 The Classic Violation

```go
// WRONG: defining a large interface at the implementation site
// This forces ALL consumers to depend on ALL methods
type UserRepository interface {
    Create(ctx context.Context, user *User) error
    GetByID(ctx context.Context, id string) (*User, error)
    GetByEmail(ctx context.Context, email string) (*User, error)
    Update(ctx context.Context, user *User) error
    Delete(ctx context.Context, id string) error
    List(ctx context.Context, filter UserFilter) ([]*User, error)
    Count(ctx context.Context, filter UserFilter) (int64, error)
    BulkCreate(ctx context.Context, users []*User) error
    ExistsWithEmail(ctx context.Context, email string) (bool, error)
}

// Handler that only needs GetByID and GetByEmail
// is now forced to depend on Create, Delete, BulkCreate...
type AuthHandler struct {
    users UserRepository // carries 9 methods when only 2 are needed
}
```

### 3.2 The Correct Approach: Consumer-Defined Interfaces

```go
// CORRECT: each consumer defines exactly what it needs

// auth/handler.go — only needs to read users
type AuthHandler struct {
    users interface {
        GetByID(ctx context.Context, id string) (*User, error)
        GetByEmail(ctx context.Context, email string) (*User, error)
    }
}

// admin/handler.go — needs full CRUD
type AdminHandler struct {
    users interface {
        Create(ctx context.Context, user *User) error
        Update(ctx context.Context, user *User) error
        Delete(ctx context.Context, id string) error
        List(ctx context.Context, filter UserFilter) ([]*User, error)
    }
}

// reports/handler.go — only needs aggregates
type ReportHandler struct {
    users interface {
        Count(ctx context.Context, filter UserFilter) (int64, error)
        List(ctx context.Context, filter UserFilter) ([]*User, error)
    }
}

// The concrete implementation (PostgresUserStore) satisfies ALL of these
// interfaces without knowing any of them exist.
// Testing each handler requires only a tiny fake.
```

### 3.3 Named Interfaces for Reuse

When the same small interface is used across multiple packages, define it once in a shared package:

```go
// storage/interfaces.go
package storage

import "context"

// UserReader provides read-only user access.
// Implemented by: PostgresUserStore, CachedUserStore, TestUserStore
type UserReader interface {
	GetUserByID(ctx context.Context, id string) (*User, error)
	GetUserByEmail(ctx context.Context, email string) (*User, error)
}

// UserWriter provides write-only user access.
type UserWriter interface {
	CreateUser(ctx context.Context, user *User) error
	UpdateUser(ctx context.Context, user *User) error
}

// UserDeleter provides delete access.
type UserDeleter interface {
	DeleteUser(ctx context.Context, id string) error
}

// UserStore is the full CRUD interface (composed from smaller ones).
// Only use this interface when ALL operations are needed.
type UserStore interface {
	UserReader
	UserWriter
	UserDeleter
}
```

## Section 4: Designing for Testability

The most valuable property of small, consumer-defined interfaces: you can fake them cheaply in tests.

### 4.1 Fakes vs Mocks

**Fakes** are hand-written implementations of an interface that store data in memory. They are:
- Simple to write and understand
- Fast (no reflection)
- Readable in test output
- Maintainable without mock framework upgrades
- Often more accurate to real behavior

**Mocks** (using mockery, gomock, testify/mock) are generated implementations that record calls and allow expectations. They are:
- Good for testing exact interaction sequences
- Brittle: tests fail when refactoring even if behavior is unchanged
- Harder to read failure messages
- Generate boilerplate that clutters the codebase

Go prefers fakes. Use mocks only when you must assert exact call sequences or call counts.

### 4.2 Writing a Fake

```go
// storage/fake/fake_user_store.go
package fake

import (
	"context"
	"fmt"
	"sync"

	"github.com/support-tools/example/storage"
)

// UserStore is an in-memory implementation of storage.UserStore for testing.
type UserStore struct {
	mu     sync.RWMutex
	users  map[string]*storage.User
	emails map[string]string // email → id
}

// NewUserStore creates a new empty fake user store.
func NewUserStore() *UserStore {
	return &UserStore{
		users:  make(map[string]*storage.User),
		emails: make(map[string]string),
	}
}

// Seed adds a user directly (for test setup without going through CreateUser).
func (f *UserStore) Seed(users ...*storage.User) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, u := range users {
		u2 := *u // copy to prevent mutation
		f.users[u.ID] = &u2
		f.emails[u.Email] = u.ID
	}
}

func (f *UserStore) GetUserByID(ctx context.Context, id string) (*storage.User, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if u, ok := f.users[id]; ok {
		u2 := *u // return copy
		return &u2, nil
	}
	return nil, fmt.Errorf("user %s: %w", id, storage.ErrNotFound)
}

func (f *UserStore) GetUserByEmail(ctx context.Context, email string) (*storage.User, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if id, ok := f.emails[email]; ok {
		if u, ok := f.users[id]; ok {
			u2 := *u
			return &u2, nil
		}
	}
	return nil, fmt.Errorf("user with email %s: %w", email, storage.ErrNotFound)
}

func (f *UserStore) CreateUser(ctx context.Context, user *storage.User) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, exists := f.emails[user.Email]; exists {
		return fmt.Errorf("email %s: %w", user.Email, storage.ErrAlreadyExists)
	}
	u2 := *user
	f.users[user.ID] = &u2
	f.emails[user.Email] = user.ID
	return nil
}

func (f *UserStore) UpdateUser(ctx context.Context, user *storage.User) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.users[user.ID]; !ok {
		return fmt.Errorf("user %s: %w", user.ID, storage.ErrNotFound)
	}
	u2 := *user
	f.users[user.ID] = &u2
	return nil
}

func (f *UserStore) DeleteUser(ctx context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	u, ok := f.users[id]
	if !ok {
		return fmt.Errorf("user %s: %w", id, storage.ErrNotFound)
	}
	delete(f.emails, u.Email)
	delete(f.users, id)
	return nil
}

// Verify that the fake satisfies the interface at compile time.
var _ storage.UserStore = (*UserStore)(nil)
```

### 4.3 Using the Fake in Tests

```go
// auth/handler_test.go
package auth_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/support-tools/example/auth"
	"github.com/support-tools/example/storage"
	"github.com/support-tools/example/storage/fake"
)

func TestAuthHandler_Login_Success(t *testing.T) {
	// Arrange
	store := fake.NewUserStore()
	store.Seed(&storage.User{
		ID:           "user-123",
		Email:        "alice@example.com",
		PasswordHash: "$2a$10$...", // bcrypt hash of "secret"
	})

	handler := auth.NewHandler(store)

	// Act
	body := strings.NewReader(`{"email":"alice@example.com","password":"secret"}`)
	req := httptest.NewRequest(http.MethodPost, "/login", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.Login(rec, req)

	// Assert
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestAuthHandler_Login_UserNotFound(t *testing.T) {
	store := fake.NewUserStore() // empty store
	handler := auth.NewHandler(store)

	body := strings.NewReader(`{"email":"nobody@example.com","password":"whatever"}`)
	req := httptest.NewRequest(http.MethodPost, "/login", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.Login(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}
```

### 4.4 Error Injection with Fakes

Fakes can be configured to return errors, which is essential for testing error handling paths:

```go
// storage/fake/error_store.go
package fake

import (
	"context"
	"errors"

	"github.com/support-tools/example/storage"
)

// ErrorUserStore always returns the configured error.
// Used to test that handlers handle storage errors correctly.
type ErrorUserStore struct {
	Err error
}

func (e *ErrorUserStore) GetUserByID(ctx context.Context, id string) (*storage.User, error) {
	return nil, e.Err
}

func (e *ErrorUserStore) GetUserByEmail(ctx context.Context, email string) (*storage.User, error) {
	return nil, e.Err
}

func (e *ErrorUserStore) CreateUser(ctx context.Context, user *storage.User) error {
	return e.Err
}

func (e *ErrorUserStore) UpdateUser(ctx context.Context, user *storage.User) error {
	return e.Err
}

func (e *ErrorUserStore) DeleteUser(ctx context.Context, id string) error {
	return e.Err
}

var _ storage.UserStore = (*ErrorUserStore)(nil)

// Usage in tests:
// store := &fake.ErrorUserStore{Err: errors.New("connection reset")}
// handler := auth.NewHandler(store)
// ... test that handler returns 500 and logs the error
```

## Section 5: Interface Composition Patterns

### 5.1 Decorator Pattern

The decorator pattern is natural in Go because small interfaces compose cleanly:

```go
// cache/user_cache.go
package cache

import (
	"context"
	"sync"
	"time"

	"github.com/support-tools/example/storage"
)

// CachedUserReader wraps a UserReader with an in-memory cache.
// This is the Decorator pattern — it implements UserReader
// and delegates to the underlying reader on cache miss.
type CachedUserReader struct {
	mu      sync.RWMutex
	inner   storage.UserReader
	cache   map[string]*cacheEntry
	ttl     time.Duration
}

type cacheEntry struct {
	user    *storage.User
	expires time.Time
}

func NewCachedUserReader(inner storage.UserReader, ttl time.Duration) *CachedUserReader {
	return &CachedUserReader{
		inner: inner,
		cache: make(map[string]*cacheEntry),
		ttl:   ttl,
	}
}

func (c *CachedUserReader) GetUserByID(ctx context.Context, id string) (*storage.User, error) {
	c.mu.RLock()
	entry, ok := c.cache[id]
	c.mu.RUnlock()

	if ok && time.Now().Before(entry.expires) {
		u := *entry.user
		return &u, nil
	}

	user, err := c.inner.GetUserByID(ctx, id)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	c.cache[id] = &cacheEntry{user: user, expires: time.Now().Add(c.ttl)}
	c.mu.Unlock()

	u := *user
	return &u, nil
}

func (c *CachedUserReader) GetUserByEmail(ctx context.Context, email string) (*storage.User, error) {
	// For brevity: delegate to inner (add email caching similarly)
	return c.inner.GetUserByEmail(ctx, email)
}

var _ storage.UserReader = (*CachedUserReader)(nil)

// Usage:
// rawStore := postgres.NewUserStore(db)
// cachedStore := cache.NewCachedUserReader(rawStore, 5*time.Minute)
// handler := auth.NewHandler(cachedStore)
// The handler doesn't know or care about the cache layer.
```

### 5.2 Middleware Pattern for Interfaces

```go
// tracing/user_tracing.go
package tracing

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"

	"github.com/support-tools/example/storage"
)

// TracingUserReader wraps a UserReader with OpenTelemetry tracing.
type TracingUserReader struct {
	inner  storage.UserReader
	tracer interface{ Start(ctx context.Context, spanName string, opts ...interface{}) (context.Context, interface{}) }
}

func NewTracingUserReader(inner storage.UserReader) *TracingUserReader {
	return &TracingUserReader{inner: inner}
}

func (t *TracingUserReader) GetUserByID(ctx context.Context, id string) (*storage.User, error) {
	ctx, span := otel.Tracer("storage").Start(ctx, "UserReader.GetUserByID")
	// span.End() is called with defer
	defer func() {
		if span != nil {
			type ender interface{ End() }
			if e, ok := span.(ender); ok {
				e.End()
			}
		}
	}()

	user, err := t.inner.GetUserByID(ctx, id)
	return user, err
}

func (t *TracingUserReader) GetUserByEmail(ctx context.Context, email string) (*storage.User, error) {
	ctx, span := otel.Tracer("storage").Start(ctx, "UserReader.GetUserByEmail")
	_ = ctx
	_ = span
	return t.inner.GetUserByEmail(ctx, email)
}
```

### 5.3 Fan-Out Pattern

```go
// fanout/user_fanout.go — write to multiple stores (primary + replica sync)
package fanout

import (
	"context"
	"fmt"

	"github.com/support-tools/example/storage"
)

// MultiWriter writes to multiple UserWriters.
// All writes must succeed, or the operation is considered failed.
type MultiWriter struct {
	writers []storage.UserWriter
}

func NewMultiWriter(writers ...storage.UserWriter) *MultiWriter {
	return &MultiWriter{writers: writers}
}

func (m *MultiWriter) CreateUser(ctx context.Context, user *storage.User) error {
	for i, w := range m.writers {
		if err := w.CreateUser(ctx, user); err != nil {
			return fmt.Errorf("writer %d: %w", i, err)
		}
	}
	return nil
}

func (m *MultiWriter) UpdateUser(ctx context.Context, user *storage.User) error {
	for i, w := range m.writers {
		if err := w.UpdateUser(ctx, user); err != nil {
			return fmt.Errorf("writer %d: %w", i, err)
		}
	}
	return nil
}

var _ storage.UserWriter = (*MultiWriter)(nil)
```

## Section 6: Avoiding Interface Pollution

Interface pollution is the antipattern of defining interfaces everywhere "just in case." Signs of pollution:

### 6.1 The Interface-Per-Type Antipattern

```go
// ANTIPATTERN: every struct has a matching interface
type UserServiceInterface interface {
    CreateUser(ctx context.Context, req CreateUserRequest) (*User, error)
    // ... 15 more methods mirroring UserService exactly
}

type UserService struct { /* ... */ }

// There is no polymorphism here — only one implementation exists.
// Testing uses a mock that exactly mirrors the service.
// This adds zero value and doubles the interface maintenance burden.
```

**Rule**: Define an interface only when you have (or realistically expect) more than one implementation. These include:
- Testing (fake/stub) implementations
- Cache decorators
- Metrics decorators
- Alternative backends (Postgres vs Redis vs in-memory)
- Feature-flag-based implementations

### 6.2 The Internal Interface Antipattern

```go
// ANTIPATTERN: interface used only within a single package
package user

type userRepositoryInterface interface {
    findByID(id string) (*user, error)
}

// If the interface is only used by one function in one package,
// it's not doing anything. Remove it.
```

**Rule**: Interfaces that are only used within a single package rarely justify their existence. The exception is if you need to test the package in isolation using a fake.

### 6.3 Return Concrete Types, Accept Interfaces

Rob Pike's second law for Go interfaces: "Accept interfaces, return structs."

```go
// ANTIPATTERN: returning interface from constructor
func NewUserService(db *sql.DB) UserServiceInterface {
    return &userService{db: db}
}

// CORRECT: return concrete type
// Let the caller decide what interface to use it as
func NewUserService(db *sql.DB) *UserService {
    return &userService{db: db}
}
```

Returning concrete types:
- Shows callers exactly what methods are available
- Avoids boxing/interface allocation on every method call
- Allows embedding and composition at the call site
- Does not prevent callers from using the type as an interface

## Section 7: Error Handling and Interface Boundaries

### 7.1 Sentinel Errors and Interface Boundaries

When a function returns an error through an interface, callers need to check specific error types. Use sentinel errors and `errors.Is`/`errors.As`:

```go
// storage/errors.go
package storage

import "errors"

var (
	ErrNotFound     = errors.New("not found")
	ErrAlreadyExists = errors.New("already exists")
	ErrInvalidInput  = errors.New("invalid input")
	ErrUnauthorized  = errors.New("unauthorized")
)

// StorageError wraps a storage error with context.
type StorageError struct {
	Op  string // the operation that failed (e.g., "GetUserByID")
	Err error
}

func (e *StorageError) Error() string {
	return fmt.Sprintf("storage %s: %v", e.Op, e.Err)
}

func (e *StorageError) Unwrap() error {
	return e.Err
}
```

```go
// In a handler: check specific errors
user, err := h.users.GetUserByID(ctx, id)
if err != nil {
    if errors.Is(err, storage.ErrNotFound) {
        http.Error(w, "user not found", http.StatusNotFound)
        return
    }
    // Unexpected storage error
    log.ErrorContext(ctx, "storage error", slog.Any("error", err))
    http.Error(w, "internal server error", http.StatusInternalServerError)
    return
}
```

### 7.2 Testing Error Paths

```go
func TestUserHandler_GetUser_NotFound(t *testing.T) {
	store := &fake.ErrorUserStore{Err: storage.ErrNotFound}
	handler := user.NewHandler(store)

	req := httptest.NewRequest(http.MethodGet, "/users/nonexistent", nil)
	rec := httptest.NewRecorder()
	handler.GetUser(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rec.Code)
	}
}

func TestUserHandler_GetUser_StorageError(t *testing.T) {
	store := &fake.ErrorUserStore{Err: errors.New("connection reset by peer")}
	handler := user.NewHandler(store)

	req := httptest.NewRequest(http.MethodGet, "/users/123", nil)
	rec := httptest.NewRecorder()
	handler.GetUser(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rec.Code)
	}
}
```

## Section 8: Interface Design for Large Services

### 8.1 The Repository Pattern

For large services with multiple storage backends, the repository pattern using small interfaces per domain entity keeps dependencies clean:

```go
// domain/repository.go
package domain

import "context"

// OrderReader provides read access to orders.
type OrderReader interface {
	GetOrder(ctx context.Context, id string) (*Order, error)
	ListOrders(ctx context.Context, filter OrderFilter) ([]*Order, error)
}

// OrderWriter provides write access to orders.
type OrderWriter interface {
	CreateOrder(ctx context.Context, order *Order) error
	UpdateOrderStatus(ctx context.Context, id string, status OrderStatus) error
}

// OrderEventPublisher publishes order events to the message bus.
type OrderEventPublisher interface {
	PublishOrderCreated(ctx context.Context, order *Order) error
	PublishOrderStatusChanged(ctx context.Context, id string, status OrderStatus) error
}

// OrderService processes order business logic.
// It depends on three small interfaces, each independently testable.
type OrderService struct {
	orders    OrderReader
	writer    OrderWriter
	publisher OrderEventPublisher
}

func NewOrderService(r OrderReader, w OrderWriter, p OrderEventPublisher) *OrderService {
	return &OrderService{orders: r, writer: w, publisher: p}
}

func (s *OrderService) PlaceOrder(ctx context.Context, req PlaceOrderRequest) (*Order, error) {
	order := &Order{
		ID:       generateOrderID(),
		UserID:   req.UserID,
		Items:    req.Items,
		Status:   OrderStatusPending,
		Total:    calculateTotal(req.Items),
	}

	if err := s.writer.CreateOrder(ctx, order); err != nil {
		return nil, fmt.Errorf("create order: %w", err)
	}

	if err := s.publisher.PublishOrderCreated(ctx, order); err != nil {
		// Non-fatal: order is created, but event didn't publish
		// Log and continue; a reconciler will retry
		slog.WarnContext(ctx, "failed to publish order created event",
			slog.String("order_id", order.ID),
			slog.Any("error", err),
		)
	}

	return order, nil
}
```

### 8.2 Testing the Service

```go
// domain/order_service_test.go
package domain_test

import (
	"context"
	"errors"
	"testing"

	"github.com/support-tools/example/domain"
	"github.com/support-tools/example/domain/fake"
)

func TestOrderService_PlaceOrder_PublisherFailure(t *testing.T) {
	// The service should succeed even if the event publisher fails
	orders := fake.NewOrderStore()
	failingPublisher := &fake.FailingPublisher{
		Err: errors.New("kafka unavailable"),
	}

	svc := domain.NewOrderService(orders, orders, failingPublisher)

	req := domain.PlaceOrderRequest{
		UserID: "user-123",
		Items:  []domain.OrderItem{{ProductID: "prod-1", Quantity: 1}},
	}

	order, err := svc.PlaceOrder(context.Background(), req)
	if err != nil {
		t.Fatalf("expected PlaceOrder to succeed despite publisher failure, got: %v", err)
	}
	if order == nil {
		t.Fatal("expected non-nil order")
	}

	// Verify order was persisted
	saved, err := orders.GetOrder(context.Background(), order.ID)
	if err != nil {
		t.Fatalf("expected order to be saved: %v", err)
	}
	if saved.UserID != "user-123" {
		t.Errorf("expected UserID user-123, got %s", saved.UserID)
	}
}
```

## Section 9: Interface Verification at Compile Time

A critical technique: verify that your implementations satisfy interfaces at compile time, before tests run.

```go
// Compile-time interface verification
// Place these in the implementation file, NOT the interface file

// postgres/user_store.go
package postgres

import "github.com/support-tools/example/storage"

var _ storage.UserStore = (*UserStore)(nil)
var _ storage.UserReader = (*UserStore)(nil)

// If PostgresUserStore is missing any method of storage.UserStore,
// this causes a compile error: cannot use (*UserStore)(nil) (type *UserStore)
// as type storage.UserStore in assignment:
//   *UserStore does not implement storage.UserStore
//   (missing method DeleteUser)

// Also verify fakes:
// storage/fake/fake_user_store.go
var _ storage.UserStore = (*UserStore)(nil)
```

## Section 10: When to Use a Mock Library

Despite the preference for fakes, mock libraries (mockery, gomock) are appropriate when:

1. **Sequence verification is required**: You need to assert that `CreateOrder` was called before `PublishOrderCreated`, not just that both were called.
2. **Exact call count matters**: You need to assert that a cache is only called once per request, not multiple times.
3. **Return values change per call**: The mock should return success on the first call and error on the second.

```go
// Using testify/mock for call sequence verification
// go get github.com/stretchr/testify/mock

type MockOrderWriter struct {
	mock.Mock
}

func (m *MockOrderWriter) CreateOrder(ctx context.Context, order *Order) error {
	args := m.Called(ctx, order)
	return args.Error(0)
}

func TestOrderService_RetryOnTransientError(t *testing.T) {
	writer := &MockOrderWriter{}

	// First call fails with transient error
	writer.On("CreateOrder", mock.Anything, mock.Anything).
		Return(errors.New("deadlock detected")).
		Once()
	// Second call succeeds
	writer.On("CreateOrder", mock.Anything, mock.Anything).
		Return(nil).
		Once()

	svc := NewOrderService(fakeReader, writer, fakePublisher)
	_, err := svc.PlaceOrder(ctx, req)
	if err != nil {
		t.Fatalf("expected retry to succeed: %v", err)
	}

	writer.AssertNumberOfCalls(t, "CreateOrder", 2)
}
```

## Summary

Go interface design follows three principles:

1. **Small and consumer-defined**: Define interfaces at the point of use with only the methods that point of use actually needs. Avoid defining interfaces at the implementation site.
2. **Compose from small pieces**: Build complex behaviors by composing small interfaces using embedding, decorators, and fan-out patterns — exactly as the standard library does with `io.Reader` and `io.Writer`.
3. **Test with fakes**: Hand-written fakes are simpler, faster, and more maintainable than mock frameworks for most testing scenarios. Use mock frameworks only for interaction sequence tests.

The payoff is a codebase where every component is independently testable, every dependency is explicit, and adding new implementations or behaviors requires no changes to existing code — only new types that satisfy the relevant interfaces.
