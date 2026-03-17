---
title: "Go Dependency Injection Without Frameworks: Wire and Manual DI Patterns"
date: 2030-06-04T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Dependency Injection", "Wire", "Testing", "Software Architecture", "Best Practices"]
categories:
- Go
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Production DI patterns in Go: manual constructor injection, Google Wire code generation, interface segregation, testable component design, and avoiding the anti-patterns that make Go services hard to test."
more_link: "yes"
url: "/go-dependency-injection-wire-manual-di-patterns/"
---

Dependency injection in Go does not require a framework. The language's first-class functions, interfaces, and struct composition make constructor injection natural and explicit. But as service graphs grow, manual wiring becomes tedious and error-prone — and this is where Google Wire earns its place. This guide covers the full DI spectrum: from clean manual patterns to Wire-generated initialization, with the interface design principles that make both approaches work at enterprise scale.

<!--more-->

## The Case Against Framework-Based DI in Go

Reflection-based DI frameworks (like Spring in the Java ecosystem) work by scanning types at runtime, resolving dependencies through tags or annotations, and constructing objects dynamically. In Go, this pattern has significant costs:

- **No compile-time verification** — dependency resolution failures surface at startup, not during compilation.
- **Hidden control flow** — understanding what gets injected where requires reading framework docs rather than following code.
- **Performance overhead** — reflection is orders of magnitude slower than direct function calls.
- **Debugging complexity** — stack traces through reflection machinery obscure the actual failure site.

Go's approach is different: dependencies are explicit parameters. A function that needs a database connection receives one as an argument. The compiler verifies that every dependency is provided. This is dependency injection without a framework, and it scales surprisingly far.

## Manual Constructor Injection

### The Core Pattern

The foundation of Go DI is the constructor function: a function that accepts dependencies as parameters and returns an initialized value.

```go
package database

import (
    "context"
    "database/sql"
    "fmt"
    "time"

    _ "github.com/lib/pq"
)

// Config holds database connection configuration.
type Config struct {
    Host            string
    Port            int
    Name            string
    User            string
    Password        string
    MaxOpenConns    int
    MaxIdleConns    int
    ConnMaxLifetime time.Duration
}

// DB wraps sql.DB with application-specific behavior.
type DB struct {
    db  *sql.DB
    cfg Config
}

// New creates a new DB instance. All dependencies are explicit parameters.
func New(cfg Config) (*DB, error) {
    dsn := fmt.Sprintf(
        "host=%s port=%d dbname=%s user=%s password=%s sslmode=require",
        cfg.Host, cfg.Port, cfg.Name, cfg.User, cfg.Password,
    )

    db, err := sql.Open("postgres", dsn)
    if err != nil {
        return nil, fmt.Errorf("opening database: %w", err)
    }

    db.SetMaxOpenConns(cfg.MaxOpenConns)
    db.SetMaxIdleConns(cfg.MaxIdleConns)
    db.SetConnMaxLifetime(cfg.ConnMaxLifetime)

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    if err := db.PingContext(ctx); err != nil {
        db.Close()
        return nil, fmt.Errorf("pinging database: %w", err)
    }

    return &DB{db: db, cfg: cfg}, nil
}

func (d *DB) Close() error {
    return d.db.Close()
}
```

### Repository Layer

```go
package user

import (
    "context"
    "database/sql"
    "errors"
    "fmt"
    "time"

    "github.com/example/app/database"
)

// Repository defines the data access contract for user operations.
// This interface is what callers depend on — not the concrete type.
type Repository interface {
    GetByID(ctx context.Context, id int64) (*User, error)
    GetByEmail(ctx context.Context, email string) (*User, error)
    Create(ctx context.Context, u *CreateUserRequest) (*User, error)
    Update(ctx context.Context, id int64, u *UpdateUserRequest) (*User, error)
    Delete(ctx context.Context, id int64) error
}

// User represents a user in the system.
type User struct {
    ID        int64
    Email     string
    Name      string
    CreatedAt time.Time
    UpdatedAt time.Time
}

type CreateUserRequest struct {
    Email string
    Name  string
}

type UpdateUserRequest struct {
    Name string
}

// postgresRepository is the PostgreSQL implementation of Repository.
// It is unexported — callers access it through the Repository interface.
type postgresRepository struct {
    db *database.DB
}

// NewRepository creates a new user repository. Dependencies are explicit.
func NewRepository(db *database.DB) Repository {
    return &postgresRepository{db: db}
}

func (r *postgresRepository) GetByID(ctx context.Context, id int64) (*User, error) {
    query := `
        SELECT id, email, name, created_at, updated_at
        FROM users
        WHERE id = $1 AND deleted_at IS NULL
    `

    var u User
    err := r.db.QueryRowContext(ctx, query, id).Scan(
        &u.ID, &u.Email, &u.Name, &u.CreatedAt, &u.UpdatedAt,
    )
    if errors.Is(err, sql.ErrNoRows) {
        return nil, ErrNotFound
    }
    if err != nil {
        return nil, fmt.Errorf("querying user by id %d: %w", id, err)
    }

    return &u, nil
}

var ErrNotFound = errors.New("user not found")
```

### Service Layer

```go
package user

import (
    "context"
    "fmt"
    "regexp"

    "github.com/example/app/events"
    "github.com/example/app/cache"
    "go.uber.org/zap"
)

// Emailer defines the contract for sending emails.
// Small, focused interfaces are easier to mock and satisfy.
type Emailer interface {
    SendWelcome(ctx context.Context, email, name string) error
}

// Cache defines the caching contract for user lookups.
type Cache interface {
    Get(ctx context.Context, key string) (*User, bool)
    Set(ctx context.Context, key string, user *User) error
    Delete(ctx context.Context, key string) error
}

// EventPublisher defines the contract for publishing domain events.
type EventPublisher interface {
    Publish(ctx context.Context, topic string, payload interface{}) error
}

// Service implements business logic for user operations.
// Every dependency is injected — no package-level state, no global singletons.
type Service struct {
    repo      Repository
    cache     Cache
    emailer   Emailer
    publisher EventPublisher
    logger    *zap.Logger
}

// ServiceConfig holds optional configuration for the service.
type ServiceConfig struct {
    MaxEmailRetries int
}

// NewService creates a user service with all required dependencies.
// The signature documents every dependency the service needs.
func NewService(
    repo Repository,
    cache Cache,
    emailer Emailer,
    publisher EventPublisher,
    logger *zap.Logger,
) *Service {
    return &Service{
        repo:      repo,
        cache:     cache,
        emailer:   emailer,
        publisher: publisher,
        logger:    logger,
    }
}

var emailRegex = regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)

func (s *Service) CreateUser(ctx context.Context, req *CreateUserRequest) (*User, error) {
    if !emailRegex.MatchString(req.Email) {
        return nil, fmt.Errorf("invalid email address: %q", req.Email)
    }

    existing, err := s.repo.GetByEmail(ctx, req.Email)
    if err != nil && err != ErrNotFound {
        return nil, fmt.Errorf("checking for existing user: %w", err)
    }
    if existing != nil {
        return nil, ErrEmailAlreadyExists
    }

    user, err := s.repo.Create(ctx, req)
    if err != nil {
        return nil, fmt.Errorf("creating user: %w", err)
    }

    // Cache the new user
    cacheKey := fmt.Sprintf("user:id:%d", user.ID)
    if err := s.cache.Set(ctx, cacheKey, user); err != nil {
        // Non-fatal: log and continue
        s.logger.Warn("failed to cache user", zap.Int64("user_id", user.ID), zap.Error(err))
    }

    // Send welcome email asynchronously
    go func() {
        if err := s.emailer.SendWelcome(context.Background(), user.Email, user.Name); err != nil {
            s.logger.Error("failed to send welcome email",
                zap.String("email", user.Email),
                zap.Error(err),
            )
        }
    }()

    // Publish domain event
    if err := s.publisher.Publish(ctx, "user.created", user); err != nil {
        s.logger.Warn("failed to publish user.created event",
            zap.Int64("user_id", user.ID),
            zap.Error(err),
        )
    }

    return user, nil
}

var ErrEmailAlreadyExists = errors.New("email address already registered")
```

### Manual Application Wiring

```go
package main

import (
    "context"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/example/app/cache"
    "github.com/example/app/database"
    "github.com/example/app/email"
    "github.com/example/app/events"
    "github.com/example/app/http/server"
    userhttp "github.com/example/app/http/user"
    "github.com/example/app/user"
    "go.uber.org/zap"
)

func main() {
    logger, err := zap.NewProduction()
    if err != nil {
        panic("failed to create logger: " + err.Error())
    }
    defer logger.Sync()

    cfg := loadConfig()

    // Infrastructure layer
    db, err := database.New(cfg.Database)
    if err != nil {
        logger.Fatal("failed to connect to database", zap.Error(err))
    }
    defer db.Close()

    redisCache, err := cache.NewRedis(cfg.Redis)
    if err != nil {
        logger.Fatal("failed to connect to Redis", zap.Error(err))
    }
    defer redisCache.Close()

    publisher, err := events.NewKafkaPublisher(cfg.Kafka)
    if err != nil {
        logger.Fatal("failed to create Kafka publisher", zap.Error(err))
    }
    defer publisher.Close()

    emailer := email.NewSMTPEmailer(cfg.SMTP)

    // Repository layer
    userRepo := user.NewRepository(db)

    // Cache adapter (adapts cache.Redis to user.Cache interface)
    userCache := cache.NewUserCache(redisCache)

    // Service layer
    userService := user.NewService(userRepo, userCache, emailer, publisher, logger)

    // HTTP handler layer
    userHandler := userhttp.NewHandler(userService, logger)

    // HTTP server
    srv := server.New(cfg.Server, logger)
    srv.RegisterRoutes(userHandler)

    // Graceful shutdown
    go func() {
        if err := srv.Start(); err != nil {
            logger.Fatal("server failed", zap.Error(err))
        }
    }()

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := srv.Shutdown(ctx); err != nil {
        logger.Error("server shutdown failed", zap.Error(err))
    }
}
```

## Interface Segregation for Testability

### The Problem with Wide Interfaces

Wide interfaces with many methods create difficult mocks and force test authors to implement irrelevant behavior:

```go
// BAD: Wide interface forces test implementations to stub irrelevant methods
type UserStore interface {
    GetByID(ctx context.Context, id int64) (*User, error)
    GetByEmail(ctx context.Context, email string) (*User, error)
    Create(ctx context.Context, u *CreateUserRequest) (*User, error)
    Update(ctx context.Context, id int64, u *UpdateUserRequest) (*User, error)
    Delete(ctx context.Context, id int64) error
    ListByTenant(ctx context.Context, tenantID int64) ([]*User, error)
    CountByTenant(ctx context.Context, tenantID int64) (int, error)
    SetLastLogin(ctx context.Context, id int64, t time.Time) error
    GetAuditLog(ctx context.Context, id int64) ([]*AuditEntry, error)
}
```

### Role-Based Interface Segregation

Define interfaces at the point of use, scoped to what the consumer actually needs:

```go
// GOOD: Each consumer declares only what it uses

// AuthService needs only credential lookup
type UserCredentialStore interface {
    GetByEmail(ctx context.Context, email string) (*User, error)
    SetLastLogin(ctx context.Context, id int64, t time.Time) error
}

// ProfileService needs read/write of profile data
type UserProfileStore interface {
    GetByID(ctx context.Context, id int64) (*User, error)
    Update(ctx context.Context, id int64, u *UpdateUserRequest) (*User, error)
}

// AdminService needs full access
type UserAdminStore interface {
    GetByID(ctx context.Context, id int64) (*User, error)
    Create(ctx context.Context, u *CreateUserRequest) (*User, error)
    Update(ctx context.Context, id int64, u *UpdateUserRequest) (*User, error)
    Delete(ctx context.Context, id int64) error
    ListByTenant(ctx context.Context, tenantID int64) ([]*User, error)
}

// The concrete repository satisfies all three interfaces.
// Go's implicit interface satisfaction handles the composition automatically.
type postgresRepository struct { /* ... */ }

func (r *postgresRepository) GetByEmail(ctx context.Context, email string) (*User, error) { /* ... */ }
func (r *postgresRepository) SetLastLogin(ctx context.Context, id int64, t time.Time) error { /* ... */ }
func (r *postgresRepository) GetByID(ctx context.Context, id int64) (*User, error) { /* ... */ }
// ... and so on
```

## Google Wire: Code-Generated DI

Wire solves the maintenance burden of manual wiring graphs without sacrificing type safety or readability. It generates the wiring code at compile time — the output is plain Go, not reflection.

### Installing Wire

```bash
go install github.com/google/wire/cmd/wire@latest
```

### Wire Provider Functions

Wire's unit of composition is the **provider**: a function that constructs a value given its dependencies. Providers are ordinary Go functions annotated with Wire's build tags.

```go
// wire_providers.go
//go:build wireinject
// +build wireinject

package main
```

```go
// providers.go — no build tags, these are real Go code
package main

import (
    "github.com/example/app/cache"
    "github.com/example/app/database"
    "github.com/example/app/email"
    "github.com/example/app/events"
    userhttp "github.com/example/app/http/user"
    "github.com/example/app/user"
    "go.uber.org/zap"
)

// provideLogger creates a production logger.
func provideLogger() (*zap.Logger, error) {
    return zap.NewProduction()
}

// provideDatabase creates the database connection.
func provideDatabase(cfg DatabaseConfig) (*database.DB, error) {
    return database.New(database.Config{
        Host:            cfg.Host,
        Port:            cfg.Port,
        Name:            cfg.Name,
        User:            cfg.User,
        Password:        cfg.Password,
        MaxOpenConns:    cfg.MaxOpenConns,
        MaxIdleConns:    cfg.MaxIdleConns,
        ConnMaxLifetime: cfg.ConnMaxLifetime,
    })
}

// provideRedisCache creates the Redis cache client.
func provideRedisCache(cfg RedisConfig) (*cache.Redis, error) {
    return cache.NewRedis(cfg.toInternalConfig())
}

// provideUserCache adapts the Redis cache to the user.Cache interface.
func provideUserCache(r *cache.Redis) user.Cache {
    return cache.NewUserCache(r)
}

// provideEventPublisher creates the Kafka publisher.
func provideEventPublisher(cfg KafkaConfig) (user.EventPublisher, error) {
    return events.NewKafkaPublisher(cfg.toInternalConfig())
}

// provideEmailer creates the SMTP emailer.
func provideEmailer(cfg SMTPConfig) user.Emailer {
    return email.NewSMTPEmailer(cfg.toInternalConfig())
}

// provideUserRepository creates the user repository.
func provideUserRepository(db *database.DB) user.Repository {
    return user.NewRepository(db)
}

// provideUserService creates the user service with all dependencies.
func provideUserService(
    repo user.Repository,
    cache user.Cache,
    emailer user.Emailer,
    publisher user.EventPublisher,
    logger *zap.Logger,
) *user.Service {
    return user.NewService(repo, cache, emailer, publisher, logger)
}

// provideUserHandler creates the HTTP handler.
func provideUserHandler(svc *user.Service, logger *zap.Logger) *userhttp.Handler {
    return userhttp.NewHandler(svc, logger)
}
```

### Wire Injector Function

```go
// wire.go — only compiled during wire generation
//go:build wireinject
// +build wireinject

package main

import (
    "github.com/google/wire"
)

// ProviderSet groups related providers.
var InfraProviderSet = wire.NewSet(
    provideLogger,
    provideDatabase,
    provideRedisCache,
    provideEventPublisher,
    provideEmailer,
)

var UserProviderSet = wire.NewSet(
    provideUserRepository,
    provideUserCache,
    provideUserService,
    provideUserHandler,
)

// InitializeApp is the Wire injector. Wire generates the body.
// The function signature documents the top-level dependencies.
func InitializeApp(cfg AppConfig) (*App, func(), error) {
    wire.Build(
        InfraProviderSet,
        UserProviderSet,
        provideApp,
    )
    return nil, nil, nil // Wire replaces this body
}
```

### Running Wire

```bash
# Generate wire_gen.go from wire.go
wire ./...

# wire_gen.go is created automatically — do not edit by hand
```

The generated `wire_gen.go` looks like:

```go
// wire_gen.go — GENERATED CODE, DO NOT EDIT

//go:build !wireinject

package main

func InitializeApp(cfg AppConfig) (*App, func(), error) {
    logger, err := provideLogger()
    if err != nil {
        return nil, nil, err
    }
    db, err := provideDatabase(cfg.Database)
    if err != nil {
        logger.Sync()
        return nil, nil, err
    }
    redisClient, err := provideRedisCache(cfg.Redis)
    if err != nil {
        db.Close()
        logger.Sync()
        return nil, nil, err
    }
    userCache := provideUserCache(redisClient)
    publisher, err := provideEventPublisher(cfg.Kafka)
    if err != nil {
        redisClient.Close()
        db.Close()
        logger.Sync()
        return nil, nil, err
    }
    emailer := provideEmailer(cfg.SMTP)
    repo := provideUserRepository(db)
    svc := provideUserService(repo, userCache, emailer, publisher, logger)
    handler := provideUserHandler(svc, logger)

    app := provideApp(cfg, logger, handler)

    cleanup := func() {
        publisher.Close()
        redisClient.Close()
        db.Close()
        logger.Sync()
    }

    return app, cleanup, nil
}
```

### Wire Provider Sets and Binding

Wire can bind interface types to concrete implementations:

```go
var UserProviderSet = wire.NewSet(
    user.NewRepository,
    // Bind user.Repository interface to *user.postgresRepository
    wire.Bind(new(user.Repository), new(*user.postgresRepository)),
    cache.NewUserCache,
    wire.Bind(new(user.Cache), new(*cache.UserCache)),
    user.NewService,
    userhttp.NewHandler,
)
```

### Struct Providers

For structs with many fields, use `wire.Struct` to avoid writing a constructor:

```go
// Instead of writing a constructor function for a config struct:
type ServerConfig struct {
    Logger *zap.Logger
    DB     *database.DB
    Cache  *cache.Redis
}

// Use wire.Struct to generate the initialization
var ServerProviderSet = wire.NewSet(
    wire.Struct(new(ServerConfig), "*"), // "*" means inject all fields
)
```

## Testing with Dependency Injection

### Unit Testing with Manual Mocks

```go
package user_test

import (
    "context"
    "errors"
    "testing"
    "time"

    "github.com/example/app/user"
    "go.uber.org/zap/zaptest"
)

// fakeRepository is a test double for user.Repository.
type fakeRepository struct {
    users       map[int64]*user.User
    emailIndex  map[string]*user.User
    nextID      int64
    createErr   error
    getByIDErr  error
}

func newFakeRepository() *fakeRepository {
    return &fakeRepository{
        users:      make(map[int64]*user.User),
        emailIndex: make(map[string]*user.User),
        nextID:     1,
    }
}

func (r *fakeRepository) GetByID(ctx context.Context, id int64) (*user.User, error) {
    if r.getByIDErr != nil {
        return nil, r.getByIDErr
    }
    u, ok := r.users[id]
    if !ok {
        return nil, user.ErrNotFound
    }
    return u, nil
}

func (r *fakeRepository) GetByEmail(ctx context.Context, email string) (*user.User, error) {
    u, ok := r.emailIndex[email]
    if !ok {
        return nil, user.ErrNotFound
    }
    return u, nil
}

func (r *fakeRepository) Create(ctx context.Context, req *user.CreateUserRequest) (*user.User, error) {
    if r.createErr != nil {
        return nil, r.createErr
    }
    u := &user.User{
        ID:        r.nextID,
        Email:     req.Email,
        Name:      req.Name,
        CreatedAt: time.Now(),
        UpdatedAt: time.Now(),
    }
    r.users[u.ID] = u
    r.emailIndex[u.Email] = u
    r.nextID++
    return u, nil
}

func (r *fakeRepository) Update(ctx context.Context, id int64, req *user.UpdateUserRequest) (*user.User, error) {
    u, ok := r.users[id]
    if !ok {
        return nil, user.ErrNotFound
    }
    u.Name = req.Name
    u.UpdatedAt = time.Now()
    return u, nil
}

func (r *fakeRepository) Delete(ctx context.Context, id int64) error {
    delete(r.users, id)
    return nil
}

// fakeCache is a no-op cache for testing.
type fakeCache struct{}

func (c *fakeCache) Get(ctx context.Context, key string) (*user.User, bool) { return nil, false }
func (c *fakeCache) Set(ctx context.Context, key string, u *user.User) error { return nil }
func (c *fakeCache) Delete(ctx context.Context, key string) error             { return nil }

// fakeEmailer captures sent emails for assertion.
type fakeEmailer struct {
    sent []struct{ email, name string }
    err  error
}

func (e *fakeEmailer) SendWelcome(ctx context.Context, email, name string) error {
    if e.err != nil {
        return e.err
    }
    e.sent = append(e.sent, struct{ email, name string }{email, name})
    return nil
}

// fakePublisher captures published events.
type fakePublisher struct {
    events []struct{ topic string; payload interface{} }
}

func (p *fakePublisher) Publish(ctx context.Context, topic string, payload interface{}) error {
    p.events = append(p.events, struct{ topic string; payload interface{} }{topic, payload})
    return nil
}

// TestCreateUser_Success verifies the happy path for user creation.
func TestCreateUser_Success(t *testing.T) {
    repo := newFakeRepository()
    cache := &fakeCache{}
    emailer := &fakeEmailer{}
    publisher := &fakePublisher{}
    logger := zaptest.NewLogger(t)

    svc := user.NewService(repo, cache, emailer, publisher, logger)

    req := &user.CreateUserRequest{
        Email: "alice@example.com",
        Name:  "Alice Smith",
    }

    u, err := svc.CreateUser(context.Background(), req)
    if err != nil {
        t.Fatalf("expected no error, got: %v", err)
    }

    if u.Email != req.Email {
        t.Errorf("expected email %q, got %q", req.Email, u.Email)
    }
    if u.Name != req.Name {
        t.Errorf("expected name %q, got %q", req.Name, u.Name)
    }
    if u.ID == 0 {
        t.Error("expected non-zero user ID")
    }
}

// TestCreateUser_DuplicateEmail verifies duplicate email rejection.
func TestCreateUser_DuplicateEmail(t *testing.T) {
    repo := newFakeRepository()
    cache := &fakeCache{}
    emailer := &fakeEmailer{}
    publisher := &fakePublisher{}
    logger := zaptest.NewLogger(t)

    svc := user.NewService(repo, cache, emailer, publisher, logger)

    req := &user.CreateUserRequest{Email: "alice@example.com", Name: "Alice Smith"}

    // Create first user
    if _, err := svc.CreateUser(context.Background(), req); err != nil {
        t.Fatalf("first create failed: %v", err)
    }

    // Attempt duplicate
    _, err := svc.CreateUser(context.Background(), req)
    if !errors.Is(err, user.ErrEmailAlreadyExists) {
        t.Errorf("expected ErrEmailAlreadyExists, got: %v", err)
    }
}
```

### Using gomock for Generated Mocks

```bash
# Install mockgen
go install go.uber.org/mock/mockgen@latest

# Generate mocks for the user.Repository interface
mockgen -source=user/repository.go -destination=user/mocks/mock_repository.go -package=mocks
```

```go
// Using generated mocks in tests
package user_test

import (
    "context"
    "testing"

    "github.com/example/app/user"
    "github.com/example/app/user/mocks"
    "go.uber.org/mock/gomock"
    "go.uber.org/zap/zaptest"
)

func TestCreateUser_RepositoryError(t *testing.T) {
    ctrl := gomock.NewController(t)
    defer ctrl.Finish()

    mockRepo := mocks.NewMockRepository(ctrl)
    mockCache := mocks.NewMockCache(ctrl)
    mockEmailer := mocks.NewMockEmailer(ctrl)
    mockPublisher := mocks.NewMockEventPublisher(ctrl)
    logger := zaptest.NewLogger(t)

    // Set expectations
    mockRepo.EXPECT().
        GetByEmail(gomock.Any(), "alice@example.com").
        Return(nil, user.ErrNotFound)

    mockRepo.EXPECT().
        Create(gomock.Any(), gomock.Any()).
        Return(nil, errors.New("connection timeout"))

    svc := user.NewService(mockRepo, mockCache, mockEmailer, mockPublisher, logger)

    _, err := svc.CreateUser(context.Background(), &user.CreateUserRequest{
        Email: "alice@example.com",
        Name:  "Alice",
    })

    if err == nil {
        t.Fatal("expected error from repository, got nil")
    }
}
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Global State and init()

```go
// BAD: global state makes testing impossible without side effects
var globalDB *sql.DB

func init() {
    var err error
    globalDB, err = sql.Open("postgres", os.Getenv("DATABASE_URL"))
    if err != nil {
        panic(err)
    }
}

func GetUser(id int64) (*User, error) {
    // Implicitly depends on global state
    return queryUserFromDB(globalDB, id)
}
```

```go
// GOOD: explicit dependency, injectable and testable
type UserGetter struct {
    db *sql.DB
}

func NewUserGetter(db *sql.DB) *UserGetter {
    return &UserGetter{db: db}
}

func (g *UserGetter) GetUser(ctx context.Context, id int64) (*User, error) {
    return queryUserFromDB(ctx, g.db, id)
}
```

### Anti-Pattern 2: Service Locator

```go
// BAD: service locator hides dependencies and makes testing fragile
type ServiceLocator struct {
    services map[string]interface{}
}

var locator = &ServiceLocator{services: make(map[string]interface{})}

func Register(name string, svc interface{}) { locator.services[name] = svc }
func Locate(name string) interface{}        { return locator.services[name] }

// Caller has to know the magic string and cast the type
func DoSomething() {
    db := Locate("database").(*sql.DB)
    // ...
}
```

### Anti-Pattern 3: Optional Dependencies via nil Checks

```go
// BAD: optional dependencies through nil checks scatter conditional logic
type Service struct {
    repo      Repository
    cache     Cache  // might be nil
    telemetry Tracer // might be nil
}

func (s *Service) GetUser(ctx context.Context, id int64) (*User, error) {
    if s.cache != nil { // nil checks everywhere
        if u, ok := s.cache.Get(ctx, id); ok {
            return u, nil
        }
    }
    u, err := s.repo.GetByID(ctx, id)
    if s.telemetry != nil { // and everywhere
        s.telemetry.Record("user.get", /* ... */)
    }
    return u, err
}
```

```go
// GOOD: use the null object pattern for optional dependencies
type noopCache struct{}
func (c *noopCache) Get(ctx context.Context, key string) (*User, bool) { return nil, false }
func (c *noopCache) Set(ctx context.Context, key string, u *User) error { return nil }
func (c *noopCache) Delete(ctx context.Context, key string) error        { return nil }

type noopTracer struct{}
func (t *noopTracer) Record(name string, attrs ...interface{}) {}

// Callers always provide a real or null implementation — no nil checks in service code
svc := NewService(repo, &noopCache{}, &noopTracer{}, logger)
```

### Anti-Pattern 4: Constructors with Too Many Parameters

```go
// BAD: 8-parameter constructor is hard to call correctly and hard to extend
func NewPaymentService(
    db *database.DB,
    cache *cache.Redis,
    gateway PaymentGateway,
    fraud FraudDetector,
    notifier Notifier,
    audit AuditLogger,
    metrics MetricsRecorder,
    logger *zap.Logger,
) *PaymentService { /* ... */ }
```

```go
// GOOD: group related dependencies into config structs
type PaymentServiceDeps struct {
    DB       *database.DB
    Cache    Cache
    Gateway  PaymentGateway
    Fraud    FraudDetector
    Notifier Notifier
    Audit    AuditLogger
    Metrics  MetricsRecorder
    Logger   *zap.Logger
}

func NewPaymentService(deps PaymentServiceDeps) (*PaymentService, error) {
    if deps.DB == nil {
        return nil, errors.New("DB is required")
    }
    if deps.Gateway == nil {
        return nil, errors.New("Gateway is required")
    }
    // ...
    return &PaymentService{deps: deps}, nil
}
```

## Wire in CI/CD Pipelines

Regenerating Wire output must be part of the build process:

```makefile
# Makefile
.PHONY: generate build test

generate:
	go generate ./...

# Wire generation via go:generate directive in wire.go:
# //go:generate wire

build: generate
	go build -o bin/app ./cmd/app/...

test: generate
	go test ./...

# Fail CI if wire_gen.go is out of date
check-generate: generate
	git diff --exit-code -- '**/wire_gen.go'
```

```yaml
# .github/workflows/ci.yaml (partial)
- name: Verify Wire generation is current
  run: |
    go install github.com/google/wire/cmd/wire@latest
    wire ./...
    git diff --exit-code -- '**/wire_gen.go'
```

## Summary

Dependency injection in Go is most effective when it follows the grain of the language. Constructor injection is explicit, type-safe, and directly supported by the compiler. Interface segregation — defining small, role-based interfaces at the point of use — makes mocking trivial and prevents coupling to implementation details. Google Wire removes the maintenance burden of large wiring graphs while preserving compile-time verification and generating readable, debuggable code.

The patterns covered here — layered constructors, role-based interfaces, Wire providers, and null object mocks — compose into a DI approach that scales from small services to large codebases without introducing the magic or runtime overhead of reflection-based frameworks.
