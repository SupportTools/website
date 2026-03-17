---
title: "Go Functional Options Pattern: API Design for Extensible Libraries"
date: 2031-04-01T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "API Design", "Software Architecture", "Design Patterns", "Libraries"]
categories:
- Go
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Go's functional options pattern for designing extensible, backward-compatible library APIs. Covers comparisons with config structs and builder pattern, option validation, testing strategies, and real examples from grpc-go and go-redis."
more_link: "yes"
url: "/go-functional-options-pattern-extensible-library-design/"
---

The functional options pattern is one of the most widely adopted API design techniques in the Go ecosystem. Popularized by Rob Pike and Dave Cheney, it solves the fundamental tension between providing a simple default interface and allowing rich customization without breaking backward compatibility. This guide examines the pattern in depth, compares it to alternatives, and demonstrates production-grade implementation techniques.

<!--more-->

# Go Functional Options Pattern: API Design for Extensible Libraries

## The Problem with Naive API Design

Before exploring functional options, understand the problems they solve.

### The Many-Parameter Anti-Pattern

```go
// Bad: function signature becomes unmanageable
func NewServer(host string, port int, timeout time.Duration,
    maxConns int, tlsEnabled bool, tlsCertFile string,
    tlsKeyFile string, readTimeout time.Duration,
    writeTimeout time.Duration, idleTimeout time.Duration,
    logger *slog.Logger) (*Server, error) {
    // ...
}

// Callsite is confusing and error-prone
s, err := NewServer("0.0.0.0", 8080, 30*time.Second,
    100, true, "/etc/ssl/cert.pem", "/etc/ssl/key.pem",
    10*time.Second, 10*time.Second, 60*time.Second, nil)
```

### The Config Struct Approach

```go
// Better but still has issues
type ServerConfig struct {
    Host         string
    Port         int
    Timeout      time.Duration
    MaxConns     int
    TLSEnabled   bool
    TLSCertFile  string
    TLSKeyFile   string
    ReadTimeout  time.Duration
    WriteTimeout time.Duration
    IdleTimeout  time.Duration
    Logger       *slog.Logger
}

func NewServer(cfg ServerConfig) (*Server, error) { ... }
```

Config structs work, but have drawbacks:
- Zero values are valid, making defaults ambiguous (is `Port: 0` intentional or did the caller forget to set it?)
- Adding new fields is backward compatible, but removing or renaming fields breaks callers
- Validation logic must live outside the struct or in a separate Validate method
- No way to express required vs. optional fields at the type level
- Difficult to compose options from multiple sources (flags, env vars, files)

## Section 1: The Functional Options Pattern

### Core Implementation

```go
// server.go
package server

import (
    "crypto/tls"
    "fmt"
    "log/slog"
    "time"
)

// Server is the main server type.
type Server struct {
    host         string
    port         int
    timeout      time.Duration
    maxConns     int
    tlsConfig    *tls.Config
    readTimeout  time.Duration
    writeTimeout time.Duration
    idleTimeout  time.Duration
    logger       *slog.Logger
}

// Option is a functional option for Server.
// Using a named type makes the option self-documenting in godoc.
type Option func(*Server) error

// defaults returns a Server with sensible production defaults applied.
func defaults() *Server {
    return &Server{
        host:         "0.0.0.0",
        port:         8080,
        timeout:      30 * time.Second,
        maxConns:     100,
        readTimeout:  10 * time.Second,
        writeTimeout: 10 * time.Second,
        idleTimeout:  60 * time.Second,
        logger:       slog.Default(),
    }
}

// New creates a Server with defaults and applies the provided options.
// Errors from any option are returned immediately.
func New(opts ...Option) (*Server, error) {
    s := defaults()
    for _, opt := range opts {
        if err := opt(s); err != nil {
            return nil, fmt.Errorf("server option: %w", err)
        }
    }
    return s, nil
}
```

### Defining Individual Options

```go
// options.go
package server

import (
    "crypto/tls"
    "errors"
    "fmt"
    "net"
    "time"
    "log/slog"
)

// WithHost sets the bind host address.
func WithHost(host string) Option {
    return func(s *Server) error {
        if host == "" {
            return errors.New("host cannot be empty")
        }
        if net.ParseIP(host) == nil && host != "localhost" {
            // Allow hostnames for bind address
        }
        s.host = host
        return nil
    }
}

// WithPort sets the TCP port the server listens on.
func WithPort(port int) Option {
    return func(s *Server) error {
        if port < 1 || port > 65535 {
            return fmt.Errorf("port must be between 1 and 65535, got %d", port)
        }
        s.port = port
        return nil
    }
}

// WithTimeout sets the general operation timeout.
func WithTimeout(d time.Duration) Option {
    return func(s *Server) error {
        if d <= 0 {
            return fmt.Errorf("timeout must be positive, got %v", d)
        }
        s.timeout = d
        return nil
    }
}

// WithMaxConnections sets the maximum number of simultaneous connections.
func WithMaxConnections(n int) Option {
    return func(s *Server) error {
        if n <= 0 {
            return fmt.Errorf("maxConns must be positive, got %d", n)
        }
        s.maxConns = n
        return nil
    }
}

// WithTLS configures TLS using the provided configuration.
func WithTLS(cfg *tls.Config) Option {
    return func(s *Server) error {
        if cfg == nil {
            return errors.New("TLS config cannot be nil")
        }
        s.tlsConfig = cfg
        return nil
    }
}

// WithTLSFiles configures TLS by loading a certificate and key from disk.
func WithTLSFiles(certFile, keyFile string) Option {
    return func(s *Server) error {
        cert, err := tls.LoadX509KeyPair(certFile, keyFile)
        if err != nil {
            return fmt.Errorf("loading TLS certificate: %w", err)
        }
        s.tlsConfig = &tls.Config{
            Certificates: []tls.Certificate{cert},
            MinVersion:   tls.VersionTLS12,
        }
        return nil
    }
}

// WithTimeouts sets read, write, and idle timeouts independently.
func WithTimeouts(read, write, idle time.Duration) Option {
    return func(s *Server) error {
        if read <= 0 || write <= 0 || idle <= 0 {
            return errors.New("all timeout values must be positive")
        }
        s.readTimeout = read
        s.writeTimeout = write
        s.idleTimeout = idle
        return nil
    }
}

// WithLogger sets a structured logger.
func WithLogger(logger *slog.Logger) Option {
    return func(s *Server) error {
        if logger == nil {
            return errors.New("logger cannot be nil; use slog.Default() for default logger")
        }
        s.logger = logger
        return nil
    }
}
```

### Usage at Call Sites

```go
// main.go
package main

import (
    "crypto/tls"
    "log"
    "log/slog"
    "os"
    "time"

    "github.com/example/myapp/server"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    // Minimal usage - all defaults apply
    s, err := server.New()
    if err != nil {
        log.Fatal(err)
    }

    // Production configuration
    s, err = server.New(
        server.WithHost("0.0.0.0"),
        server.WithPort(8443),
        server.WithTLSFiles("/etc/ssl/server.crt", "/etc/ssl/server.key"),
        server.WithTimeouts(15*time.Second, 15*time.Second, 90*time.Second),
        server.WithMaxConnections(500),
        server.WithLogger(logger),
    )
    if err != nil {
        log.Fatalf("creating server: %v", err)
    }

    _ = s // use the server
}
```

## Section 2: Composing and Combining Options

One of the most powerful aspects of functional options is composition.

### Option Slices and Presets

```go
// presets.go
package server

import "time"

// DevelopmentOptions returns options suitable for local development.
func DevelopmentOptions() []Option {
    return []Option{
        WithHost("127.0.0.1"),
        WithPort(8080),
        WithTimeout(60 * time.Second),
        WithMaxConnections(10),
    }
}

// ProductionOptions returns a base set of production options.
func ProductionOptions() []Option {
    return []Option{
        WithTimeout(30 * time.Second),
        WithMaxConnections(1000),
        WithTimeouts(10*time.Second, 10*time.Second, 120*time.Second),
    }
}

// Usage:
// opts := server.ProductionOptions()
// opts = append(opts, server.WithPort(9443))
// s, err := server.New(opts...)
```

### Options from Configuration Files

```go
// config_loader.go
package server

import (
    "encoding/json"
    "fmt"
    "os"
    "time"
)

type fileConfig struct {
    Host         string `json:"host"`
    Port         int    `json:"port"`
    TimeoutSecs  int    `json:"timeout_seconds"`
    MaxConns     int    `json:"max_connections"`
    TLSCertFile  string `json:"tls_cert_file"`
    TLSKeyFile   string `json:"tls_key_file"`
}

// WithConfigFile loads options from a JSON configuration file.
// Options specified in the file are applied, overriding defaults.
// Options not present in the file leave defaults unchanged.
func WithConfigFile(path string) Option {
    return func(s *Server) error {
        f, err := os.Open(path)
        if err != nil {
            return fmt.Errorf("opening config file %q: %w", path, err)
        }
        defer f.Close()

        var cfg fileConfig
        if err := json.NewDecoder(f).Decode(&cfg); err != nil {
            return fmt.Errorf("parsing config file %q: %w", path, err)
        }

        if cfg.Host != "" {
            if err := WithHost(cfg.Host)(s); err != nil {
                return err
            }
        }
        if cfg.Port != 0 {
            if err := WithPort(cfg.Port)(s); err != nil {
                return err
            }
        }
        if cfg.TimeoutSecs != 0 {
            if err := WithTimeout(time.Duration(cfg.TimeoutSecs) * time.Second)(s); err != nil {
                return err
            }
        }
        if cfg.MaxConns != 0 {
            if err := WithMaxConnections(cfg.MaxConns)(s); err != nil {
                return err
            }
        }
        if cfg.TLSCertFile != "" && cfg.TLSKeyFile != "" {
            if err := WithTLSFiles(cfg.TLSCertFile, cfg.TLSKeyFile)(s); err != nil {
                return err
            }
        }
        return nil
    }
}
```

### Conditional Options

```go
// conditional.go
package server

// WithOptionIf applies opt only when condition is true.
// Useful for toggling features based on build tags or environment variables.
func WithOptionIf(condition bool, opt Option) Option {
    return func(s *Server) error {
        if condition {
            return opt(s)
        }
        return nil
    }
}

// WithAny applies the first option from opts that does not return an error.
// Useful for fallback configurations (e.g., try mTLS, fall back to TLS).
func WithAny(opts ...Option) Option {
    return func(s *Server) error {
        var lastErr error
        for _, opt := range opts {
            if err := opt(s); err == nil {
                return nil
            } else {
                lastErr = err
            }
        }
        return fmt.Errorf("all options failed, last error: %w", lastErr)
    }
}

// Usage example:
// s, err := server.New(
//     server.WithOptionIf(os.Getenv("ENV") == "production", server.WithTLSFiles(cert, key)),
//     server.WithOptionIf(os.Getenv("ENV") != "production", server.WithPort(8080)),
// )
```

## Section 3: Comparison with Config Structs and Builder Pattern

### When to Use Config Structs

Config structs remain appropriate when:
- The configuration is meant to be serialized/deserialized (JSON, YAML, TOML)
- The configuration is passed across package boundaries where options are not available
- The struct is embedded in a larger application config hierarchy

```go
// Config struct works well for serializable configurations
type Config struct {
    Server   ServerConfig   `yaml:"server"`
    Database DatabaseConfig `yaml:"database"`
    Cache    CacheConfig    `yaml:"cache"`
}

type ServerConfig struct {
    Host    string        `yaml:"host"`
    Port    int           `yaml:"port"`
    Timeout time.Duration `yaml:"timeout"`
}
```

The hybrid approach uses both: load config from file into a struct, then convert to functional options:

```go
func OptionsFromConfig(cfg ServerConfig) []Option {
    var opts []Option
    if cfg.Host != "" {
        opts = append(opts, WithHost(cfg.Host))
    }
    if cfg.Port != 0 {
        opts = append(opts, WithPort(cfg.Port))
    }
    if cfg.Timeout != 0 {
        opts = append(opts, WithTimeout(cfg.Timeout))
    }
    return opts
}
```

### The Builder Pattern in Go

The builder pattern uses method chaining on a builder object:

```go
// Builder pattern
type ServerBuilder struct {
    server *Server
    errors []error
}

func NewBuilder() *ServerBuilder {
    return &ServerBuilder{server: defaults()}
}

func (b *ServerBuilder) WithHost(host string) *ServerBuilder {
    if host == "" {
        b.errors = append(b.errors, errors.New("host cannot be empty"))
        return b
    }
    b.server.host = host
    return b
}

func (b *ServerBuilder) WithPort(port int) *ServerBuilder {
    if port < 1 || port > 65535 {
        b.errors = append(b.errors, fmt.Errorf("invalid port: %d", port))
        return b
    }
    b.server.port = port
    return b
}

func (b *ServerBuilder) Build() (*Server, error) {
    if len(b.errors) > 0 {
        return nil, errors.Join(b.errors...)
    }
    return b.server, nil
}

// Usage:
// s, err := NewBuilder().WithHost("0.0.0.0").WithPort(8080).Build()
```

**Builder vs Functional Options comparison:**

| Aspect | Functional Options | Builder Pattern |
|---|---|---|
| Composability | Options are values, easily stored in slices | Builder is stateful, harder to compose |
| Error handling | Immediate (fail-fast) or deferred | Typically deferred to Build() |
| Testing | Options can be injected individually | Builder must be exercised as a whole |
| Variadic API | Natural fit | Requires explicit Build() terminator |
| Documentation | Self-documenting option names | Method names |
| Reusability | Options reusable across types | Builders are type-specific |

The functional options pattern wins when the primary concern is providing a clean, composable public API for a library. The builder pattern can be preferable when building fluent query DSLs.

## Section 4: Advanced Validation Patterns

### Validation After All Options Applied

Some validations require seeing the final state after all options have been applied:

```go
// validator.go
package server

import (
    "errors"
    "fmt"
)

// validate checks the final server configuration for consistency.
func (s *Server) validate() error {
    var errs []error

    if s.tlsConfig != nil && s.port == 80 {
        errs = append(errs, errors.New(
            "TLS is configured but port is 80; consider using port 443"))
    }

    if s.tlsConfig == nil && s.port == 443 {
        errs = append(errs, errors.New(
            "port is 443 but TLS is not configured"))
    }

    if s.readTimeout > s.idleTimeout {
        errs = append(errs, fmt.Errorf(
            "readTimeout (%v) should be less than idleTimeout (%v)",
            s.readTimeout, s.idleTimeout))
    }

    if s.maxConns < 1 {
        errs = append(errs, fmt.Errorf(
            "maxConns must be at least 1, got %d", s.maxConns))
    }

    return errors.Join(errs...)
}

// Modified New() with post-application validation
func New(opts ...Option) (*Server, error) {
    s := defaults()
    for _, opt := range opts {
        if err := opt(s); err != nil {
            return nil, fmt.Errorf("applying option: %w", err)
        }
    }
    if err := s.validate(); err != nil {
        return nil, fmt.Errorf("invalid server configuration: %w", err)
    }
    return s, nil
}
```

### Mutex-Protected Option Application for Concurrent Reconfiguration

For servers that support live reconfiguration:

```go
// dynamic.go
package server

import (
    "fmt"
    "sync"
)

type DynamicServer struct {
    mu     sync.RWMutex
    config *Server
}

// Reconfigure applies new options to a running server.
// It takes a snapshot of the current config, applies options to the snapshot,
// validates it, and atomically swaps if valid.
func (ds *DynamicServer) Reconfigure(opts ...Option) error {
    ds.mu.RLock()
    // Shallow copy current config
    snapshot := *ds.config
    ds.mu.RUnlock()

    for _, opt := range opts {
        if err := opt(&snapshot); err != nil {
            return fmt.Errorf("reconfiguration option: %w", err)
        }
    }

    if err := snapshot.validate(); err != nil {
        return fmt.Errorf("invalid reconfiguration: %w", err)
    }

    ds.mu.Lock()
    ds.config = &snapshot
    ds.mu.Unlock()

    return nil
}
```

## Section 5: Testing with Functional Options

Functional options make testing significantly cleaner by allowing injection of test-specific behaviors.

### Injecting Test Dependencies

```go
// test_options.go (in package server, build tag _test or internal package)
package server

import (
    "io"
    "log/slog"
    "net"
    "time"
)

// withPort0 makes the server bind to OS-assigned port (useful in tests).
func withPort0() Option {
    return func(s *Server) error {
        s.port = 0
        return nil
    }
}

// withTestLogger returns an option that logs to the provided writer.
func withTestLogger(w io.Writer) Option {
    return func(s *Server) error {
        s.logger = slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{
            Level: slog.LevelDebug,
        }))
        return nil
    }
}

// withShortTimeouts applies aggressive timeouts for faster tests.
func withShortTimeouts() Option {
    return func(s *Server) error {
        s.timeout = 1 * time.Second
        s.readTimeout = 500 * time.Millisecond
        s.writeTimeout = 500 * time.Millisecond
        s.idleTimeout = 2 * time.Second
        return nil
    }
}
```

### Unit Tests for Options

```go
// server_test.go
package server_test

import (
    "crypto/tls"
    "strings"
    "testing"
    "time"

    "github.com/example/myapp/server"
)

func TestNewWithDefaults(t *testing.T) {
    s, err := server.New()
    if err != nil {
        t.Fatalf("New() with no options failed: %v", err)
    }
    if s == nil {
        t.Fatal("New() returned nil server")
    }
}

func TestWithPort(t *testing.T) {
    tests := []struct {
        name    string
        port    int
        wantErr bool
    }{
        {"valid port", 8080, false},
        {"valid high port", 65535, false},
        {"zero port", 0, true},
        {"negative port", -1, true},
        {"overflow port", 65536, true},
    }

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            _, err := server.New(server.WithPort(tc.port))
            if (err != nil) != tc.wantErr {
                t.Errorf("WithPort(%d): wantErr=%v, got err=%v", tc.port, tc.wantErr, err)
            }
        })
    }
}

func TestWithTimeout(t *testing.T) {
    _, err := server.New(server.WithTimeout(-1 * time.Second))
    if err == nil {
        t.Error("expected error for negative timeout")
    }
    if !strings.Contains(err.Error(), "timeout must be positive") {
        t.Errorf("unexpected error message: %v", err)
    }
}

func TestOptionsAppliedInOrder(t *testing.T) {
    // Second WithPort should override the first
    s, err := server.New(
        server.WithPort(8080),
        server.WithPort(9090),
    )
    if err != nil {
        t.Fatalf("New() failed: %v", err)
    }
    if s.Port() != 9090 {
        t.Errorf("expected port 9090, got %d", s.Port())
    }
}

func TestWithTLSValidation(t *testing.T) {
    _, err := server.New(server.WithTLS(nil))
    if err == nil {
        t.Error("expected error for nil TLS config")
    }
}
```

### Benchmarking Option Application

```go
// bench_test.go
package server_test

import (
    "testing"
    "time"

    "github.com/example/myapp/server"
)

func BenchmarkNewWithOptions(b *testing.B) {
    opts := []server.Option{
        server.WithHost("0.0.0.0"),
        server.WithPort(8080),
        server.WithTimeout(30 * time.Second),
        server.WithMaxConnections(100),
    }

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _, err := server.New(opts...)
        if err != nil {
            b.Fatal(err)
        }
    }
}
```

## Section 6: Real-World Examples from Popular Libraries

### grpc-go Functional Options

The grpc-go library (`google.golang.org/grpc`) is a canonical example:

```go
// From google.golang.org/grpc - simplified illustration
// The actual grpc.DialOption and grpc.ServerOption types follow this pattern.

// grpc.Dial uses functional options
conn, err := grpc.NewClient(
    "localhost:50051",
    grpc.WithTransportCredentials(insecure.NewCredentials()),
    grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(16*1024*1024)),
    grpc.WithKeepaliveParams(keepalive.ClientParameters{
        Time:                10 * time.Second,
        Timeout:             time.Second,
        PermitWithoutStream: true,
    }),
    grpc.WithChainUnaryInterceptor(
        otgrpc.UnaryClientInterceptor(),
        retry.UnaryClientInterceptor(),
    ),
)

// grpc.NewServer uses functional options
srv := grpc.NewServer(
    grpc.Creds(credentials.NewTLS(tlsConfig)),
    grpc.MaxRecvMsgSize(16*1024*1024),
    grpc.KeepaliveParams(keepalive.ServerParameters{
        MaxConnectionIdle: 5 * time.Minute,
        MaxConnectionAge:  2 * time.Hour,
        Time:              1 * time.Minute,
        Timeout:           20 * time.Second,
    }),
    grpc.ChainUnaryInterceptor(
        grpc_recovery.UnaryServerInterceptor(),
        grpc_prometheus.UnaryServerInterceptor,
    ),
)
```

The grpc-go implementation uses an interface-based option:

```go
// Illustrative, not actual grpc-go code
type DialOption interface {
    apply(*dialOptions)
}

type funcDialOption struct {
    f func(*dialOptions)
}

func (fdo *funcDialOption) apply(do *dialOptions) {
    fdo.f(do)
}

func newFuncDialOption(f func(*dialOptions)) *funcDialOption {
    return &funcDialOption{f: f}
}
```

Using an interface rather than a bare function type allows the library to add metadata to options (like string representations for debugging) without breaking the API.

### go-redis Functional Options

```go
// go-redis also uses functional options (github.com/redis/go-redis)
rdb := redis.NewClient(&redis.Options{
    Addr:         "localhost:6379",
    Password:     "",
    DB:           0,
    PoolSize:     10,
    DialTimeout:  5 * time.Second,
    ReadTimeout:  3 * time.Second,
    WriteTimeout: 3 * time.Second,
})

// go-redis v9 uses the functional options pattern for cluster client
cluster := redis.NewClusterClient(&redis.ClusterOptions{
    Addrs: []string{
        "localhost:7000",
        "localhost:7001",
        "localhost:7002",
    },
    RouteByLatency: true,
})
```

### Implementing Interface-Based Options for Richer Metadata

```go
// rich_options.go
package server

import "fmt"

// TypedOption extends the basic option with metadata for debugging.
type TypedOption interface {
    apply(*Server) error
    String() string
}

type namedOption struct {
    name string
    fn   func(*Server) error
}

func (o namedOption) apply(s *Server) error {
    return o.fn(s)
}

func (o namedOption) String() string {
    return fmt.Sprintf("Option(%s)", o.name)
}

func newNamedOption(name string, fn func(*Server) error) TypedOption {
    return namedOption{name: name, fn: fn}
}

// WithPortTyped is a TypedOption version (for frameworks that need introspection)
func WithPortTyped(port int) TypedOption {
    return newNamedOption(
        fmt.Sprintf("WithPort(%d)", port),
        func(s *Server) error {
            if port < 1 || port > 65535 {
                return fmt.Errorf("invalid port: %d", port)
            }
            s.port = port
            return nil
        },
    )
}

// NewTyped creates a server from TypedOptions, logging each applied option.
func NewTyped(logger interface{ Info(string, ...any) }, opts ...TypedOption) (*Server, error) {
    s := defaults()
    for _, opt := range opts {
        logger.Info("applying server option", "option", opt.String())
        if err := opt.apply(s); err != nil {
            return nil, fmt.Errorf("option %s: %w", opt, err)
        }
    }
    return s, nil
}
```

## Section 7: Distributing Options Across Packages

Large applications often want to separate option definitions across packages while maintaining a single construction point.

### External Option Injection Pattern

```go
// database/options.go
package database

import "github.com/example/myapp/server"

// WithDatabaseMetrics adds a middleware that tracks database query metrics.
// This option lives in the database package but configures the server package.
func WithDatabaseMetrics(db *DB) server.Option {
    return func(s *server.Server) error {
        // Register database health in server's health check registry
        return s.RegisterHealthCheck("database", func() error {
            return db.Ping()
        })
    }
}
```

For this to work, the server must export a method like `RegisterHealthCheck`. The key insight is that options defined in external packages can integrate their specific concerns into the server construction without requiring the server package to know about them.

```go
// main.go combining options from multiple packages
package main

import (
    "github.com/example/myapp/server"
    "github.com/example/myapp/database"
    "github.com/example/myapp/tracing"
)

func main() {
    db, _ := database.New()

    s, err := server.New(
        server.WithPort(8080),
        database.WithDatabaseMetrics(db),    // from database package
        tracing.WithOpenTelemetry("myapp"),  // from tracing package
    )
    // ...
}
```

## Section 8: Backward Compatibility and API Evolution

### Adding New Options Without Breaking Changes

```go
// v1.2.0 additions - all backward compatible
// New options can be added without changing the New() signature

// WithMetricsPath sets the path for Prometheus metrics endpoint.
// Introduced in v1.2.0. Default: "/metrics"
func WithMetricsPath(path string) Option {
    return func(s *Server) error {
        if path == "" || path[0] != '/' {
            return fmt.Errorf("metrics path must start with '/': %q", path)
        }
        s.metricsPath = path
        return nil
    }
}

// WithGracefulShutdownTimeout sets the maximum time to wait for in-flight
// requests during shutdown. Introduced in v1.2.0. Default: 30s
func WithGracefulShutdownTimeout(d time.Duration) Option {
    return func(s *Server) error {
        if d < 0 {
            return fmt.Errorf("graceful shutdown timeout cannot be negative: %v", d)
        }
        s.shutdownTimeout = d
        return nil
    }
}
```

### Deprecating Options

```go
// deprecated.go

// WithSSL is deprecated. Use WithTLSFiles or WithTLS instead.
// This option will be removed in v2.0.
//
// Deprecated: Use WithTLSFiles(certFile, keyFile) instead.
func WithSSL(certFile, keyFile string) Option {
    return func(s *Server) error {
        // Log deprecation warning
        s.logger.Warn("WithSSL is deprecated, use WithTLSFiles instead",
            "replacement", "WithTLSFiles")
        return WithTLSFiles(certFile, keyFile)(s)
    }
}
```

## Conclusion

The functional options pattern provides the ideal balance between simplicity and extensibility for Go library APIs. It handles defaults transparently, validates inputs eagerly, composes naturally, and evolves without breaking changes. The pattern is well-suited for any Go library that needs more than two or three configuration parameters, and its adoption across major Go libraries (grpc-go, go-redis, zap, go-kit) confirms its status as an idiomatic Go best practice. When building your next Go library, start with functional options as the default API shape and only deviate when serialization requirements genuinely demand config structs.
