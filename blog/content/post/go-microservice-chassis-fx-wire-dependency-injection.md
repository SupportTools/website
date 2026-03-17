---
title: "Go Microservice Chassis: Building Reusable Infrastructure with fx and wire"
date: 2030-01-08T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Microservices", "Dependency Injection", "fx", "wire", "Architecture"]
categories: ["Go", "Software Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Building a Go microservice chassis with dependency injection using uber/fx and google/wire, covering service lifecycle management, plugin architecture, and reusable infrastructure patterns for enterprise microservice frameworks."
more_link: "yes"
url: "/go-microservice-chassis-fx-wire-dependency-injection/"
---

Enterprise microservice teams often find themselves copy-pasting the same infrastructure code across dozens of services: HTTP server setup, database connection pooling, metrics registration, health check endpoints, graceful shutdown, and configuration loading. This boilerplate is not just tedious — it leads to inconsistency, missed security patches when updates are not applied uniformly, and debugging challenges when services behave differently from each other.

A microservice chassis solves this by extracting shared infrastructure into a reusable framework. This guide demonstrates how to build a production-grade chassis using `uber/fx` for dependency injection and lifecycle management, with `google/wire` as an alternative approach and migration path for teams with different preferences.

<!--more-->

# Go Microservice Chassis: Building Reusable Infrastructure with fx and wire

## The Chassis Pattern

A microservice chassis is not a framework that dictates your business logic — it is a set of pre-built, opinionated infrastructure components that every service in your organization needs. A chassis typically provides:

- **Application lifecycle**: startup ordering, graceful shutdown hooks, signal handling
- **Configuration management**: typed config structs loaded from environment, files, and secrets managers
- **Observability**: structured logging, Prometheus metrics, distributed tracing
- **HTTP server**: with middleware for auth, rate limiting, request ID injection, and health checks
- **Database clients**: connection pooling, retry logic, circuit breakers
- **Message queue clients**: producer/consumer setup with standardized error handling

The chassis pattern reduces a new microservice from 2000 lines of infrastructure boilerplate to about 100 lines of business-logic focused code.

## Part 1: Understanding uber/fx

`uber/fx` is a dependency injection framework built around two core concepts:

1. **Providers**: functions that construct components and declare what they need as input
2. **Invokers**: functions that use components and trigger their construction

fx builds a dependency graph from your providers, detects cycles, and starts/stops components in dependency order.

### Basic fx Concepts

```go
// cmd/service/main.go
package main

import (
    "context"
    "fmt"
    "net/http"

    "go.uber.org/fx"
    "go.uber.org/zap"
)

// Component: Logger
func NewLogger() (*zap.Logger, error) {
    return zap.NewProduction()
}

// Component: Config
type Config struct {
    Port     int    `env:"PORT" envDefault:"8080"`
    Database string `env:"DATABASE_URL" envRequired:"true"`
}

func NewConfig() (*Config, error) {
    // In production, use envconfig or viper
    return &Config{Port: 8080, Database: "postgres://localhost/mydb"}, nil
}

// Component: HTTP Server (depends on Config and Logger)
type Server struct {
    mux    *http.ServeMux
    server *http.Server
    log    *zap.Logger
}

func NewServer(cfg *Config, log *zap.Logger, lc fx.Lifecycle) *Server {
    mux := http.NewServeMux()
    s := &Server{
        mux: mux,
        server: &http.Server{
            Addr:    fmt.Sprintf(":%d", cfg.Port),
            Handler: mux,
        },
        log: log,
    }

    // Register lifecycle hooks
    lc.Append(fx.Hook{
        OnStart: func(ctx context.Context) error {
            log.Info("Starting HTTP server", zap.String("addr", s.server.Addr))
            go func() {
                if err := s.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
                    log.Fatal("Server failed", zap.Error(err))
                }
            }()
            return nil
        },
        OnStop: func(ctx context.Context) error {
            log.Info("Stopping HTTP server")
            return s.server.Shutdown(ctx)
        },
    })

    return s
}

func main() {
    fx.New(
        // Provide all components
        fx.Provide(
            NewLogger,
            NewConfig,
            NewServer,
        ),
        // Invoke starts the application by requesting Server
        fx.Invoke(func(*Server) {}),
    ).Run()
}
```

### fx.In and fx.Out for Grouped Dependencies

```go
// When a component has many dependencies, use fx.In struct tags
type ServerParams struct {
    fx.In

    Logger  *zap.Logger
    Config  *Config
    DB      *sql.DB
    Cache   *redis.Client
    Metrics *prometheus.Registry

    // Optional dependency
    Tracer opentracing.Tracer `optional:"true"`

    // Named dependency
    AdminMux *http.ServeMux `name:"admin"`
}

func NewProductionServer(p ServerParams) (*Server, error) {
    // Use p.Logger, p.Config, etc.
    return &Server{
        log:     p.Logger,
        config:  p.Config,
        db:      p.DB,
    }, nil
}

// When providing multiple things, use fx.Out
type ServerResult struct {
    fx.Out

    Server  *Server
    Handler http.Handler `name:"main"`
    Health  HealthChecker
}

func NewServerWithResult(log *zap.Logger, cfg *Config) ServerResult {
    s := &Server{log: log}
    return ServerResult{
        Server:  s,
        Handler: s.Handler(),
        Health:  s.HealthChecker(),
    }
}
```

## Part 2: Building the Chassis

### Project Structure

```
chassis/
├── pkg/
│   ├── chassis/
│   │   ├── chassis.go          # Main chassis builder
│   │   └── options.go          # Chassis configuration options
│   ├── config/
│   │   ├── config.go           # Configuration loading
│   │   └── provider.go         # fx provider
│   ├── logging/
│   │   ├── logger.go           # Zap logger setup
│   │   └── provider.go
│   ├── metrics/
│   │   ├── metrics.go          # Prometheus setup
│   │   └── provider.go
│   ├── tracing/
│   │   ├── tracer.go           # OpenTelemetry setup
│   │   └── provider.go
│   ├── httpserver/
│   │   ├── server.go           # HTTP server with middleware
│   │   ├── middleware.go       # Standard middleware suite
│   │   └── provider.go
│   ├── database/
│   │   ├── postgres.go         # PostgreSQL connection pool
│   │   └── provider.go
│   └── healthcheck/
│       ├── health.go           # Health check registry
│       └── provider.go
├── examples/
│   ├── minimal/                # Simplest possible service
│   └── full/                   # Kitchen-sink service
└── go.mod
```

### Core Config Package

```go
// pkg/config/config.go
package config

import (
    "fmt"
    "os"
    "reflect"
    "strconv"
    "strings"
    "time"
)

// BaseConfig contains fields every service needs
type BaseConfig struct {
    // Service identity
    ServiceName    string `env:"SERVICE_NAME" required:"true"`
    ServiceVersion string `env:"SERVICE_VERSION" default:"unknown"`
    Environment    string `env:"ENVIRONMENT" default:"development"`

    // HTTP server
    HTTPPort    int           `env:"HTTP_PORT" default:"8080"`
    HTTPTimeout time.Duration `env:"HTTP_TIMEOUT" default:"30s"`

    // Metrics
    MetricsPort int `env:"METRICS_PORT" default:"9090"`

    // Logging
    LogLevel  string `env:"LOG_LEVEL" default:"info"`
    LogFormat string `env:"LOG_FORMAT" default:"json"`

    // Tracing
    TracingEnabled  bool   `env:"TRACING_ENABLED" default:"false"`
    TracingEndpoint string `env:"TRACING_ENDPOINT" default:"localhost:4317"`

    // Health check
    HealthCheckPath string `env:"HEALTH_CHECK_PATH" default:"/health"`
    ReadyCheckPath  string `env:"READY_CHECK_PATH" default:"/ready"`

    // Graceful shutdown
    ShutdownTimeout time.Duration `env:"SHUTDOWN_TIMEOUT" default:"30s"`
}

// LoadConfig populates a config struct from environment variables
// using struct tags: `env:"VAR_NAME" default:"value" required:"true"`
func LoadConfig(cfg interface{}) error {
    return loadFromEnv(reflect.ValueOf(cfg).Elem(), "")
}

func loadFromEnv(v reflect.Value, prefix string) error {
    t := v.Type()
    for i := 0; i < v.NumField(); i++ {
        field := v.Field(i)
        fieldType := t.Field(i)

        // Recurse into embedded structs
        if fieldType.Anonymous || field.Kind() == reflect.Struct {
            if err := loadFromEnv(field, prefix); err != nil {
                return err
            }
            continue
        }

        tag := fieldType.Tag.Get("env")
        if tag == "" {
            continue
        }

        envVar := prefix + tag
        required := fieldType.Tag.Get("required") == "true"
        defaultVal := fieldType.Tag.Get("default")

        value := os.Getenv(envVar)
        if value == "" {
            if required {
                return fmt.Errorf("required environment variable %s is not set", envVar)
            }
            value = defaultVal
        }

        if value == "" {
            continue
        }

        if err := setField(field, value, fieldType.Name); err != nil {
            return fmt.Errorf("setting field %s from %s: %w", fieldType.Name, envVar, err)
        }
    }
    return nil
}

func setField(field reflect.Value, value, fieldName string) error {
    switch field.Kind() {
    case reflect.String:
        field.SetString(value)
    case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
        // Handle time.Duration specially
        if field.Type() == reflect.TypeOf(time.Duration(0)) {
            d, err := time.ParseDuration(value)
            if err != nil {
                return fmt.Errorf("parsing duration %q: %w", value, err)
            }
            field.SetInt(int64(d))
            return nil
        }
        n, err := strconv.ParseInt(value, 10, 64)
        if err != nil {
            return fmt.Errorf("parsing int %q: %w", value, err)
        }
        field.SetInt(n)
    case reflect.Bool:
        b, err := strconv.ParseBool(value)
        if err != nil {
            return fmt.Errorf("parsing bool %q: %w", value, err)
        }
        field.SetBool(b)
    case reflect.Float64:
        f, err := strconv.ParseFloat(value, 64)
        if err != nil {
            return fmt.Errorf("parsing float %q: %w", value, err)
        }
        field.SetFloat(f)
    case reflect.Slice:
        if field.Type().Elem().Kind() == reflect.String {
            field.Set(reflect.ValueOf(strings.Split(value, ",")))
        }
    default:
        return fmt.Errorf("unsupported field type %s for field %s", field.Kind(), fieldName)
    }
    return nil
}
```

### HTTP Server with Middleware

```go
// pkg/httpserver/server.go
package httpserver

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "go.uber.org/fx"
    "go.uber.org/zap"
)

// Params holds all dependencies for the HTTP server
type Params struct {
    fx.In

    Logger  *zap.Logger
    Config  *Config
    Routes  []Route `group:"routes"`
}

// Route represents a single HTTP route
type Route struct {
    Method  string
    Path    string
    Handler http.HandlerFunc
}

// ServerConfig contains HTTP server settings
type Config struct {
    Port            int
    ReadTimeout     time.Duration
    WriteTimeout    time.Duration
    IdleTimeout     time.Duration
    MaxHeaderBytes  int
    ShutdownTimeout time.Duration
}

// DefaultConfig returns sensible production defaults
func DefaultConfig() *Config {
    return &Config{
        Port:            8080,
        ReadTimeout:     10 * time.Second,
        WriteTimeout:    30 * time.Second,
        IdleTimeout:     120 * time.Second,
        MaxHeaderBytes:  1 << 20, // 1MB
        ShutdownTimeout: 30 * time.Second,
    }
}

// Server wraps the standard library HTTP server
type Server struct {
    httpServer *http.Server
    mux        *http.ServeMux
    log        *zap.Logger
}

// New creates a new HTTP server with all middleware applied
func New(p Params, lc fx.Lifecycle) (*Server, error) {
    mux := http.NewServeMux()

    // Register all routes
    for _, route := range p.Routes {
        handler := route.Handler
        // Apply middleware chain
        handler = RequestIDMiddleware(handler)
        handler = LoggingMiddleware(handler, p.Logger)
        handler = RecoveryMiddleware(handler, p.Logger)
        handler = MetricsMiddleware(handler, route.Path)
        mux.Handle(route.Path, http.HandlerFunc(handler))
    }

    // Health and readiness endpoints (no middleware)
    mux.HandleFunc("/health", healthHandler)
    mux.HandleFunc("/ready", readyHandler)

    srv := &Server{
        mux: mux,
        log: p.Logger,
        httpServer: &http.Server{
            Addr:           fmt.Sprintf(":%d", p.Config.Port),
            Handler:        mux,
            ReadTimeout:    p.Config.ReadTimeout,
            WriteTimeout:   p.Config.WriteTimeout,
            IdleTimeout:    p.Config.IdleTimeout,
            MaxHeaderBytes: p.Config.MaxHeaderBytes,
        },
    }

    lc.Append(fx.Hook{
        OnStart: func(ctx context.Context) error {
            p.Logger.Info("HTTP server starting",
                zap.String("addr", srv.httpServer.Addr),
                zap.Int("routes", len(p.Routes)),
            )
            go func() {
                if err := srv.httpServer.ListenAndServe(); err != nil &&
                    err != http.ErrServerClosed {
                    p.Logger.Fatal("HTTP server failed", zap.Error(err))
                }
            }()
            return nil
        },
        OnStop: func(ctx context.Context) error {
            shutdownCtx, cancel := context.WithTimeout(ctx, p.Config.ShutdownTimeout)
            defer cancel()
            p.Logger.Info("HTTP server shutting down")
            return srv.httpServer.Shutdown(shutdownCtx)
        },
    })

    return srv, nil
}

// HandleFunc adds a route to the server from a provider
func AsRoute(method, path string, handler http.HandlerFunc) fx.Option {
    return fx.Provide(
        fx.Annotate(
            func() Route {
                return Route{
                    Method:  method,
                    Path:    path,
                    Handler: handler,
                }
            },
            fx.ResultTags(`group:"routes"`),
        ),
    )
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status":"ok"}`))
}

func readyHandler(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status":"ready"}`))
}
```

### Middleware Suite

```go
// pkg/httpserver/middleware.go
package httpserver

import (
    "net/http"
    "runtime/debug"
    "time"

    "github.com/google/uuid"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "go.opentelemetry.io/otel"
    "go.uber.org/zap"
)

var (
    httpRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total number of HTTP requests",
        },
        []string{"method", "path", "status"},
    )
    httpRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "HTTP request duration in seconds",
            Buckets: prometheus.ExponentialBuckets(0.001, 2, 14),
        },
        []string{"method", "path"},
    )
)

// responseRecorder captures the status code written to the response
type responseRecorder struct {
    http.ResponseWriter
    statusCode int
    bytes      int
}

func (rr *responseRecorder) WriteHeader(code int) {
    rr.statusCode = code
    rr.ResponseWriter.WriteHeader(code)
}

func (rr *responseRecorder) Write(b []byte) (int, error) {
    n, err := rr.ResponseWriter.Write(b)
    rr.bytes += n
    return n, err
}

// RequestIDMiddleware injects a unique request ID into the context
func RequestIDMiddleware(next http.HandlerFunc) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        requestID := r.Header.Get("X-Request-ID")
        if requestID == "" {
            requestID = uuid.New().String()
        }
        w.Header().Set("X-Request-ID", requestID)
        ctx := context.WithValue(r.Context(), requestIDKey{}, requestID)
        next.ServeHTTP(w, r.WithContext(ctx))
    }
}

type requestIDKey struct{}

// GetRequestID retrieves the request ID from context
func GetRequestID(ctx context.Context) string {
    if id, ok := ctx.Value(requestIDKey{}).(string); ok {
        return id
    }
    return ""
}

// LoggingMiddleware logs request details with structured logging
func LoggingMiddleware(next http.HandlerFunc, log *zap.Logger) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        rec := &responseRecorder{ResponseWriter: w, statusCode: http.StatusOK}

        next.ServeHTTP(rec, r)

        duration := time.Since(start)
        log.Info("request",
            zap.String("method", r.Method),
            zap.String("path", r.URL.Path),
            zap.String("remote_addr", r.RemoteAddr),
            zap.String("user_agent", r.UserAgent()),
            zap.String("request_id", GetRequestID(r.Context())),
            zap.Int("status", rec.statusCode),
            zap.Int("bytes", rec.bytes),
            zap.Duration("duration", duration),
        )
    }
}

// RecoveryMiddleware recovers from panics and returns 500
func RecoveryMiddleware(next http.HandlerFunc, log *zap.Logger) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if err := recover(); err != nil {
                log.Error("panic in HTTP handler",
                    zap.Any("panic", err),
                    zap.String("stack", string(debug.Stack())),
                    zap.String("path", r.URL.Path),
                    zap.String("request_id", GetRequestID(r.Context())),
                )
                http.Error(w, "Internal Server Error", http.StatusInternalServerError)
            }
        }()
        next.ServeHTTP(w, r)
    }
}

// MetricsMiddleware records Prometheus metrics for each request
func MetricsMiddleware(next http.HandlerFunc, path string) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        rec := &responseRecorder{ResponseWriter: w, statusCode: http.StatusOK}

        next.ServeHTTP(rec, r)

        duration := time.Since(start).Seconds()
        status := fmt.Sprintf("%d", rec.statusCode)

        httpRequestsTotal.WithLabelValues(r.Method, path, status).Inc()
        httpRequestDuration.WithLabelValues(r.Method, path).Observe(duration)
    }
}

// TracingMiddleware injects OpenTelemetry spans
func TracingMiddleware(next http.HandlerFunc) http.HandlerFunc {
    tracer := otel.Tracer("http")
    return func(w http.ResponseWriter, r *http.Request) {
        ctx, span := tracer.Start(r.Context(), fmt.Sprintf("%s %s", r.Method, r.URL.Path))
        defer span.End()
        next.ServeHTTP(w, r.WithContext(ctx))
    }
}

// CORSMiddleware handles CORS headers
func CORSMiddleware(allowedOrigins []string) func(http.HandlerFunc) http.HandlerFunc {
    return func(next http.HandlerFunc) http.HandlerFunc {
        return func(w http.ResponseWriter, r *http.Request) {
            origin := r.Header.Get("Origin")
            for _, allowed := range allowedOrigins {
                if allowed == "*" || allowed == origin {
                    w.Header().Set("Access-Control-Allow-Origin", origin)
                    w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
                    w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-ID")
                    break
                }
            }
            if r.Method == http.MethodOptions {
                w.WriteHeader(http.StatusNoContent)
                return
            }
            next.ServeHTTP(w, r)
        }
    }
}
```

### The Main Chassis Builder

```go
// pkg/chassis/chassis.go
package chassis

import (
    "go.uber.org/fx"
    "go.uber.org/fx/fxevent"
    "go.uber.org/zap"

    "myorg/chassis/pkg/config"
    "myorg/chassis/pkg/database"
    "myorg/chassis/pkg/healthcheck"
    "myorg/chassis/pkg/httpserver"
    "myorg/chassis/pkg/logging"
    "myorg/chassis/pkg/metrics"
    "myorg/chassis/pkg/tracing"
)

// Options holds configuration for the chassis
type Options struct {
    ServiceConfig interface{} // Service-specific config struct
    ExtraModules  []fx.Option // Additional fx modules
    Routes        []fx.Option // HTTP route providers
}

// BaseModule provides all standard chassis components
var BaseModule = fx.Options(
    // Core infrastructure
    logging.Module,
    config.Module,
    metrics.Module,
    healthcheck.Module,
    httpserver.Module,
)

// WithDatabase adds database support to the chassis
var WithDatabase = fx.Options(
    database.Module,
)

// New creates an fx application with all chassis components
func New(opts Options) *fx.App {
    modules := []fx.Option{
        BaseModule,
    }
    modules = append(modules, opts.ExtraModules...)
    modules = append(modules, opts.Routes...)

    // If service provides its own config, include it
    if opts.ServiceConfig != nil {
        modules = append(modules, fx.Provide(func() interface{} {
            return opts.ServiceConfig
        }))
    }

    return fx.New(
        modules...,

        // Control fx logging verbosity
        fx.WithLogger(func(log *zap.Logger) fxevent.Logger {
            return &fxevent.ZapLogger{Logger: log.Named("fx")}
        }),

        // Ensure HTTP server starts
        fx.Invoke(func(*httpserver.Server) {}),
    )
}

// Run is a convenience function that creates and runs the chassis
func Run(opts Options) {
    New(opts).Run()
}
```

## Part 3: Service Using the Chassis

Here is how a service team uses the chassis — only business logic, zero infrastructure boilerplate:

```go
// cmd/user-service/main.go
package main

import (
    "context"
    "encoding/json"
    "net/http"

    "go.uber.org/fx"
    "go.uber.org/zap"

    "myorg/chassis/pkg/chassis"
    "myorg/chassis/pkg/httpserver"
    "myorg/user-service/internal/handler"
    "myorg/user-service/internal/repository"
    "myorg/user-service/internal/service"
)

// ServiceConfig is specific to the user service
type ServiceConfig struct {
    DatabaseURL    string `env:"DATABASE_URL" required:"true"`
    RedisURL       string `env:"REDIS_URL" required:"true"`
    MaxConnections int    `env:"DB_MAX_CONNECTIONS" default:"25"`
}

func main() {
    chassis.Run(chassis.Options{
        ExtraModules: []fx.Option{
            fx.Provide(
                NewServiceConfig,
                repository.NewUserRepository,
                service.NewUserService,
                handler.NewUserHandler,
            ),
            chassis.WithDatabase,
        },
        Routes: []fx.Option{
            httpserver.AsRoute("GET", "/users", userListHandler()),
            httpserver.AsRoute("POST", "/users", userCreateHandler()),
            httpserver.AsRoute("GET", "/users/{id}", userGetHandler()),
        },
    })
}

func NewServiceConfig() (*ServiceConfig, error) {
    cfg := &ServiceConfig{}
    return cfg, config.LoadConfig(cfg)
}

// handlers - pure business logic, no infrastructure concerns
func userListHandler() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // All infrastructure (DB, cache, tracing) injected via handler package
        // ...
    }
}
```

## Part 4: google/wire as an Alternative

`google/wire` takes a code-generation approach to dependency injection. Rather than a runtime graph, wire generates Go code at build time.

### Wire Providers

```go
// internal/wire_gen.go (generated)
// DO NOT EDIT - generated by wire

package main

func InitializeServer(config *Config) (*Server, error) {
    logger, err := NewLogger()
    if err != nil {
        return nil, err
    }
    db, err := NewDatabase(config, logger)
    if err != nil {
        return nil, err
    }
    userRepo := repository.NewUserRepository(db, logger)
    userService := service.NewUserService(userRepo, logger)
    handler := handler.NewUserHandler(userService, logger)
    server, err := NewServer(config, logger, handler)
    if err != nil {
        return nil, err
    }
    return server, nil
}
```

Wire providers are defined in a separate file:

```go
// internal/wire.go (input to wire code generator)
//go:build wireinject

package main

import (
    "github.com/google/wire"
)

func InitializeServer(config *Config) (*Server, error) {
    wire.Build(
        NewLogger,
        NewDatabase,
        repository.NewUserRepository,
        service.NewUserService,
        handler.NewUserHandler,
        NewServer,
    )
    return nil, nil
}
```

Generate the wire code:

```bash
go install github.com/google/wire/cmd/wire@latest
cd cmd/user-service
wire
```

### fx vs wire: When to Use Each

| Aspect | uber/fx | google/wire |
|---|---|---|
| Approach | Runtime DI | Compile-time code generation |
| Error detection | Runtime | Compile time (after generation) |
| Plugin/extensibility | Native (fx.Option) | Requires re-running wire |
| Lifecycle management | Built-in | Must implement manually |
| Learning curve | Moderate | Lower for generated code |
| Best for | Frameworks, plugins, runtime extensibility | Fixed-topology services |

**Use fx when:**
- Building a framework or chassis that others extend
- You need runtime plugin loading
- Lifecycle management (start/stop ordering) is complex
- You want the dependency graph to be resolved and validated at startup

**Use wire when:**
- You want to see exactly what code is being generated
- Your team is uncomfortable with reflection-based DI
- You want zero runtime overhead for DI
- The dependency graph is known at compile time

## Part 5: Advanced fx Patterns

### Module Organization with fx.Module

```go
// pkg/kafka/module.go
package kafka

import "go.uber.org/fx"

// Module provides all Kafka-related components
var Module = fx.Module("kafka",
    fx.Provide(
        NewConfig,
        NewProducer,
        NewConsumer,
        NewAdminClient,
    ),
    fx.Decorate(
        // Override logger for Kafka to add namespace
        func(log *zap.Logger) *zap.Logger {
            return log.Named("kafka")
        },
    ),
)
```

### Lifecycle-Aware Components

```go
// pkg/database/postgres.go
package database

import (
    "context"
    "database/sql"
    "fmt"
    "time"

    _ "github.com/lib/pq"
    "go.uber.org/fx"
    "go.uber.org/zap"
)

type Config struct {
    URL             string        `env:"DATABASE_URL" required:"true"`
    MaxOpenConns    int           `env:"DB_MAX_OPEN_CONNS" default:"25"`
    MaxIdleConns    int           `env:"DB_MAX_IDLE_CONNS" default:"10"`
    ConnMaxLifetime time.Duration `env:"DB_CONN_MAX_LIFETIME" default:"5m"`
    ConnMaxIdleTime time.Duration `env:"DB_CONN_MAX_IDLE_TIME" default:"10m"`
}

// NewDB creates a PostgreSQL connection pool with lifecycle management
func NewDB(cfg *Config, log *zap.Logger, lc fx.Lifecycle) (*sql.DB, error) {
    db, err := sql.Open("postgres", cfg.URL)
    if err != nil {
        return nil, fmt.Errorf("opening database: %w", err)
    }

    db.SetMaxOpenConns(cfg.MaxOpenConns)
    db.SetMaxIdleConns(cfg.MaxIdleConns)
    db.SetConnMaxLifetime(cfg.ConnMaxLifetime)
    db.SetConnMaxIdleTime(cfg.ConnMaxIdleTime)

    lc.Append(fx.Hook{
        OnStart: func(ctx context.Context) error {
            if err := db.PingContext(ctx); err != nil {
                return fmt.Errorf("pinging database: %w", err)
            }
            log.Info("Database connected",
                zap.String("url", maskPassword(cfg.URL)),
                zap.Int("max_open_conns", cfg.MaxOpenConns),
            )
            return nil
        },
        OnStop: func(ctx context.Context) error {
            log.Info("Closing database connection pool")
            return db.Close()
        },
    })

    return db, nil
}

func maskPassword(dsn string) string {
    // Replace password in DSN for safe logging
    // postgres://user:password@host:port/dbname
    // -> postgres://user:***@host:port/dbname
    return "postgres://[masked]"
}

// Module provides database components
var Module = fx.Module("database",
    fx.Provide(NewDB),
)
```

### Multi-Instance Components with fx.Name

```go
// Multiple database connections (primary + replica)
func NewPrimaryDB(cfg *Config, log *zap.Logger, lc fx.Lifecycle) (*sql.DB, error) {
    return newDB(cfg.PrimaryURL, cfg, log, lc)
}

func NewReplicaDB(cfg *Config, log *zap.Logger, lc fx.Lifecycle) (*sql.DB, error) {
    return newDB(cfg.ReplicaURL, cfg, log, lc)
}

var DatabaseModule = fx.Module("database",
    fx.Provide(
        fx.Annotate(NewPrimaryDB, fx.ResultTags(`name:"primary"`)),
        fx.Annotate(NewReplicaDB, fx.ResultTags(`name:"replica"`)),
    ),
)

// Consumer uses named instances
type RepositoryParams struct {
    fx.In
    Primary *sql.DB `name:"primary"`
    Replica *sql.DB `name:"replica"`
}

func NewUserRepository(p RepositoryParams) *UserRepository {
    return &UserRepository{
        primary: p.Primary,
        replica: p.Replica,
    }
}
```

## Part 6: Testing with fx

```go
// internal/service/user_test.go
package service_test

import (
    "testing"

    "go.uber.org/fx"
    "go.uber.org/fx/fxtest"
    "go.uber.org/zap/zaptest"
)

func TestUserService(t *testing.T) {
    app := fxtest.New(t,
        // Provide test doubles instead of real infrastructure
        fx.Provide(
            func() *zap.Logger { return zaptest.NewLogger(t) },
            newTestDB,
            repository.NewUserRepository,
            service.NewUserService,
        ),
        fx.Invoke(func(s *service.UserService) {
            // Test the service
            user, err := s.CreateUser(context.Background(), CreateUserInput{
                Name:  "Test User",
                Email: "test@example.com",
            })
            require.NoError(t, err)
            assert.Equal(t, "Test User", user.Name)
        }),
    )
    app.RequireStart()
    app.RequireStop()
}

func newTestDB(t *testing.T) *sql.DB {
    // Use a test database or SQLite for fast tests
    db, err := sql.Open("sqlite3", ":memory:")
    require.NoError(t, err)
    t.Cleanup(func() { db.Close() })
    return db
}
```

## Key Takeaways

The microservice chassis pattern with fx solves the real operational challenge of keeping dozens of services consistent without burdening each service team with infrastructure concerns.

**fx excels at framework-level code** where components are extensible at runtime and lifecycle management is complex. The `fx.Option` pattern lets each team customize their service while inheriting all standard infrastructure.

**wire is better for fixed topologies** where you want generated code you can read and debug. It provides zero overhead and excellent compile-time safety.

**The investment pays off at scale**: the first service using a chassis requires building the chassis (significant upfront work). Services 2-50 each take minutes to bootstrap rather than days.

**Test your chassis components independently**: the httpserver, database, and metrics packages should have their own tests. Individual service tests then only test business logic, not infrastructure wiring.

**Version your chassis like a library**: breaking changes to the chassis interface affect all services. Use semantic versioning and maintain a changelog.
