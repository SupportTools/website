---
title: "Go Dependency Injection: Wire, fx, and Manual DI Patterns for Large Codebases"
date: 2030-12-12T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Dependency Injection", "Wire", "fx", "Architecture", "Testing", "Design Patterns"]
categories:
- Go
- Architecture
- Best Practices
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to dependency injection in Go: comparing manual DI, Google Wire code generation, and Uber fx runtime injection. Covers container patterns, mock injection for testing, lifecycle management, and structuring large Go services."
more_link: "yes"
url: "/go-dependency-injection-wire-fx-manual-di-patterns-large-codebases/"
---

Dependency injection is the single most impactful architectural decision you can make in a large Go service. It decouples components, enables comprehensive testing with mocks, and makes the dependency graph explicit and auditable. Go has three dominant approaches: manual constructor chaining, Google Wire (compile-time code generation), and Uber fx (runtime reflection-based injection). This guide examines all three in production contexts.

<!--more-->

# Go Dependency Injection: Wire, fx, and Manual DI Patterns for Large Codebases

## Section 1: The Case for Dependency Injection in Go

Go's idiomatic style favors explicit over implicit. A function that creates its own database connection is implicitly coupled to a specific database. A function that accepts a `db.Querier` interface is explicitly decoupled — you can pass a real database in production and an in-memory mock in tests.

### The Problem with Global State

```go
// BAD: implicit dependency on global database
package user

import "myapp/db"

func GetUser(id int64) (*User, error) {
    // db.DB is a global variable — untestable without a real database
    return db.DB.QueryUser(id)
}
```

```go
// GOOD: explicit dependency injection
package user

type Repository interface {
    GetUser(ctx context.Context, id int64) (*User, error)
    CreateUser(ctx context.Context, u *User) error
    UpdateUser(ctx context.Context, u *User) error
    DeleteUser(ctx context.Context, id int64) error
}

type Service struct {
    repo   Repository
    cache  Cache
    logger *slog.Logger
}

func NewService(repo Repository, cache Cache, logger *slog.Logger) *Service {
    return &Service{
        repo:   repo,
        cache:  cache,
        logger: logger,
    }
}

func (s *Service) GetUser(ctx context.Context, id int64) (*User, error) {
    // Try cache first
    if u, ok := s.cache.Get(ctx, fmt.Sprintf("user:%d", id)); ok {
        return u.(*User), nil
    }
    return s.repo.GetUser(ctx, id)
}
```

## Section 2: Manual DI — Constructor Injection at Scale

Manual DI means writing the wiring code yourself. For small services (under 20 components), this is the right approach. It produces zero magic, is grep-friendly, and produces readable stack traces.

### The Application Container Pattern

```go
// internal/app/app.go
package app

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "myapp/internal/cache"
    "myapp/internal/config"
    "myapp/internal/database"
    "myapp/internal/handler"
    "myapp/internal/middleware"
    "myapp/internal/repository"
    "myapp/internal/service"

    "github.com/redis/go-redis/v9"
    "go.uber.org/zap"
    "gorm.io/driver/postgres"
    "gorm.io/gorm"
)

// App holds all application components with their dependencies resolved.
type App struct {
    cfg        *config.Config
    logger     *zap.Logger
    db         *gorm.DB
    redis      *redis.Client
    httpServer *http.Server

    // Repositories
    userRepo repository.UserRepository
    orderRepo repository.OrderRepository

    // Services
    userService  *service.UserService
    orderService *service.OrderService
    authService  *service.AuthService

    // HTTP handlers
    userHandler  *handler.UserHandler
    orderHandler *handler.OrderHandler
    authHandler  *handler.AuthHandler

    // HTTP router
    router http.Handler
}

// New constructs the complete application by wiring all dependencies.
// This function is the single place where the dependency graph is assembled.
func New(cfg *config.Config) (*App, error) {
    a := &App{cfg: cfg}

    // Layer 1: Infrastructure
    if err := a.buildInfrastructure(); err != nil {
        return nil, fmt.Errorf("building infrastructure: %w", err)
    }

    // Layer 2: Repositories (depend on infrastructure)
    a.buildRepositories()

    // Layer 3: Services (depend on repositories)
    a.buildServices()

    // Layer 4: Handlers (depend on services)
    a.buildHandlers()

    // Layer 5: Router (depends on handlers)
    a.buildRouter()

    // Layer 6: HTTP Server
    a.buildHTTPServer()

    return a, nil
}

func (a *App) buildInfrastructure() error {
    var err error

    // Logger
    zapCfg := zap.NewProductionConfig()
    if a.cfg.Debug {
        zapCfg = zap.NewDevelopmentConfig()
    }
    a.logger, err = zapCfg.Build()
    if err != nil {
        return fmt.Errorf("building logger: %w", err)
    }

    // Database
    a.db, err = gorm.Open(postgres.Open(a.cfg.Database.DSN()), &gorm.Config{
        Logger: database.NewGormLogger(a.logger),
    })
    if err != nil {
        return fmt.Errorf("opening database: %w", err)
    }

    sqlDB, err := a.db.DB()
    if err != nil {
        return fmt.Errorf("getting sql.DB: %w", err)
    }
    sqlDB.SetMaxOpenConns(a.cfg.Database.MaxOpenConns)
    sqlDB.SetMaxIdleConns(a.cfg.Database.MaxIdleConns)
    sqlDB.SetConnMaxLifetime(time.Duration(a.cfg.Database.ConnMaxLifetimeSeconds) * time.Second)

    // Redis
    a.redis = redis.NewClient(&redis.Options{
        Addr:     a.cfg.Redis.Addr,
        Password: a.cfg.Redis.Password,
        DB:       a.cfg.Redis.DB,
    })

    return nil
}

func (a *App) buildRepositories() {
    a.userRepo = repository.NewUserRepository(a.db, a.logger)
    a.orderRepo = repository.NewOrderRepository(a.db, a.logger)
}

func (a *App) buildServices() {
    userCache := cache.NewRedisCache[*service.User](a.redis, "user", 5*time.Minute)
    a.userService = service.NewUserService(a.userRepo, userCache, a.logger)

    a.authService = service.NewAuthService(a.userRepo, a.cfg.JWT, a.logger)

    a.orderService = service.NewOrderService(
        a.orderRepo,
        a.userService,
        a.logger,
    )
}

func (a *App) buildHandlers() {
    a.userHandler = handler.NewUserHandler(a.userService, a.logger)
    a.orderHandler = handler.NewOrderHandler(a.orderService, a.logger)
    a.authHandler = handler.NewAuthHandler(a.authService, a.logger)
}

func (a *App) buildRouter() {
    mux := http.NewServeMux()

    // Auth middleware wraps the mux
    authMiddleware := middleware.NewAuthMiddleware(a.authService)

    mux.Handle("/api/v1/auth/", a.authHandler)
    mux.Handle("/api/v1/users/", authMiddleware.Wrap(a.userHandler))
    mux.Handle("/api/v1/orders/", authMiddleware.Wrap(a.orderHandler))

    a.router = middleware.Chain(
        mux,
        middleware.RequestID,
        middleware.Logging(a.logger),
        middleware.Metrics,
        middleware.Recovery(a.logger),
    )
}

func (a *App) buildHTTPServer() {
    a.httpServer = &http.Server{
        Addr:         fmt.Sprintf(":%d", a.cfg.HTTP.Port),
        Handler:      a.router,
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  120 * time.Second,
    }
}

// Run starts the application and blocks until shutdown.
func (a *App) Run(ctx context.Context) error {
    errCh := make(chan error, 1)

    go func() {
        a.logger.Info("starting HTTP server", zap.String("addr", a.httpServer.Addr))
        if err := a.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            errCh <- err
        }
    }()

    select {
    case err := <-errCh:
        return err
    case <-ctx.Done():
        return a.Shutdown()
    }
}

// Shutdown gracefully stops all components in reverse dependency order.
func (a *App) Shutdown() error {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    a.logger.Info("shutting down HTTP server")
    if err := a.httpServer.Shutdown(ctx); err != nil {
        a.logger.Error("HTTP server shutdown error", zap.Error(err))
    }

    a.logger.Info("closing Redis connection")
    if err := a.redis.Close(); err != nil {
        a.logger.Error("Redis close error", zap.Error(err))
    }

    a.logger.Info("closing database connection")
    if sqlDB, err := a.db.DB(); err == nil {
        sqlDB.Close()
    }

    a.logger.Sync()
    return nil
}
```

### Testing with Manual DI — Mock Injection

```go
// internal/service/user_test.go
package service_test

import (
    "context"
    "errors"
    "testing"

    "myapp/internal/service"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
    "go.uber.org/zap/zaptest"
)

// MockUserRepository implements repository.UserRepository for testing.
type MockUserRepository struct {
    mock.Mock
}

func (m *MockUserRepository) GetUser(ctx context.Context, id int64) (*service.User, error) {
    args := m.Called(ctx, id)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).(*service.User), args.Error(1)
}

func (m *MockUserRepository) CreateUser(ctx context.Context, u *service.User) error {
    args := m.Called(ctx, u)
    return args.Error(0)
}

func (m *MockUserRepository) UpdateUser(ctx context.Context, u *service.User) error {
    args := m.Called(ctx, u)
    return args.Error(0)
}

func (m *MockUserRepository) DeleteUser(ctx context.Context, id int64) error {
    args := m.Called(ctx, id)
    return args.Error(0)
}

// MockCache implements cache.Cache for testing.
type MockCache struct {
    mock.Mock
}

func (m *MockCache) Get(ctx context.Context, key string) (interface{}, bool) {
    args := m.Called(ctx, key)
    return args.Get(0), args.Bool(1)
}

func (m *MockCache) Set(ctx context.Context, key string, value interface{}) error {
    args := m.Called(ctx, key, value)
    return args.Error(0)
}

func (m *MockCache) Delete(ctx context.Context, key string) error {
    args := m.Called(ctx, key)
    return args.Error(0)
}

func TestUserService_GetUser_CacheHit(t *testing.T) {
    ctx := context.Background()
    logger := zaptest.NewLogger(t)

    mockRepo := new(MockUserRepository)
    mockCache := new(MockCache)

    expectedUser := &service.User{ID: 42, Email: "test@example.com"}

    // Cache returns the user — repo should NOT be called
    mockCache.On("Get", ctx, "user:42").Return(expectedUser, true)

    svc := service.NewUserService(mockRepo, mockCache, logger)

    user, err := svc.GetUser(ctx, 42)

    assert.NoError(t, err)
    assert.Equal(t, expectedUser, user)
    mockRepo.AssertNotCalled(t, "GetUser")
    mockCache.AssertExpectations(t)
}

func TestUserService_GetUser_CacheMiss(t *testing.T) {
    ctx := context.Background()
    logger := zaptest.NewLogger(t)

    mockRepo := new(MockUserRepository)
    mockCache := new(MockCache)

    expectedUser := &service.User{ID: 42, Email: "test@example.com"}

    // Cache miss
    mockCache.On("Get", ctx, "user:42").Return(nil, false)
    // Repo returns user
    mockRepo.On("GetUser", ctx, int64(42)).Return(expectedUser, nil)
    // Cache stores the result
    mockCache.On("Set", ctx, "user:42", expectedUser).Return(nil)

    svc := service.NewUserService(mockRepo, mockCache, logger)

    user, err := svc.GetUser(ctx, 42)

    assert.NoError(t, err)
    assert.Equal(t, expectedUser, user)
    mockRepo.AssertExpectations(t)
    mockCache.AssertExpectations(t)
}

func TestUserService_GetUser_NotFound(t *testing.T) {
    ctx := context.Background()
    logger := zaptest.NewLogger(t)

    mockRepo := new(MockUserRepository)
    mockCache := new(MockCache)

    mockCache.On("Get", ctx, "user:99").Return(nil, false)
    mockRepo.On("GetUser", ctx, int64(99)).Return(nil, service.ErrUserNotFound)

    svc := service.NewUserService(mockRepo, mockCache, logger)

    user, err := svc.GetUser(ctx, 99)

    assert.Nil(t, user)
    assert.True(t, errors.Is(err, service.ErrUserNotFound))
}
```

## Section 3: Google Wire — Compile-Time Code Generation

Wire generates the wiring code at compile time. It reads your provider functions and produces an `Initialize` function that constructs the dependency graph. The generated code is readable Go, not reflection magic.

### Installation

```bash
go install github.com/google/wire/cmd/wire@latest
```

### Defining Providers

```go
// internal/infrastructure/providers.go
package infrastructure

import (
    "myapp/internal/config"

    "go.uber.org/zap"
    "github.com/redis/go-redis/v9"
    "gorm.io/gorm"
    "gorm.io/driver/postgres"
)

// ProvideLogger creates a zap logger from config.
func ProvideLogger(cfg *config.Config) (*zap.Logger, error) {
    if cfg.Debug {
        return zap.NewDevelopment()
    }
    return zap.NewProduction()
}

// ProvideDatabase creates a GORM DB connection from config.
func ProvideDatabase(cfg *config.Config, logger *zap.Logger) (*gorm.DB, error) {
    return gorm.Open(postgres.Open(cfg.Database.DSN()), &gorm.Config{
        Logger: NewGormLogger(logger),
    })
}

// ProvideRedis creates a Redis client from config.
func ProvideRedis(cfg *config.Config) *redis.Client {
    return redis.NewClient(&redis.Options{
        Addr:     cfg.Redis.Addr,
        Password: cfg.Redis.Password,
        DB:       cfg.Redis.DB,
    })
}
```

```go
// internal/repository/providers.go
package repository

import (
    "go.uber.org/zap"
    "gorm.io/gorm"
)

func ProvideUserRepository(db *gorm.DB, logger *zap.Logger) UserRepository {
    return NewUserRepository(db, logger)
}

func ProvideOrderRepository(db *gorm.DB, logger *zap.Logger) OrderRepository {
    return NewOrderRepository(db, logger)
}
```

```go
// internal/service/providers.go
package service

import (
    "time"

    "myapp/internal/cache"
    "myapp/internal/config"
    "myapp/internal/repository"

    "github.com/redis/go-redis/v9"
    "go.uber.org/zap"
)

func ProvideUserService(
    repo repository.UserRepository,
    redis *redis.Client,
    logger *zap.Logger,
) *UserService {
    userCache := cache.NewRedisCache[*User](redis, "user", 5*time.Minute)
    return NewUserService(repo, userCache, logger)
}

func ProvideAuthService(
    repo repository.UserRepository,
    cfg *config.Config,
    logger *zap.Logger,
) *AuthService {
    return NewAuthService(repo, cfg.JWT, logger)
}

func ProvideOrderService(
    repo repository.OrderRepository,
    users *UserService,
    logger *zap.Logger,
) *OrderService {
    return NewOrderService(repo, users, logger)
}
```

### Wire Injector

```go
// cmd/server/wire.go
//go:build wireinject
// +build wireinject

package main

import (
    "myapp/internal/app"
    "myapp/internal/config"
    "myapp/internal/handler"
    "myapp/internal/infrastructure"
    "myapp/internal/repository"
    "myapp/internal/service"

    "github.com/google/wire"
)

// InfrastructureSet groups all infrastructure providers.
var InfrastructureSet = wire.NewSet(
    infrastructure.ProvideLogger,
    infrastructure.ProvideDatabase,
    infrastructure.ProvideRedis,
)

// RepositorySet groups all repository providers.
var RepositorySet = wire.NewSet(
    repository.ProvideUserRepository,
    repository.ProvideOrderRepository,
)

// ServiceSet groups all service providers.
var ServiceSet = wire.NewSet(
    service.ProvideUserService,
    service.ProvideAuthService,
    service.ProvideOrderService,
)

// HandlerSet groups all handler providers.
var HandlerSet = wire.NewSet(
    handler.ProvideUserHandler,
    handler.ProvideOrderHandler,
    handler.ProvideAuthHandler,
)

// InitializeApp constructs the complete application.
// Wire reads this function signature and generates the wiring code.
func InitializeApp(cfg *config.Config) (*app.App, error) {
    wire.Build(
        InfrastructureSet,
        RepositorySet,
        ServiceSet,
        HandlerSet,
        app.NewApp,
    )
    return nil, nil
}
```

```go
// cmd/server/main.go
package main

import (
    "context"
    "log"
    "os"
    "os/signal"
    "syscall"

    "myapp/internal/config"
)

func main() {
    cfg, err := config.Load()
    if err != nil {
        log.Fatalf("loading config: %v", err)
    }

    // InitializeApp is generated by wire into wire_gen.go
    application, err := InitializeApp(cfg)
    if err != nil {
        log.Fatalf("initializing app: %v", err)
    }

    ctx, cancel := signal.NotifyContext(context.Background(),
        os.Interrupt, syscall.SIGTERM)
    defer cancel()

    if err := application.Run(ctx); err != nil {
        log.Fatalf("running app: %v", err)
    }
}
```

Running `wire ./cmd/server/` generates `wire_gen.go`:

```go
// wire_gen.go (generated — do not edit)
// Code generated by Wire. DO NOT EDIT.

//go:generate go run github.com/google/wire/cmd/wire
//go:build !wireinject
// +build !wireinject

package main

import (
    "myapp/internal/app"
    "myapp/internal/config"
    "myapp/internal/handler"
    "myapp/internal/infrastructure"
    "myapp/internal/repository"
    "myapp/internal/service"
)

// Injectors from wire.go:

// InitializeApp constructs the complete application.
func InitializeApp(cfg *config.Config) (*app.App, error) {
    logger, err := infrastructure.ProvideLogger(cfg)
    if err != nil {
        return nil, err
    }
    db, err := infrastructure.ProvideDatabase(cfg, logger)
    if err != nil {
        return nil, err
    }
    redisClient := infrastructure.ProvideRedis(cfg)
    userRepository := repository.ProvideUserRepository(db, logger)
    orderRepository := repository.ProvideOrderRepository(db, logger)
    userService := service.ProvideUserService(userRepository, redisClient, logger)
    authService := service.ProvideAuthService(userRepository, cfg, logger)
    orderService := service.ProvideOrderService(orderRepository, userService, logger)
    userHandler := handler.ProvideUserHandler(userService, logger)
    orderHandler := handler.ProvideOrderHandler(orderService, logger)
    authHandler := handler.ProvideAuthHandler(authService, logger)
    appApp, err := app.NewApp(cfg, logger, db, redisClient, userService, authService, orderService, userHandler, orderHandler, authHandler)
    if err != nil {
        return nil, err
    }
    return appApp, nil
}
```

### Wire Provider Sets for Testing

```go
// internal/testing/wire_test.go
//go:build wireinject
// +build wireinject

package testing

import (
    "myapp/internal/app"
    "myapp/internal/config"
    "myapp/internal/handler"
    "myapp/internal/service"

    "github.com/google/wire"
)

// MockRepositorySet provides in-memory implementations.
var MockRepositorySet = wire.NewSet(
    ProvideMockUserRepository,
    ProvideMockOrderRepository,
)

// InitializeTestApp builds the app with mocked infrastructure.
func InitializeTestApp(cfg *config.Config) (*app.App, error) {
    wire.Build(
        MockRepositorySet,
        service.ProvideUserService,   // real services
        service.ProvideAuthService,
        service.ProvideOrderService,
        handler.ProvideUserHandler,
        handler.ProvideOrderHandler,
        handler.ProvideAuthHandler,
        ProvideTestLogger,
        ProvideTestRedis,             // in-memory Redis
        app.NewApp,
    )
    return nil, nil
}
```

## Section 4: Uber fx — Runtime Dependency Injection

fx uses reflection-based dependency injection at runtime. It is more flexible than Wire but adds startup cost and makes dependency errors runtime failures rather than compile-time failures. It is well-suited for plugin architectures and large applications where modules are loaded conditionally.

### Basic fx Application

```go
// cmd/server/main.go
package main

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "myapp/internal/config"
    "myapp/internal/handler"
    "myapp/internal/repository"
    "myapp/internal/service"

    "go.uber.org/fx"
    "go.uber.org/fx/fxevent"
    "go.uber.org/zap"
)

func main() {
    app := fx.New(
        // Provide configuration
        fx.Provide(config.Load),

        // Infrastructure module
        fx.Provide(
            NewLogger,
            NewDatabase,
            NewRedis,
        ),

        // Repository module
        fx.Provide(
            fx.Annotate(
                repository.NewUserRepository,
                fx.As(new(repository.UserRepository)),
            ),
            fx.Annotate(
                repository.NewOrderRepository,
                fx.As(new(repository.OrderRepository)),
            ),
        ),

        // Service module
        fx.Provide(
            service.NewUserService,
            service.NewAuthService,
            service.NewOrderService,
        ),

        // Handler module
        fx.Provide(
            handler.NewUserHandler,
            handler.NewOrderHandler,
            handler.NewAuthHandler,
            AsRoute(handler.NewUserHandler),
            AsRoute(handler.NewOrderHandler),
            AsRoute(handler.NewAuthHandler),
        ),

        // HTTP server
        fx.Provide(NewHTTPServer),
        fx.Invoke(StartHTTPServer),

        // Use zap for fx's own logging
        fx.WithLogger(func(log *zap.Logger) fxevent.Logger {
            return &fxevent.ZapLogger{Logger: log}
        }),
    )

    app.Run()
}

// AsRoute annotates a handler constructor to be collected as a route.
func AsRoute(f interface{}) interface{} {
    return fx.Annotate(
        f,
        fx.As(new(http.Handler)),
        fx.ResultTags(`group:"routes"`),
    )
}

// NewHTTPServer creates an HTTP server with all registered routes.
func NewHTTPServer(
    lc fx.Lifecycle,
    cfg *config.Config,
    logger *zap.Logger,
) *http.Server {
    mux := http.NewServeMux()

    srv := &http.Server{
        Addr:         fmt.Sprintf(":%d", cfg.HTTP.Port),
        Handler:      mux,
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 30 * time.Second,
    }

    lc.Append(fx.Hook{
        OnStart: func(ctx context.Context) error {
            go func() {
                logger.Info("starting HTTP server", zap.String("addr", srv.Addr))
                if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
                    logger.Error("HTTP server error", zap.Error(err))
                }
            }()
            return nil
        },
        OnStop: func(ctx context.Context) error {
            logger.Info("stopping HTTP server")
            return srv.Shutdown(ctx)
        },
    })

    return srv
}

func StartHTTPServer(srv *http.Server) {
    // fx.Invoke ensures NewHTTPServer lifecycle hooks are registered
}
```

### fx Module Pattern for Large Services

```go
// internal/user/module.go
package user

import (
    "go.uber.org/fx"
)

// Module is the fx module for the user domain.
var Module = fx.Module("user",
    fx.Provide(
        NewRepository,
        NewService,
        NewHandler,
        NewCache,
    ),
    fx.Invoke(RegisterRoutes),
)
```

```go
// internal/order/module.go
package order

import "go.uber.org/fx"

var Module = fx.Module("order",
    fx.Provide(
        NewRepository,
        NewService,
        NewHandler,
    ),
    fx.Invoke(RegisterRoutes),
)
```

```go
// cmd/server/main.go (with modules)
func main() {
    fx.New(
        fx.Provide(config.Load),
        infrastructure.Module,
        user.Module,
        order.Module,
        auth.Module,
        http.Module,
    ).Run()
}
```

### fx Lifecycle Management

```go
// internal/database/database.go
package database

import (
    "context"
    "fmt"
    "time"

    "myapp/internal/config"

    "go.uber.org/fx"
    "go.uber.org/zap"
    "gorm.io/driver/postgres"
    "gorm.io/gorm"
)

// Params uses fx.In for named/grouped injection.
type Params struct {
    fx.In

    Config *config.Config
    Logger *zap.Logger
    LC     fx.Lifecycle
}

func New(p Params) (*gorm.DB, error) {
    db, err := gorm.Open(postgres.Open(p.Config.Database.DSN()), &gorm.Config{})
    if err != nil {
        return nil, fmt.Errorf("opening database: %w", err)
    }

    sqlDB, _ := db.DB()
    sqlDB.SetMaxOpenConns(p.Config.Database.MaxOpenConns)
    sqlDB.SetMaxIdleConns(p.Config.Database.MaxIdleConns)
    sqlDB.SetConnMaxLifetime(time.Duration(p.Config.Database.ConnMaxLifetimeSeconds) * time.Second)

    p.LC.Append(fx.Hook{
        OnStart: func(ctx context.Context) error {
            if err := sqlDB.PingContext(ctx); err != nil {
                return fmt.Errorf("pinging database: %w", err)
            }
            p.Logger.Info("database connection established",
                zap.String("host", p.Config.Database.Host))
            return nil
        },
        OnStop: func(ctx context.Context) error {
            p.Logger.Info("closing database connection")
            return sqlDB.Close()
        },
    })

    return db, nil
}
```

### fx Value Groups for Plugin Architecture

```go
// Collect all middleware implementations automatically
type Middleware interface {
    Wrap(http.Handler) http.Handler
    Priority() int
}

// Each middleware registers itself in the "middleware" group
fx.Provide(
    fx.Annotate(
        NewAuthMiddleware,
        fx.As(new(Middleware)),
        fx.ResultTags(`group:"middleware"`),
    ),
    fx.Annotate(
        NewLoggingMiddleware,
        fx.As(new(Middleware)),
        fx.ResultTags(`group:"middleware"`),
    ),
    fx.Annotate(
        NewMetricsMiddleware,
        fx.As(new(Middleware)),
        fx.ResultTags(`group:"middleware"`),
    ),
)

// Router receives all middleware automatically
type RouterParams struct {
    fx.In
    Middlewares []Middleware `group:"middleware"`
}

func NewRouter(p RouterParams) http.Handler {
    // Sort by priority and chain
    sort.Slice(p.Middlewares, func(i, j int) bool {
        return p.Middlewares[i].Priority() < p.Middlewares[j].Priority()
    })
    // Build chain...
}
```

## Section 5: Comparison and Decision Guide

### When to Use Each Approach

| Factor | Manual DI | Wire | fx |
|--------|-----------|------|----|
| Codebase size | Small (<20 components) | Medium (20-100) | Large (100+) |
| Compile-time safety | Yes | Yes | No (runtime) |
| Debugging ease | Excellent | Good | Moderate |
| Dynamic/conditional | No | Limited | Yes |
| Code generation | No | Yes | No |
| Startup performance | Fastest | Fastest | Slower |
| Plugin architecture | No | No | Yes |
| Learning curve | Low | Medium | High |

### Interface Design for Testability

Regardless of which DI framework you use, interface design determines testability:

```go
// Good interface design — focused, testable
type UserRepository interface {
    GetUser(ctx context.Context, id int64) (*User, error)
    CreateUser(ctx context.Context, u *User) error
    UpdateUser(ctx context.Context, u *User) error
    DeleteUser(ctx context.Context, id int64) error
    ListUsers(ctx context.Context, filter UserFilter) ([]*User, int64, error)
}

// Bad — too wide, impossible to mock completely
type UserRepository interface {
    GetUser(ctx context.Context, id int64) (*User, error)
    // ... 40 more methods
    RunMigrations() error          // infrastructure concern
    GetDatabaseConnection() *sql.DB // leaks implementation
}
```

### Structuring the Dependency Graph

```go
// Visualize your dependency graph with Wire
// wire -v shows the dependency order

// Always structure in layers:
// Config → Infrastructure → Repository → Service → Handler → Router → Server
//
// Rules:
// - Each layer only depends on layers below it
// - No circular dependencies
// - Interfaces at layer boundaries
// - Concrete types within a layer
```

## Section 6: Testing Strategies with DI

### Table-Driven Tests with DI

```go
// internal/service/user_test.go
func TestUserService_CreateUser(t *testing.T) {
    tests := []struct {
        name      string
        input     *User
        repoErr   error
        wantErr   bool
        wantErrIs error
    }{
        {
            name:  "successful creation",
            input: &User{Email: "new@example.com", Name: "New User"},
        },
        {
            name:      "duplicate email",
            input:     &User{Email: "existing@example.com"},
            repoErr:   ErrDuplicateEmail,
            wantErr:   true,
            wantErrIs: ErrDuplicateEmail,
        },
        {
            name:      "repository failure",
            input:     &User{Email: "test@example.com"},
            repoErr:   errors.New("connection refused"),
            wantErr:   true,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            ctx := context.Background()
            logger := zaptest.NewLogger(t)
            mockRepo := new(MockUserRepository)
            mockCache := new(MockCache)

            if tt.repoErr != nil {
                mockRepo.On("CreateUser", ctx, tt.input).Return(tt.repoErr)
            } else {
                mockRepo.On("CreateUser", ctx, tt.input).Return(nil)
            }

            svc := NewUserService(mockRepo, mockCache, logger)
            err := svc.CreateUser(ctx, tt.input)

            if tt.wantErr {
                assert.Error(t, err)
                if tt.wantErrIs != nil {
                    assert.ErrorIs(t, err, tt.wantErrIs)
                }
            } else {
                assert.NoError(t, err)
            }
            mockRepo.AssertExpectations(t)
        })
    }
}
```

### Integration Tests with Real Dependencies

```go
// internal/integration/user_test.go
//go:build integration

package integration_test

import (
    "context"
    "testing"

    "myapp/internal/config"
    "myapp/internal/database"
    "myapp/internal/repository"
    "myapp/internal/service"

    "go.uber.org/zap/zaptest"
    "github.com/stretchr/testify/require"
)

func TestUserService_Integration(t *testing.T) {
    if testing.Short() {
        t.Skip("skipping integration test")
    }

    cfg := config.LoadTestConfig(t)
    logger := zaptest.NewLogger(t)

    // Real database, real repo, real service
    db, err := database.New(cfg, logger)
    require.NoError(t, err)
    t.Cleanup(func() { db.Exec("DELETE FROM users WHERE email LIKE '%@test.example.com'") })

    userRepo := repository.NewUserRepository(db, logger)
    // In-memory cache for integration tests (avoid Redis dependency)
    cache := cache.NewInMemoryCache[*service.User](5 * time.Minute)
    svc := service.NewUserService(userRepo, cache, logger)

    ctx := context.Background()

    // Create
    u := &service.User{Email: "integration@test.example.com", Name: "Integration Test"}
    err = svc.CreateUser(ctx, u)
    require.NoError(t, err)
    require.NotZero(t, u.ID)

    // Read
    fetched, err := svc.GetUser(ctx, u.ID)
    require.NoError(t, err)
    require.Equal(t, u.Email, fetched.Email)
}
```

## Section 7: Lifecycle Management Patterns

### Graceful Shutdown with errgroup

```go
// internal/app/lifecycle.go
package app

import (
    "context"
    "os"
    "os/signal"
    "syscall"

    "golang.org/x/sync/errgroup"
    "go.uber.org/zap"
)

// RunWithGracefulShutdown runs multiple components and shuts them down on signal.
func RunWithGracefulShutdown(
    logger *zap.Logger,
    components ...Component,
) error {
    ctx, stop := signal.NotifyContext(
        context.Background(),
        os.Interrupt,
        syscall.SIGTERM,
    )
    defer stop()

    g, ctx := errgroup.WithContext(ctx)

    for _, c := range components {
        component := c // capture loop variable
        g.Go(func() error {
            if err := component.Start(ctx); err != nil {
                logger.Error("component failed",
                    zap.String("component", component.Name()),
                    zap.Error(err))
                return err
            }
            return nil
        })
    }

    return g.Wait()
}

// Component is the interface that all runnable components must implement.
type Component interface {
    Name() string
    Start(ctx context.Context) error
}
```

This guide covers the full spectrum of DI approaches in Go. For new services, start with manual DI and a clean container pattern. Introduce Wire when the wiring code becomes a maintenance burden. Reserve fx for services with genuine plugin requirements or those with hundreds of components where the startup graph is too complex to maintain manually.
