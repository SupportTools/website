---
title: "Go Dependency Injection with Wire: Code Generation for Production Services"
date: 2028-05-15T00:00:00-05:00
draft: false
tags: ["Go", "Wire", "Dependency Injection", "Code Generation", "Testing", "Architecture"]
categories: ["Go", "Software Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go dependency injection using Google Wire: providers, injectors, testing strategies, and eliminating global state in large Go microservices."
more_link: "yes"
url: "/go-wire-dependency-injection-guide/"
---

Dependency injection in Go has historically been a point of contention. Manual constructor chaining works for small services but becomes unwieldy as applications grow. Runtime injection frameworks like Uber's `fx` add startup complexity and make the dependency graph opaque. Google Wire takes a different approach entirely: compile-time code generation that produces ordinary Go code you can read, debug, and reason about. This guide covers Wire's provider model, injector patterns, testing strategies, and production practices for eliminating global state in large Go services.

<!--more-->

## The Problem with Global State and Manual Wiring

Consider a typical Go service that has grown organically:

```go
// The anti-pattern: global variables scattered across packages
var (
    DB     *sql.DB
    Cache  *redis.Client
    Logger *zap.Logger
)

func init() {
    Logger, _ = zap.NewProduction()
    DB, _ = sql.Open("postgres", os.Getenv("DATABASE_URL"))
    Cache = redis.NewClient(&redis.Options{
        Addr: os.Getenv("REDIS_ADDR"),
    })
}
```

This pattern creates several production problems:

- **Untestable**: Unit tests cannot substitute mock dependencies without patching globals
- **Initialization order undefined**: `init()` ordering across packages is fragile
- **Hidden dependencies**: Function signatures lie about what they actually need
- **Concurrent initialization unsafe**: Race conditions during startup

The correct pattern is explicit dependency injection through constructors:

```go
// Explicit dependencies through constructors
type UserService struct {
    db     *sql.DB
    cache  *redis.Client
    logger *zap.Logger
    mailer Mailer
}

func NewUserService(db *sql.DB, cache *redis.Client, logger *zap.Logger, mailer Mailer) *UserService {
    return &UserService{
        db:     db,
        cache:  cache,
        logger: logger,
        mailer: mailer,
    }
}
```

The challenge: wiring these constructors together in `main()` for a service with 30+ components becomes error-prone boilerplate. Wire generates this wiring code.

## Installing Wire

```bash
# Install the wire tool
go install github.com/google/wire/cmd/wire@latest

# Add the wire package to your module
go get github.com/google/wire@latest

# Verify installation
wire --version
# wire: HEAD
```

## Core Concepts

### Providers

A provider is any function that constructs a value. Wire understands functions with one of these signatures:

```go
// Simple provider
func NewLogger() (*zap.Logger, error) {
    return zap.NewProduction()
}

// Provider with dependencies
func NewDB(cfg *Config) (*sql.DB, error) {
    db, err := sql.Open("postgres", cfg.DatabaseURL)
    if err != nil {
        return nil, fmt.Errorf("opening database: %w", err)
    }
    db.SetMaxOpenConns(cfg.DBMaxOpenConns)
    db.SetMaxIdleConns(cfg.DBMaxIdleConns)
    db.SetConnMaxLifetime(cfg.DBConnMaxLifetime)
    return db, nil
}

// Provider with cleanup function
func NewRedisClient(cfg *Config) (*redis.Client, func(), error) {
    client := redis.NewClient(&redis.Options{
        Addr:         cfg.RedisAddr,
        Password:     cfg.RedisPassword,
        DB:           cfg.RedisDB,
        PoolSize:     cfg.RedisPoolSize,
        MinIdleConns: cfg.RedisMinIdleConns,
    })

    if err := client.Ping(context.Background()).Err(); err != nil {
        return nil, nil, fmt.Errorf("connecting to redis: %w", err)
    }

    cleanup := func() {
        client.Close()
    }

    return client, cleanup, nil
}
```

The cleanup function pattern is critical for production services. Wire generates code that calls cleanup functions in reverse initialization order, ensuring proper resource release.

### Provider Sets

Provider sets group related providers:

```go
// providers/database/wire.go
package database

import "github.com/google/wire"

var ProviderSet = wire.NewSet(
    NewDB,
    NewMigrationRunner,
    NewConnectionPool,
)
```

```go
// providers/cache/wire.go
package cache

import "github.com/google/wire"

var ProviderSet = wire.NewSet(
    NewRedisClient,
    NewCacheWrapper,
)
```

```go
// providers/observability/wire.go
package observability

import "github.com/google/wire"

var ProviderSet = wire.NewSet(
    NewLogger,
    NewTracer,
    NewMetricsRegistry,
)
```

### Injectors

Injectors are the entry point. They declare what you want built:

```go
// wire.go (build tag ensures this file is only used by wire)
//go:build wireinject

package main

import (
    "github.com/google/wire"
    "github.com/example/myservice/providers/cache"
    "github.com/example/myservice/providers/database"
    "github.com/example/myservice/providers/observability"
)

func InitializeApp(cfg *Config) (*App, func(), error) {
    wire.Build(
        observability.ProviderSet,
        database.ProviderSet,
        cache.ProviderSet,
        NewUserService,
        NewOrderService,
        NewHTTPServer,
        NewApp,
    )
    return nil, nil, nil // Wire replaces this with generated code
}
```

Run wire to generate the implementation:

```bash
wire gen ./...
```

Wire produces `wire_gen.go`:

```go
// Code generated by Wire. DO NOT EDIT.
//go:build !wireinject

package main

func InitializeApp(cfg *Config) (*App, func(), error) {
    logger, err := observability.NewLogger()
    if err != nil {
        return nil, nil, err
    }
    tracer, cleanup, err := observability.NewTracer(cfg)
    if err != nil {
        return nil, nil, err
    }
    metricsRegistry := observability.NewMetricsRegistry()
    db, err := database.NewDB(cfg)
    if err != nil {
        cleanup()
        return nil, nil, err
    }
    migrationRunner := database.NewMigrationRunner(db, logger)
    connectionPool := database.NewConnectionPool(db, cfg)
    redisClient, cleanup2, err := cache.NewRedisClient(cfg)
    if err != nil {
        db.Close()
        cleanup()
        return nil, nil, err
    }
    cacheWrapper := cache.NewCacheWrapper(redisClient, logger)
    userService := NewUserService(db, redisClient, logger, cfg)
    orderService := NewOrderService(db, cacheWrapper, logger, tracer)
    httpServer := NewHTTPServer(userService, orderService, logger, metricsRegistry, cfg)
    app := NewApp(httpServer, migrationRunner, logger)
    return app, func() {
        cleanup2()
        db.Close()
        cleanup()
    }, nil
}
```

This generated code is readable Go. No reflection, no magic, no runtime overhead.

## Real-World Service Structure

### Project Layout

```
myservice/
├── cmd/
│   └── server/
│       ├── main.go
│       ├── wire.go          # Injector (build tag: wireinject)
│       └── wire_gen.go      # Generated (build tag: !wireinject)
├── internal/
│   ├── config/
│   │   ├── config.go
│   │   └── wire.go
│   ├── database/
│   │   ├── db.go
│   │   └── wire.go
│   ├── cache/
│   │   ├── redis.go
│   │   └── wire.go
│   ├── services/
│   │   ├── user/
│   │   │   ├── service.go
│   │   │   └── wire.go
│   │   └── order/
│   │       ├── service.go
│   │       └── wire.go
│   └── http/
│       ├── server.go
│       └── wire.go
└── go.mod
```

### Config Provider Pattern

Configuration is typically the root of the dependency graph:

```go
// internal/config/config.go
package config

import (
    "fmt"
    "time"

    "github.com/caarlos0/env/v11"
)

type Config struct {
    // Server
    HTTPPort    int    `env:"HTTP_PORT" envDefault:"8080"`
    MetricsPort int    `env:"METRICS_PORT" envDefault:"9090"`
    Environment string `env:"ENVIRONMENT" envDefault:"development"`

    // Database
    DatabaseURL         string        `env:"DATABASE_URL,required"`
    DBMaxOpenConns      int           `env:"DB_MAX_OPEN_CONNS" envDefault:"25"`
    DBMaxIdleConns      int           `env:"DB_MAX_IDLE_CONNS" envDefault:"5"`
    DBConnMaxLifetime   time.Duration `env:"DB_CONN_MAX_LIFETIME" envDefault:"5m"`

    // Redis
    RedisAddr        string `env:"REDIS_ADDR" envDefault:"localhost:6379"`
    RedisPassword    string `env:"REDIS_PASSWORD"`
    RedisDB          int    `env:"REDIS_DB" envDefault:"0"`
    RedisPoolSize    int    `env:"REDIS_POOL_SIZE" envDefault:"10"`
    RedisMinIdleConns int   `env:"REDIS_MIN_IDLE_CONNS" envDefault:"2"`

    // Observability
    TracingEndpoint string `env:"TRACING_ENDPOINT" envDefault:"localhost:4317"`
    LogLevel        string `env:"LOG_LEVEL" envDefault:"info"`
    ServiceName     string `env:"SERVICE_NAME" envDefault:"myservice"`
    ServiceVersion  string `env:"SERVICE_VERSION" envDefault:"unknown"`
}

func NewConfig() (*Config, error) {
    cfg := &Config{}
    if err := env.Parse(cfg); err != nil {
        return nil, fmt.Errorf("parsing config: %w", err)
    }
    return cfg, nil
}
```

```go
// internal/config/wire.go
package config

import "github.com/google/wire"

var ProviderSet = wire.NewSet(NewConfig)
```

### Service Layer Providers

```go
// internal/services/user/service.go
package user

import (
    "context"
    "database/sql"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
    "go.uber.org/zap"
)

type Repository interface {
    FindByID(ctx context.Context, id int64) (*User, error)
    FindByEmail(ctx context.Context, email string) (*User, error)
    Create(ctx context.Context, u *User) error
    Update(ctx context.Context, u *User) error
}

type CacheRepository interface {
    Get(ctx context.Context, key string) (*User, error)
    Set(ctx context.Context, key string, user *User, ttl time.Duration) error
    Delete(ctx context.Context, key string) error
}

type Mailer interface {
    SendWelcome(ctx context.Context, user *User) error
    SendPasswordReset(ctx context.Context, user *User, token string) error
}

type Service struct {
    repo   Repository
    cache  CacheRepository
    mailer Mailer
    logger *zap.Logger
}

func NewService(repo Repository, cache CacheRepository, mailer Mailer, logger *zap.Logger) *Service {
    return &Service{
        repo:   repo,
        cache:  cache,
        mailer: mailer,
        logger: logger,
    }
}

func NewRepository(db *sql.DB, logger *zap.Logger) Repository {
    return &sqlRepository{db: db, logger: logger}
}

func NewCacheRepository(client *redis.Client, logger *zap.Logger) CacheRepository {
    return &redisCacheRepository{client: client, logger: logger}
}
```

```go
// internal/services/user/wire.go
package user

import "github.com/google/wire"

var ProviderSet = wire.NewSet(
    NewService,
    NewRepository,
    NewCacheRepository,
    wire.Bind(new(Repository), new(*sqlRepository)),
    wire.Bind(new(CacheRepository), new(*redisCacheRepository)),
)
```

The `wire.Bind` call tells Wire that `*sqlRepository` satisfies the `Repository` interface. This is required because Wire works with concrete types but your service constructors accept interfaces.

## Interface Binding Patterns

### Binding Concrete Types to Interfaces

```go
// Bind concrete implementations to interfaces
var ProviderSet = wire.NewSet(
    NewPostgresRepository,
    NewSMTPMailer,
    NewS3FileStore,
    wire.Bind(new(UserRepository), new(*PostgresUserRepository)),
    wire.Bind(new(Mailer), new(*SMTPMailer)),
    wire.Bind(new(FileStore), new(*S3FileStore)),
)
```

### Value Providers

For values that don't have a constructor:

```go
// Provide a specific value type
var ProviderSet = wire.NewSet(
    wire.Value(http.DefaultClient),
    wire.Value(time.UTC),
    wire.InterfaceValue(new(io.Writer), os.Stdout),
)
```

### Struct Providers

Wire can build structs directly when all fields are provided:

```go
type HTTPServer struct {
    Handler  http.Handler
    Logger   *zap.Logger
    Addr     string
}

// Wire can fill this struct if Handler and *zap.Logger are in the graph
var ProviderSet = wire.NewSet(
    wire.Struct(new(HTTPServer), "Handler", "Logger"),
    // Addr is not in the graph, it won't be filled
)
```

## Testing with Wire

### Test Injectors

Create separate injectors for testing that substitute mock implementations:

```go
// internal/services/user/testhelpers/wire_test.go
//go:build wireinject

package testhelpers

import (
    "github.com/google/wire"
    "github.com/example/myservice/internal/services/user"
)

func InitializeTestUserService(
    repo user.Repository,
    cache user.CacheRepository,
    mailer user.Mailer,
) *user.Service {
    wire.Build(user.NewService)
    return nil
}
```

```go
// internal/services/user/service_test.go
package user_test

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
    "github.com/example/myservice/internal/services/user"
    "github.com/example/myservice/internal/services/user/testhelpers"
    "go.uber.org/zap/zaptest"
)

// Mock implementations
type MockRepository struct {
    mock.Mock
}

func (m *MockRepository) FindByID(ctx context.Context, id int64) (*user.User, error) {
    args := m.Called(ctx, id)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).(*user.User), args.Error(1)
}

// ... other interface methods

func TestUserService_GetUser_CacheMiss(t *testing.T) {
    repo := &MockRepository{}
    cache := &MockCacheRepository{}
    mailer := &MockMailer{}
    logger := zaptest.NewLogger(t)

    // Setup expectations
    expectedUser := &user.User{ID: 42, Email: "alice@example.com", Name: "Alice"}
    cache.On("Get", mock.Anything, "user:42").Return(nil, user.ErrNotFound)
    repo.On("FindByID", mock.Anything, int64(42)).Return(expectedUser, nil)
    cache.On("Set", mock.Anything, "user:42", expectedUser, mock.Anything).Return(nil)

    svc := testhelpers.InitializeTestUserService(repo, cache, mailer, logger)

    result, err := svc.GetUser(context.Background(), 42)

    assert.NoError(t, err)
    assert.Equal(t, expectedUser, result)
    repo.AssertExpectations(t)
    cache.AssertExpectations(t)
}
```

### Integration Test Injectors

```go
// testhelpers/integration/wire.go
//go:build wireinject && integration

package integration

import (
    "github.com/google/wire"
    "github.com/example/myservice/internal/config"
    "github.com/example/myservice/internal/database"
    "github.com/example/myservice/internal/services/user"
)

// Uses real implementations but test database
func InitializeIntegrationUserService(cfg *config.Config) (*user.Service, func(), error) {
    wire.Build(
        database.TestProviderSet, // Uses TEST_DATABASE_URL
        user.ProviderSet,
    )
    return nil, nil, nil
}
```

```go
// internal/database/wire_test.go
package database

import "github.com/google/wire"

// TestProviderSet uses a test-specific database configuration
var TestProviderSet = wire.NewSet(
    NewTestDB,
    NewMigrationRunner,
    NewConnectionPool,
)

func NewTestDB(cfg *config.Config) (*sql.DB, func(), error) {
    testURL := cfg.TestDatabaseURL
    if testURL == "" {
        testURL = "postgres://localhost/myservice_test?sslmode=disable"
    }
    db, err := sql.Open("postgres", testURL)
    if err != nil {
        return nil, nil, err
    }
    cleanup := func() { db.Close() }
    return db, cleanup, nil
}
```

## Advanced Wire Patterns

### Multiple Outputs from One Constructor (Wire Values)

When a constructor returns multiple types that should be used independently:

```go
type APIClients struct {
    Stripe  *stripe.Client
    Twilio  *twilio.Client
    SendGrid *sendgrid.Client
}

func NewAPIClients(cfg *Config) (*APIClients, error) {
    return &APIClients{
        Stripe:   stripe.NewClient(cfg.StripeAPIKey),
        Twilio:   twilio.NewClient(cfg.TwilioSID, cfg.TwilioToken),
        SendGrid: sendgrid.NewClient(cfg.SendGridKey),
    }, nil
}

// Extract individual clients from the struct
func ExtractStripeClient(clients *APIClients) *stripe.Client {
    return clients.Stripe
}

func ExtractTwilioClient(clients *APIClients) *twilio.Client {
    return clients.Twilio
}

var ProviderSet = wire.NewSet(
    NewAPIClients,
    ExtractStripeClient,
    ExtractTwilioClient,
)
```

### Options Pattern with Wire

```go
type ServerOptions struct {
    ReadTimeout     time.Duration
    WriteTimeout    time.Duration
    MaxHeaderBytes  int
    ShutdownTimeout time.Duration
}

func NewServerOptions(cfg *Config) *ServerOptions {
    return &ServerOptions{
        ReadTimeout:     cfg.HTTPReadTimeout,
        WriteTimeout:    cfg.HTTPWriteTimeout,
        MaxHeaderBytes:  1 << 20, // 1MB
        ShutdownTimeout: 30 * time.Second,
    }
}

func NewHTTPServer(opts *ServerOptions, handler http.Handler, logger *zap.Logger) *http.Server {
    return &http.Server{
        Addr:           fmt.Sprintf(":%d", 8080),
        Handler:        handler,
        ReadTimeout:    opts.ReadTimeout,
        WriteTimeout:   opts.WriteTimeout,
        MaxHeaderBytes: opts.MaxHeaderBytes,
        ErrorLog:       zap.NewStdLog(logger),
    }
}
```

### Conditional Providers with Build Tags

Development vs production logger:

```go
// providers/observability/logger_dev.go
//go:build !production

package observability

import "go.uber.org/zap"

func NewLogger() (*zap.Logger, error) {
    return zap.NewDevelopment()
}
```

```go
// providers/observability/logger_prod.go
//go:build production

package observability

import "go.uber.org/zap"

func NewLogger() (*zap.Logger, error) {
    return zap.NewProduction()
}
```

Build for production:

```bash
go build -tags production ./cmd/server/
```

### Event Bus Pattern

```go
type EventBus struct {
    handlers map[string][]EventHandler
    mu       sync.RWMutex
}

func NewEventBus() *EventBus {
    return &EventBus{
        handlers: make(map[string][]EventHandler),
    }
}

// Register handlers as Wire providers
func RegisterUserEventHandlers(bus *EventBus, svc *user.Service, notifier *NotificationService) {
    bus.Subscribe("user.created", svc.HandleUserCreated)
    bus.Subscribe("user.created", notifier.HandleUserCreated)
    bus.Subscribe("user.password_reset", notifier.HandlePasswordReset)
}

var ProviderSet = wire.NewSet(
    NewEventBus,
    RegisterUserEventHandlers,
)
```

## Integrating with main.go

```go
// cmd/server/main.go
package main

import (
    "context"
    "errors"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "go.uber.org/zap"
)

func main() {
    cfg, err := config.NewConfig()
    if err != nil {
        fmt.Fprintf(os.Stderr, "loading config: %v\n", err)
        os.Exit(1)
    }

    app, cleanup, err := InitializeApp(cfg)
    if err != nil {
        fmt.Fprintf(os.Stderr, "initializing app: %v\n", err)
        os.Exit(1)
    }
    defer cleanup()

    // Run the application
    ctx, stop := signal.NotifyContext(context.Background(),
        syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    if err := app.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
        app.Logger().Error("application error", zap.Error(err))
        os.Exit(1)
    }
}
```

## CI/CD Integration

Ensure wire generation is part of the build pipeline:

```yaml
# .github/workflows/build.yml
- name: Generate Wire
  run: |
    go install github.com/google/wire/cmd/wire@latest
    wire gen ./...
    # Verify no uncommitted changes to wire_gen.go
    git diff --exit-code -- '**wire_gen.go'
```

```makefile
# Makefile
.PHONY: wire
wire:
	wire gen ./...

.PHONY: wire-check
wire-check: wire
	@if ! git diff --exit-code -- '**/wire_gen.go'; then \
		echo "ERROR: wire_gen.go is out of date. Run 'make wire' and commit."; \
		exit 1; \
	fi

.PHONY: build
build: wire-check
	go build ./...
```

## Performance Considerations

Wire generates code that runs once at startup. There is zero runtime overhead compared to manual wiring. The generated `wire_gen.go` file is plain Go with no reflection or interface boxing.

For services with expensive initialization (database connection pools, cache warmup), Wire's cleanup function ordering ensures deterministic teardown:

```go
// Cleanup order is reverse of initialization
// If initialization was: logger -> db -> redis -> server
// Cleanup will be:       server -> redis -> db -> logger

func (s *Service) gracefulShutdown(ctx context.Context) error {
    // This is called before cleanup functions
    return s.server.Shutdown(ctx)
}
```

## Debugging Wire Errors

Wire provides detailed error messages. Common issues and fixes:

**Missing provider:**
```
wire: no provider found for *sql.DB
```
Fix: Add `database.ProviderSet` to the `wire.Build()` call.

**Multiple providers for same type:**
```
wire: conflict: multiple bindings for *zap.Logger
```
Fix: Use named types to differentiate: `type UserServiceLogger *zap.Logger`

**Cycle detection:**
```
wire: cycle detected: A -> B -> C -> A
```
Fix: Introduce an interface to break the cycle or restructure the dependency graph.

**Provider returning error not handled:**
```
wire: InitializeApp cannot use provider NewDB (returns error) without error return
```
Fix: Add `error` to the injector's return signature.

## Summary

Wire brings the discipline of compile-time dependency injection to Go without the complexity of runtime frameworks. The provider/injector model maps cleanly to how well-structured Go code already works. Generated code is readable and debuggable. Testing becomes straightforward because every dependency is an explicit constructor parameter. For services with more than a handful of components, Wire eliminates a category of wiring bugs and makes the dependency graph explicit, auditable, and automatically validated at build time.
