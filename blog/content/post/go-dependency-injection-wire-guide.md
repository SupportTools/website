---
title: "Dependency Injection in Go: Wire, Fx, and Manual Patterns for Large Services"
date: 2028-03-10T00:00:00-05:00
draft: false
tags: ["Go", "Dependency Injection", "Wire", "Uber Fx", "Architecture", "Testing"]
categories: ["Go", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to dependency injection in Go covering manual constructors, Google Wire providers and injectors, Uber Fx modules and lifecycle hooks, mock injection for testing, and DI container trade-offs for large services."
more_link: "yes"
url: "/go-dependency-injection-wire-guide/"
---

Dependency injection in Go is often misunderstood as requiring a framework. For small services, manual constructor chaining is the clearest approach. For large services with dozens of components, the wiring logic itself becomes a maintenance burden — and tools like Google Wire (compile-time code generation) and Uber Fx (runtime container with lifecycle management) address this at different points on the complexity spectrum. This guide covers all three approaches with production-grade patterns for each.

<!--more-->

## Manual Dependency Injection

### Constructor Pattern

Manual DI passes dependencies as constructor arguments, creating an explicit dependency graph in code:

```go
// config/config.go
package config

type Config struct {
    DatabaseURL    string
    RedisURL       string
    JWTSecret      string
    Port           int
    MetricsPort    int
    LogLevel       string
}

func Load() (*Config, error) {
    return &Config{
        DatabaseURL: requireEnv("DATABASE_URL"),
        RedisURL:    requireEnv("REDIS_URL"),
        JWTSecret:   requireEnv("JWT_SECRET"),
        Port:        getEnvInt("PORT", 8080),
        MetricsPort: getEnvInt("METRICS_PORT", 9090),
        LogLevel:    getEnvString("LOG_LEVEL", "info"),
    }, nil
}
```

```go
// repository/user.go
package repository

type UserRepository struct {
    db *sql.DB
}

func NewUserRepository(db *sql.DB) *UserRepository {
    return &UserRepository{db: db}
}
```

```go
// service/user.go
package service

type UserService struct {
    repo   UserRepository
    cache  Cache
    mailer Mailer
    clock  clock.Clock
}

type UserRepository interface {
    FindByID(ctx context.Context, id string) (*User, error)
    Save(ctx context.Context, user *User) error
}

type Cache interface {
    Get(ctx context.Context, key string) ([]byte, error)
    Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
}

type Mailer interface {
    SendWelcome(ctx context.Context, email, name string) error
}

func NewUserService(
    repo UserRepository,
    cache Cache,
    mailer Mailer,
    clk clock.Clock,
) *UserService {
    return &UserService{
        repo:   repo,
        cache:  cache,
        mailer: mailer,
        clock:  clk,
    }
}
```

### Application Assembly

Assemble all dependencies in `main.go` or a dedicated `cmd/` package:

```go
// cmd/api/main.go
package main

import (
    "context"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/example/service/config"
    "github.com/example/service/database"
    "github.com/example/service/handler"
    "github.com/example/service/repository"
    "github.com/example/service/service"
)

func main() {
    cfg, err := config.Load()
    if err != nil {
        slog.Error("failed to load config", "error", err)
        os.Exit(1)
    }

    // Infrastructure layer
    db, err := database.Open(cfg.DatabaseURL)
    if err != nil {
        slog.Error("failed to open database", "error", err)
        os.Exit(1)
    }
    defer db.Close()

    if err := database.Migrate(db); err != nil {
        slog.Error("failed to run migrations", "error", err)
        os.Exit(1)
    }

    redisClient, err := cache.NewRedis(cfg.RedisURL)
    if err != nil {
        slog.Error("failed to connect to Redis", "error", err)
        os.Exit(1)
    }
    defer redisClient.Close()

    smtpMailer := mailer.NewSMTP(cfg.SMTPConfig)

    // Repository layer
    userRepo := repository.NewUserRepository(db)
    orderRepo := repository.NewOrderRepository(db)

    // Service layer
    clk := clock.Real()
    userSvc := service.NewUserService(userRepo, redisClient, smtpMailer, clk)
    orderSvc := service.NewOrderService(orderRepo, userRepo, redisClient, clk)

    // Handler layer
    userHandler := handler.NewUserHandler(userSvc)
    orderHandler := handler.NewOrderHandler(orderSvc)

    // Router
    mux := http.NewServeMux()
    mux.HandleFunc("GET /api/v1/users/{id}", userHandler.Get)
    mux.HandleFunc("POST /api/v1/users", userHandler.Create)
    mux.HandleFunc("GET /api/v1/orders/{id}", orderHandler.Get)
    mux.HandleFunc("POST /api/v1/orders", orderHandler.Create)

    srv := &http.Server{
        Addr:         fmt.Sprintf(":%d", cfg.Port),
        Handler:      mux,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    // Graceful shutdown
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    go func() {
        slog.Info("starting server", "addr", srv.Addr)
        if err := srv.ListenAndServe(); err != http.ErrServerClosed {
            slog.Error("server error", "error", err)
            os.Exit(1)
        }
    }()

    <-ctx.Done()
    slog.Info("shutting down server")
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    if err := srv.Shutdown(shutdownCtx); err != nil {
        slog.Error("shutdown error", "error", err)
    }
}
```

Manual DI works well for services with up to ~15 components. Beyond that, the wiring in `main.go` becomes verbose and error-prone.

## Google Wire (Compile-Time Code Generation)

Wire generates the `main.go` wiring code at compile time from provider functions and injector signatures. The generated code is regular Go — readable, debuggable, and type-safe.

### Installation

```bash
go install github.com/google/wire/cmd/wire@latest
```

### Defining Providers

Providers are functions that return a type along with an optional error:

```go
// wire_providers.go
package main

import (
    "database/sql"
    "fmt"

    "github.com/google/wire"
    "github.com/example/service/config"
    "github.com/example/service/repository"
    "github.com/example/service/service"
)

// ProviderSet groups related providers
var RepositorySet = wire.NewSet(
    repository.NewUserRepository,
    repository.NewOrderRepository,
)

var ServiceSet = wire.NewSet(
    service.NewUserService,
    service.NewOrderService,
)

var InfraSet = wire.NewSet(
    ProvideDB,
    ProvideRedis,
    ProvideMailer,
    ProvideRealClock,
)

func ProvideDB(cfg *config.Config) (*sql.DB, error) {
    db, err := sql.Open("postgres", cfg.DatabaseURL)
    if err != nil {
        return nil, fmt.Errorf("open db: %w", err)
    }
    if err := db.Ping(); err != nil {
        return nil, fmt.Errorf("ping db: %w", err)
    }
    return db, nil
}

func ProvideRedis(cfg *config.Config) (*redis.Client, error) {
    opt, err := redis.ParseURL(cfg.RedisURL)
    if err != nil {
        return nil, fmt.Errorf("parse redis URL: %w", err)
    }
    return redis.NewClient(opt), nil
}

func ProvideMailer(cfg *config.Config) mailer.Mailer {
    return mailer.NewSMTP(cfg.SMTPConfig)
}

func ProvideRealClock() clock.Clock {
    return clock.Real()
}
```

### Defining Injectors

The injector function signature tells Wire what to build and how to build it:

```go
// wire.go
//go:build wireinject
// +build wireinject

package main

import (
    "github.com/google/wire"
    "github.com/example/service/config"
)

// InitializeApp is the injector — Wire fills in the implementation
func InitializeApp(cfg *config.Config) (*App, error) {
    wire.Build(
        InfraSet,
        RepositorySet,
        ServiceSet,
        handler.NewUserHandler,
        handler.NewOrderHandler,
        NewRouter,
        NewApp,
    )
    return nil, nil // Wire replaces this with generated code
}
```

### Running Wire

```bash
# Generate wire_gen.go
wire ./cmd/api/

# The generated file looks like regular Go wiring code:
# func InitializeApp(cfg *config.Config) (*App, error) {
#     db, err := ProvideDB(cfg)
#     if err != nil { return nil, err }
#     redisClient, err := ProvideRedis(cfg)
#     ...
# }
```

### Wire Interface Bindings

Bind concrete implementations to interfaces:

```go
var MockSet = wire.NewSet(
    wire.Bind(new(service.UserRepository), new(*repository.MockUserRepository)),
    wire.Bind(new(service.Cache), new(*cache.MockCache)),
    wire.Bind(new(service.Mailer), new(*mailer.MockMailer)),
    repository.NewMockUserRepository,
    cache.NewMockCache,
    mailer.NewMockMailer,
)
```

### Wire Values and Struct Fields

Inject configuration values directly:

```go
func ProvideServerConfig(cfg *config.Config) ServerConfig {
    return ServerConfig{
        Port:         cfg.Port,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 30 * time.Second,
    }
}

// Wire StructProvider for simple structs
var HandlerSet = wire.NewSet(
    wire.Struct(new(handler.Dependencies), "*"),
)
```

### Circular Dependency Detection

Wire detects circular dependencies at code generation time:

```
wire: github.com/example/service/cmd/api: cycle for *service.OrderService
  github.com/example/service/service.NewOrderService
      needs *service.UserService
  github.com/example/service/service.NewUserService
      needs *service.OrderService
```

Resolution: introduce an interface or a shared repository that both services use without needing each other.

## Uber Fx (Runtime Container with Lifecycle)

Fx provides a runtime DI container with lifecycle hooks for Start/Stop, making it well-suited for services with complex startup/shutdown ordering requirements.

### Installation

```bash
go get go.uber.org/fx@latest
```

### Basic Fx Application

```go
// main.go
package main

import (
    "context"
    "net/http"

    "go.uber.org/fx"
    "go.uber.org/fx/fxevent"
    "go.uber.org/zap"
)

func main() {
    app := fx.New(
        fx.WithLogger(func(log *zap.Logger) fxevent.Logger {
            return &fxevent.ZapLogger{Logger: log}
        }),
        fx.Provide(
            zap.NewProduction,
            config.Load,
            database.NewDB,
            cache.NewRedis,
            repository.NewUserRepository,
            repository.NewOrderRepository,
            service.NewUserService,
            service.NewOrderService,
            handler.NewUserHandler,
            handler.NewOrderHandler,
            NewHTTPServer,
        ),
        fx.Invoke(registerRoutes),
        fx.Invoke(startHTTPServer),
    )

    app.Run()
}

func NewHTTPServer(lc fx.Lifecycle, cfg *config.Config) *http.Server {
    srv := &http.Server{Addr: fmt.Sprintf(":%d", cfg.Port)}

    lc.Append(fx.Hook{
        OnStart: func(ctx context.Context) error {
            go func() {
                if err := srv.ListenAndServe(); err != http.ErrServerClosed {
                    // log error
                }
            }()
            return nil
        },
        OnStop: func(ctx context.Context) error {
            return srv.Shutdown(ctx)
        },
    })

    return srv
}

func registerRoutes(
    mux *http.ServeMux,
    userH *handler.UserHandler,
    orderH *handler.OrderHandler,
) {
    mux.HandleFunc("GET /api/v1/users/{id}", userH.Get)
    mux.HandleFunc("POST /api/v1/users", userH.Create)
    mux.HandleFunc("GET /api/v1/orders/{id}", orderH.Get)
    mux.HandleFunc("POST /api/v1/orders", orderH.Create)
}
```

### Fx Modules for Organizational Boundaries

Group related providers into reusable modules:

```go
// database/module.go
package database

import "go.uber.org/fx"

var Module = fx.Module("database",
    fx.Provide(
        NewDB,
        fx.Annotate(
            NewDB,
            fx.As(new(DB)), // bind to interface
        ),
    ),
    fx.Invoke(func(lc fx.Lifecycle, db *sql.DB) {
        lc.Append(fx.Hook{
            OnStop: func(ctx context.Context) error {
                return db.Close()
            },
        })
    }),
)
```

```go
// main.go
func main() {
    app := fx.New(
        database.Module,
        cache.Module,
        repository.Module,
        service.Module,
        handler.Module,
        server.Module,
    )
    app.Run()
}
```

### Fx Lifecycle Hooks for Ordered Startup

```go
// repository/module.go
package repository

import (
    "context"
    "database/sql"

    "go.uber.org/fx"
)

func NewUserRepository(lc fx.Lifecycle, db *sql.DB, log *zap.Logger) *UserRepository {
    repo := &UserRepository{db: db, log: log}

    lc.Append(fx.Hook{
        OnStart: func(ctx context.Context) error {
            // Run any repo-level initialization
            if err := repo.warmCache(ctx); err != nil {
                log.Warn("cache warm failed, continuing", zap.Error(err))
            }
            return nil
        },
    })

    return repo
}
```

### Fx Named and Grouped Values

When multiple implementations of the same interface are needed:

```go
// Provide two database connections with different names
func ProvideReadDB(cfg *config.Config) (*sql.DB, error) {
    return sql.Open("postgres", cfg.ReadReplicaURL)
}

func ProvideWriteDB(cfg *config.Config) (*sql.DB, error) {
    return sql.Open("postgres", cfg.PrimaryURL)
}

// In the application setup
fx.Provide(
    fx.Annotate(
        ProvideReadDB,
        fx.ResultTags(`name:"read"`),
    ),
    fx.Annotate(
        ProvideWriteDB,
        fx.ResultTags(`name:"write"`),
    ),
)

// In the consumer
type UserRepository struct {
    readDB  *sql.DB
    writeDB *sql.DB
}

func NewUserRepository(
    readDB *sql.DB `name:"read"`,
    writeDB *sql.DB `name:"write"`,
) *UserRepository {
    return &UserRepository{readDB: readDB, writeDB: writeDB}
}
```

### Fx Value Groups for Plugin-Style Registration

```go
// Register multiple HTTP handlers dynamically
type Route struct {
    Pattern string
    Handler http.Handler
}

// Each module contributes routes
func NewUserRoutes(h *UserHandler) []Route {
    return []Route{
        {Pattern: "GET /api/v1/users/{id}", Handler: http.HandlerFunc(h.Get)},
        {Pattern: "POST /api/v1/users", Handler: http.HandlerFunc(h.Create)},
    }
}

// Annotate with group tag
fx.Annotate(
    NewUserRoutes,
    fx.ResultTags(`group:"routes"`),
)

// Collect all routes
type RouterParams struct {
    fx.In
    Routes []Route `group:"routes"`
}

func NewRouter(p RouterParams) *http.ServeMux {
    mux := http.NewServeMux()
    for _, r := range p.Routes {
        mux.Handle(r.Pattern, r.Handler)
    }
    return mux
}
```

## Testing with Mock Injection

### Manual Mock Injection

```go
// service/user_test.go
package service_test

func TestUserService_Create(t *testing.T) {
    tests := []struct {
        name      string
        input     CreateUserInput
        repoErr   error
        cacheErr  error
        mailerErr error
        wantErr   bool
    }{
        {
            name:  "successful creation",
            input: CreateUserInput{Name: "Alice", Email: "alice@example.com"},
        },
        {
            name:    "repo failure",
            input:   CreateUserInput{Name: "Bob", Email: "bob@example.com"},
            repoErr: errors.New("db connection lost"),
            wantErr: true,
        },
        {
            name:      "mailer failure does not block creation",
            input:     CreateUserInput{Name: "Charlie", Email: "charlie@example.com"},
            mailerErr: errors.New("smtp timeout"),
            wantErr:   false, // mailer errors are async and non-blocking
        },
    }

    for _, tc := range tests {
        tc := tc
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()

            mockRepo := &MockUserRepository{
                SaveFn: func(_ context.Context, u *User) error {
                    return tc.repoErr
                },
            }
            mockCache := &MockCache{
                SetFn: func(_ context.Context, _ string, _ []byte, _ time.Duration) error {
                    return tc.cacheErr
                },
            }
            mockMailer := &MockMailer{
                SendWelcomeFn: func(_ context.Context, _, _ string) error {
                    return tc.mailerErr
                },
            }

            svc := NewUserService(mockRepo, mockCache, mockMailer, clock.NewFake(time.Now()))

            _, err := svc.Create(context.Background(), tc.input)
            if (err != nil) != tc.wantErr {
                t.Errorf("Create() error = %v, wantErr %v", err, tc.wantErr)
            }
        })
    }
}
```

### Wire-Based Test Injectors

```go
// wire_test.go
//go:build wireinject
// +build wireinject

package service_test

import "github.com/google/wire"

var TestProviderSet = wire.NewSet(
    wire.Bind(new(UserRepository), new(*MockUserRepository)),
    wire.Bind(new(Cache), new(*MockCache)),
    wire.Bind(new(Mailer), new(*MockMailer)),
    NewMockUserRepository,
    NewMockCache,
    NewMockMailer,
    clock.NewFake,
    NewUserService,
)

func InitializeTestUserService(t *testing.T) (*UserService, error) {
    wire.Build(TestProviderSet)
    return nil, nil
}
```

### Fx Test App

```go
// server_test.go
package server_test

func TestServerIntegration(t *testing.T) {
    app := fxtest.New(t,
        fx.Provide(
            func() *config.Config {
                return &config.Config{Port: 0} // port 0 = random available port
            },
        ),
        fx.Provide(
            NewMockUserRepository,
            NewMockOrderRepository,
        ),
        service.Module,
        handler.Module,
        server.Module,
    )

    app.RequireStart()
    defer app.RequireStop()

    // Test against the server
    srv := app.RequireValue(new(*http.Server)).(*http.Server)
    client := &http.Client{Timeout: 5 * time.Second}
    resp, err := client.Get(fmt.Sprintf("http://%s/health", srv.Addr))
    require.NoError(t, err)
    assert.Equal(t, http.StatusOK, resp.StatusCode)
}
```

## Multi-Environment Configuration Injection

### Environment-Based Provider Selection

```go
// wire_providers_prod.go
//go:build !test

package main

func ProvideMailer(cfg *config.Config) mailer.Mailer {
    return mailer.NewSESMailer(cfg.AWSConfig)
}

func ProvideCache(cfg *config.Config) (cache.Cache, error) {
    return cache.NewRedis(cfg.RedisURL)
}
```

```go
// wire_providers_test.go
//go:build test

package main

func ProvideMailer(_ *config.Config) mailer.Mailer {
    return mailer.NewNoOpMailer()
}

func ProvideCache(_ *config.Config) (cache.Cache, error) {
    return cache.NewInMemory(), nil
}
```

### Configuration Injection with Interfaces

```go
type ConfigProvider interface {
    DatabaseURL() string
    RedisURL() string
    Port() int
}

type EnvConfig struct{}
func (e EnvConfig) DatabaseURL() string { return os.Getenv("DATABASE_URL") }
func (e EnvConfig) RedisURL() string    { return os.Getenv("REDIS_URL") }
func (e EnvConfig) Port() int {
    p, _ := strconv.Atoi(os.Getenv("PORT"))
    if p == 0 { return 8080 }
    return p
}

type TestConfig struct {
    databaseURL string
    redisURL    string
    port        int
}
func (t TestConfig) DatabaseURL() string { return t.databaseURL }
func (t TestConfig) RedisURL() string    { return t.redisURL }
func (t TestConfig) Port() int           { return t.port }
```

## DI Container vs Service Locator Trade-offs

The service locator anti-pattern hides dependencies:

```go
// Anti-pattern: service locator
type Container struct {
    services map[string]interface{}
}

func (c *Container) Get(name string) interface{} {
    return c.services[name]
}

// Usage — dependencies are invisible at the call site
func NewUserService(c *Container) *UserService {
    return &UserService{
        repo: c.Get("userRepo").(*UserRepository), // runtime panic risk
    }
}
```

The DI pattern makes dependencies explicit:

```go
// Good: explicit constructor injection
func NewUserService(repo UserRepository, cache Cache, mailer Mailer) *UserService {
    return &UserService{repo: repo, cache: cache, mailer: mailer}
}
```

| Criterion | Manual DI | Wire | Fx | Service Locator |
|---|---|---|---|---|
| Compile-time safety | Yes | Yes | Partial | No |
| Circular dep detection | At runtime | At generation | At startup | At runtime |
| Testability | Excellent | Excellent | Good | Poor |
| Lifecycle management | Manual | Manual | Built-in | None |
| Suitable for | <15 components | 15-50 components | 50+ components | Avoid |
| Generated code | No | Yes | No | No |
| Learning curve | Low | Medium | High | Low |

## Practical Decision Guide

Start with manual DI. Migrate to Wire when:
- `main.go` wiring exceeds 100 lines
- Multiple binaries share the same component graph
- Adding a new dependency requires touching many files

Migrate to Fx when:
- Services have complex startup/shutdown ordering (database migrations before HTTP, graceful drain before connection close)
- Plugin-style extensibility is needed (e.g., dynamically registered metric exporters)
- The team is comfortable with reflection-based frameworks

Neither Wire nor Fx is a substitute for designing clean interfaces. DI frameworks amplify the quality of the underlying design — they do not fix poorly structured code.

## Summary

Dependency injection in Go is fundamentally about making dependencies explicit and swappable. Manual constructors are always the clearest option; they require no tooling and produce the most readable code. Wire adds compile-time code generation for large component graphs, eliminating manual wiring while preserving type safety. Fx adds lifecycle management and runtime extensibility for services with complex startup choreography. In all cases, programming to interfaces rather than concrete types is the foundation that makes any DI approach testable and maintainable.
