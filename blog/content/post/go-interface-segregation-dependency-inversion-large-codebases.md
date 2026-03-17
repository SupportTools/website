---
title: "Go Interface Segregation and Dependency Inversion in Large Codebases"
date: 2029-07-11T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Interface Design", "SOLID", "Testing", "Architecture", "Dependency Injection"]
categories: ["Go", "Software Architecture", "Best Practices"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Practical guide to interface design principles in Go for large codebases: interface segregation, consumer-defined interfaces, avoiding interface pollution, and effective mocking strategies with testify/mock vs gomock."
more_link: "yes"
url: "/go-interface-segregation-dependency-inversion-large-codebases/"
---

Go's approach to interfaces is fundamentally different from Java or C#. Interfaces are satisfied implicitly—a type doesn't declare that it implements an interface, it just does. This elegance becomes a liability in large codebases if misused: interface pollution, overly broad contracts, and testing anti-patterns are common failure modes. This guide covers the principles and patterns that keep interface-heavy Go codebases maintainable and testable.

<!--more-->

# Go Interface Segregation and Dependency Inversion in Large Codebases

## The Go Interface Philosophy

The Go proverb captures the core insight: "The bigger the interface, the weaker the abstraction." This runs counter to Java-style OOP where large interfaces signal comprehensive behavior. In Go, small interfaces are more useful because they're easier to satisfy, easier to mock, and compose into larger ones when needed.

```go
// Anti-pattern: God interface (from a real codebase)
type UserService interface {
    CreateUser(ctx context.Context, user *User) error
    GetUser(ctx context.Context, id int64) (*User, error)
    UpdateUser(ctx context.Context, user *User) error
    DeleteUser(ctx context.Context, id int64) error
    ListUsers(ctx context.Context, filter UserFilter) ([]*User, error)
    AuthenticateUser(ctx context.Context, email, password string) (*Token, error)
    RefreshToken(ctx context.Context, token string) (*Token, error)
    RevokeToken(ctx context.Context, token string) error
    SendVerificationEmail(ctx context.Context, userID int64) error
    VerifyEmail(ctx context.Context, token string) error
    UpdatePassword(ctx context.Context, userID int64, oldPwd, newPwd string) error
    ResetPassword(ctx context.Context, email string) error
    GetUserProfile(ctx context.Context, userID int64) (*Profile, error)
    UpdateUserProfile(ctx context.Context, userID int64, profile *Profile) error
    GetUserPreferences(ctx context.Context, userID int64) (*Preferences, error)
}

// The problem: any code that needs to read a user is coupled to
// the entire interface, including auth, email, and password operations
```

## Interface Segregation in Practice

Interface segregation means splitting large interfaces into smaller, focused ones. In Go, define interfaces at the point of use, not at the point of implementation.

### Splitting by Consumer Responsibility

```go
// Segregated interfaces - each focused on one concern

// For handlers that only read user data
type UserReader interface {
    GetUser(ctx context.Context, id int64) (*User, error)
    ListUsers(ctx context.Context, filter UserFilter) ([]*User, error)
}

// For handlers that modify users
type UserWriter interface {
    CreateUser(ctx context.Context, user *User) error
    UpdateUser(ctx context.Context, user *User) error
    DeleteUser(ctx context.Context, id int64) error
}

// For authentication middleware
type Authenticator interface {
    AuthenticateUser(ctx context.Context, email, password string) (*Token, error)
    RefreshToken(ctx context.Context, token string) (*Token, error)
    RevokeToken(ctx context.Context, token string) error
}

// For the email verification flow
type EmailVerifier interface {
    SendVerificationEmail(ctx context.Context, userID int64) error
    VerifyEmail(ctx context.Context, token string) error
}

// Compose larger interfaces when truly needed
type UserManager interface {
    UserReader
    UserWriter
}

// The implementation satisfies all interfaces implicitly
type userServiceImpl struct {
    db    *sql.DB
    cache cache.Cache
    mailer mailer.Mailer
}

// All methods are implemented on userServiceImpl, but callers
// only depend on the interface they actually need
```

### Consumer-Defined Interfaces

The most powerful Go interface pattern: define the interface in the package that *uses* it, not in the package that *provides* the implementation. This is the inverse of Java's typical approach.

```go
// package notification (consumer defines what it needs)
package notification

import "context"

// NotificationStore is defined HERE, in the consumer package.
// It captures exactly what the notification package needs from storage.
// The actual implementation lives in the storage package.
type NotificationStore interface {
    SaveNotification(ctx context.Context, n *Notification) error
    GetPendingNotifications(ctx context.Context, userID int64) ([]*Notification, error)
    MarkDelivered(ctx context.Context, ids []int64) error
}

// Sender is also defined by the consumer
type Sender interface {
    Send(ctx context.Context, recipient string, msg *Message) error
}

// NotificationService depends only on the minimal interfaces it defines
type NotificationService struct {
    store  NotificationStore
    sender Sender
}

func NewNotificationService(store NotificationStore, sender Sender) *NotificationService {
    return &NotificationService{store: store, sender: sender}
}
```

```go
// package storage (implementation, unaware of notification package)
package storage

type PostgresStore struct {
    db *sql.DB
}

// PostgresStore satisfies notification.NotificationStore implicitly
// It may have many other methods; that doesn't matter
func (p *PostgresStore) SaveNotification(ctx context.Context, n *notification.Notification) error {
    _, err := p.db.ExecContext(ctx,
        "INSERT INTO notifications (user_id, type, payload) VALUES ($1, $2, $3)",
        n.UserID, n.Type, n.Payload,
    )
    return err
}

func (p *PostgresStore) GetPendingNotifications(ctx context.Context, userID int64) ([]*notification.Notification, error) {
    // ...
    return nil, nil
}

func (p *PostgresStore) MarkDelivered(ctx context.Context, ids []int64) error {
    // ...
    return nil
}
```

This pattern has a critical advantage: the `storage` package doesn't import `notification`. There's no circular dependency, and the `storage` package can be used by many consumers without any coupling.

### The io.Reader Pattern

The standard library demonstrates this perfectly:

```go
// io.Reader: the smallest useful interface
type Reader interface {
    Read(p []byte) (n int, err error)
}

// Any function that only needs to read can accept io.Reader,
// working with files, network connections, bytes.Buffer, etc.
func processData(r io.Reader) error {
    scanner := bufio.NewScanner(r)
    for scanner.Scan() {
        // process scanner.Text()
    }
    return scanner.Err()
}

// Call with a file, HTTP response body, bytes.Reader - anything
processData(os.Stdin)
processData(resp.Body)
processData(bytes.NewReader(data))
```

Apply the same thinking to your domain:

```go
// Instead of accepting *sql.DB everywhere, define a minimal interface
type Execer interface {
    ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error)
}

type Queryer interface {
    QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error)
    QueryRowContext(ctx context.Context, query string, args ...interface{}) *sql.Row
}

// Most repositories only need Queryer or Execer, not both
type OrderRepository struct {
    db Queryer
}

func (r *OrderRepository) GetOrder(ctx context.Context, id int64) (*Order, error) {
    row := r.db.QueryRowContext(ctx, "SELECT * FROM orders WHERE id = $1", id)
    // ...
    return nil, nil
}

// Works with *sql.DB, *sql.Tx, or any mock
```

## Avoiding Interface Pollution

Interface pollution occurs when interfaces are created prematurely or unnecessarily, adding complexity without benefit.

### When NOT to Use an Interface

```go
// Anti-pattern: Interface for a single implementation with no test need
type Logger interface {
    Log(msg string)
}

type zapLogger struct {
    z *zap.Logger
}

func (l *zapLogger) Log(msg string) {
    l.z.Info(msg)
}

// You only ever use zapLogger. There's no mock needed.
// Just use *zap.Logger directly.

// ---------------------------------------------------------
// Anti-pattern: Interface for a struct you own that's never mocked
type Config interface {
    GetDatabaseURL() string
    GetPort() int
}

// If Config is just a struct you populate from environment variables
// and never need to mock in tests, don't use an interface.
// Use the struct directly:
type Config struct {
    DatabaseURL string
    Port        int
}
```

### The "Accept Interfaces, Return Structs" Rule

```go
// GOOD: Accept interface (flexible), return concrete type (clear)
func NewFileProcessor(r io.Reader, w io.Writer) *FileProcessor {
    return &FileProcessor{reader: r, writer: w}
}

// AVOID: Returning an interface when the concrete type adds value
// This hides the concrete type's methods from the caller
func NewFileProcessor(r io.Reader, w io.Writer) Processor {  // Anti-pattern
    return &FileProcessor{reader: r, writer: w}
}

// Exception: return interface when you need to hide implementation details
// or when there are multiple implementations
func NewCache(backend string) (Cache, error) {
    switch backend {
    case "redis":
        return newRedisCache(), nil
    case "memory":
        return newMemoryCache(), nil
    default:
        return nil, fmt.Errorf("unknown cache backend: %s", backend)
    }
}
```

### Detecting Interface Pollution

```go
// Signs of interface pollution in a codebase:

// 1. One-method interfaces that are only used in one place
type OrderSaver interface {
    Save(o *Order) error  // Only used in OrderService.Create
}
// Fix: pass the concrete type, or use the method directly

// 2. Interfaces that match a single external package's type exactly
type HTTPClient interface {
    Do(req *http.Request) (*http.Response, error)
    Get(url string) (*http.Response, error)
    Post(url, contentType string, body io.Reader) (*http.Response, error)
    // ... 5 more methods that are all just *http.Client
}
// Fix: only include the methods you actually call

// 3. Interfaces used only in test files
// If the interface exists solely so tests can compile, it's test-driven pollution
// Fix: use testify/mock or gomock, which generate mocks from interfaces
```

## Dependency Injection Without Frameworks

Go's interface system enables clean dependency injection without a DI framework:

```go
package main

import (
    "context"
    "database/sql"
    "net/http"
    "os"

    _ "github.com/lib/pq"
    "go.uber.org/zap"
)

// Domain types and interfaces
type UserRepository interface {
    GetUser(ctx context.Context, id int64) (*User, error)
    CreateUser(ctx context.Context, u *User) error
}

type EmailSender interface {
    SendEmail(ctx context.Context, to, subject, body string) error
}

type UserService struct {
    repo   UserRepository
    mailer EmailSender
    logger *zap.Logger
}

type UserHandler struct {
    service *UserService
    logger  *zap.Logger
}

// Wire everything together in main()
func main() {
    logger, _ := zap.NewProduction()
    defer logger.Sync()

    // Build infrastructure
    db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
    if err != nil {
        logger.Fatal("database connection failed", zap.Error(err))
    }
    defer db.Close()

    // Build concrete implementations
    userRepo := &postgresUserRepository{db: db}
    emailSender := &smtpEmailSender{
        host: os.Getenv("SMTP_HOST"),
        port: 587,
    }

    // Wire service
    userSvc := &UserService{
        repo:   userRepo,
        mailer: emailSender,
        logger: logger,
    }

    // Wire handler
    userHandler := &UserHandler{
        service: userSvc,
        logger:  logger,
    }

    // Mount routes
    mux := http.NewServeMux()
    mux.HandleFunc("/users", userHandler.handleUsers)

    logger.Info("server starting", zap.String("addr", ":8080"))
    http.ListenAndServe(":8080", mux)
}
```

### Wire for Large Applications

For large codebases, manual wiring becomes unwieldy. Google's Wire tool generates the wiring code:

```go
// wire.go - wire provider declarations
//go:build wireinject

package main

import (
    "github.com/google/wire"
)

// ProvideDB creates a database connection
func ProvideDB(cfg *Config) (*sql.DB, error) {
    return sql.Open("postgres", cfg.DatabaseURL)
}

// ProvideUserRepository creates the user repository
func ProvideUserRepository(db *sql.DB) UserRepository {
    return &postgresUserRepository{db: db}
}

// ProvideEmailSender creates the email sender
func ProvideEmailSender(cfg *Config) EmailSender {
    return &smtpEmailSender{host: cfg.SMTPHost, port: cfg.SMTPPort}
}

// InitializeApp wires everything together - Wire generates this
func InitializeApp(cfg *Config) (*App, error) {
    wire.Build(
        ProvideDB,
        ProvideUserRepository,
        ProvideEmailSender,
        NewUserService,
        NewUserHandler,
        NewApp,
    )
    return nil, nil
}
```

## Mocking Strategies

### testify/mock: Runtime Mocking

```go
package service_test

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
)

// Generated or hand-written mock
type MockUserRepository struct {
    mock.Mock
}

func (m *MockUserRepository) GetUser(ctx context.Context, id int64) (*User, error) {
    args := m.Called(ctx, id)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).(*User), args.Error(1)
}

func (m *MockUserRepository) CreateUser(ctx context.Context, u *User) error {
    args := m.Called(ctx, u)
    return args.Error(0)
}

type MockEmailSender struct {
    mock.Mock
}

func (m *MockEmailSender) SendEmail(ctx context.Context, to, subject, body string) error {
    args := m.Called(ctx, to, subject, body)
    return args.Error(0)
}

func TestUserService_GetUser_Success(t *testing.T) {
    // Arrange
    mockRepo := new(MockUserRepository)
    mockMailer := new(MockEmailSender)
    svc := &UserService{repo: mockRepo, mailer: mockMailer}

    expectedUser := &User{ID: 42, Name: "Alice", Email: "alice@example.com"}

    // Set expectations
    mockRepo.On("GetUser", mock.Anything, int64(42)).
        Return(expectedUser, nil)

    // Act
    user, err := svc.GetUser(context.Background(), 42)

    // Assert
    assert.NoError(t, err)
    assert.Equal(t, expectedUser, user)
    mockRepo.AssertExpectations(t)
    mockMailer.AssertNotCalled(t, "SendEmail") // Verify no side effects
}

func TestUserService_CreateUser_SendsWelcomeEmail(t *testing.T) {
    mockRepo := new(MockUserRepository)
    mockMailer := new(MockEmailSender)
    svc := &UserService{repo: mockRepo, mailer: mockMailer}

    newUser := &User{Name: "Bob", Email: "bob@example.com"}

    mockRepo.On("CreateUser", mock.Anything, newUser).Return(nil)
    mockMailer.On("SendEmail",
        mock.Anything,
        "bob@example.com",
        "Welcome!",
        mock.MatchedBy(func(body string) bool {
            return len(body) > 0 // Any non-empty body
        }),
    ).Return(nil)

    err := svc.CreateUser(context.Background(), newUser)

    assert.NoError(t, err)
    mockRepo.AssertExpectations(t)
    mockMailer.AssertExpectations(t)
}

// Test error propagation
func TestUserService_GetUser_NotFound(t *testing.T) {
    mockRepo := new(MockUserRepository)
    mockMailer := new(MockEmailSender)
    svc := &UserService{repo: mockRepo, mailer: mockMailer}

    mockRepo.On("GetUser", mock.Anything, int64(99)).
        Return(nil, ErrNotFound)

    user, err := svc.GetUser(context.Background(), 99)

    assert.Nil(t, user)
    assert.ErrorIs(t, err, ErrNotFound)
}
```

### gomock: Code-Generated Mocks

```bash
# Install mockgen
go install go.uber.org/mock/mockgen@latest

# Generate mocks for an interface
mockgen -destination=mocks/mock_user_repository.go \
  -package=mocks \
  yourmodule/internal/domain \
  UserRepository

# Or use source mode (reads the Go source file)
mockgen -source=internal/domain/interfaces.go \
  -destination=mocks/mock_interfaces.go \
  -package=mocks
```

```go
// Generated mock (do not edit by hand)
// mocks/mock_user_repository.go

package mocks

import (
    "context"
    "reflect"

    "go.uber.org/mock/gomock"
    "yourmodule/internal/domain"
)

type MockUserRepository struct {
    ctrl     *gomock.Controller
    recorder *MockUserRepositoryMockRecorder
}

type MockUserRepositoryMockRecorder struct {
    mock *MockUserRepository
}

func NewMockUserRepository(ctrl *gomock.Controller) *MockUserRepository {
    mock := &MockUserRepository{ctrl: ctrl}
    mock.recorder = &MockUserRepositoryMockRecorder{mock}
    return mock
}

func (m *MockUserRepository) EXPECT() *MockUserRepositoryMockRecorder {
    return m.recorder
}

func (m *MockUserRepository) GetUser(ctx context.Context, id int64) (*domain.User, error) {
    m.ctrl.T.Helper()
    ret := m.ctrl.Call(m, "GetUser", ctx, id)
    ret0, _ := ret[0].(*domain.User)
    ret1, _ := ret[1].(error)
    return ret0, ret1
}

func (r *MockUserRepositoryMockRecorder) GetUser(ctx, id interface{}) *gomock.Call {
    r.mock.ctrl.T.Helper()
    return r.mock.ctrl.RecordCallWithMethodType(r.mock, "GetUser",
        reflect.TypeOf((*MockUserRepository)(nil).GetUser),
        ctx, id)
}
```

```go
// Using gomock in tests
package service_test

import (
    "context"
    "testing"

    "go.uber.org/mock/gomock"
    "yourmodule/internal/mocks"
    "yourmodule/internal/service"
)

func TestUserService_WithGomock(t *testing.T) {
    ctrl := gomock.NewController(t)
    // ctrl.Finish() is called automatically in Go 1.14+

    mockRepo := mocks.NewMockUserRepository(ctrl)
    mockMailer := mocks.NewMockEmailSender(ctrl)

    svc := service.NewUserService(mockRepo, mockMailer)

    // gomock expectations
    expectedUser := &domain.User{ID: 1, Name: "Alice"}

    // Expect exactly one call with specific args
    mockRepo.EXPECT().
        GetUser(gomock.Any(), int64(1)).
        Return(expectedUser, nil).
        Times(1)

    // Expect no email sending
    mockMailer.EXPECT().SendEmail(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
        Times(0)

    user, err := svc.GetUser(context.Background(), 1)

    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if user.ID != expectedUser.ID {
        t.Errorf("expected user ID %d, got %d", expectedUser.ID, user.ID)
    }
}

// gomock matchers for complex assertions
func TestUserService_CreateUser_GomockMatchers(t *testing.T) {
    ctrl := gomock.NewController(t)

    mockRepo := mocks.NewMockUserRepository(ctrl)
    mockMailer := mocks.NewMockEmailSender(ctrl)
    svc := service.NewUserService(mockRepo, mockMailer)

    // Custom matcher
    userMatcher := gomock.AssignableToTypeOf(&domain.User{})

    mockRepo.EXPECT().
        CreateUser(gomock.Any(), userMatcher).
        DoAndReturn(func(ctx context.Context, u *domain.User) error {
            u.ID = 42 // Simulate DB assigning ID
            return nil
        })

    mockMailer.EXPECT().
        SendEmail(
            gomock.Any(),
            gomock.Eq("alice@example.com"),
            gomock.Contains("Welcome"),
            gomock.Any(),
        ).
        Return(nil)

    newUser := &domain.User{Name: "Alice", Email: "alice@example.com"}
    err := svc.CreateUser(context.Background(), newUser)

    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if newUser.ID != 42 {
        t.Errorf("expected ID 42, got %d", newUser.ID)
    }
}
```

### testify/mock vs gomock Comparison

| Feature | testify/mock | gomock |
|---------|-------------|--------|
| Mock creation | Manual or generated | Code generation required |
| Expectation style | Fluent chain | Method recorder |
| Argument matchers | `mock.MatchedBy`, `mock.Anything` | `gomock.Any()`, custom matchers |
| Strict ordering | Not enforced by default | `gomock.InOrder()` |
| Unexpected calls | Panic | Test failure |
| Maintenance | Hand-maintained mocks | Regenerate from interface |
| IDE support | Good | Good |
| Learning curve | Lower | Moderate |

**Prefer testify/mock when:**
- Interfaces are hand-written and infrequently change
- Tests are simple and don't need call ordering
- Team is more comfortable with fluent API

**Prefer gomock when:**
- Interfaces are complex or change frequently (regeneration is cheaper than updates)
- You need strict call ordering verification
- You want generated mocks to always match the interface

### Fake Implementations (No Framework)

For simple cases, hand-written fakes are often clearer than mocks:

```go
// A fake implementation: simple, no framework needed
type fakeUserRepository struct {
    users map[int64]*User
    nextID int64
}

func newFakeUserRepository() *fakeUserRepository {
    return &fakeUserRepository{
        users: make(map[int64]*User),
    }
}

func (f *fakeUserRepository) GetUser(ctx context.Context, id int64) (*User, error) {
    user, ok := f.users[id]
    if !ok {
        return nil, ErrNotFound
    }
    return user, nil
}

func (f *fakeUserRepository) CreateUser(ctx context.Context, u *User) error {
    f.nextID++
    u.ID = f.nextID
    f.users[u.ID] = u
    return nil
}

// Use in tests - no mock framework, no generated code
func TestUserService_WithFake(t *testing.T) {
    fakeRepo := newFakeUserRepository()
    fakeSender := &captureEmailSender{}  // Records sent emails

    svc := &UserService{repo: fakeRepo, mailer: fakeSender}

    err := svc.CreateUser(context.Background(), &User{
        Name:  "Bob",
        Email: "bob@example.com",
    })

    assert.NoError(t, err)
    assert.Len(t, fakeSender.sent, 1)
    assert.Equal(t, "bob@example.com", fakeSender.sent[0].to)
}

type captureEmailSender struct {
    sent []sentEmail
}

type sentEmail struct {
    to, subject, body string
}

func (c *captureEmailSender) SendEmail(ctx context.Context, to, subject, body string) error {
    c.sent = append(c.sent, sentEmail{to: to, subject: subject, body: body})
    return nil
}
```

## Interface Design for Large Codebase Patterns

### The Repository Pattern with Proper Interfaces

```go
// Internal package structure:
// internal/
//   domain/        - core types, no dependencies
//   repository/    - persistence interfaces (defined here)
//   service/       - business logic, depends on repository interfaces
//   storage/       - concrete implementations
//   http/          - HTTP handlers

// domain/user.go
package domain

type User struct {
    ID        int64
    Name      string
    Email     string
    CreatedAt time.Time
}

type UserFilter struct {
    Email  *string
    Limit  int
    Offset int
}

// repository/user.go - interfaces defined at the service boundary
package repository

import (
    "context"
    "yourmodule/internal/domain"
)

type UserRepository interface {
    Get(ctx context.Context, id int64) (*domain.User, error)
    GetByEmail(ctx context.Context, email string) (*domain.User, error)
    List(ctx context.Context, filter domain.UserFilter) ([]*domain.User, error)
    Create(ctx context.Context, user *domain.User) error
    Update(ctx context.Context, user *domain.User) error
    Delete(ctx context.Context, id int64) error
}

// UnitOfWork pattern for transactions
type UnitOfWork interface {
    Users() UserRepository
    Orders() OrderRepository
    Commit() error
    Rollback() error
}
```

### Wrapping Interfaces for Cross-Cutting Concerns

```go
// Middleware pattern for interfaces
// Add logging, metrics, caching as transparent wrappers

// Logging wrapper
type loggingUserRepository struct {
    next   UserRepository
    logger *zap.Logger
}

func NewLoggingUserRepository(next UserRepository, logger *zap.Logger) UserRepository {
    return &loggingUserRepository{next: next, logger: logger}
}

func (l *loggingUserRepository) Get(ctx context.Context, id int64) (*User, error) {
    start := time.Now()
    user, err := l.next.Get(ctx, id)
    l.logger.Info("UserRepository.Get",
        zap.Int64("id", id),
        zap.Duration("duration", time.Since(start)),
        zap.Error(err),
    )
    return user, err
}

// Caching wrapper
type cachingUserRepository struct {
    next  UserRepository
    cache cache.Cache
    ttl   time.Duration
}

func (c *cachingUserRepository) Get(ctx context.Context, id int64) (*User, error) {
    key := fmt.Sprintf("user:%d", id)

    // Try cache first
    var user User
    if err := c.cache.Get(ctx, key, &user); err == nil {
        return &user, nil
    }

    // Fall through to next layer
    u, err := c.next.Get(ctx, id)
    if err != nil {
        return nil, err
    }

    // Store in cache
    c.cache.Set(ctx, key, u, c.ttl)
    return u, nil
}

// Composing wrappers in main.go
func buildUserRepository(db *sql.DB, cache cache.Cache, logger *zap.Logger) UserRepository {
    var repo UserRepository
    repo = &postgresUserRepository{db: db}
    repo = &cachingUserRepository{next: repo, cache: cache, ttl: 5 * time.Minute}
    repo = NewLoggingUserRepository(repo, logger)
    return repo
}
```

### Compile-Time Interface Verification

Ensure your concrete types implement interfaces at compile time:

```go
// Add these assertions to each implementation file

// Verify at compile time that postgresUserRepository implements UserRepository
var _ UserRepository = (*postgresUserRepository)(nil)

// Verify all wrappers implement the interface
var _ UserRepository = (*loggingUserRepository)(nil)
var _ UserRepository = (*cachingUserRepository)(nil)

// Verify mock satisfies interface (in test file)
var _ UserRepository = (*MockUserRepository)(nil)
```

## Testing Strategies for Interface-Heavy Code

### Table-Driven Tests with Multiple Scenarios

```go
func TestUserService_GetUser(t *testing.T) {
    tests := []struct {
        name        string
        userID      int64
        setupMock   func(*MockUserRepository)
        wantUser    *User
        wantErr     error
    }{
        {
            name:   "success",
            userID: 1,
            setupMock: func(m *MockUserRepository) {
                m.On("Get", mock.Anything, int64(1)).
                    Return(&User{ID: 1, Name: "Alice"}, nil)
            },
            wantUser: &User{ID: 1, Name: "Alice"},
        },
        {
            name:   "not found",
            userID: 99,
            setupMock: func(m *MockUserRepository) {
                m.On("Get", mock.Anything, int64(99)).
                    Return(nil, ErrNotFound)
            },
            wantErr: ErrNotFound,
        },
        {
            name:   "database error",
            userID: 1,
            setupMock: func(m *MockUserRepository) {
                m.On("Get", mock.Anything, int64(1)).
                    Return(nil, fmt.Errorf("connection refused"))
            },
            wantErr: ErrInternal,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            mockRepo := new(MockUserRepository)
            tt.setupMock(mockRepo)

            svc := &UserService{repo: mockRepo, mailer: &noopEmailSender{}}
            user, err := svc.GetUser(context.Background(), tt.userID)

            if tt.wantErr != nil {
                assert.ErrorIs(t, err, tt.wantErr)
                assert.Nil(t, user)
            } else {
                assert.NoError(t, err)
                assert.Equal(t, tt.wantUser, user)
            }

            mockRepo.AssertExpectations(t)
        })
    }
}
```

## Summary

Effective interface design in Go follows these principles:

1. **Define interfaces at the consumer** — the package that uses an interface should define it, not the package that implements it. This prevents circular dependencies and tight coupling.

2. **Keep interfaces small** — one or two methods is often ideal. Compose small interfaces when you need broader behavior.

3. **Accept interfaces, return structs** — functions and methods should accept the minimal interface they need, but return concrete types that callers can use fully.

4. **Avoid premature interfaces** — don't create an interface until you have at least two implementations or a clear testing need. One implementation + no tests = no interface needed.

5. **Use compile-time verification** — `var _ MyInterface = (*MyImpl)(nil)` catches interface drift before runtime.

6. **Choose the right mock strategy** — fakes for simple in-memory behavior, testify/mock for flexible runtime setup, gomock for generated mocks from complex interfaces.

These patterns scale from small services to million-line codebases by keeping coupling explicit, testability built-in, and interfaces meaningful rather than ceremonial.
