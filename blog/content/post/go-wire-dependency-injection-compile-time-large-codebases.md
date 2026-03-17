---
title: "Go Dependency Injection with Wire: Compile-Time DI for Large Codebases"
date: 2028-12-21T00:00:00-05:00
draft: false
tags: ["Go", "Dependency Injection", "Wire", "Architecture", "Enterprise", "Code Generation"]
categories:
- Go
- Software Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Google Wire for compile-time dependency injection in Go, covering provider sets, injectors, interfaces, testing patterns, and structuring large enterprise codebases without runtime reflection."
more_link: "yes"
url: "/go-wire-dependency-injection-compile-time-large-codebases/"
---

Dependency injection in Go is a subject with strong opinions. Unlike Java or C# ecosystems, Go's community has historically preferred explicit construction over framework-driven DI containers. Google Wire occupies a unique position: it provides the organizational benefits of a DI framework while generating plain Go code at compile time, eliminating reflection overhead and making dependency graphs inspectable with standard tooling. This post covers Wire architecture, provider organization, interface binding, testing patterns, and how to structure Wire in a large Go monorepo without losing maintainability.

<!--more-->

## Why Wire Over Manual Wiring

In small services, manually constructing the dependency graph in `main.go` is perfectly reasonable. As codebases grow, manual wiring creates several problems:

- `main.go` becomes a sprawling construction site with hundreds of lines
- Adding a new transitive dependency requires modifying every call site up the chain
- Testing requires duplicating construction logic or building specialized test helpers
- Circular dependency detection happens at runtime (panic) rather than compile time

Wire solves these with a code generator that analyzes provider functions, builds the dependency graph, and emits a `wire_gen.go` file containing ordinary Go functions. The generated code is committed to version control, readable, and has zero runtime overhead.

## Wire Fundamentals

### Installation

```bash
# Install the wire CLI
go install github.com/google/wire/cmd/wire@v0.6.0

# Add to go.mod
go get github.com/google/wire@v0.6.0
```

### Provider Functions

A provider is any function that returns a type (or a type and an error). Wire analyzes provider signatures to understand what types they produce and what types they consume:

```go
// internal/database/provider.go
package database

import (
    "context"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "go.support.tools/myapp/internal/config"
)

// Pool is a type alias to make Wire's graph unambiguous
type Pool = pgxpool.Pool

// NewPool is a Wire provider for *Pool.
// Wire sees: takes config.DatabaseConfig, returns (*Pool, error)
func NewPool(ctx context.Context, cfg config.DatabaseConfig) (*Pool, error) {
    connStr := fmt.Sprintf(
        "host=%s port=%d user=%s password=%s dbname=%s sslmode=%s pool_max_conns=%d",
        cfg.Host, cfg.Port, cfg.User, cfg.Password, cfg.DBName, cfg.SSLMode,
        cfg.MaxConns,
    )

    poolConfig, err := pgxpool.ParseConfig(connStr)
    if err != nil {
        return nil, fmt.Errorf("parsing pool config: %w", err)
    }

    poolConfig.MaxConnLifetime = 30 * time.Minute
    poolConfig.MaxConnIdleTime = 5 * time.Minute
    poolConfig.HealthCheckPeriod = time.Minute

    pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
    if err != nil {
        return nil, fmt.Errorf("creating pool: %w", err)
    }

    if err := pool.Ping(ctx); err != nil {
        pool.Close()
        return nil, fmt.Errorf("pool health check: %w", err)
    }

    return pool, nil
}

// PoolCleanup is a cleanup function returned alongside the pool
func PoolCleanup(pool *Pool) func() {
    return func() {
        pool.Close()
    }
}
```

### Provider Sets

Provider sets group related providers. They compose hierarchically, forming a declarative dependency catalog:

```go
// internal/database/wire.go
package database

import "github.com/google/wire"

// Set is the Wire provider set for the database package.
// Any consumer can include this set to get all database providers.
var Set = wire.NewSet(
    NewPool,
)
```

```go
// internal/repository/user_repository.go
package repository

import (
    "context"
    "fmt"

    "github.com/jackc/pgx/v5/pgxpool"
    "go.support.tools/myapp/internal/database"
    "go.support.tools/myapp/internal/domain"
)

type UserRepository struct {
    pool *database.Pool
}

func NewUserRepository(pool *database.Pool) *UserRepository {
    return &UserRepository{pool: pool}
}

func (r *UserRepository) FindByID(ctx context.Context, id int64) (*domain.User, error) {
    var u domain.User
    err := r.pool.QueryRow(ctx,
        "SELECT id, email, name, created_at FROM users WHERE id = $1 AND deleted_at IS NULL",
        id,
    ).Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt)
    if err != nil {
        return nil, fmt.Errorf("finding user %d: %w", id, err)
    }
    return &u, nil
}

func (r *UserRepository) Create(ctx context.Context, u *domain.User) error {
    return r.pool.QueryRow(ctx,
        "INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id, created_at",
        u.Email, u.Name,
    ).Scan(&u.ID, &u.CreatedAt)
}
```

```go
// internal/repository/wire.go
package repository

import "github.com/google/wire"

var Set = wire.NewSet(
    NewUserRepository,
    NewOrderRepository,
    NewProductRepository,
)
```

## Interface Binding

Wire's most powerful feature is binding interfaces to concrete implementations, enabling clean architecture boundaries:

```go
// internal/domain/ports.go
package domain

import "context"

// UserReader is the read port for users
type UserReader interface {
    FindByID(ctx context.Context, id int64) (*User, error)
    FindByEmail(ctx context.Context, email string) (*User, error)
    List(ctx context.Context, opts ListOptions) ([]*User, error)
}

// UserWriter is the write port for users
type UserWriter interface {
    Create(ctx context.Context, u *User) error
    Update(ctx context.Context, u *User) error
    Delete(ctx context.Context, id int64) error
}

// UserRepository combines read and write operations
type UserRepository interface {
    UserReader
    UserWriter
}

// EmailSender abstracts email delivery
type EmailSender interface {
    SendWelcome(ctx context.Context, to string, name string) error
    SendPasswordReset(ctx context.Context, to string, token string) error
}
```

```go
// internal/repository/wire_bindings.go
package repository

import (
    "github.com/google/wire"
    "go.support.tools/myapp/internal/domain"
)

// Bindings maps interfaces to their concrete implementations.
// This is the only place in the codebase where interface-to-struct
// bindings live, making the architecture visible at a glance.
var Bindings = wire.NewSet(
    wire.Bind(new(domain.UserRepository), new(*UserRepository)),
    wire.Bind(new(domain.OrderRepository), new(*OrderRepository)),
    wire.Bind(new(domain.ProductRepository), new(*ProductRepository)),
)

// Set includes both providers and bindings
var Set = wire.NewSet(
    NewUserRepository,
    NewOrderRepository,
    NewProductRepository,
    Bindings,
)
```

## Structuring a Large Service

For a production service with multiple HTTP handlers, background workers, and external integrations:

```go
// internal/service/user_service.go
package service

import (
    "context"
    "fmt"
    "time"

    "go.support.tools/myapp/internal/domain"
    "go.support.tools/myapp/internal/metrics"
    "go.uber.org/zap"
)

type UserService struct {
    users   domain.UserRepository
    email   domain.EmailSender
    metrics *metrics.Recorder
    logger  *zap.Logger
}

func NewUserService(
    users domain.UserRepository,
    email domain.EmailSender,
    m *metrics.Recorder,
    logger *zap.Logger,
) *UserService {
    return &UserService{
        users:   users,
        email:   email,
        metrics: m,
        logger:  logger,
    }
}

func (s *UserService) Register(ctx context.Context, req domain.RegisterRequest) (*domain.User, error) {
    start := time.Now()
    defer func() {
        s.metrics.RecordLatency("user.register", time.Since(start))
    }()

    // Check for existing user
    existing, err := s.users.FindByEmail(ctx, req.Email)
    if err == nil && existing != nil {
        return nil, domain.ErrEmailAlreadyRegistered
    }

    user := &domain.User{
        Email: req.Email,
        Name:  req.Name,
    }

    if err := s.users.Create(ctx, user); err != nil {
        return nil, fmt.Errorf("creating user: %w", err)
    }

    if err := s.email.SendWelcome(ctx, user.Email, user.Name); err != nil {
        s.logger.Warn("failed to send welcome email",
            zap.Int64("user_id", user.ID),
            zap.Error(err),
        )
        // Non-fatal: user is created, email failure is logged
    }

    s.metrics.IncrementCounter("user.registered")
    return user, nil
}
```

### The Application Struct and Injector

```go
// cmd/api/app.go
package main

import (
    "context"

    "go.support.tools/myapp/internal/handler"
    "go.support.tools/myapp/internal/worker"
    "go.uber.org/zap"
)

// Application holds all top-level components.
// Wire generates the constructor for this struct.
type Application struct {
    Server  *handler.HTTPServer
    Workers *worker.Manager
    Logger  *zap.Logger
}

// Cleanup releases all resources held by Application.
type Cleanup func()
```

```go
// cmd/api/wire.go
//go:build wireinject
// +build wireinject

// The wireinject build tag ensures this file is only used by the wire tool,
// never compiled into the actual binary.

package main

import (
    "context"

    "github.com/google/wire"
    "go.support.tools/myapp/internal/config"
    "go.support.tools/myapp/internal/database"
    "go.support.tools/myapp/internal/email"
    "go.support.tools/myapp/internal/handler"
    "go.support.tools/myapp/internal/logging"
    "go.support.tools/myapp/internal/metrics"
    "go.support.tools/myapp/internal/repository"
    "go.support.tools/myapp/internal/service"
    "go.support.tools/myapp/internal/worker"
)

// InitializeApplication is the Wire injector function.
// Wire reads this function's body as a graph specification, not as executable code.
func InitializeApplication(ctx context.Context, cfg *config.Config) (*Application, Cleanup, error) {
    wire.Build(
        // Infrastructure
        logging.Set,
        metrics.Set,
        database.Set,

        // Data access
        repository.Set,

        // External integrations
        email.Set,

        // Business logic
        service.Set,

        // Transport
        handler.Set,
        worker.Set,

        // Top-level struct
        wire.Struct(new(Application), "*"),
    )
    return nil, nil, nil // Wire replaces this body with generated code
}
```

### Generated Wire Code

After running `wire ./cmd/api/...`, Wire produces:

```go
// cmd/api/wire_gen.go
// Code generated by Wire. DO NOT EDIT.

//go:generate go run github.com/google/wire/cmd/wire
//go:build !wireinject
// +build !wireinject

package main

import (
    "context"

    "go.support.tools/myapp/internal/config"
    "go.support.tools/myapp/internal/database"
    "go.support.tools/myapp/internal/email"
    "go.support.tools/myapp/internal/handler"
    "go.support.tools/myapp/internal/logging"
    "go.support.tools/myapp/internal/metrics"
    "go.support.tools/myapp/internal/repository"
    "go.support.tools/myapp/internal/service"
    "go.support.tools/myapp/internal/worker"
)

// Injectors from wire.go:

func InitializeApplication(ctx context.Context, cfg *config.Config) (*Application, Cleanup, error) {
    logger, err := logging.NewLogger(cfg.Logging)
    if err != nil {
        return nil, nil, err
    }

    recorder := metrics.NewRecorder(cfg.Metrics)

    pool, err := database.NewPool(ctx, cfg.Database)
    if err != nil {
        return nil, nil, err
    }

    userRepository := repository.NewUserRepository(pool)
    orderRepository := repository.NewOrderRepository(pool)
    productRepository := repository.NewProductRepository(pool)

    smtpSender := email.NewSMTPSender(cfg.Email, logger)

    userService := service.NewUserService(userRepository, smtpSender, recorder, logger)
    orderService := service.NewOrderService(orderRepository, productRepository, recorder, logger)

    httpServer := handler.NewHTTPServer(cfg.HTTP, userService, orderService, logger)
    manager := worker.NewManager(cfg.Workers, orderService, logger)

    app := &Application{
        Server:  httpServer,
        Workers: manager,
        Logger:  logger,
    }

    cleanup := func() {
        database.PoolCleanup(pool)()
    }

    return app, cleanup, nil
}
```

## Testing with Wire

Wire's real advantage shows in testing. Each layer can be tested by substituting providers:

```go
// internal/service/user_service_test.go
package service_test

import (
    "context"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
    "go.support.tools/myapp/internal/domain"
    "go.support.tools/myapp/internal/service"
    "go.uber.org/zap/zaptest"
)

// MockUserRepository satisfies domain.UserRepository
type MockUserRepository struct {
    mock.Mock
}

func (m *MockUserRepository) FindByID(ctx context.Context, id int64) (*domain.User, error) {
    args := m.Called(ctx, id)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).(*domain.User), args.Error(1)
}

func (m *MockUserRepository) FindByEmail(ctx context.Context, email string) (*domain.User, error) {
    args := m.Called(ctx, email)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).(*domain.User), args.Error(1)
}

func (m *MockUserRepository) Create(ctx context.Context, u *domain.User) error {
    args := m.Called(ctx, u)
    if args.Error(0) == nil {
        u.ID = 42
        u.CreatedAt = time.Now()
    }
    return args.Error(0)
}

// MockEmailSender satisfies domain.EmailSender
type MockEmailSender struct {
    mock.Mock
}

func (m *MockEmailSender) SendWelcome(ctx context.Context, to, name string) error {
    return m.Called(ctx, to, name).Error(0)
}

func TestUserService_Register_Success(t *testing.T) {
    ctx := context.Background()
    logger := zaptest.NewLogger(t)

    userRepo := &MockUserRepository{}
    emailSender := &MockEmailSender{}
    metricsRecorder := metrics.NewNoopRecorder()

    // No existing user with this email
    userRepo.On("FindByEmail", ctx, "alice@example.com").
        Return(nil, domain.ErrNotFound)

    // Creation succeeds
    userRepo.On("Create", ctx, mock.MatchedBy(func(u *domain.User) bool {
        return u.Email == "alice@example.com"
    })).Return(nil)

    // Welcome email sends successfully
    emailSender.On("SendWelcome", ctx, "alice@example.com", "Alice").
        Return(nil)

    svc := service.NewUserService(userRepo, emailSender, metricsRecorder, logger)

    user, err := svc.Register(ctx, domain.RegisterRequest{
        Email: "alice@example.com",
        Name:  "Alice",
    })

    assert.NoError(t, err)
    assert.Equal(t, int64(42), user.ID)
    assert.Equal(t, "alice@example.com", user.Email)

    userRepo.AssertExpectations(t)
    emailSender.AssertExpectations(t)
}

func TestUserService_Register_DuplicateEmail(t *testing.T) {
    ctx := context.Background()
    logger := zaptest.NewLogger(t)

    userRepo := &MockUserRepository{}
    emailSender := &MockEmailSender{}
    metricsRecorder := metrics.NewNoopRecorder()

    existingUser := &domain.User{ID: 1, Email: "bob@example.com"}
    userRepo.On("FindByEmail", ctx, "bob@example.com").
        Return(existingUser, nil)

    svc := service.NewUserService(userRepo, emailSender, metricsRecorder, logger)

    _, err := svc.Register(ctx, domain.RegisterRequest{
        Email: "bob@example.com",
        Name:  "Bob",
    })

    assert.ErrorIs(t, err, domain.ErrEmailAlreadyRegistered)
    userRepo.AssertExpectations(t)
    emailSender.AssertNotCalled(t, "SendWelcome")
}
```

### Wire Test Injectors

For integration tests that wire real components against test infrastructure:

```go
// internal/integration/wire_test.go
//go:build wireinject
// +build wireinject

package integration

import (
    "context"
    "testing"

    "github.com/google/wire"
    "go.support.tools/myapp/internal/config"
    "go.support.tools/myapp/internal/database"
    "go.support.tools/myapp/internal/repository"
    "go.support.tools/myapp/internal/service"
)

// TestApplication holds components needed for integration tests
type TestApplication struct {
    UserService  *service.UserService
    OrderService *service.OrderService
}

// InitializeTestApplication wires real components against a test database.
// The test config points to a Docker-based test PostgreSQL instance.
func InitializeTestApplication(ctx context.Context, t *testing.T) (*TestApplication, func(), error) {
    wire.Build(
        provideTestConfig,     // Returns config pointing to test-db:5432
        provideTestLogger,     // Returns zap test logger
        provideNoopMetrics,    // Returns no-op metrics recorder
        database.Set,
        repository.Set,
        service.Set,
        wire.Struct(new(TestApplication), "*"),
    )
    return nil, nil, nil
}

func provideTestConfig(t *testing.T) *config.Config {
    t.Helper()
    return &config.Config{
        Database: config.DatabaseConfig{
            Host:     "localhost",
            Port:     5433,
            User:     "testuser",
            Password: "testpassword",
            DBName:   "testdb",
            SSLMode:  "disable",
            MaxConns: 5,
        },
    }
}
```

## Value Bindings and Struct Providers

Wire supports value bindings for primitive types and configuration that doesn't require construction:

```go
// internal/config/wire.go
package config

import (
    "github.com/google/wire"
)

// Provide individual config sections as typed values
// This allows packages to depend on specific config sections
// rather than the entire Config struct

func ProvideHTTPConfig(cfg *Config) HTTPConfig {
    return cfg.HTTP
}

func ProvideDatabaseConfig(cfg *Config) DatabaseConfig {
    return cfg.Database
}

func ProvideEmailConfig(cfg *Config) EmailConfig {
    return cfg.Email
}

func ProvideMetricsConfig(cfg *Config) MetricsConfig {
    return cfg.Metrics
}

var Set = wire.NewSet(
    ProvideHTTPConfig,
    ProvideDatabaseConfig,
    ProvideEmailConfig,
    ProvideMetricsConfig,
)
```

### wire.Value and wire.InterfaceValue

```go
// For constants and pre-constructed values:
wire.Build(
    // Bind a string value directly
    wire.Value("production"),

    // Bind an interface to a pre-constructed value
    wire.InterfaceValue(new(io.Writer), os.Stdout),

    // Use a struct field provider
    wire.FieldsOf(new(*Config), "Database", "HTTP", "Email"),
)
```

## Multi-Binary Monorepo Organization

In a monorepo with multiple binaries, each binary gets its own `wire.go` and `wire_gen.go`, but all share provider sets from `internal/`:

```
myapp/
├── cmd/
│   ├── api/
│   │   ├── main.go
│   │   ├── wire.go          # injector (build tag: wireinject)
│   │   └── wire_gen.go      # generated (committed)
│   ├── worker/
│   │   ├── main.go
│   │   ├── wire.go
│   │   └── wire_gen.go
│   └── migrator/
│       ├── main.go
│       ├── wire.go
│       └── wire_gen.go
├── internal/
│   ├── config/
│   │   └── wire.go          # config provider set
│   ├── database/
│   │   └── wire.go          # database provider set
│   ├── repository/
│   │   └── wire.go          # repository provider set + bindings
│   ├── service/
│   │   └── wire.go          # service provider set
│   └── handler/
│       └── wire.go          # HTTP handler provider set
└── Makefile
```

```makefile
# Makefile
.PHONY: wire
wire:
	@echo "Generating Wire code..."
	go run github.com/google/wire/cmd/wire ./cmd/api/...
	go run github.com/google/wire/cmd/wire ./cmd/worker/...
	go run github.com/google/wire/cmd/wire ./cmd/migrator/...
	@echo "Wire generation complete"

.PHONY: wire-check
wire-check:
	@echo "Verifying Wire output is up to date..."
	go run github.com/google/wire/cmd/wire check ./cmd/...
```

## CI Integration and Wire Drift Detection

Detecting when `wire_gen.go` is out of sync with provider changes:

```yaml
# .github/workflows/wire-check.yml
name: Wire Check

on:
  pull_request:
    paths:
    - '**.go'

jobs:
  wire-check:
    runs-on: ubuntu-24.04
    steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-go@v5
      with:
        go-version: '1.23'
        cache: true

    - name: Install Wire
      run: go install github.com/google/wire/cmd/wire@v0.6.0

    - name: Regenerate Wire
      run: |
        wire ./cmd/api/...
        wire ./cmd/worker/...

    - name: Check for drift
      run: |
        if ! git diff --exit-code -- '**/wire_gen.go'; then
          echo "ERROR: wire_gen.go is out of sync. Run 'make wire' and commit the result."
          exit 1
        fi
```

## Common Wire Pitfalls

### Ambiguous Providers

Wire fails when two providers return the same type. Use named types to disambiguate:

```go
// Bad: two providers returning *http.Client
func NewHTTPClient() *http.Client { ... }
func NewMetricsHTTPClient() *http.Client { ... }

// Good: named types distinguish purpose
type DefaultHTTPClient *http.Client
type MetricsHTTPClient *http.Client

func NewHTTPClient() DefaultHTTPClient { ... }
func NewMetricsHTTPClient() MetricsHTTPClient { ... }
```

### Cleanup Function Ordering

Wire accumulates cleanup functions and calls them in reverse construction order. Ensure your cleanup functions are idempotent:

```go
func NewCacheClient(cfg config.CacheConfig) (*redis.Client, func(), error) {
    client := redis.NewClient(&redis.Options{
        Addr:         fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
        Password:     cfg.Password,
        DB:           cfg.DB,
        PoolSize:     cfg.PoolSize,
        MinIdleConns: cfg.MinIdle,
    })

    // Test connectivity
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    if _, err := client.Ping(ctx).Result(); err != nil {
        return nil, nil, fmt.Errorf("redis ping failed: %w", err)
    }

    cleanup := func() {
        if err := client.Close(); err != nil {
            // Log but don't panic — cleanup must not fail the process
            log.Printf("error closing redis client: %v", err)
        }
    }

    return client, cleanup, nil
}
```

Wire's compile-time approach catches dependency graph errors during development rather than at startup, provides complete visibility into the wiring through generated code, and scales cleanly to codebases with dozens of packages and hundreds of types. For enterprise Go services, it strikes the right balance between explicit construction and maintainable organization.
