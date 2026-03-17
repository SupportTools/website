---
title: "Go Functional Options Pattern: API Design for Complex Configuration"
date: 2029-05-28T00:00:00-05:00
draft: false
tags: ["Go", "Functional Options", "API Design", "golang", "Patterns", "Architecture"]
categories: ["Go", "Software Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to the functional options pattern in Go covering the evolution from config structs to options functions, grpc.DialOption style APIs, variadic functions, defaults and overrides, testing with options, and proto-style options."
more_link: "yes"
url: "/go-functional-options-pattern-api-design/"
---

The functional options pattern is one of Go's most elegant API design techniques. It solves a fundamental tension: complex components need many configuration parameters, but Go lacks method overloading and optional parameters. Naive approaches — long constructor parameter lists, configuration structs, builder patterns — each have significant drawbacks. Functional options, popularized by Dave Cheney and Rob Pike, provide extensible, backward-compatible, self-documenting configuration APIs. This guide covers the pattern's full evolution, from basic options to gRPC-style APIs, variadic composition, testing strategies, and proto-style options.

<!--more-->

# Go Functional Options Pattern: API Design for Complex Configuration

## The Problem: Configuration Without Options

Consider a database connection pool. It needs to accept many configuration parameters:

```go
// Approach 1: Long constructor — breaks when you add new params
func NewPool(host string, port int, maxConns int, timeout time.Duration,
             retryDelay time.Duration, maxRetries int, tls bool,
             tlsCert string, tlsKey string, caBundle string,
             readOnly bool, timezone string) *Pool {
    // ...
}

// Callers must pass ALL parameters, even ones they don't care about
pool := NewPool("localhost", 5432, 10, 30*time.Second, 5*time.Second, 3,
                false, "", "", "", false, "UTC")
// Which arg is which? Can't tell without IDE support.

// Approach 2: Configuration struct
type PoolConfig struct {
    Host       string
    Port       int
    MaxConns   int
    Timeout    time.Duration
    RetryDelay time.Duration
    MaxRetries int
    TLS        bool
    TLSCert    string
    TLSKey     string
    CABundle   string
    ReadOnly   bool
    Timezone   string
}

func NewPool(cfg PoolConfig) *Pool { ... }

// Better — named fields
pool := NewPool(PoolConfig{
    Host:    "localhost",
    Port:    5432,
    MaxConns: 10,
})
// But: no defaults! All zero values are silently used.
// Zero-value MaxConns = 0, which might mean "unlimited" or "no connections" — ambiguous.
// Also: PoolConfig is now exported, creating a public type you must maintain forever.
```

Both approaches have the same fundamental problem: adding new fields is a breaking change if you use structs as value types, and zero values are ambiguous.

## Section 1: The Functional Options Pattern

```go
// options.go
package pool

import (
    "crypto/tls"
    "time"
)

// Option is a function that configures a Pool
type Option func(*config)

// config holds all Pool configuration — unexported
type config struct {
    host       string
    port       int
    maxConns   int
    timeout    time.Duration
    retryDelay time.Duration
    maxRetries int
    tlsCfg     *tls.Config
    readOnly   bool
    timezone   string
}

// defaultConfig returns safe defaults
func defaultConfig() *config {
    return &config{
        host:       "localhost",
        port:       5432,
        maxConns:   10,
        timeout:    30 * time.Second,
        retryDelay: 5 * time.Second,
        maxRetries: 3,
        readOnly:   false,
        timezone:   "UTC",
    }
}

// Option constructors — each is a standalone function that returns an Option
func WithHost(host string) Option {
    return func(c *config) {
        c.host = host
    }
}

func WithPort(port int) Option {
    return func(c *config) {
        c.port = port
    }
}

func WithMaxConnections(n int) Option {
    return func(c *config) {
        c.maxConns = n
    }
}

func WithTimeout(d time.Duration) Option {
    return func(c *config) {
        c.timeout = d
    }
}

func WithTLS(certFile, keyFile, caFile string) Option {
    return func(c *config) {
        tlsCfg, err := buildTLSConfig(certFile, keyFile, caFile)
        if err != nil {
            // Option functions can't return errors — common tradeoff
            // See Section 5 for error handling strategies
            panic(fmt.Sprintf("invalid TLS config: %v", err))
        }
        c.tlsCfg = tlsCfg
    }
}

func WithTLSConfig(tlsCfg *tls.Config) Option {
    return func(c *config) {
        c.tlsCfg = tlsCfg
    }
}

func WithReadOnly(readOnly bool) Option {
    return func(c *config) {
        c.readOnly = readOnly
    }
}

func WithRetry(maxRetries int, delay time.Duration) Option {
    return func(c *config) {
        c.maxRetries = maxRetries
        c.retryDelay = delay
    }
}

// Pool is the configured component
type Pool struct {
    cfg *config
}

// NewPool creates a Pool with functional options
func NewPool(opts ...Option) *Pool {
    // Start with sensible defaults
    cfg := defaultConfig()

    // Apply each option in order
    for _, opt := range opts {
        opt(cfg)
    }

    // Validate the final configuration
    if err := cfg.validate(); err != nil {
        panic(fmt.Sprintf("invalid pool configuration: %v", err))
    }

    return &Pool{cfg: cfg}
}

func (c *config) validate() error {
    if c.host == "" {
        return fmt.Errorf("host is required")
    }
    if c.port < 1 || c.port > 65535 {
        return fmt.Errorf("port must be between 1 and 65535, got %d", c.port)
    }
    if c.maxConns < 1 {
        return fmt.Errorf("maxConns must be at least 1, got %d", c.maxConns)
    }
    return nil
}
```

### Caller Experience

```go
// Simple usage — just override what you need
pool := pool.NewPool(
    pool.WithHost("db.production.example.com"),
    pool.WithPort(5432),
)

// Complex usage — all options explicitly named
pool := pool.NewPool(
    pool.WithHost("db.production.example.com"),
    pool.WithPort(5432),
    pool.WithMaxConnections(50),
    pool.WithTimeout(10 * time.Second),
    pool.WithTLS("/etc/certs/client.crt", "/etc/certs/client.key", "/etc/certs/ca.crt"),
    pool.WithRetry(5, 2*time.Second),
)

// Zero configuration — all defaults
pool := pool.NewPool()
```

## Section 2: gRPC-Style Options (grpc.DialOption)

The gRPC library popularized a specific variant of functional options where the option type is an interface, not a function. This allows options to be typed and inspected:

```go
// grpc-style options
package client

// DialOption is an interface for dial-time configuration
type DialOption interface {
    apply(*dialOptions)
}

// dialOptions holds the actual configuration
type dialOptions struct {
    timeout     time.Duration
    maxRetries  int
    tls         *tls.Config
    interceptors []grpc.UnaryClientInterceptor
    userAgent   string
    balancer    string
}

// funcDialOption wraps a function to implement DialOption
type funcDialOption struct {
    f func(*dialOptions)
}

func (fdo *funcDialOption) apply(do *dialOptions) {
    fdo.f(do)
}

func newFuncDialOption(f func(*dialOptions)) *funcDialOption {
    return &funcDialOption{f: f}
}

// Public option constructors
func WithTimeout(d time.Duration) DialOption {
    return newFuncDialOption(func(do *dialOptions) {
        do.timeout = d
    })
}

func WithMaxRetries(n int) DialOption {
    return newFuncDialOption(func(do *dialOptions) {
        do.maxRetries = n
    })
}

func WithTransportSecurity(tlsCfg *tls.Config) DialOption {
    return newFuncDialOption(func(do *dialOptions) {
        do.tls = tlsCfg
    })
}

func WithUnaryInterceptor(interceptor grpc.UnaryClientInterceptor) DialOption {
    return newFuncDialOption(func(do *dialOptions) {
        do.interceptors = append(do.interceptors, interceptor)
    })
}

func WithUserAgent(ua string) DialOption {
    return newFuncDialOption(func(do *dialOptions) {
        do.userAgent = ua
    })
}

// Dial creates a connection with the specified options
func Dial(target string, opts ...DialOption) (*Conn, error) {
    do := &dialOptions{
        timeout:    30 * time.Second,
        maxRetries: 3,
        balancer:   "round_robin",
    }

    for _, opt := range opts {
        opt.apply(do)
    }

    return newConn(target, do)
}
```

### Why Use Interface-Based Options?

The interface approach allows options to be stored, inspected, and compared:

```go
// You can store and reuse option sets
var ProductionDialOpts = []DialOption{
    WithTimeout(5 * time.Second),
    WithMaxRetries(3),
    WithUserAgent("my-service/v1.0"),
}

// Compose with additional options
conn, err := Dial("api.example.com:443",
    append(ProductionDialOpts,
        WithTransportSecurity(tlsCfg),
    )...,
)

// Type-assert to inspect options at runtime
for _, opt := range opts {
    if to, ok := opt.(*timeoutOption); ok {
        log.Printf("Timeout configured: %v", to.d)
    }
}
```

## Section 3: Variadic Option Composition

Options can be composed to create higher-level configurations:

```go
// composition.go
package client

// OptionGroup combines multiple options into one
type OptionGroup []Option

func (og OptionGroup) apply(c *config) {
    for _, opt := range og {
        opt(c)
    }
}

// Helper to create named option sets
func Options(opts ...Option) OptionGroup {
    return OptionGroup(opts)
}

// Predefined option groups for common scenarios
var DevelopmentOptions = Options(
    WithHost("localhost"),
    WithPort(5432),
    WithMaxConnections(5),
    WithTimeout(60 * time.Second),  // More lenient in dev
    WithRetry(1, time.Second),
)

var ProductionOptions = Options(
    WithMaxConnections(100),
    WithTimeout(10 * time.Second),
    WithRetry(3, 5*time.Second),
    // TLS configured separately per deployment
)

var HighAvailabilityOptions = Options(
    ProductionOptions,              // Include production options
    WithMaxConnections(200),        // Override with higher limit
    WithRetry(5, 2*time.Second),   // More retries
)

// Usage: compose from base options
pool := NewPool(
    ProductionOptions,
    WithHost("db.prod.example.com"),
    WithTLS(certFile, keyFile, caFile),
)
```

### Option Precedence and Override

Options are applied in order — later options override earlier ones:

```go
// This is the most important property: LAST option wins
pool := NewPool(
    WithTimeout(30 * time.Second),   // First: set timeout to 30s
    WithTimeout(5 * time.Second),    // Second: OVERRIDES to 5s
)
// Final timeout: 5 seconds

// This enables environment-specific overrides
pool := NewPool(
    DevelopmentOptions,  // Base config
    envSpecificOptions,  // Override for this environment
)
```

## Section 4: Error Handling with Options

A common critique of functional options is that option functions cannot return errors. Several strategies address this:

### Strategy 1: Lazy Validation (Validate in New/Build)

```go
// option-errors-lazy.go
package client

type Option func(*config) error

func WithTLS(certFile, keyFile, caFile string) Option {
    return func(c *config) error {
        tlsCfg, err := buildTLSConfig(certFile, keyFile, caFile)
        if err != nil {
            return fmt.Errorf("invalid TLS config: %w", err)
        }
        c.tlsCfg = tlsCfg
        return nil
    }
}

func NewPool(opts ...Option) (*Pool, error) {
    cfg := defaultConfig()

    for _, opt := range opts {
        if err := opt(cfg); err != nil {
            return nil, fmt.Errorf("applying option: %w", err)
        }
    }

    if err := cfg.validate(); err != nil {
        return nil, fmt.Errorf("invalid configuration: %w", err)
    }

    return &Pool{cfg: cfg}, nil
}
```

**Caller**:
```go
pool, err := NewPool(
    WithHost("localhost"),
    WithTLS("/bad/path/cert.crt", "/bad/path/key.key", ""),
)
if err != nil {
    log.Fatalf("creating pool: %v", err)
}
```

### Strategy 2: Error-Collecting Options

```go
// Accumulate errors rather than stopping at the first
type Builder struct {
    cfg    *config
    errors []error
}

func (b *Builder) With(opts ...Option) *Builder {
    for _, opt := range opts {
        if err := opt(b.cfg); err != nil {
            b.errors = append(b.errors, err)
        }
    }
    return b
}

func (b *Builder) Build() (*Pool, error) {
    if len(b.errors) > 0 {
        return nil, fmt.Errorf("configuration errors: %v", errors.Join(b.errors...))
    }
    return &Pool{cfg: b.cfg}, nil
}

// Usage:
pool, err := NewBuilder().
    With(
        WithHost("localhost"),
        WithTLS("/cert.crt", "/key.key", "/ca.crt"),
        WithMaxConnections(50),
    ).
    Build()
```

### Strategy 3: Pre-Validation Option Factories

```go
// Validate at option creation time, not application time
func WithTLS(certFile, keyFile, caFile string) (Option, error) {
    // Validate now
    tlsCfg, err := buildTLSConfig(certFile, keyFile, caFile)
    if err != nil {
        return nil, fmt.Errorf("invalid TLS config: %w", err)
    }

    // Return option that just sets the pre-validated config
    return func(c *config) {
        c.tlsCfg = tlsCfg
    }, nil
}

// Usage:
tlsOpt, err := WithTLS(certFile, keyFile, caFile)
if err != nil {
    log.Fatal(err)
}
pool := NewPool(
    WithHost("localhost"),
    tlsOpt,
)
```

## Section 5: Testing with Options

Functional options shine for testing because you can inject test-specific behavior:

```go
// option-testing.go
package pool_test

import (
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

// Test helpers — options that inject test-specific behavior
func withTestDialer(dialer Dialer) Option {
    return func(c *config) {
        c.dialer = dialer
    }
}

func withFixedClock(t time.Time) Option {
    return func(c *config) {
        c.clock = fixedClock{t}
    }
}

func withNopLogger() Option {
    return func(c *config) {
        c.logger = noopLogger{}
    }
}

// FakeDialer records connections for assertion
type FakeDialer struct {
    connections []string
    err         error
}

func (d *FakeDialer) Dial(address string) (Conn, error) {
    d.connections = append(d.connections, address)
    if d.err != nil {
        return nil, d.err
    }
    return &FakeConn{}, nil
}

func TestPoolConnectsToConfiguredHost(t *testing.T) {
    dialer := &FakeDialer{}

    pool := NewPool(
        WithHost("test-db.example.com"),
        WithPort(5432),
        withTestDialer(dialer),
        withNopLogger(),
    )

    conn, err := pool.Acquire(context.Background())
    require.NoError(t, err)
    defer pool.Release(conn)

    assert.Equal(t, []string{"test-db.example.com:5432"}, dialer.connections)
}

func TestPoolRetriesOnConnectionFailure(t *testing.T) {
    callCount := 0
    dialer := &FakeDialer{
        err: errors.New("connection refused"),
    }

    pool := NewPool(
        withTestDialer(dialer),
        WithRetry(3, 10*time.Millisecond),  // Fast retries for test
        withNopLogger(),
    )

    _, err := pool.Acquire(context.Background())
    assert.Error(t, err)
    assert.Equal(t, 3, callCount, "Should have retried 3 times")
}

func TestPoolDefaultConfiguration(t *testing.T) {
    // Test that zero-option usage gives sane defaults
    pool := NewPool()

    assert.Equal(t, "localhost", pool.cfg.host)
    assert.Equal(t, 5432, pool.cfg.port)
    assert.Equal(t, 10, pool.cfg.maxConns)
    assert.Equal(t, 30*time.Second, pool.cfg.timeout)
}

func TestPoolOptionsAreAppliedInOrder(t *testing.T) {
    pool := NewPool(
        WithTimeout(60 * time.Second),
        WithTimeout(5 * time.Second),   // Should win
    )
    assert.Equal(t, 5*time.Second, pool.cfg.timeout)
}
```

### Snapshot Testing for Option Combinations

```go
func TestPoolOptionCombinations(t *testing.T) {
    cases := []struct {
        name     string
        opts     []Option
        wantHost string
        wantPort int
        wantTLS  bool
    }{
        {
            name:     "defaults",
            opts:     nil,
            wantHost: "localhost",
            wantPort: 5432,
            wantTLS:  false,
        },
        {
            name:     "custom host and port",
            opts:     []Option{WithHost("db.example.com"), WithPort(3306)},
            wantHost: "db.example.com",
            wantPort: 3306,
            wantTLS:  false,
        },
        {
            name:     "production options",
            opts:     []Option{ProductionOptions, WithHost("prod-db.example.com")},
            wantHost: "prod-db.example.com",
            wantPort: 5432,
            wantTLS:  false,
        },
    }

    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            pool := NewPool(tc.opts...)
            assert.Equal(t, tc.wantHost, pool.cfg.host)
            assert.Equal(t, tc.wantPort, pool.cfg.port)
            assert.Equal(t, tc.wantTLS, pool.cfg.tlsCfg != nil)
        })
    }
}
```

## Section 6: Proto-Style Options

Protocol Buffers popularized a specific form of options for message construction. This is useful when you need to pass options to deeply nested structures or across language boundaries:

```go
// proto-style options using builder pattern with method chaining
package http

// RequestOption configures an HTTP request
type RequestOption struct {
    applyFn func(*requestOptions)
}

type requestOptions struct {
    headers     map[string]string
    timeout     time.Duration
    retryPolicy *RetryPolicy
    auth        AuthProvider
    body        io.Reader
    contentType string
}

// Option constructors using a named type for clarity
func Header(key, value string) RequestOption {
    return RequestOption{func(o *requestOptions) {
        if o.headers == nil {
            o.headers = make(map[string]string)
        }
        o.headers[key] = value
    }}
}

func Timeout(d time.Duration) RequestOption {
    return RequestOption{func(o *requestOptions) {
        o.timeout = d
    }}
}

func WithBody(r io.Reader, contentType string) RequestOption {
    return RequestOption{func(o *requestOptions) {
        o.body = r
        o.contentType = contentType
    }}
}

func WithJSON(v interface{}) RequestOption {
    return RequestOption{func(o *requestOptions) {
        data, _ := json.Marshal(v)
        o.body = bytes.NewReader(data)
        o.contentType = "application/json"
    }}
}

func WithBearerToken(token string) RequestOption {
    return RequestOption{func(o *requestOptions) {
        o.auth = &bearerAuth{token: token}
    }}
}

func WithRetry(maxAttempts int, backoff BackoffPolicy) RequestOption {
    return RequestOption{func(o *requestOptions) {
        o.retryPolicy = &RetryPolicy{
            MaxAttempts: maxAttempts,
            Backoff:     backoff,
        }
    }}
}

// Client.Do accepts proto-style options
func (c *Client) Do(ctx context.Context, method, url string, opts ...RequestOption) (*http.Response, error) {
    o := &requestOptions{
        timeout: c.defaultTimeout,
    }

    for _, opt := range opts {
        opt.applyFn(o)
    }

    req, err := http.NewRequestWithContext(ctx, method, url, o.body)
    if err != nil {
        return nil, err
    }

    if o.contentType != "" {
        req.Header.Set("Content-Type", o.contentType)
    }
    for k, v := range o.headers {
        req.Header.Set(k, v)
    }
    if o.auth != nil {
        o.auth.Apply(req)
    }

    if o.retryPolicy != nil {
        return c.doWithRetry(req, o.retryPolicy)
    }
    return c.httpClient.Do(req)
}

// Usage is extremely clean and readable:
resp, err := client.Do(ctx, "POST", "https://api.example.com/users",
    WithJSON(user),
    WithBearerToken(token),
    Timeout(10*time.Second),
    WithRetry(3, ExponentialBackoff(100*time.Millisecond)),
    Header("X-Request-ID", requestID),
)
```

## Section 7: Real-World Pattern Library

### HTTP Server Options

```go
// server/options.go
package server

type ServerOption func(*Server)

func WithAddr(addr string) ServerOption {
    return func(s *Server) {
        s.addr = addr
    }
}

func WithTLSFromFiles(certFile, keyFile string) ServerOption {
    return func(s *Server) {
        cert, err := tls.LoadX509KeyPair(certFile, keyFile)
        if err != nil {
            panic(err)
        }
        s.tlsCfg = &tls.Config{Certificates: []tls.Certificate{cert}}
    }
}

func WithReadTimeout(d time.Duration) ServerOption {
    return func(s *Server) {
        s.readTimeout = d
    }
}

func WithWriteTimeout(d time.Duration) ServerOption {
    return func(s *Server) {
        s.writeTimeout = d
    }
}

func WithShutdownTimeout(d time.Duration) ServerOption {
    return func(s *Server) {
        s.shutdownTimeout = d
    }
}

func WithMiddleware(mw ...Middleware) ServerOption {
    return func(s *Server) {
        s.middleware = append(s.middleware, mw...)
    }
}

func WithHealthCheck(path string, checker HealthChecker) ServerOption {
    return func(s *Server) {
        s.healthPath = path
        s.healthChecker = checker
    }
}

func NewServer(opts ...ServerOption) *Server {
    s := &Server{
        addr:            ":8080",
        readTimeout:     15 * time.Second,
        writeTimeout:    15 * time.Second,
        shutdownTimeout: 30 * time.Second,
    }
    for _, opt := range opts {
        opt(s)
    }
    return s
}
```

### Logger Options

```go
// logger/options.go — demonstrates type-safe options
package logger

type Level int

const (
    LevelDebug Level = iota
    LevelInfo
    LevelWarn
    LevelError
)

type LoggerOption func(*Logger)

func WithLevel(level Level) LoggerOption {
    return func(l *Logger) {
        l.level = level
    }
}

func WithOutput(w io.Writer) LoggerOption {
    return func(l *Logger) {
        l.output = w
    }
}

func WithFormat(format string) LoggerOption {
    return func(l *Logger) {
        l.format = format
    }
}

func WithFields(fields map[string]interface{}) LoggerOption {
    return func(l *Logger) {
        for k, v := range fields {
            l.fields[k] = v
        }
    }
}

// Environment-specific presets
func DevelopmentLogger() LoggerOption {
    return func(l *Logger) {
        l.level = LevelDebug
        l.format = "text"
        l.output = os.Stdout
    }
}

func ProductionLogger() LoggerOption {
    return func(l *Logger) {
        l.level = LevelInfo
        l.format = "json"
        l.output = os.Stdout
    }
}

func NewLogger(opts ...LoggerOption) *Logger {
    l := &Logger{
        level:  LevelInfo,
        format: "json",
        output: os.Stdout,
        fields: make(map[string]interface{}),
    }
    for _, opt := range opts {
        opt(l)
    }
    return l
}
```

## Section 8: Anti-Patterns and Pitfalls

### Anti-Pattern 1: Exposing config Struct

```go
// BAD: Exporting config defeats the purpose
type Config struct {
    Host string
    Port int
}

// GOOD: Keep config unexported
type config struct {
    host string
    port int
}
```

### Anti-Pattern 2: Too Many Options

```go
// BAD: Option explosion — 50+ options is a design smell
func WithConnectionPoolMaxConnectionLifetimeAfterClosingTCP(d time.Duration) Option { ... }

// GOOD: Group related options
type PoolConfig struct {
    MaxConns     int
    MinConns     int
    MaxLifetime  time.Duration
    MaxIdleTime  time.Duration
}

func WithConnectionPool(cfg PoolConfig) Option {
    return func(c *config) {
        c.pool = cfg
    }
}
```

### Anti-Pattern 3: Mutable Options After Construction

```go
// BAD: Allowing post-construction mutation
type Pool struct {
    cfg config
}

func (p *Pool) SetMaxConns(n int) {  // Dangerous — concurrent access
    p.cfg.maxConns = n
}

// GOOD: Immutable after construction
type Pool struct {
    cfg *config  // Pointer, but never mutated after New()
}
// No setters — create a new Pool if you need different config
```

### Anti-Pattern 4: Panic in Option Functions

```go
// BAD: Panic makes option composition unpredictable
func WithTLS(certFile, keyFile string) Option {
    return func(c *config) {
        cert, err := tls.LoadX509KeyPair(certFile, keyFile)
        if err != nil {
            panic(err)  // Unexpected for callers
        }
        c.tls = &cert
    }
}

// GOOD: Return error from New, or use error-collecting pattern
func WithTLS(certFile, keyFile string) Option {
    return func(c *config) error {
        cert, err := tls.LoadX509KeyPair(certFile, keyFile)
        if err != nil {
            return fmt.Errorf("loading TLS keypair: %w", err)
        }
        c.tls = &cert
        return nil
    }
}
```

## Conclusion

The functional options pattern is a mature, production-proven approach to API design in Go. Its key benefits are backward compatibility (new options can be added without breaking existing callers), self-documentation (each option is named and described), sensible defaults (zero-options usage works), and testability (test-specific options inject fakes without changing production code).

Choose between the simple `func(*config)` style and the interface-based style based on whether you need to inspect or compare options at runtime. Use the error-returning variant (`func(*config) error`) when options involve I/O or validation. Compose options into named presets for different environments. And always keep your `config` struct unexported — the options API is your public contract, not the struct fields.

The pattern scales from simple two-option types to the complexity of gRPC's dozens of dial options, proving its staying power as a fundamental Go API design technique.
