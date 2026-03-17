---
title: "Go Dependency Injection: Wire, Fx, and Manual DI Patterns"
date: 2029-05-19T00:00:00-05:00
draft: false
tags: ["Go", "Dependency Injection", "Wire", "Fx", "Architecture", "Testing", "golang"]
categories: ["Go", "Software Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to dependency injection in Go covering uber-go/fx, google/wire, manual DI patterns, testability, circular dependency prevention, and module initialization order."
more_link: "yes"
url: "/go-dependency-injection-wire-fx-manual-patterns/"
---

Dependency injection (DI) is one of the most powerful patterns for building maintainable, testable Go applications at scale. Unlike many other languages where DI frameworks are a given, Go's community has debated the merits of manual vs. framework-driven approaches for years. This post explores the full landscape: manual constructor injection, `google/wire` compile-time code generation, and `uber-go/fx` runtime container — giving you the tools to choose the right approach for your production systems.

<!--more-->

# Go Dependency Injection: Wire, Fx, and Manual DI Patterns

## Why Dependency Injection Matters in Go

At its core, dependency injection means that a component receives its dependencies rather than constructing them internally. This seemingly small distinction has enormous consequences for:

- **Testability**: swap real implementations with fakes or mocks during testing
- **Flexibility**: change implementations without touching consumers
- **Maintainability**: make dependency graphs explicit and auditable
- **Lifecycle management**: control initialization order and shutdown sequences

In Go, the standard idiom is constructor functions — `NewServer(db *DB, logger *Logger) *Server` — which naturally supports DI without any framework at all. However, as applications grow to dozens or hundreds of components, wiring them together manually becomes error-prone and tedious.

## Section 1: Manual Dependency Injection

Manual DI is the foundation everything else builds on. Understanding it deeply makes framework usage more effective.

### The Constructor Pattern

```go
package main

import (
    "database/sql"
    "log/slog"
    "net/http"
    "os"
)

// Config holds application configuration
type Config struct {
    DatabaseDSN string
    HTTPAddr    string
    LogLevel    string
}

// Database wraps sql.DB with application-specific methods
type Database struct {
    db     *sql.DB
    logger *slog.Logger
}

func NewDatabase(cfg Config, logger *slog.Logger) (*Database, error) {
    db, err := sql.Open("postgres", cfg.DatabaseDSN)
    if err != nil {
        return nil, fmt.Errorf("opening database: %w", err)
    }
    if err := db.Ping(); err != nil {
        return nil, fmt.Errorf("pinging database: %w", err)
    }
    return &Database{db: db, logger: logger}, nil
}

func (d *Database) Close() error {
    return d.db.Close()
}

// UserRepository handles user data persistence
type UserRepository struct {
    db     *Database
    logger *slog.Logger
}

func NewUserRepository(db *Database, logger *slog.Logger) *UserRepository {
    return &UserRepository{db: db, logger: logger}
}

// UserService contains business logic for users
type UserService struct {
    repo   *UserRepository
    logger *slog.Logger
}

func NewUserService(repo *UserRepository, logger *slog.Logger) *UserService {
    return &UserService{repo: repo, logger: logger}
}

// HTTPServer serves HTTP requests
type HTTPServer struct {
    svc    *UserService
    logger *slog.Logger
    addr   string
}

func NewHTTPServer(cfg Config, svc *UserService, logger *slog.Logger) *HTTPServer {
    return &HTTPServer{svc: svc, logger: logger, addr: cfg.HTTPAddr}
}

func (s *HTTPServer) ListenAndServe() error {
    mux := http.NewServeMux()
    mux.HandleFunc("/users", s.handleUsers)
    return http.ListenAndServe(s.addr, mux)
}

// Manual wiring in main
func main() {
    cfg := Config{
        DatabaseDSN: os.Getenv("DATABASE_DSN"),
        HTTPAddr:    ":8080",
        LogLevel:    "info",
    }

    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    db, err := NewDatabase(cfg, logger)
    if err != nil {
        logger.Error("failed to connect to database", "error", err)
        os.Exit(1)
    }
    defer db.Close()

    repo := NewUserRepository(db, logger)
    svc := NewUserService(repo, logger)
    server := NewHTTPServer(cfg, svc, logger)

    if err := server.ListenAndServe(); err != nil {
        logger.Error("server failed", "error", err)
        os.Exit(1)
    }
}
```

### Interface-Based DI for Testability

The key to testable code is depending on interfaces, not concrete types:

```go
package users

import (
    "context"
    "time"
)

// UserStore defines the storage contract
type UserStore interface {
    GetByID(ctx context.Context, id string) (*User, error)
    Create(ctx context.Context, user *User) error
    Update(ctx context.Context, user *User) error
    Delete(ctx context.Context, id string) error
}

// EmailSender defines the email contract
type EmailSender interface {
    Send(ctx context.Context, to, subject, body string) error
}

// User represents the domain entity
type User struct {
    ID        string
    Email     string
    Name      string
    CreatedAt time.Time
}

// Service handles user business logic
type Service struct {
    store  UserStore
    email  EmailSender
    logger *slog.Logger
}

func NewService(store UserStore, email EmailSender, logger *slog.Logger) *Service {
    return &Service{
        store:  store,
        email:  email,
        logger: logger,
    }
}

func (s *Service) CreateUser(ctx context.Context, req CreateUserRequest) (*User, error) {
    user := &User{
        ID:        generateID(),
        Email:     req.Email,
        Name:      req.Name,
        CreatedAt: time.Now(),
    }

    if err := s.store.Create(ctx, user); err != nil {
        return nil, fmt.Errorf("creating user: %w", err)
    }

    // Send welcome email
    if err := s.email.Send(ctx, user.Email, "Welcome!", "Thanks for signing up."); err != nil {
        // Log but don't fail — email is non-critical
        s.logger.Warn("failed to send welcome email", "user_id", user.ID, "error", err)
    }

    return user, nil
}
```

### Testing with Manual Fakes

```go
package users_test

import (
    "context"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

// FakeUserStore is a test double implementing UserStore
type FakeUserStore struct {
    users  map[string]*User
    err    error  // inject errors for failure testing
}

func NewFakeUserStore() *FakeUserStore {
    return &FakeUserStore{users: make(map[string]*User)}
}

func (f *FakeUserStore) GetByID(_ context.Context, id string) (*User, error) {
    if f.err != nil {
        return nil, f.err
    }
    u, ok := f.users[id]
    if !ok {
        return nil, ErrNotFound
    }
    return u, nil
}

func (f *FakeUserStore) Create(_ context.Context, user *User) error {
    if f.err != nil {
        return f.err
    }
    f.users[user.ID] = user
    return nil
}

func (f *FakeUserStore) Update(_ context.Context, user *User) error {
    if f.err != nil {
        return f.err
    }
    f.users[user.ID] = user
    return nil
}

func (f *FakeUserStore) Delete(_ context.Context, id string) error {
    if f.err != nil {
        return f.err
    }
    delete(f.users, id)
    return nil
}

// FakeEmailSender captures sent emails for assertion
type FakeEmailSender struct {
    Sent []SentEmail
    err  error
}

type SentEmail struct {
    To, Subject, Body string
}

func (f *FakeEmailSender) Send(_ context.Context, to, subject, body string) error {
    if f.err != nil {
        return f.err
    }
    f.Sent = append(f.Sent, SentEmail{To: to, Subject: subject, Body: body})
    return nil
}

func TestCreateUser(t *testing.T) {
    store := NewFakeUserStore()
    emailSender := &FakeEmailSender{}
    logger := slog.New(slog.NewTextHandler(io.Discard, nil))

    svc := NewService(store, emailSender, logger)

    user, err := svc.CreateUser(context.Background(), CreateUserRequest{
        Email: "alice@example.com",
        Name:  "Alice",
    })

    require.NoError(t, err)
    assert.Equal(t, "alice@example.com", user.Email)
    assert.Equal(t, "Alice", user.Name)

    // Verify email was sent
    require.Len(t, emailSender.Sent, 1)
    assert.Equal(t, "alice@example.com", emailSender.Sent[0].To)
    assert.Equal(t, "Welcome!", emailSender.Sent[0].Subject)
}

func TestCreateUser_EmailFailure_DoesNotFail(t *testing.T) {
    store := NewFakeUserStore()
    emailSender := &FakeEmailSender{err: errors.New("SMTP timeout")}
    logger := slog.New(slog.NewTextHandler(io.Discard, nil))

    svc := NewService(store, emailSender, logger)

    // Should succeed even when email fails
    user, err := svc.CreateUser(context.Background(), CreateUserRequest{
        Email: "bob@example.com",
        Name:  "Bob",
    })

    require.NoError(t, err)
    assert.NotEmpty(t, user.ID)
}
```

## Section 2: Google Wire — Compile-Time Code Generation

`google/wire` is a code generation tool that analyzes your constructor functions at compile time and generates the wiring code for you. There is no runtime overhead — the generated code is identical to what you'd write manually.

### Installation and Setup

```bash
go install github.com/google/wire/cmd/wire@latest
```

### Defining Providers

Wire calls constructors "providers". You organize them into `ProviderSet` objects:

```go
// wire_providers.go
package app

import (
    "github.com/google/wire"
)

// DatabaseSet groups database-related providers
var DatabaseSet = wire.NewSet(
    NewDatabase,
    NewUserRepository,
    NewOrderRepository,
)

// ServiceSet groups service-layer providers
var ServiceSet = wire.NewSet(
    NewUserService,
    NewOrderService,
    NewNotificationService,
)

// InfraSet groups infrastructure providers
var InfraSet = wire.NewSet(
    NewConfig,
    NewLogger,
    NewHTTPClient,
    NewEmailSender,
)

// AppSet is the root provider set
var AppSet = wire.NewSet(
    InfraSet,
    DatabaseSet,
    ServiceSet,
    NewHTTPServer,
)
```

### The Wire Initializer File

```go
// wire.go — this file is used by wire to generate wire_gen.go
//go:build wireinject
// +build wireinject

package app

import (
    "github.com/google/wire"
)

// InitializeApp creates a fully wired application
func InitializeApp(cfgPath string) (*App, func(), error) {
    wire.Build(AppSet)
    return nil, nil, nil
}

// InitializeTestApp creates a wired app for testing
// with fake implementations substituted
func InitializeTestApp(store UserStore, email EmailSender) (*App, func(), error) {
    wire.Build(
        NewConfig,
        NewLogger,
        NewUserService,
        NewOrderService,
        NewHTTPServer,
        // Note: UserStore and EmailSender are passed in as parameters
        // Wire will use them directly rather than calling constructors
    )
    return nil, nil, nil
}
```

### Running Wire Code Generation

```bash
# Run wire in the package directory
wire ./app/...

# Or run it for the whole module
wire ./...
```

### Generated Code (wire_gen.go)

Wire generates something like this — do not edit it manually:

```go
// Code generated by Wire. DO NOT EDIT.

//go:generate go run github.com/google/wire/cmd/wire
//go:build !wireinject
// +build !wireinject

package app

// Injectors from wire.go:

func InitializeApp(cfgPath string) (*App, func(), error) {
    config, err := NewConfig(cfgPath)
    if err != nil {
        return nil, nil, err
    }
    logger := NewLogger(config)
    database, cleanup, err := NewDatabase(config, logger)
    if err != nil {
        return nil, nil, err
    }
    userRepository := NewUserRepository(database, logger)
    orderRepository := NewOrderRepository(database, logger)
    httpClient := NewHTTPClient(config)
    emailSender := NewEmailSender(config, httpClient)
    userService := NewUserService(userRepository, emailSender, logger)
    orderService := NewOrderService(orderRepository, userService, logger)
    notificationService := NewNotificationService(emailSender, logger)
    httpServer := NewHTTPServer(config, userService, orderService, notificationService, logger)
    app := &App{
        server: httpServer,
        db:     database,
    }
    cleanup2 := func() {
        cleanup()
    }
    return app, cleanup2, nil
}
```

### Wire Bindings for Interfaces

When providers return concrete types but consumers expect interfaces, use `wire.Bind`:

```go
var UserStoreBinding = wire.NewSet(
    NewPostgresUserStore,
    wire.Bind(new(UserStore), new(*PostgresUserStore)),
)

var EmailBinding = wire.NewSet(
    NewSMTPEmailSender,
    wire.Bind(new(EmailSender), new(*SMTPEmailSender)),
)
```

### Wire Value Providers

For values that don't need construction:

```go
// wire_providers.go
func provideHTTPMux() *http.ServeMux {
    return http.NewServeMux()
}

// Or use wire.Value for constants
var TimeZoneSet = wire.NewSet(
    wire.Value(time.UTC),
)
```

### Handling Cleanup Functions

Wire understands a specific pattern for cleanup:

```go
// Constructor returns a cleanup func
func NewDatabase(cfg Config, logger *slog.Logger) (*Database, func(), error) {
    db, err := sql.Open("postgres", cfg.DatabaseDSN)
    if err != nil {
        return nil, nil, err
    }

    cleanup := func() {
        if err := db.Close(); err != nil {
            logger.Error("error closing database", "error", err)
        }
    }

    return &Database{db: db, logger: logger}, cleanup, nil
}
```

Wire will chain these cleanup functions and call them in reverse initialization order.

## Section 3: Uber-Go/Fx — Runtime Dependency Injection

`uber-go/fx` is a full-featured runtime DI framework that uses reflection. It manages the entire application lifecycle including start/stop hooks.

### Installation

```bash
go get go.uber.org/fx
```

### Basic Fx Application

```go
package main

import (
    "context"
    "fmt"
    "net"
    "net/http"
    "os"

    "go.uber.org/fx"
    "go.uber.org/zap"
)

func NewLogger() (*zap.Logger, error) {
    return zap.NewProduction()
}

func NewMux(lc fx.Lifecycle, logger *zap.Logger) *http.ServeMux {
    mux := http.NewServeMux()
    server := &http.Server{Addr: ":8080", Handler: mux}

    lc.Append(fx.Hook{
        OnStart: func(ctx context.Context) error {
            ln, err := net.Listen("tcp", server.Addr)
            if err != nil {
                return err
            }
            logger.Info("Starting HTTP server", zap.String("addr", server.Addr))
            go server.Serve(ln)
            return nil
        },
        OnStop: func(ctx context.Context) error {
            logger.Info("Stopping HTTP server")
            return server.Shutdown(ctx)
        },
    })

    return mux
}

func NewDatabase(lc fx.Lifecycle, cfg *Config, logger *zap.Logger) (*Database, error) {
    db, err := sql.Open("postgres", cfg.DatabaseDSN)
    if err != nil {
        return nil, err
    }

    lc.Append(fx.Hook{
        OnStart: func(ctx context.Context) error {
            return db.PingContext(ctx)
        },
        OnStop: func(ctx context.Context) error {
            return db.Close()
        },
    })

    return &Database{db: db, logger: logger}, nil
}

func RegisterRoutes(mux *http.ServeMux, userHandler *UserHandler, orderHandler *OrderHandler) {
    mux.HandleFunc("GET /users", userHandler.List)
    mux.HandleFunc("POST /users", userHandler.Create)
    mux.HandleFunc("GET /orders", orderHandler.List)
    mux.HandleFunc("POST /orders", orderHandler.Create)
}

func main() {
    app := fx.New(
        // Provide constructors
        fx.Provide(
            NewConfig,
            NewLogger,
            NewDatabase,
            NewMux,
            NewUserRepository,
            NewUserService,
            NewUserHandler,
            NewOrderRepository,
            NewOrderService,
            NewOrderHandler,
        ),
        // Invoke runs functions that have side effects (like registering routes)
        fx.Invoke(RegisterRoutes),
    )

    app.Run()
}
```

### Fx Modules for Large Applications

Fx supports organizing providers into modules:

```go
// users/module.go
package users

import "go.uber.org/fx"

var Module = fx.Module("users",
    fx.Provide(
        NewRepository,
        NewService,
        NewHandler,
    ),
)

// orders/module.go
package orders

import "go.uber.org/fx"

var Module = fx.Module("orders",
    fx.Provide(
        NewRepository,
        NewService,
        NewHandler,
    ),
)

// main.go
func main() {
    app := fx.New(
        fx.Provide(NewConfig, NewLogger, NewDatabase),
        users.Module,
        orders.Module,
        fx.Invoke(RegisterRoutes),
    )
    app.Run()
}
```

### Fx Value Groups for Multi-Provider Patterns

Value groups allow multiple providers to contribute to the same slice:

```go
// Define a type alias to use as the group key
type Route struct {
    Pattern string
    Handler http.Handler
}

// Each handler provides a route
func NewUserRoutes(svc *UserService) []Route {
    return []Route{
        {Pattern: "GET /users", Handler: http.HandlerFunc(svc.List)},
        {Pattern: "POST /users", Handler: http.HandlerFunc(svc.Create)},
    }
}

// Annotate the provider with the group tag
fx.Provide(
    fx.Annotate(
        NewUserRoutes,
        fx.ResultTags(`group:"routes"`),
    ),
    fx.Annotate(
        NewOrderRoutes,
        fx.ResultTags(`group:"routes"`),
    ),
)

// Consumer collects all routes from the group
type RouteRegistrar struct {
    routes []Route
}

func NewRouteRegistrar(routes []Route) *RouteRegistrar {
    return &RouteRegistrar{routes: routes}
}

// Tell Fx to collect all "routes" group values
fx.Provide(
    fx.Annotate(
        NewRouteRegistrar,
        fx.ParamTags(`group:"routes"`),
    ),
)
```

### Fx Lifecycle Hooks in Detail

```go
// Structured service with proper lifecycle management
type Server struct {
    http   *http.Server
    db     *sql.DB
    logger *zap.Logger
}

func NewServer(lc fx.Lifecycle, cfg *Config, handler http.Handler, db *sql.DB, logger *zap.Logger) *Server {
    s := &Server{
        http: &http.Server{
            Addr:         cfg.HTTPAddr,
            Handler:      handler,
            ReadTimeout:  15 * time.Second,
            WriteTimeout: 15 * time.Second,
            IdleTimeout:  60 * time.Second,
        },
        db:     db,
        logger: logger,
    }

    lc.Append(fx.Hook{
        OnStart: func(ctx context.Context) error {
            ln, err := net.Listen("tcp", s.http.Addr)
            if err != nil {
                return fmt.Errorf("listening on %s: %w", s.http.Addr, err)
            }
            logger.Info("Server starting", zap.String("addr", s.http.Addr))
            go func() {
                if err := s.http.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
                    logger.Error("Server error", zap.Error(err))
                }
            }()
            return nil
        },
        OnStop: func(ctx context.Context) error {
            logger.Info("Server shutting down")
            return s.http.Shutdown(ctx)
        },
    })

    return s
}
```

## Section 4: Preventing Circular Dependencies

Circular dependencies are a design smell — and in Go, they cause compile errors between packages. Here's how to recognize and resolve them.

### Detecting Circular Dependencies

```bash
# Go will tell you directly
go build ./...
# import cycle not allowed in test
# package a (test) imports b imports a

# Use go mod graph to visualize
go mod graph | grep -E "^myapp"

# Or use a visualization tool
go get golang.org/x/tools/cmd/goimports
go get github.com/kisielk/godepgraph
godepgraph ./... | dot -Tsvg -o deps.svg
```

### Common Circular Dependency Patterns and Solutions

**Pattern 1: Two packages that reference each other**

```go
// BAD: users imports orders, orders imports users
package users

import "myapp/orders" // users needs orders.Order

package orders

import "myapp/users" // orders needs users.User
```

**Solution: Extract shared types to a common package**

```go
// myapp/domain/types.go — shared domain types
package domain

type User struct {
    ID    string
    Email string
}

type Order struct {
    ID     string
    UserID string
}

// Now neither users nor orders packages import each other
package users

import "myapp/domain"

package orders

import "myapp/domain"
```

**Pattern 2: Service layer circular reference**

```go
// BAD: UserService needs OrderService to get user's orders
//      OrderService needs UserService to validate user exists
package users

import "myapp/orders"

type UserService struct {
    orders *orders.OrderService // CIRCULAR
}

package orders

import "myapp/users"

type OrderService struct {
    users *users.UserService // CIRCULAR
}
```

**Solution: Use interfaces to break the cycle**

```go
// users/service.go
package users

// OrderProvider is implemented by orders.OrderService
// but defined here to break the cycle
type OrderProvider interface {
    GetOrdersForUser(ctx context.Context, userID string) ([]*Order, error)
}

type UserService struct {
    repo   UserStore
    orders OrderProvider // interface, not concrete type
}

// orders/service.go
package orders

// UserValidator is implemented by users.UserService
type UserValidator interface {
    ValidateUserExists(ctx context.Context, userID string) error
}

type OrderService struct {
    repo  OrderStore
    users UserValidator // interface, not concrete type
}
```

**Pattern 3: Mediator / Event Bus to decouple**

```go
// events/bus.go
package events

type EventBus struct {
    handlers map[string][]Handler
    mu       sync.RWMutex
}

type Handler func(ctx context.Context, event Event) error

func (b *EventBus) Subscribe(eventType string, h Handler) {
    b.mu.Lock()
    defer b.mu.Unlock()
    b.handlers[eventType] = append(b.handlers[eventType], h)
}

func (b *EventBus) Publish(ctx context.Context, event Event) error {
    b.mu.RLock()
    handlers := b.handlers[event.Type]
    b.mu.RUnlock()

    for _, h := range handlers {
        if err := h(ctx, event); err != nil {
            return err
        }
    }
    return nil
}

// users/service.go — publishes events, doesn't know about orders
type UserService struct {
    repo UserStore
    bus  *events.EventBus
}

func (s *UserService) CreateUser(ctx context.Context, req CreateUserRequest) (*User, error) {
    user, err := s.repo.Create(ctx, req)
    if err != nil {
        return nil, err
    }
    s.bus.Publish(ctx, events.Event{Type: "user.created", Payload: user})
    return user, nil
}

// orders/service.go — subscribes to events, doesn't know about users
func (s *OrderService) Register(bus *events.EventBus) {
    bus.Subscribe("user.created", s.onUserCreated)
}

func (s *OrderService) onUserCreated(ctx context.Context, event events.Event) error {
    // React to user creation without importing users package
    return nil
}
```

## Section 5: Module Initialization Order

### The Problem with `init()` Functions

```go
// BAD: relying on init() order is fragile
package db

var DefaultDB *Database

func init() {
    var err error
    DefaultDB, err = connect()
    if err != nil {
        log.Fatal(err) // Can't return errors from init
    }
}

// This creates hidden dependencies and makes testing impossible
package users

import _ "myapp/db" // side-effect import

var repo = &UserRepository{db: db.DefaultDB}
```

### Explicit Initialization Order with DI

```go
// GOOD: explicit ordering through constructor dependencies
func main() {
    // 1. Infrastructure first
    cfg := NewConfig()
    logger := NewLogger(cfg)

    // 2. Data stores next
    db, cleanup, err := NewDatabase(cfg, logger)
    if err != nil {
        logger.Error("database init failed", "error", err)
        os.Exit(1)
    }
    defer cleanup()

    cache, err := NewRedisCache(cfg, logger)
    if err != nil {
        logger.Error("cache init failed", "error", err)
        os.Exit(1)
    }
    defer cache.Close()

    // 3. Repositories
    userRepo := NewUserRepository(db, logger)
    orderRepo := NewOrderRepository(db, logger)

    // 4. Services
    userSvc := NewUserService(userRepo, cache, logger)
    orderSvc := NewOrderService(orderRepo, userSvc, logger)

    // 5. HTTP layer last
    server := NewServer(cfg, userSvc, orderSvc, logger)

    // 6. Start
    if err := server.ListenAndServe(); err != nil {
        logger.Error("server error", "error", err)
        os.Exit(1)
    }
}
```

### Using errgroup for Parallel Initialization

Some components can be initialized in parallel:

```go
package app

import (
    "context"
    "fmt"

    "golang.org/x/sync/errgroup"
)

type Infrastructure struct {
    DB    *Database
    Cache *Cache
    Queue *Queue
}

func InitializeInfrastructure(ctx context.Context, cfg Config, logger *slog.Logger) (*Infrastructure, error) {
    var (
        infra Infrastructure
        g     errgroup.Group
        mu    sync.Mutex
    )

    g.Go(func() error {
        db, err := NewDatabase(cfg, logger)
        if err != nil {
            return fmt.Errorf("database: %w", err)
        }
        mu.Lock()
        infra.DB = db
        mu.Unlock()
        return nil
    })

    g.Go(func() error {
        cache, err := NewRedisCache(cfg, logger)
        if err != nil {
            return fmt.Errorf("cache: %w", err)
        }
        mu.Lock()
        infra.Cache = cache
        mu.Unlock()
        return nil
    })

    g.Go(func() error {
        queue, err := NewMessageQueue(cfg, logger)
        if err != nil {
            return fmt.Errorf("queue: %w", err)
        }
        mu.Lock()
        infra.Queue = queue
        mu.Unlock()
        return nil
    })

    if err := g.Wait(); err != nil {
        return nil, fmt.Errorf("initializing infrastructure: %w", err)
    }

    return &infra, nil
}
```

## Section 6: Choosing Between Wire, Fx, and Manual DI

### Decision Matrix

| Factor | Manual DI | Wire | Fx |
|--------|-----------|------|----|
| Runtime overhead | None | None | Small (reflection) |
| Compile-time safety | Partial | Full | Partial |
| Learning curve | Low | Medium | High |
| Lifecycle management | Manual | Manual | Built-in |
| Large app scalability | Poor | Good | Excellent |
| Debugging | Easy | Easy | Harder |
| Testing | Easy | Easy | Medium |
| Code generation | None | Yes | No |

### When to Use Each

**Manual DI** is best when:
- The application has fewer than ~20 components
- You want zero magic and maximum transparency
- The team is new to Go and prefers to see everything explicitly

**Wire** is best when:
- You have many components but want compile-time guarantees
- You're willing to run `wire` as part of your build process
- You want generated code that's readable and debuggable

**Fx** is best when:
- You're building a large microservice or monolith with complex lifecycle
- You want plugin-style module composition
- The team is comfortable with framework conventions

### Practical Wire Example: Complete Application

```go
// app/wire.go
//go:build wireinject

package app

import "github.com/google/wire"

func InitializeServer(cfgPath string) (*Server, func(), error) {
    wire.Build(
        NewConfig,
        NewLogger,
        NewDatabase,        // returns (*DB, func(), error)
        NewCache,           // returns (*Cache, func(), error)
        NewUserRepository,
        NewOrderRepository,
        NewUserService,
        NewOrderService,
        wire.Bind(new(UserStore), new(*PostgresUserStore)),
        wire.Bind(new(EmailSender), new(*SMTPEmailSender)),
        NewSMTPEmailSender,
        NewHTTPServer,
    )
    return nil, nil, nil
}
```

```bash
# In Makefile:
generate:
    go generate ./...

# In each package with wire:
//go:generate wire
```

## Section 7: Integration Testing with DI

The real payoff of DI is integration testing:

```go
// integration_test.go
package app_test

import (
    "context"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestUserCreationFlow(t *testing.T) {
    // Set up fakes
    store := NewFakeUserStore()
    email := &FakeEmailSender{}
    logger := slog.New(slog.NewTextHandler(io.Discard, nil))

    // Wire up the real service with fake infrastructure
    repo := NewUserRepository(store, logger)
    svc := NewUserService(repo, email, logger)
    handler := NewUserHandler(svc, logger)

    // Create test server
    mux := http.NewServeMux()
    handler.RegisterRoutes(mux)
    ts := httptest.NewServer(mux)
    defer ts.Close()

    // Execute the full request/response cycle
    body := strings.NewReader(`{"email":"test@example.com","name":"Test User"}`)
    resp, err := http.Post(ts.URL+"/users", "application/json", body)
    require.NoError(t, err)
    assert.Equal(t, http.StatusCreated, resp.StatusCode)

    // Verify side effects
    require.Len(t, email.Sent, 1)
    assert.Equal(t, "test@example.com", email.Sent[0].To)
}
```

## Conclusion

Dependency injection in Go is not about choosing the most sophisticated framework — it's about making your code testable, maintainable, and explicit. Start with manual DI and interfaces, reach for Wire when the wiring becomes tedious, and adopt Fx when you need rich lifecycle management for complex applications.

The principles are the same regardless of approach: program to interfaces, inject dependencies through constructors, and keep your initialization logic separated from your business logic. These habits will serve you well whether you have 10 components or 1,000.
