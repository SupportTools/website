---
title: "Dependency Injection in Go: Wire vs Fx vs Manual Patterns"
date: 2028-09-28T00:00:00-05:00
draft: false
tags: ["Go", "Dependency Injection", "Wire", "Fx", "Software Architecture"]
categories:
- Go
- Software Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to dependency injection patterns in Go covering manual constructor injection and functional options, Google Wire compile-time DI with providers and injectors, Uber Fx runtime DI with lifecycle hooks and modules, testing strategies with DI, and choosing the right approach for different project scales."
more_link: "yes"
url: "/go-dependency-injection-wire-fx-guide/"
---

Dependency injection in Go is frequently over-engineered or entirely avoided. Many Go projects pass dependencies through function arguments or global variables, which works until the graph of dependencies becomes large enough that tracking them manually becomes error-prone.

This guide covers three approaches — manual DI, Google Wire (compile-time), and Uber Fx (runtime) — with concrete examples of each, and criteria for choosing between them.

<!--more-->

# Dependency Injection in Go: Wire vs Fx vs Manual Patterns

## The Problem DI Solves

Consider a typical service with multiple dependencies:

```go
// Without DI: dependencies are created inline or via globals
func main() {
    db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
    if err != nil {
        log.Fatal(err)
    }

    cache := redis.NewClient(&redis.Options{
        Addr: os.Getenv("REDIS_URL"),
    })

    emailClient := smtp.NewClient(os.Getenv("SMTP_HOST"))

    userRepo    := repository.NewUserRepository(db)
    orderRepo   := repository.NewOrderRepository(db)
    emailSvc    := service.NewEmailService(emailClient)
    userService := service.NewUserService(userRepo, cache, emailSvc)
    orderService := service.NewOrderService(orderRepo, userService, cache)

    httpServer := httpserver.New(userService, orderService)
    httpServer.Serve(":8080")
}
```

As the dependency graph grows, this becomes:
- Tedious to maintain
- Hard to test (the real database/cache/smtp are always created)
- Error-prone when dependencies need to be shared vs duplicated

DI frameworks solve the wiring problem, leaving you to focus on the components.

## Manual Dependency Injection

Manual DI is the Go-idiomatic baseline. It uses constructor functions and interface-based dependencies.

### Constructor Injection

```go
// domain/repository.go
package repository

import "database/sql"

type UserRepository interface {
    FindByID(ctx context.Context, id int64) (*User, error)
    Create(ctx context.Context, user *User) error
    Update(ctx context.Context, user *User) error
}

type userRepository struct {
    db *sql.DB
}

// Constructor: all dependencies are explicit parameters
func NewUserRepository(db *sql.DB) UserRepository {
    return &userRepository{db: db}
}

func (r *userRepository) FindByID(ctx context.Context, id int64) (*User, error) {
    var u User
    err := r.db.QueryRowContext(ctx,
        "SELECT id, name, email FROM users WHERE id = $1", id,
    ).Scan(&u.ID, &u.Name, &u.Email)
    if err != nil {
        return nil, fmt.Errorf("finding user %d: %w", id, err)
    }
    return &u, nil
}
```

```go
// service/user_service.go
package service

import (
    "context"
    "time"

    "github.com/example/app/domain/repository"
)

type Cache interface {
    Get(ctx context.Context, key string) (string, error)
    Set(ctx context.Context, key string, value string, ttl time.Duration) error
}

type EmailSender interface {
    Send(ctx context.Context, to, subject, body string) error
}

type UserService struct {
    repo  repository.UserRepository
    cache Cache
    email EmailSender
}

// All dependencies are injected through the constructor
func NewUserService(
    repo repository.UserRepository,
    cache Cache,
    email EmailSender,
) *UserService {
    return &UserService{
        repo:  repo,
        cache: cache,
        email: email,
    }
}
```

### Functional Options Pattern

Functional options provide optional configuration without breaking the constructor signature:

```go
// config/options.go
package config

import "time"

type ServerConfig struct {
    addr           string
    readTimeout    time.Duration
    writeTimeout   time.Duration
    maxConnections int
    tlsEnabled     bool
    certFile       string
    keyFile        string
}

type Option func(*ServerConfig)

func defaultConfig() *ServerConfig {
    return &ServerConfig{
        addr:           ":8080",
        readTimeout:    30 * time.Second,
        writeTimeout:   30 * time.Second,
        maxConnections: 1000,
    }
}

func WithAddr(addr string) Option {
    return func(c *ServerConfig) {
        c.addr = addr
    }
}

func WithTimeout(read, write time.Duration) Option {
    return func(c *ServerConfig) {
        c.readTimeout  = read
        c.writeTimeout = write
    }
}

func WithTLS(certFile, keyFile string) Option {
    return func(c *ServerConfig) {
        c.tlsEnabled = true
        c.certFile   = certFile
        c.keyFile    = keyFile
    }
}

func WithMaxConnections(n int) Option {
    return func(c *ServerConfig) {
        c.maxConnections = n
    }
}

// HTTPServer applies options through the constructor
type HTTPServer struct {
    config *ServerConfig
    // ... other fields
}

func NewHTTPServer(opts ...Option) *HTTPServer {
    cfg := defaultConfig()
    for _, opt := range opts {
        opt(cfg)
    }
    return &HTTPServer{config: cfg}
}

// Usage:
// server := NewHTTPServer(
//     config.WithAddr(":9090"),
//     config.WithTLS("/etc/certs/tls.crt", "/etc/certs/tls.key"),
//     config.WithMaxConnections(5000),
// )
```

### Testing with Manual DI

The primary benefit of manual DI is trivial test doubles:

```go
// service/user_service_test.go
package service_test

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
)

// Mock implementations
type MockUserRepository struct{ mock.Mock }

func (m *MockUserRepository) FindByID(ctx context.Context, id int64) (*User, error) {
    args := m.Called(ctx, id)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).(*User), args.Error(1)
}

func (m *MockUserRepository) Create(ctx context.Context, u *User) error {
    return m.Called(ctx, u).Error(0)
}

func (m *MockUserRepository) Update(ctx context.Context, u *User) error {
    return m.Called(ctx, u).Error(0)
}

type MockCache struct{ mock.Mock }

func (m *MockCache) Get(ctx context.Context, key string) (string, error) {
    args := m.Called(ctx, key)
    return args.String(0), args.Error(1)
}

func (m *MockCache) Set(ctx context.Context, key, value string, ttl time.Duration) error {
    return m.Called(ctx, key, value, ttl).Error(0)
}

type MockEmailSender struct{ mock.Mock }

func (m *MockEmailSender) Send(ctx context.Context, to, subject, body string) error {
    return m.Called(ctx, to, subject, body).Error(0)
}

func TestUserService_GetUser_CacheHit(t *testing.T) {
    repo  := &MockUserRepository{}
    cache := &MockCache{}
    email := &MockEmailSender{}

    svc := service.NewUserService(repo, cache, email)

    ctx := context.Background()
    user := &User{ID: 1, Name: "Alice", Email: "alice@example.com"}

    // Cache hit: repository should NOT be called
    cache.On("Get", ctx, "user:1").Return(`{"id":1,"name":"Alice"}`, nil)

    result, err := svc.GetUser(ctx, 1)
    assert.NoError(t, err)
    assert.Equal(t, int64(1), result.ID)

    cache.AssertCalled(t, "Get", ctx, "user:1")
    repo.AssertNotCalled(t, "FindByID")
}
```

## Google Wire (Compile-Time DI)

Wire generates the dependency wiring code at compile time. You write providers (constructors) and injectors (entry points), and Wire generates a `wire_gen.go` file with the actual initialization code.

### Installation

```bash
go install github.com/google/wire/cmd/wire@latest
```

### Defining Providers

```go
// internal/providers/database.go
package providers

import (
    "database/sql"
    "fmt"

    _ "github.com/lib/pq"
)

type DBConfig struct {
    Host     string
    Port     int
    Database string
    User     string
    Password string
    SSLMode  string
}

// NewDatabase is a Wire provider — a constructor function
func NewDatabase(cfg DBConfig) (*sql.DB, error) {
    dsn := fmt.Sprintf(
        "host=%s port=%d dbname=%s user=%s password=%s sslmode=%s",
        cfg.Host, cfg.Port, cfg.Database, cfg.User, cfg.Password, cfg.SSLMode,
    )
    db, err := sql.Open("postgres", dsn)
    if err != nil {
        return nil, fmt.Errorf("opening database: %w", err)
    }
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(5)
    db.SetConnMaxLifetime(5 * time.Minute)

    if err := db.Ping(); err != nil {
        return nil, fmt.Errorf("pinging database: %w", err)
    }

    return db, nil
}
```

```go
// internal/providers/cache.go
package providers

import (
    "context"
    "github.com/redis/go-redis/v9"
)

type RedisConfig struct {
    Addr     string
    Password string
    DB       int
}

func NewRedisClient(cfg RedisConfig) (*redis.Client, error) {
    client := redis.NewClient(&redis.Options{
        Addr:     cfg.Addr,
        Password: cfg.Password,
        DB:       cfg.DB,
    })

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    if err := client.Ping(ctx).Err(); err != nil {
        return nil, fmt.Errorf("connecting to redis: %w", err)
    }

    return client, nil
}

// RedisCache wraps *redis.Client to implement the Cache interface
type RedisCache struct {
    client *redis.Client
}

func NewRedisCache(client *redis.Client) *RedisCache {
    return &RedisCache{client: client}
}

func (c *RedisCache) Get(ctx context.Context, key string) (string, error) {
    val, err := c.client.Get(ctx, key).Result()
    if err == redis.Nil {
        return "", nil  // Cache miss
    }
    return val, err
}

func (c *RedisCache) Set(ctx context.Context, key, value string, ttl time.Duration) error {
    return c.client.Set(ctx, key, value, ttl).Err()
}
```

### Provider Sets

Group related providers into sets for reuse:

```go
// internal/providers/wire.go
package providers

import "github.com/google/wire"

// InfrastructureSet provides database and cache infrastructure
var InfrastructureSet = wire.NewSet(
    NewDatabase,
    NewRedisClient,
    NewRedisCache,
    wire.Bind(new(service.Cache), new(*RedisCache)),
)

// RepositorySet provides all repository implementations
var RepositorySet = wire.NewSet(
    repository.NewUserRepository,
    repository.NewOrderRepository,
    wire.Bind(new(repository.UserRepository), new(*repository.userRepository)),
    wire.Bind(new(repository.OrderRepository), new(*repository.orderRepository)),
)

// ServiceSet provides all business logic services
var ServiceSet = wire.NewSet(
    service.NewUserService,
    service.NewOrderService,
    service.NewEmailService,
)
```

### Writing the Injector

```go
// cmd/server/wire.go
//go:build wireinject
// +build wireinject

// This file is ONLY compiled when running `wire` — the build tag
// ensures it is excluded from normal builds

package main

import (
    "github.com/google/wire"
    "github.com/example/app/internal/providers"
    "github.com/example/app/internal/httpserver"
)

// InitializeServer is the Wire injector function.
// Wire generates a concrete implementation in wire_gen.go.
func InitializeServer(dbCfg providers.DBConfig, redisCfg providers.RedisConfig) (*httpserver.Server, error) {
    wire.Build(
        providers.InfrastructureSet,
        providers.RepositorySet,
        providers.ServiceSet,
        httpserver.New,
    )
    return nil, nil  // Wire replaces this return
}
```

```bash
# Run wire code generation in the package directory
cd cmd/server
wire

# This generates wire_gen.go with the actual initialization code:
```

```go
// wire_gen.go — GENERATED FILE, do not edit
// Code generated by Wire. DO NOT EDIT.

package main

import (
    "github.com/example/app/internal/httpserver"
    "github.com/example/app/internal/providers"
    "github.com/example/app/internal/repository"
    "github.com/example/app/internal/service"
)

// Injectors from wire.go:

func InitializeServer(dbCfg providers.DBConfig, redisCfg providers.RedisConfig) (*httpserver.Server, error) {
    db, err := providers.NewDatabase(dbCfg)
    if err != nil {
        return nil, err
    }
    redisClient, err := providers.NewRedisClient(redisCfg)
    if err != nil {
        return nil, err
    }
    redisCache := providers.NewRedisCache(redisClient)
    userRepository := repository.NewUserRepository(db)
    orderRepository := repository.NewOrderRepository(db)
    emailService := service.NewEmailService()
    userService := service.NewUserService(userRepository, redisCache, emailService)
    orderService := service.NewOrderService(orderRepository, userService, redisCache)
    server := httpserver.New(userService, orderService)
    return server, nil
}
```

### Using the Generated Code

```go
// cmd/server/main.go
package main

import (
    "log"
    "os"

    "github.com/example/app/internal/providers"
)

func main() {
    dbCfg := providers.DBConfig{
        Host:     os.Getenv("DB_HOST"),
        Port:     5432,
        Database: os.Getenv("DB_NAME"),
        User:     os.Getenv("DB_USER"),
        Password: os.Getenv("DB_PASSWORD"),
        SSLMode:  "require",
    }

    redisCfg := providers.RedisConfig{
        Addr:     os.Getenv("REDIS_ADDR"),
        Password: os.Getenv("REDIS_PASSWORD"),
    }

    server, err := InitializeServer(dbCfg, redisCfg)
    if err != nil {
        log.Fatalf("failed to initialize server: %v", err)
    }

    if err := server.Run(":8080"); err != nil {
        log.Fatalf("server error: %v", err)
    }
}
```

## Uber Fx (Runtime DI)

Fx uses runtime reflection to build the dependency graph. Unlike Wire, it does not generate code — it resolves dependencies at startup. Fx also handles application lifecycle (start/stop hooks) as a first-class concept.

### Basic Fx Application

```go
// main.go
package main

import (
    "context"
    "database/sql"
    "fmt"
    "net/http"
    "os"

    "go.uber.org/fx"
    "go.uber.org/fx/fxevent"
    "go.uber.org/zap"
    _ "github.com/lib/pq"
)

func main() {
    app := fx.New(
        // Modules group related providers
        DatabaseModule,
        CacheModule,
        RepositoryModule,
        ServiceModule,
        HTTPModule,

        // Application-level logging
        fx.WithLogger(func(log *zap.Logger) fxevent.Logger {
            return &fxevent.ZapLogger{Logger: log}
        }),
    )

    app.Run()
}
```

### Fx Modules

```go
// internal/database/module.go
package database

import (
    "database/sql"
    "fmt"
    "time"

    "go.uber.org/fx"
    "go.uber.org/zap"
    _ "github.com/lib/pq"
)

type Config struct {
    DSN             string
    MaxOpenConns    int
    MaxIdleConns    int
    ConnMaxLifetime time.Duration
}

// Provide the *sql.DB — Fx calls this and injects its return value
func NewDatabase(cfg Config, log *zap.Logger, lc fx.Lifecycle) (*sql.DB, error) {
    db, err := sql.Open("postgres", cfg.DSN)
    if err != nil {
        return nil, fmt.Errorf("opening database: %w", err)
    }

    db.SetMaxOpenConns(cfg.MaxOpenConns)
    db.SetMaxIdleConns(cfg.MaxIdleConns)
    db.SetConnMaxLifetime(cfg.ConnMaxLifetime)

    // Register lifecycle hooks
    lc.Append(fx.Hook{
        OnStart: func(ctx context.Context) error {
            if err := db.PingContext(ctx); err != nil {
                return fmt.Errorf("database ping failed: %w", err)
            }
            log.Info("database connected",
                zap.String("dsn_masked", maskDSN(cfg.DSN)))
            return nil
        },
        OnStop: func(ctx context.Context) error {
            log.Info("closing database connection")
            return db.Close()
        },
    })

    return db, nil
}

func maskDSN(dsn string) string {
    // Mask password in DSN for logging
    return "postgres://***:***@..."
}

// DatabaseModule groups database providers for reuse
var DatabaseModule = fx.Module("database",
    fx.Provide(
        NewDatabase,
        NewConfig,  // reads config from environment
    ),
)

func NewConfig() Config {
    return Config{
        DSN:             os.Getenv("DATABASE_URL"),
        MaxOpenConns:    25,
        MaxIdleConns:    5,
        ConnMaxLifetime: 5 * time.Minute,
    }
}
```

```go
// internal/httpserver/module.go
package httpserver

import (
    "context"
    "fmt"
    "net"
    "net/http"

    "go.uber.org/fx"
    "go.uber.org/zap"
)

type Config struct {
    Addr string
}

type Server struct {
    mux    *http.ServeMux
    server *http.Server
    log    *zap.Logger
}

// Fx supports multiple return values; error is the last one
func NewServer(
    cfg Config,
    log *zap.Logger,
    userHandler *UserHandler,
    orderHandler *OrderHandler,
    lc fx.Lifecycle,
) *Server {
    mux := http.NewServeMux()
    mux.Handle("/api/users/", userHandler)
    mux.Handle("/api/orders/", orderHandler)
    mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    srv := &Server{
        mux: mux,
        server: &http.Server{
            Addr:    cfg.Addr,
            Handler: mux,
        },
        log: log,
    }

    lc.Append(fx.Hook{
        OnStart: func(ctx context.Context) error {
            ln, err := net.Listen("tcp", cfg.Addr)
            if err != nil {
                return fmt.Errorf("listening on %s: %w", cfg.Addr, err)
            }
            log.Info("HTTP server starting", zap.String("addr", cfg.Addr))
            go srv.server.Serve(ln)
            return nil
        },
        OnStop: func(ctx context.Context) error {
            log.Info("HTTP server shutting down")
            return srv.server.Shutdown(ctx)
        },
    })

    return srv
}

var HTTPModule = fx.Module("http",
    fx.Provide(
        NewConfig,
        NewServer,
        NewUserHandler,
        NewOrderHandler,
    ),
)
```

### Fx Value Groups (Multiple Implementations)

```go
// Provide multiple HTTP handlers and collect them in a slice
// This avoids having to update the server when adding a new handler

// handler.go
type Handler interface {
    Pattern() string
    http.Handler
}

// Route annotates a provider result as a "routes" group member
type UserHandler struct{}
func NewUserHandler() Handler { return &UserHandler{} }
func (h *UserHandler) Pattern() string { return "/api/users/" }

type OrderHandler struct{}
func NewOrderHandler() Handler { return &OrderHandler{} }
func (h *OrderHandler) Pattern() string { return "/api/orders/" }

// module.go
var HandlersModule = fx.Module("handlers",
    fx.Provide(
        // Tag each handler as a member of the "routes" group
        fx.Annotate(NewUserHandler,
            fx.ResultTags(`group:"routes"`)),
        fx.Annotate(NewOrderHandler,
            fx.ResultTags(`group:"routes"`)),
    ),
)

// server.go
type RouteParams struct {
    fx.In

    Routes []Handler `group:"routes"`  // Collects all tagged handlers
}

func NewServer(p RouteParams, log *zap.Logger, lc fx.Lifecycle) *http.Server {
    mux := http.NewServeMux()
    for _, handler := range p.Routes {
        mux.Handle(handler.Pattern(), handler)
        log.Info("registered route", zap.String("pattern", handler.Pattern()))
    }
    // ...
}
```

### Fx with Parameters Objects

```go
// For constructors with many dependencies, use a params struct
type UserServiceParams struct {
    fx.In

    Repo  repository.UserRepository
    Cache Cache
    Email EmailSender
    Log   *zap.Logger

    // Optional dependencies
    Metrics MetricsCollector `optional:"true"`
}

func NewUserService(p UserServiceParams) *UserService {
    return &UserService{
        repo:    p.Repo,
        cache:   p.Cache,
        email:   p.Email,
        log:     p.Log,
        metrics: p.Metrics,
    }
}
```

## Testing with Fx

```go
// internal/service/user_service_fx_test.go
package service_test

import (
    "context"
    "testing"

    "go.uber.org/fx"
    "go.uber.org/fx/fxtest"
    "github.com/stretchr/testify/assert"
)

func TestUserServiceWithFx(t *testing.T) {
    var userService *UserService

    // fxtest.New creates an app with lifecycle tied to t.Cleanup
    app := fxtest.New(t,
        // Provide test doubles instead of real infrastructure
        fx.Provide(func() repository.UserRepository {
            m := &MockUserRepository{}
            m.On("FindByID", mock.Anything, int64(1)).
                Return(&User{ID: 1, Name: "Alice"}, nil)
            return m
        }),
        fx.Provide(func() Cache {
            m := &MockCache{}
            m.On("Get", mock.Anything, "user:1").
                Return("", nil)  // Cache miss
            m.On("Set", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
                Return(nil)
            return m
        }),
        fx.Provide(func() EmailSender { return &MockEmailSender{} }),
        fx.Provide(zap.NewNop),
        fx.Provide(NewUserService),
        fx.Populate(&userService),
    )

    app.RequireStart()
    defer app.RequireStop()

    ctx := context.Background()
    user, err := userService.GetUser(ctx, 1)
    assert.NoError(t, err)
    assert.Equal(t, "Alice", user.Name)
}
```

## Comparison and Decision Guide

| Criterion | Manual DI | Wire | Fx |
|-----------|-----------|------|-----|
| **Startup error detection** | Runtime | Compile time | Runtime |
| **IDE support** | Full | Good | Limited |
| **Learning curve** | Minimal | Moderate | Moderate |
| **Generated code** | None | Yes (wire_gen.go) | None |
| **Lifecycle management** | Manual | Manual | Built-in |
| **Reflection overhead** | None | None | Startup only |
| **Graph visualization** | None | Via `wire -v` | Via dot graph |
| **Optional dependencies** | Interface nil check | Not supported natively | fx.optional tag |
| **Dynamic modules** | Manual | Not supported | Supported |
| **Best for** | Small-medium | Medium-large (no lifecycle) | Large (with lifecycle) |

### Decision Framework

**Use manual DI when:**
- The application has fewer than 20-30 components
- You prefer explicit, traceable initialization code
- Team Go experience is varied (lower onboarding cost)
- You want zero external dependencies in the DI layer

**Use Wire when:**
- The dependency graph is large but static at startup
- You want compile-time verification of the wiring
- You prefer generated code over reflection
- You don't need application lifecycle management (or handle it separately)

**Use Fx when:**
- The application has complex startup/shutdown sequencing
- You need dynamic module composition (e.g., plugin-style)
- Your team has experience with DI frameworks from other ecosystems
- You need value groups to collect multiple implementations

```go
// Practical rule of thumb:
//
// < 15 components:  Manual DI (constructor injection)
// 15-50 components: Wire (compile-time, easy to debug)
// 50+ components:   Fx (runtime, lifecycle management worth the complexity)
//
// If in doubt: start with manual DI.
// It is easy to migrate to Wire or Fx later.
// Going the other direction is harder.
```

## Summary

Dependency injection in Go does not require a framework. Manual constructor injection with interfaces provides testability and flexibility for most applications. Wire adds compile-time verification and code generation for larger graphs. Fx adds runtime lifecycle management and dynamic module composition for the most complex applications.

The key insight is that the pattern matters more than the tool: inject all dependencies through constructors, depend on interfaces rather than concrete types, and keep your `main` function responsible for wiring and nothing else.
