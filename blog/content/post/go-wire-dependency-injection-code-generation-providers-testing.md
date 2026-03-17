---
title: "Go Wire Dependency Injection: Code Generation, Providers, Injectors, and Testing Strategies"
date: 2031-10-30T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Wire", "Dependency Injection", "Code Generation", "Testing", "Architecture"]
categories:
- Go
- Architecture
- Testing
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Google Wire for Go dependency injection: understanding the code generation approach, building provider sets, implementing injectors, and writing testable code with wire in production enterprise applications."
more_link: "yes"
url: "/go-wire-dependency-injection-code-generation-providers-testing/"
---

Dependency injection in Go is often handled manually, but as applications grow, the initialization graph becomes complex and error-prone. Google Wire solves this through compile-time code generation, catching dependency errors before the program runs and producing readable, debuggable initialization code. This guide covers Wire from fundamentals through advanced patterns used in large enterprise Go applications.

<!--more-->

# Go Wire Dependency Injection: Complete Enterprise Guide

## Why Wire Instead of Manual DI or Runtime Containers

Go developers have three main choices for dependency injection:

**Manual initialization**: Direct construction in `main()`. Works well up to ~20 components, then becomes a maintenance burden. No framework overhead.

**Runtime containers (dig, fx)**: Components register themselves, container resolves at runtime. Errors caught at startup, not compile time. Adds reflection overhead and harder to debug.

**Wire (compile-time code generation)**: Wire analyzes provider functions and generates initialization code. Errors caught during code generation. Generated code is plain Go, easily readable and debuggable.

Wire's key advantage for enterprise codebases: the generated `wire_gen.go` file is ordinary Go code that can be reviewed, committed, and debugged like any other code.

## Installation and Setup

```bash
# Install wire CLI
go install github.com/google/wire/cmd/wire@latest

# Add as a Go dependency
go get github.com/google/wire@latest

# Verify installation
wire --version
```

## Core Concepts

### Providers

A provider is a function that constructs a value. Wire uses providers to build a dependency graph.

```go
// internal/database/provider.go
package database

import (
    "context"
    "database/sql"
    "fmt"
    "time"

    _ "github.com/lib/pq"
)

// Config holds database connection configuration
type Config struct {
    Host     string
    Port     int
    Database string
    Username string
    Password string
    MaxConns int
    MaxIdle  int
}

// DB wraps sql.DB with application context
type DB struct {
    *sql.DB
    config Config
}

// NewConfig creates database config from environment
// This is itself a provider
func NewConfig(host string, port int, dbName, username, password string) Config {
    return Config{
        Host:     host,
        Port:     port,
        Database: dbName,
        Username: username,
        Password: password,
        MaxConns: 25,
        MaxIdle:  5,
    }
}

// NewDB is a provider for the database connection
// Wire will call this automatically when DB is needed
func NewDB(cfg Config) (*DB, func(), error) {
    dsn := fmt.Sprintf("host=%s port=%d dbname=%s user=%s password=%s sslmode=require",
        cfg.Host, cfg.Port, cfg.Database, cfg.Username, cfg.Password)

    db, err := sql.Open("postgres", dsn)
    if err != nil {
        return nil, nil, fmt.Errorf("failed to open database: %w", err)
    }

    db.SetMaxOpenConns(cfg.MaxConns)
    db.SetMaxIdleConns(cfg.MaxIdle)
    db.SetConnMaxLifetime(30 * time.Minute)

    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    if err := db.PingContext(ctx); err != nil {
        db.Close()
        return nil, nil, fmt.Errorf("database ping failed: %w", err)
    }

    cleanup := func() {
        db.Close()
    }

    return &DB{DB: db, config: cfg}, cleanup, nil
}
```

### Provider Sets

Group related providers into sets for reuse:

```go
// internal/database/wire.go
package database

import "github.com/google/wire"

// ProviderSet groups all database providers
var ProviderSet = wire.NewSet(
    NewConfig,
    NewDB,
)
```

### Injectors

An injector is a function that Wire generates. You write the signature, Wire writes the body:

```go
// cmd/api/wire.go
//go:build wireinject
// +build wireinject

package main

import (
    "github.com/google/wire"
    "github.com/example/myapp/internal/api"
    "github.com/example/myapp/internal/auth"
    "github.com/example/myapp/internal/database"
    "github.com/example/myapp/internal/cache"
)

// InitializeApp creates the complete application with all dependencies
// Wire will generate the implementation of this function
func InitializeApp(cfg AppConfig) (*api.Server, func(), error) {
    wire.Build(
        database.ProviderSet,
        cache.ProviderSet,
        auth.ProviderSet,
        api.ProviderSet,
        NewDatabaseConfig,
        NewCacheConfig,
    )
    return nil, nil, nil  // Wire replaces this
}
```

## Complete Application Example

### Application Configuration

```go
// internal/config/config.go
package config

import (
    "fmt"
    "os"
    "strconv"
)

// AppConfig holds all application configuration
type AppConfig struct {
    HTTP     HTTPConfig
    Database DatabaseConfig
    Cache    CacheConfig
    Auth     AuthConfig
}

type HTTPConfig struct {
    Host         string
    Port         int
    ReadTimeout  int // seconds
    WriteTimeout int // seconds
}

type DatabaseConfig struct {
    Host     string
    Port     int
    Name     string
    User     string
    Password string
}

type CacheConfig struct {
    Host     string
    Port     int
    Password string
    DB       int
}

type AuthConfig struct {
    JWTSecret      string
    TokenTTLHours  int
    RefreshTTLDays int
}

// Load reads configuration from environment variables
func Load() (AppConfig, error) {
    dbPort, err := strconv.Atoi(getEnv("DB_PORT", "5432"))
    if err != nil {
        return AppConfig{}, fmt.Errorf("invalid DB_PORT: %w", err)
    }

    httpPort, err := strconv.Atoi(getEnv("HTTP_PORT", "8080"))
    if err != nil {
        return AppConfig{}, fmt.Errorf("invalid HTTP_PORT: %w", err)
    }

    cfg := AppConfig{
        HTTP: HTTPConfig{
            Host:         getEnv("HTTP_HOST", "0.0.0.0"),
            Port:         httpPort,
            ReadTimeout:  30,
            WriteTimeout: 30,
        },
        Database: DatabaseConfig{
            Host:     requireEnv("DB_HOST"),
            Port:     dbPort,
            Name:     requireEnv("DB_NAME"),
            User:     requireEnv("DB_USER"),
            Password: requireEnv("DB_PASSWORD"),
        },
        Cache: CacheConfig{
            Host:     getEnv("REDIS_HOST", "localhost"),
            Port:     6379,
            Password: os.Getenv("REDIS_PASSWORD"),
        },
        Auth: AuthConfig{
            JWTSecret:      requireEnv("JWT_SECRET"),
            TokenTTLHours:  1,
            RefreshTTLDays: 7,
        },
    }

    return cfg, nil
}

func getEnv(key, defaultVal string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return defaultVal
}

func requireEnv(key string) string {
    v := os.Getenv(key)
    if v == "" {
        panic(fmt.Sprintf("required environment variable %s not set", key))
    }
    return v
}

// Wire provider
var ProviderSet = wire.NewSet(Load)
```

### Repository Layer

```go
// internal/user/repository.go
package user

import (
    "context"
    "database/sql"
    "fmt"
    "time"

    "github.com/google/wire"
    "github.com/example/myapp/internal/database"
)

// User domain model
type User struct {
    ID           int64
    Email        string
    PasswordHash string
    CreatedAt    time.Time
    UpdatedAt    time.Time
}

// Repository interface - allows mocking in tests
type Repository interface {
    FindByID(ctx context.Context, id int64) (*User, error)
    FindByEmail(ctx context.Context, email string) (*User, error)
    Create(ctx context.Context, email, passwordHash string) (*User, error)
    Update(ctx context.Context, user *User) error
}

// SQLRepository is the production implementation
type SQLRepository struct {
    db *database.DB
}

// NewRepository is the Wire provider for Repository
// Wire sees that Repository interface is returned and uses this automatically
func NewRepository(db *database.DB) Repository {
    return &SQLRepository{db: db}
}

func (r *SQLRepository) FindByID(ctx context.Context, id int64) (*User, error) {
    query := `SELECT id, email, password_hash, created_at, updated_at
              FROM users WHERE id = $1 AND deleted_at IS NULL`

    var u User
    err := r.db.QueryRowContext(ctx, query, id).Scan(
        &u.ID, &u.Email, &u.PasswordHash, &u.CreatedAt, &u.UpdatedAt)
    if err == sql.ErrNoRows {
        return nil, ErrNotFound
    }
    if err != nil {
        return nil, fmt.Errorf("FindByID: %w", err)
    }
    return &u, nil
}

func (r *SQLRepository) FindByEmail(ctx context.Context, email string) (*User, error) {
    query := `SELECT id, email, password_hash, created_at, updated_at
              FROM users WHERE email = $1 AND deleted_at IS NULL`

    var u User
    err := r.db.QueryRowContext(ctx, query, email).Scan(
        &u.ID, &u.Email, &u.PasswordHash, &u.CreatedAt, &u.UpdatedAt)
    if err == sql.ErrNoRows {
        return nil, ErrNotFound
    }
    if err != nil {
        return nil, fmt.Errorf("FindByEmail: %w", err)
    }
    return &u, nil
}

func (r *SQLRepository) Create(ctx context.Context, email, passwordHash string) (*User, error) {
    query := `INSERT INTO users (email, password_hash) VALUES ($1, $2)
              RETURNING id, created_at, updated_at`

    var u User
    u.Email = email
    u.PasswordHash = passwordHash

    err := r.db.QueryRowContext(ctx, query, email, passwordHash).Scan(
        &u.ID, &u.CreatedAt, &u.UpdatedAt)
    if err != nil {
        return nil, fmt.Errorf("Create: %w", err)
    }
    return &u, nil
}

func (r *SQLRepository) Update(ctx context.Context, u *User) error {
    query := `UPDATE users SET email=$1, password_hash=$2, updated_at=NOW()
              WHERE id=$3`

    _, err := r.db.ExecContext(ctx, query, u.Email, u.PasswordHash, u.ID)
    return err
}

var ErrNotFound = fmt.Errorf("user not found")

// ProviderSet for user package
var ProviderSet = wire.NewSet(NewRepository)
```

### Service Layer

```go
// internal/user/service.go
package user

import (
    "context"
    "fmt"

    "golang.org/x/crypto/bcrypt"
    "github.com/example/myapp/internal/cache"
)

// Service handles user business logic
type Service struct {
    repo  Repository
    cache cache.Client
}

// NewService is the Wire provider for Service
func NewService(repo Repository, cache cache.Client) *Service {
    return &Service{
        repo:  repo,
        cache: cache,
    }
}

func (s *Service) GetUser(ctx context.Context, id int64) (*User, error) {
    // Check cache first
    cacheKey := fmt.Sprintf("user:%d", id)
    if cached, err := s.cache.Get(ctx, cacheKey); err == nil {
        var u User
        if err := json.Unmarshal([]byte(cached), &u); err == nil {
            return &u, nil
        }
    }

    user, err := s.repo.FindByID(ctx, id)
    if err != nil {
        return nil, err
    }

    // Cache the result
    if data, err := json.Marshal(user); err == nil {
        s.cache.Set(ctx, cacheKey, string(data), 5*time.Minute)
    }

    return user, nil
}

func (s *Service) Authenticate(ctx context.Context, email, password string) (*User, error) {
    user, err := s.repo.FindByEmail(ctx, email)
    if err != nil {
        return nil, fmt.Errorf("authentication failed")
    }

    if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
        return nil, fmt.Errorf("authentication failed")
    }

    return user, nil
}

func (s *Service) Register(ctx context.Context, email, password string) (*User, error) {
    hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
    if err != nil {
        return nil, fmt.Errorf("failed to hash password: %w", err)
    }

    return s.repo.Create(ctx, email, string(hash))
}
```

### HTTP Handler

```go
// internal/api/handlers.go
package api

import (
    "encoding/json"
    "net/http"
    "strconv"

    "github.com/example/myapp/internal/user"
)

type UserHandler struct {
    userService *user.Service
}

func NewUserHandler(svc *user.Service) *UserHandler {
    return &UserHandler{userService: svc}
}

func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
    idStr := r.PathValue("id")
    id, err := strconv.ParseInt(idStr, 10, 64)
    if err != nil {
        http.Error(w, "invalid user ID", http.StatusBadRequest)
        return
    }

    u, err := h.userService.GetUser(r.Context(), id)
    if err != nil {
        http.Error(w, "user not found", http.StatusNotFound)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(u)
}
```

### HTTP Server

```go
// internal/api/server.go
package api

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "github.com/google/wire"
    "github.com/example/myapp/internal/config"
)

type Server struct {
    httpServer *http.Server
    mux        *http.ServeMux
}

func NewServer(cfg config.AppConfig, userHandler *UserHandler) *Server {
    mux := http.NewServeMux()

    // Register routes
    mux.HandleFunc("GET /api/v1/users/{id}", userHandler.GetUser)
    mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    return &Server{
        mux: mux,
        httpServer: &http.Server{
            Addr:         fmt.Sprintf("%s:%d", cfg.HTTP.Host, cfg.HTTP.Port),
            Handler:      mux,
            ReadTimeout:  time.Duration(cfg.HTTP.ReadTimeout) * time.Second,
            WriteTimeout: time.Duration(cfg.HTTP.WriteTimeout) * time.Second,
        },
    }
}

func (s *Server) Start() error {
    return s.httpServer.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
    return s.httpServer.Shutdown(ctx)
}

// ProviderSet groups all API providers
var ProviderSet = wire.NewSet(
    NewServer,
    NewUserHandler,
)
```

### The Wire Injector

```go
// cmd/api/wire.go
//go:build wireinject
// +build wireinject

package main

import (
    "github.com/google/wire"
    "github.com/example/myapp/internal/api"
    "github.com/example/myapp/internal/auth"
    "github.com/example/myapp/internal/cache"
    "github.com/example/myapp/internal/config"
    "github.com/example/myapp/internal/database"
    "github.com/example/myapp/internal/user"
)

// InitializeServer creates a fully wired API server
func InitializeServer() (*api.Server, func(), error) {
    wire.Build(
        config.Load,
        provideDatabaseConfig,
        database.NewDB,
        cache.NewClient,
        user.ProviderSet,
        api.ProviderSet,
    )
    return nil, nil, nil
}

// provideDatabaseConfig adapts AppConfig to DatabaseConfig
func provideDatabaseConfig(cfg config.AppConfig) database.Config {
    return database.Config{
        Host:     cfg.Database.Host,
        Port:     cfg.Database.Port,
        Database: cfg.Database.Name,
        Username: cfg.Database.User,
        Password: cfg.Database.Password,
        MaxConns: 25,
        MaxIdle:  5,
    }
}
```

### Generate the Wire Code

```bash
cd cmd/api
wire gen .

# Or from project root
wire gen ./cmd/api/
```

This generates `cmd/api/wire_gen.go`:

```go
// Code generated by Wire. DO NOT EDIT.

//go:generate go run github.com/google/wire/cmd/wire
//go:build !wireinject
// +build !wireinject

package main

import (
    "github.com/example/myapp/internal/api"
    "github.com/example/myapp/internal/cache"
    "github.com/example/myapp/internal/config"
    "github.com/example/myapp/internal/database"
    "github.com/example/myapp/internal/user"
)

// Injectors from wire.go:

func InitializeServer() (*api.Server, func(), error) {
    appConfig, err := config.Load()
    if err != nil {
        return nil, nil, err
    }
    databaseConfig := provideDatabaseConfig(appConfig)
    db, cleanup, err := database.NewDB(databaseConfig)
    if err != nil {
        return nil, nil, err
    }
    client, err := cache.NewClient(appConfig)
    if err != nil {
        cleanup()
        return nil, nil, err
    }
    repository := user.NewRepository(db)
    service := user.NewService(repository, client)
    userHandler := api.NewUserHandler(service)
    server := api.NewServer(appConfig, userHandler)
    return server, func() {
        cleanup()
    }, nil
}
```

### Main Function

```go
// cmd/api/main.go
package main

import (
    "context"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

func main() {
    server, cleanup, err := InitializeServer()
    if err != nil {
        log.Fatalf("failed to initialize server: %v", err)
    }
    defer cleanup()

    // Handle graceful shutdown
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

    serverErr := make(chan error, 1)
    go func() {
        log.Printf("starting server")
        if err := server.Start(); err != nil && err != http.ErrServerClosed {
            serverErr <- err
        }
    }()

    select {
    case err := <-serverErr:
        log.Fatalf("server error: %v", err)
    case sig := <-sigCh:
        log.Printf("received signal %v, shutting down", sig)
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()
        if err := server.Shutdown(ctx); err != nil {
            log.Printf("shutdown error: %v", err)
        }
    }
}
```

## Advanced Wire Patterns

### Wire Value Binding

Bind concrete values directly without provider functions:

```go
//go:build wireinject

func InitializeTestServer() (*api.Server, func(), error) {
    wire.Build(
        api.ProviderSet,
        user.ProviderSet,
        // Bind a concrete config value directly
        wire.Value(config.AppConfig{
            HTTP: config.HTTPConfig{
                Host: "127.0.0.1",
                Port: 0, // OS-assigned port for testing
            },
        }),
        wire.Value(database.Config{
            Host: "localhost",
            Port: 5432,
        }),
    )
    return nil, nil, nil
}
```

### Interface Binding

Bind a concrete type to an interface:

```go
//go:build wireinject

func InitializeServer() (*api.Server, func(), error) {
    wire.Build(
        database.NewDB,
        // Bind *database.DB to database.Querier interface
        wire.Bind(new(database.Querier), new(*database.DB)),
        // Bind *user.SQLRepository to user.Repository interface
        wire.Bind(new(user.Repository), new(*user.SQLRepository)),
        user.NewSQLRepository,  // Returns *SQLRepository
        user.NewService,
        api.ProviderSet,
        ...
    )
    return nil, nil, nil
}
```

### Struct Providers

For complex structs with many dependencies, use `wire.Struct`:

```go
// Service that needs many dependencies
type OrderService struct {
    UserRepo    user.Repository
    ProductRepo product.Repository
    PaymentSvc  *payment.Service
    Notifier    *notification.Service
    Logger      *slog.Logger
}

// Wire can construct this using field injection
//go:build wireinject

func InitializeOrderService() (*OrderService, func(), error) {
    wire.Build(
        user.NewRepository,
        product.NewRepository,
        payment.NewService,
        notification.NewService,
        NewLogger,
        // Wire fills all exported fields automatically
        wire.Struct(new(OrderService), "*"),
        ...
    )
    return nil, nil, nil
}
```

### Provider Groups

Use `wire.NewSet` to create reusable provider sets:

```go
// internal/observability/wire.go
package observability

import (
    "github.com/google/wire"
    "go.opentelemetry.io/otel/trace"
    "github.com/prometheus/client_golang/prometheus"
)

var ProviderSet = wire.NewSet(
    NewTracerProvider,
    NewMeterProvider,
    NewLogger,
    // Wire these abstract types automatically
    wire.Bind(new(trace.TracerProvider), new(*sdktrace.TracerProvider)),
)
```

## Testing Strategies with Wire

### Test Injectors with Mock Dependencies

```go
// internal/user/service_test.go
package user_test

import (
    "context"
    "testing"
    "time"

    "github.com/example/myapp/internal/user"
    "github.com/example/myapp/internal/cache"
)

// MockRepository implements user.Repository for testing
type MockRepository struct {
    FindByIDFunc    func(ctx context.Context, id int64) (*user.User, error)
    FindByEmailFunc func(ctx context.Context, email string) (*user.User, error)
    CreateFunc      func(ctx context.Context, email, hash string) (*user.User, error)
    UpdateFunc      func(ctx context.Context, u *user.User) error
}

func (m *MockRepository) FindByID(ctx context.Context, id int64) (*user.User, error) {
    if m.FindByIDFunc != nil {
        return m.FindByIDFunc(ctx, id)
    }
    return &user.User{
        ID:    id,
        Email: "test@example.com",
    }, nil
}

func (m *MockRepository) FindByEmail(ctx context.Context, email string) (*user.User, error) {
    if m.FindByEmailFunc != nil {
        return m.FindByEmailFunc(ctx, email)
    }
    return nil, user.ErrNotFound
}

func (m *MockRepository) Create(ctx context.Context, email, hash string) (*user.User, error) {
    if m.CreateFunc != nil {
        return m.CreateFunc(ctx, email, hash)
    }
    return &user.User{
        ID:        42,
        Email:     email,
        CreatedAt: time.Now(),
    }, nil
}

func (m *MockRepository) Update(ctx context.Context, u *user.User) error {
    if m.UpdateFunc != nil {
        return m.UpdateFunc(ctx, u)
    }
    return nil
}

// Verify interface compliance at compile time
var _ user.Repository = (*MockRepository)(nil)

func TestUserService_GetUser(t *testing.T) {
    mockRepo := &MockRepository{
        FindByIDFunc: func(ctx context.Context, id int64) (*user.User, error) {
            if id == 1 {
                return &user.User{ID: 1, Email: "alice@example.com"}, nil
            }
            return nil, user.ErrNotFound
        },
    }

    mockCache := cache.NewInMemoryClient() // In-memory implementation for tests

    svc := user.NewService(mockRepo, mockCache)

    // Test successful case
    u, err := svc.GetUser(context.Background(), 1)
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if u.Email != "alice@example.com" {
        t.Errorf("expected alice@example.com, got %s", u.Email)
    }

    // Test not found case
    _, err = svc.GetUser(context.Background(), 999)
    if err == nil {
        t.Error("expected error for non-existent user")
    }
}
```

### Test Wire Injector

```go
// cmd/api/wire_test.go
//go:build wireinject

package main

import (
    "github.com/google/wire"
    "github.com/example/myapp/internal/api"
    "github.com/example/myapp/internal/config"
    "github.com/example/myapp/internal/user"
)

// InitializeTestServer creates a server with in-memory dependencies
func InitializeTestServer(repo user.Repository) (*api.Server, func(), error) {
    wire.Build(
        wire.Value(config.AppConfig{
            HTTP: config.HTTPConfig{Host: "127.0.0.1", Port: 0},
        }),
        // Provide mock repository directly
        wire.Bind(new(user.Repository), new(*MockRepository)),
        cache.NewInMemoryClient,
        user.NewService,
        api.ProviderSet,
    )
    return nil, nil, nil
}
```

### Integration Test with Real Database

```go
// internal/user/integration_test.go
//go:build integration

package user_test

import (
    "context"
    "os"
    "testing"

    "github.com/example/myapp/internal/database"
    "github.com/example/myapp/internal/user"
)

func TestUserRepository_Integration(t *testing.T) {
    cfg := database.Config{
        Host:     os.Getenv("TEST_DB_HOST"),
        Port:     5432,
        Database: "testdb",
        Username: os.Getenv("TEST_DB_USER"),
        Password: os.Getenv("TEST_DB_PASSWORD"),
    }

    db, cleanup, err := database.NewDB(cfg)
    if err != nil {
        t.Skipf("skipping integration test: %v", err)
    }
    defer cleanup()

    repo := user.NewRepository(db)

    // Test create
    u, err := repo.Create(context.Background(), "integration-test@example.com", "hashed-pass")
    if err != nil {
        t.Fatalf("Create failed: %v", err)
    }
    defer func() {
        // Cleanup test data
        db.ExecContext(context.Background(), "DELETE FROM users WHERE id = $1", u.ID)
    }()

    // Test find
    found, err := repo.FindByID(context.Background(), u.ID)
    if err != nil {
        t.Fatalf("FindByID failed: %v", err)
    }
    if found.Email != "integration-test@example.com" {
        t.Errorf("email mismatch: %s", found.Email)
    }
}
```

## Makefile Integration

```makefile
# Makefile
WIRE_FILES := $(shell find . -name "wire.go" -not -path "*/vendor/*")
WIRE_GEN_FILES := $(WIRE_FILES:wire.go=wire_gen.go)

.PHONY: wire
wire: ## Generate Wire code
	@echo "Running wire gen..."
	wire gen ./...

.PHONY: wire-check
wire-check: ## Verify Wire-generated files are up to date
	wire gen ./...
	git diff --exit-code -- $(WIRE_GEN_FILES) || \
		(echo "Wire-generated files are out of date. Run 'make wire'" && exit 1)

.PHONY: test
test: wire ## Run tests with generated wire code
	go test ./... -race -count=1

# CI pipeline step
.PHONY: ci
ci: wire-check test build
```

## Wire in a Monorepo

For large monorepos with multiple services:

```
services/
├── user-service/
│   └── cmd/main/
│       ├── wire.go       # injector definitions
│       └── wire_gen.go   # generated
├── order-service/
│   └── cmd/main/
│       ├── wire.go
│       └── wire_gen.go
└── shared/
    ├── database/
    │   └── wire.go       # shared provider sets
    └── cache/
        └── wire.go       # shared provider sets
```

```bash
# Generate all wire files in monorepo
wire gen ./services/...

# Or per-service
wire gen ./services/user-service/cmd/main/
```

## Debugging Wire Errors

Wire errors are deterministic and caught at generation time:

```bash
# Common error: missing provider
wire: services/user-service/cmd/main: inject InitializeServer:
need wire.Bind for user.Repository, have no provider for *user.SQLRepository
hint: no provider was found for the following inputs: *database.DB

# Fix: add the missing provider to the Build call
wire.Build(
    database.NewDB,       # <-- add this
    user.NewRepository,
    ...
)
```

```bash
# Error: ambiguous providers (two providers return the same type)
wire: services/user-service/cmd/main: inject InitializeServer:
multiple providers for user.Repository:
    "github.com/example/myapp/internal/user".NewRepository
    "github.com/example/myapp/internal/user".NewCachedRepository

# Fix: use wire.Bind to disambiguate
wire.Bind(new(user.Repository), new(*user.CachedRepository))
```

## Performance Considerations

Wire generates zero-overhead code. The generated initialization runs exactly once at startup. For hot paths:

```go
// Avoid providers that are called frequently by placing them
// in the initialization graph, not in request handlers

// BAD: creating logger on every request
func HandleRequest(w http.ResponseWriter, r *http.Request) {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
    logger.Info("request received")
}

// GOOD: logger injected at startup via Wire
type Handler struct {
    logger *slog.Logger
}

func NewHandler(logger *slog.Logger) *Handler {
    return &Handler{logger: logger}
}

func (h *Handler) HandleRequest(w http.ResponseWriter, r *http.Request) {
    h.logger.Info("request received")
}
```

## Conclusion

Wire's compile-time approach to dependency injection provides the best of both worlds: the safety of a framework with the readability of manual initialization code. The generated `wire_gen.go` files are ordinary Go — they can be committed, reviewed, and debugged without understanding Wire's internals. For production enterprise Go applications handling complex dependency graphs, Wire eliminates an entire class of runtime initialization bugs while keeping the codebase clean and testable through well-defined provider interfaces.
