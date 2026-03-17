---
title: "Go Functional Options Pattern: Option Structs vs Functions, Variadic Constructors, Interface vs Concrete Types, and Testing"
date: 2032-02-17T00:00:00-05:00
draft: false
tags: ["Go", "Design Patterns", "API Design", "Testing", "Software Engineering"]
categories:
- Go
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to the Go functional options pattern covering option struct vs function-based approaches, variadic constructors, when to use interfaces vs concrete types, and testing strategies for option-heavy APIs."
more_link: "yes"
url: "/go-functional-options-pattern-enterprise-api-design-guide/"
---

The functional options pattern is idiomatic Go for building configurable, extensible APIs that remain backward-compatible over time. This guide examines every variant: the Rob Pike / Dave Cheney style using option functions, the option struct approach, hybrid patterns, and the ergonomic tradeoffs of returning interfaces versus concrete types. We also cover how to write clean, deterministic tests for code that uses functional options.

<!--more-->

# Go Functional Options Pattern: Enterprise API Design

## Section 1: The Problem Functional Options Solve

Go lacks default parameter values and method overloading. The naive solution is a config struct passed directly to a constructor:

```go
// Naive approach — brittle, breaks callers on every field addition
type ServerConfig struct {
    Host            string
    Port            int
    Timeout         time.Duration
    MaxConnections  int
    TLSEnabled      bool
    TLSCertFile     string
    TLSKeyFile      string
    Logger          *slog.Logger
}

func NewServer(cfg ServerConfig) *Server { ... }

// Caller must set every field — zero values may be invalid
s := NewServer(ServerConfig{
    Host:    "0.0.0.0",
    Port:    8080,
    Timeout: 30 * time.Second,
})
```

Problems:
1. Adding a new required field breaks all callers
2. Zero values are ambiguous (is `Port: 0` intentional or a forgotten field?)
3. Validation is separated from the option itself
4. Callers are forced to import and understand the entire config struct

The functional options pattern solves all three.

## Section 2: The Classic Functional Option Pattern

### Basic Implementation

```go
// server/server.go
package server

import (
    "crypto/tls"
    "log/slog"
    "net"
    "time"
)

// Server is the type being configured.
type Server struct {
    host           string
    port           int
    timeout        time.Duration
    maxConnections int
    tlsConfig      *tls.Config
    logger         *slog.Logger
    listener       net.Listener
}

// Option is a function that configures a Server.
// The key insight: Option is a first-class type, enabling composition.
type Option func(*Server) error

// WithHost sets the bind address.
func WithHost(host string) Option {
    return func(s *Server) error {
        if host == "" {
            return fmt.Errorf("host cannot be empty")
        }
        s.host = host
        return nil
    }
}

// WithPort sets the TCP port.
func WithPort(port int) Option {
    return func(s *Server) error {
        if port < 1 || port > 65535 {
            return fmt.Errorf("port %d is out of range [1, 65535]", port)
        }
        s.port = port
        return nil
    }
}

// WithTimeout sets the per-request timeout.
func WithTimeout(d time.Duration) Option {
    return func(s *Server) error {
        if d <= 0 {
            return fmt.Errorf("timeout must be positive, got %v", d)
        }
        s.timeout = d
        return nil
    }
}

// WithMaxConnections sets the connection pool limit.
func WithMaxConnections(n int) Option {
    return func(s *Server) error {
        if n < 1 {
            return fmt.Errorf("maxConnections must be at least 1, got %d", n)
        }
        s.maxConnections = n
        return nil
    }
}

// WithTLS configures TLS using a cert/key file pair.
func WithTLS(certFile, keyFile string) Option {
    return func(s *Server) error {
        cert, err := tls.LoadX509KeyPair(certFile, keyFile)
        if err != nil {
            return fmt.Errorf("load TLS keypair: %w", err)
        }
        s.tlsConfig = &tls.Config{
            Certificates: []tls.Certificate{cert},
            MinVersion:   tls.VersionTLS13,
        }
        return nil
    }
}

// WithTLSConfig sets a pre-built TLS config.
func WithTLSConfig(cfg *tls.Config) Option {
    return func(s *Server) error {
        if cfg == nil {
            return fmt.Errorf("tls config must not be nil")
        }
        s.tlsConfig = cfg
        return nil
    }
}

// WithLogger sets the structured logger.
func WithLogger(logger *slog.Logger) Option {
    return func(s *Server) error {
        if logger == nil {
            return fmt.Errorf("logger must not be nil")
        }
        s.logger = logger
        return nil
    }
}

// WithListener allows injecting a pre-existing net.Listener (useful in tests).
func WithListener(l net.Listener) Option {
    return func(s *Server) error {
        if l == nil {
            return fmt.Errorf("listener must not be nil")
        }
        s.listener = l
        return nil
    }
}

// defaults sets the zero values to sensible defaults.
func defaults() *Server {
    return &Server{
        host:           "0.0.0.0",
        port:           8080,
        timeout:        30 * time.Second,
        maxConnections: 1000,
        logger:         slog.Default(),
    }
}

// New constructs a Server, applying options in order.
// Validation errors are collected and returned as a single error.
func New(opts ...Option) (*Server, error) {
    s := defaults()
    for _, opt := range opts {
        if err := opt(s); err != nil {
            return nil, fmt.Errorf("server option error: %w", err)
        }
    }
    return s, nil
}
```

### Caller Ergonomics

```go
// Minimal usage — defaults handle the rest
s, err := server.New()

// Selective overrides
s, err := server.New(
    server.WithPort(9090),
    server.WithTimeout(60 * time.Second),
)

// Full configuration
s, err := server.New(
    server.WithHost("127.0.0.1"),
    server.WithPort(8443),
    server.WithTLS("/etc/certs/server.crt", "/etc/certs/server.key"),
    server.WithMaxConnections(500),
    server.WithLogger(logger),
)

// Adding a new option never breaks existing callers.
```

## Section 3: The Option Struct Approach

Some teams prefer a struct-based approach where options are fields rather than functions. This trades the closure-validation pattern for a flatter, more serializable structure.

```go
// config/options.go
package server

import (
    "crypto/tls"
    "log/slog"
    "time"
)

// Options holds all configuration for a Server.
// Unlike the function approach, this is serializable and inspectable.
type Options struct {
    Host           string
    Port           int
    Timeout        time.Duration
    MaxConnections int
    TLSConfig      *tls.Config
    Logger         *slog.Logger
}

// DefaultOptions returns options with sensible defaults.
func DefaultOptions() Options {
    return Options{
        Host:           "0.0.0.0",
        Port:           8080,
        Timeout:        30 * time.Second,
        MaxConnections: 1000,
        Logger:         slog.Default(),
    }
}

// Validate checks all options for consistency.
func (o Options) Validate() error {
    var errs []string
    if o.Host == "" {
        errs = append(errs, "host cannot be empty")
    }
    if o.Port < 1 || o.Port > 65535 {
        errs = append(errs, fmt.Sprintf("port %d out of range", o.Port))
    }
    if o.Timeout <= 0 {
        errs = append(errs, "timeout must be positive")
    }
    if o.MaxConnections < 1 {
        errs = append(errs, "maxConnections must be at least 1")
    }
    if len(errs) > 0 {
        return fmt.Errorf("invalid options: %s", strings.Join(errs, "; "))
    }
    return nil
}

// Option is a function that mutates Options.
type Option func(*Options)

// Apply applies options to a copy of DefaultOptions and validates.
func Apply(opts ...Option) (Options, error) {
    o := DefaultOptions()
    for _, opt := range opts {
        opt(&o)
    }
    return o, o.Validate()
}

// ── Builder functions ──────────────────────────────────────────────

func WithHost(host string) Option {
    return func(o *Options) { o.Host = host }
}

func WithPort(port int) Option {
    return func(o *Options) { o.Port = port }
}

func WithTimeout(d time.Duration) Option {
    return func(o *Options) { o.Timeout = d }
}

func WithTLSConfig(cfg *tls.Config) Option {
    return func(o *Options) { o.TLSConfig = cfg }
}
```

### Struct vs Function Approach: When to Use Each

| Criteria | Function Options | Struct Options |
|---|---|---|
| Validation at apply time | Yes (per-option) | Yes (centralized Validate()) |
| Serializable | No | Yes |
| Inspectable in tests | No (closed over values) | Yes (read struct fields) |
| Composable from config file | Harder | Easy |
| Supports conditional option logic | Natural | Requires if-statements |
| Discoverable via godoc | Both are equal | Both are equal |

**Use function options** when: each option has its own validation logic, options may have side effects (e.g., loading a file), or you want to prevent callers from modifying the config struct after construction.

**Use struct options** when: you need to serialize/deserialize config (YAML, JSON), you want to inspect the final config in tests, or you're building an SDK that must be consumed by generated code.

## Section 4: Hybrid Pattern — Struct Options with Functional Builder

Many production libraries combine both approaches:

```go
// hybrid/client.go
package client

// ClientOptions holds all configuration.
type ClientOptions struct {
    BaseURL        string
    Timeout        time.Duration
    MaxRetries     int
    RetryBackoff   time.Duration
    Headers        map[string]string
    RoundTripper   http.RoundTripper
    Logger         *slog.Logger
}

// Option mutates ClientOptions.
type Option func(*ClientOptions)

// Client wraps http.Client with retry and observability.
type Client struct {
    opts   ClientOptions
    http   *http.Client
    logger *slog.Logger
}

func defaults() ClientOptions {
    return ClientOptions{
        Timeout:      30 * time.Second,
        MaxRetries:   3,
        RetryBackoff: 500 * time.Millisecond,
        Headers:      make(map[string]string),
        RoundTripper: http.DefaultTransport,
        Logger:       slog.Default(),
    }
}

// New creates a Client with the given options applied over defaults.
func New(baseURL string, opts ...Option) (*Client, error) {
    if baseURL == "" {
        return nil, fmt.Errorf("baseURL is required")
    }

    o := defaults()
    o.BaseURL = baseURL
    for _, opt := range opts {
        opt(&o)
    }

    if err := validate(o); err != nil {
        return nil, err
    }

    return &Client{
        opts: o,
        http: &http.Client{
            Timeout:   o.Timeout,
            Transport: o.RoundTripper,
        },
        logger: o.Logger,
    }, nil
}

func validate(o ClientOptions) error {
    if o.Timeout <= 0 {
        return fmt.Errorf("timeout must be positive")
    }
    if o.MaxRetries < 0 {
        return fmt.Errorf("maxRetries must be non-negative")
    }
    return nil
}

// ── Option constructors ──────────────────────────────────────────

func WithTimeout(d time.Duration) Option {
    return func(o *ClientOptions) { o.Timeout = d }
}

func WithMaxRetries(n int) Option {
    return func(o *ClientOptions) { o.MaxRetries = n }
}

func WithRetryBackoff(d time.Duration) Option {
    return func(o *ClientOptions) { o.RetryBackoff = d }
}

func WithHeader(key, value string) Option {
    return func(o *ClientOptions) { o.Headers[key] = value }
}

func WithBearerToken(token string) Option {
    return func(o *ClientOptions) {
        o.Headers["Authorization"] = "Bearer " + token
    }
}

func WithRoundTripper(rt http.RoundTripper) Option {
    return func(o *ClientOptions) { o.RoundTripper = rt }
}

func WithLogger(logger *slog.Logger) Option {
    return func(o *ClientOptions) { o.Logger = logger }
}
```

## Section 5: Interface vs Concrete Types in Constructors

A recurring debate: should `New(...)` return `*Server` or `ServerInterface`?

### Returning a Concrete Type (Recommended for Most Cases)

```go
// Concrete return type: simple, testable, no interface pollution
func New(opts ...Option) (*Server, error) {
    ...
}

// Callers can always assign to an interface if needed
var handler http.Handler = mustNew()
```

Returning a concrete type:
- Makes the API surface obvious — callers see all exported methods
- Avoids the "interface with one implementation" anti-pattern
- Allows callers to embed the type, add methods, or wrap it easily
- `go doc` and `gopls` show all methods without interface indirection

### Returning an Interface (When It Makes Sense)

```go
// Use an interface return when:
// 1. Multiple implementations are expected
// 2. The concrete type leaks implementation details callers shouldn't rely on
// 3. You want to force callers to depend only on behavior

type Store interface {
    Get(ctx context.Context, key string) ([]byte, error)
    Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
    Delete(ctx context.Context, key string) error
}

// Factory returns the interface — caller doesn't know or care about the backend
func NewStore(backendType string, opts ...Option) (Store, error) {
    switch backendType {
    case "redis":
        return newRedisStore(opts...)
    case "memcached":
        return newMemcachedStore(opts...)
    case "inmemory":
        return newInMemoryStore(opts...)
    default:
        return nil, fmt.Errorf("unknown backend: %q", backendType)
    }
}
```

### The Constructor Interface Pattern

When the concrete type is complex and callers need to mock it, define the interface in the *consumer's* package, not the provider's:

```go
// service/service.go — consumer defines the interface it needs
package service

// CacheClient is the subset of cache operations this service uses.
// Defined here, not in the cache package.
type CacheClient interface {
    Get(ctx context.Context, key string) ([]byte, error)
    Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
}

type Service struct {
    cache  CacheClient
    logger *slog.Logger
}

func New(cache CacheClient, opts ...Option) (*Service, error) {
    if cache == nil {
        return nil, fmt.Errorf("cache is required")
    }
    s := &Service{
        cache:  cache,
        logger: slog.Default(),
    }
    for _, opt := range opts {
        opt(s)
    }
    return s, nil
}
```

## Section 6: Option Composition and Groups

```go
// Options can be composed into higher-level presets
func ProductionOptions() []Option {
    return []Option{
        WithTimeout(30 * time.Second),
        WithMaxRetries(3),
        WithRetryBackoff(1 * time.Second),
        WithLogger(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
            Level: slog.LevelInfo,
        }))),
    }
}

func DevelopmentOptions() []Option {
    return []Option{
        WithTimeout(5 * time.Second),
        WithMaxRetries(1),
        WithLogger(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
            Level: slog.LevelDebug,
        }))),
    }
}

// Usage: apply a preset and override specific values
c, err := client.New(
    "https://api.example.com",
    append(
        client.ProductionOptions(),
        // Override the timeout from the preset
        client.WithTimeout(60 * time.Second),
    )...,
)
```

### Option Chaining for Clarity

```go
// Chain type — allows method chaining instead of variadic functions
type Builder struct {
    opts []Option
}

func NewBuilder() *Builder {
    return &Builder{}
}

func (b *Builder) WithHost(host string) *Builder {
    b.opts = append(b.opts, WithHost(host))
    return b
}

func (b *Builder) WithPort(port int) *Builder {
    b.opts = append(b.opts, WithPort(port))
    return b
}

func (b *Builder) WithTimeout(d time.Duration) *Builder {
    b.opts = append(b.opts, WithTimeout(d))
    return b
}

func (b *Builder) Build() (*Server, error) {
    return New(b.opts...)
}

// Usage: fluent API style
s, err := server.NewBuilder().
    WithHost("127.0.0.1").
    WithPort(9090).
    WithTimeout(45 * time.Second).
    Build()
```

## Section 7: Testing Functional Options

Testing options-heavy code is straightforward when the options are pure functions.

### Unit Testing Individual Options

```go
// server/options_test.go
package server_test

import (
    "testing"
    "time"

    "example.com/myapp/server"
)

func TestWithPort(t *testing.T) {
    tests := []struct {
        name    string
        port    int
        wantErr bool
    }{
        {"valid port", 8080, false},
        {"valid low port", 1, false},
        {"valid high port", 65535, false},
        {"zero port", 0, true},
        {"negative port", -1, true},
        {"overflow port", 65536, true},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            _, err := server.New(server.WithPort(tt.port))
            if (err != nil) != tt.wantErr {
                t.Errorf("WithPort(%d): wantErr=%v, got err=%v", tt.port, tt.wantErr, err)
            }
        })
    }
}

func TestWithTimeout(t *testing.T) {
    tests := []struct {
        name    string
        timeout time.Duration
        wantErr bool
    }{
        {"positive duration", 30 * time.Second, false},
        {"zero duration", 0, true},
        {"negative duration", -1 * time.Second, true},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            _, err := server.New(server.WithTimeout(tt.timeout))
            if (err != nil) != tt.wantErr {
                t.Errorf("WithTimeout(%v): wantErr=%v, got err=%v", tt.timeout, tt.wantErr, err)
            }
        })
    }
}
```

### Testing Option Application Order

Options are applied in order. Test that later options override earlier ones correctly:

```go
func TestOptionOrdering(t *testing.T) {
    // Apply WithPort twice — last one wins
    s, err := server.New(
        server.WithPort(8080),
        server.WithPort(9090),   // should override
    )
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }

    // Use an exported method or test helper to inspect state
    if s.Port() != 9090 {
        t.Errorf("expected port 9090 after override, got %d", s.Port())
    }
}
```

### Exposing Test Accessors Without Leaking Implementation

```go
// server/server.go — exported accessors for testing
// Guard with a build tag or use a separate _test.go in the same package

// Option to expose server's configured port (for testing)
func (s *Server) Port() int { return s.port }
func (s *Server) Host() string { return s.host }
func (s *Server) Timeout() time.Duration { return s.timeout }
```

Or use an unexported getter accessed from the `package_test` package:

```go
// server/export_test.go — only compiled during tests
package server

// Accessor exports for white-box testing
func (s *Server) TestPort() int             { return s.port }
func (s *Server) TestTimeout() time.Duration { return s.timeout }
```

### Integration Test with Mock Dependencies

```go
// service/service_test.go
package service_test

import (
    "context"
    "testing"
    "time"

    "example.com/myapp/service"
)

// mockCache implements service.CacheClient
type mockCache struct {
    data map[string][]byte
    setCalledWith []struct {
        key   string
        value []byte
        ttl   time.Duration
    }
}

func (m *mockCache) Get(_ context.Context, key string) ([]byte, error) {
    v, ok := m.data[key]
    if !ok {
        return nil, nil
    }
    return v, nil
}

func (m *mockCache) Set(_ context.Context, key string, value []byte, ttl time.Duration) error {
    m.data[key] = value
    m.setCalledWith = append(m.setCalledWith, struct {
        key   string
        value []byte
        ttl   time.Duration
    }{key, value, ttl})
    return nil
}

func TestServiceGet(t *testing.T) {
    cache := &mockCache{
        data: map[string][]byte{
            "user:42": []byte(`{"id":42,"name":"Alice"}`),
        },
    }

    // Inject mock via functional option
    svc, err := service.New(
        cache,
        service.WithLogger(discardLogger()),
        service.WithCacheTTL(5*time.Minute),
    )
    if err != nil {
        t.Fatalf("New: %v", err)
    }

    user, err := svc.GetUser(context.Background(), 42)
    if err != nil {
        t.Fatalf("GetUser: %v", err)
    }
    if user.Name != "Alice" {
        t.Errorf("expected Alice, got %q", user.Name)
    }
}
```

### Testing with the net.Listener Injection Pattern

```go
func TestServerStartStop(t *testing.T) {
    // Use an ephemeral listener so tests don't need a fixed port
    ln, err := net.Listen("tcp", "127.0.0.1:0")
    if err != nil {
        t.Fatalf("net.Listen: %v", err)
    }

    s, err := server.New(
        server.WithListener(ln),
        server.WithTimeout(5*time.Second),
    )
    if err != nil {
        t.Fatalf("server.New: %v", err)
    }

    ctx, cancel := context.WithCancel(context.Background())
    go s.Serve(ctx)
    defer cancel()

    // Make a request to the server
    addr := ln.Addr().String()
    resp, err := http.Get("http://" + addr + "/health")
    if err != nil {
        t.Fatalf("GET /health: %v", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        t.Errorf("expected 200, got %d", resp.StatusCode)
    }
}
```

## Section 8: Dealing with Mutually Exclusive Options

Sometimes options are mutually exclusive. Enforce this at construction time:

```go
type authMethod int

const (
    authNone authMethod = iota
    authAPIKey
    authOAuth2
    authMTLS
)

type clientOptions struct {
    authMethod  authMethod
    apiKey      string
    oauthConfig *oauth2.Config
    tlsConfig   *tls.Config
}

func WithAPIKey(key string) Option {
    return func(o *clientOptions) error {
        if o.authMethod != authNone {
            return fmt.Errorf("auth method already set; cannot use both API key and another auth method")
        }
        o.authMethod = authAPIKey
        o.apiKey = key
        return nil
    }
}

func WithOAuth2(cfg *oauth2.Config) Option {
    return func(o *clientOptions) error {
        if o.authMethod != authNone {
            return fmt.Errorf("auth method already set; cannot use both OAuth2 and another auth method")
        }
        o.authMethod = authOAuth2
        o.oauthConfig = cfg
        return nil
    }
}
```

## Section 9: Documenting Options

Good documentation for option functions is critical because they're the primary API surface:

```go
// WithTimeout sets the deadline for each request made by the client.
// If a request exceeds the timeout, it is cancelled with context.DeadlineExceeded.
//
// The timeout applies end-to-end: it includes DNS resolution, TCP handshake,
// TLS negotiation, and reading the entire response body.
//
// The default timeout is 30 seconds. Setting a timeout of 0 or negative
// returns an error.
//
// Example:
//
//    client, err := New(baseURL, WithTimeout(60*time.Second))
func WithTimeout(d time.Duration) Option {
    return func(o *options) error {
        if d <= 0 {
            return fmt.Errorf("timeout must be positive, got %v", d)
        }
        o.timeout = d
        return nil
    }
}
```

## Section 10: Real-World Example — HTTP Client with Retry and Observability

```go
// httpclient/client.go
package httpclient

import (
    "context"
    "fmt"
    "io"
    "log/slog"
    "net/http"
    "time"

    "golang.org/x/time/rate"
)

type options struct {
    baseURL      string
    timeout      time.Duration
    maxRetries   int
    retryBackoff time.Duration
    rateLimiter  *rate.Limiter
    transport    http.RoundTripper
    logger       *slog.Logger
    userAgent    string
    headers      map[string]string
}

type Option func(*options) error

type Client struct {
    opts   options
    client *http.Client
}

func defaults(baseURL string) options {
    return options{
        baseURL:      baseURL,
        timeout:      30 * time.Second,
        maxRetries:   3,
        retryBackoff: 500 * time.Millisecond,
        transport:    http.DefaultTransport,
        logger:       slog.Default(),
        userAgent:    "httpclient/1.0",
        headers:      make(map[string]string),
    }
}

func New(baseURL string, opts ...Option) (*Client, error) {
    o := defaults(baseURL)
    for _, opt := range opts {
        if err := opt(&o); err != nil {
            return nil, fmt.Errorf("option error: %w", err)
        }
    }
    return &Client{
        opts: o,
        client: &http.Client{
            Timeout:   o.timeout,
            Transport: o.transport,
        },
    }, nil
}

func (c *Client) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
    if c.opts.rateLimiter != nil {
        if err := c.opts.rateLimiter.Wait(ctx); err != nil {
            return nil, fmt.Errorf("rate limiter: %w", err)
        }
    }

    req.Header.Set("User-Agent", c.opts.userAgent)
    for k, v := range c.opts.headers {
        req.Header.Set(k, v)
    }

    var resp *http.Response
    var lastErr error

    for attempt := 0; attempt <= c.opts.maxRetries; attempt++ {
        if attempt > 0 {
            backoff := c.opts.retryBackoff * time.Duration(1<<uint(attempt-1))
            c.opts.logger.Debug("retrying request",
                "attempt", attempt,
                "backoff", backoff,
                "url", req.URL.String(),
            )
            select {
            case <-time.After(backoff):
            case <-ctx.Done():
                return nil, ctx.Err()
            }
        }

        resp, lastErr = c.client.Do(req.Clone(ctx))
        if lastErr != nil {
            c.opts.logger.Warn("request failed", "error", lastErr, "attempt", attempt)
            continue
        }

        if resp.StatusCode < 500 {
            return resp, nil
        }

        // 5xx — read and discard body before retry
        io.Copy(io.Discard, resp.Body)
        resp.Body.Close()
        lastErr = fmt.Errorf("server error: %d %s", resp.StatusCode, resp.Status)
    }

    return nil, fmt.Errorf("all %d attempts failed: %w", c.opts.maxRetries+1, lastErr)
}

// ── Options ───────────────────────────────────────────────────────────

func WithTimeout(d time.Duration) Option {
    return func(o *options) error {
        if d <= 0 {
            return fmt.Errorf("timeout must be positive")
        }
        o.timeout = d
        return nil
    }
}

func WithMaxRetries(n int) Option {
    return func(o *options) error {
        if n < 0 {
            return fmt.Errorf("maxRetries must be non-negative")
        }
        o.maxRetries = n
        return nil
    }
}

func WithRateLimit(rps float64, burst int) Option {
    return func(o *options) error {
        if rps <= 0 {
            return fmt.Errorf("rps must be positive")
        }
        o.rateLimiter = rate.NewLimiter(rate.Limit(rps), burst)
        return nil
    }
}

func WithTransport(t http.RoundTripper) Option {
    return func(o *options) error {
        if t == nil {
            return fmt.Errorf("transport must not be nil")
        }
        o.transport = t
        return nil
    }
}

func WithUserAgent(ua string) Option {
    return func(o *options) error {
        if ua == "" {
            return fmt.Errorf("user agent must not be empty")
        }
        o.userAgent = ua
        return nil
    }
}

func WithBearerToken(token string) Option {
    return func(o *options) error {
        if token == "" {
            return fmt.Errorf("bearer token must not be empty")
        }
        o.headers["Authorization"] = "Bearer " + token
        return nil
    }
}

func WithLogger(logger *slog.Logger) Option {
    return func(o *options) error {
        if logger == nil {
            return fmt.Errorf("logger must not be nil")
        }
        o.logger = logger
        return nil
    }
}
```

## Section 11: Anti-Patterns to Avoid

### Anti-Pattern 1: Options That Return Options

Avoid option functions that take other options as arguments — it creates confusing nesting:

```go
// BAD: options taking options
func WithTLSOptions(certFile string, extraOpts ...TLSOption) Option { ... }

// GOOD: separate option for the cert, separate option for TLS config
func WithTLSCert(certFile, keyFile string) Option { ... }
func WithTLSConfig(cfg *tls.Config) Option { ... }
```

### Anti-Pattern 2: Silent Defaults That Hide Errors

```go
// BAD: invalid input is silently ignored
func WithPort(port int) Option {
    return func(s *Server) {
        if port > 0 && port <= 65535 {
            s.port = port
        }
        // invalid port silently ignored — caller never knows
    }
}

// GOOD: return an error
func WithPort(port int) Option {
    return func(s *Server) error {
        if port < 1 || port > 65535 {
            return fmt.Errorf("invalid port: %d", port)
        }
        s.port = port
        return nil
    }
}
```

### Anti-Pattern 3: Exporting the options Struct

```go
// BAD: exporting the config struct breaks encapsulation
type Options struct {
    Port    int
    Timeout time.Duration
    // ... can grow without bound, callers depend on field names
}

// GOOD: keep options unexported; expose only the Option type and constructors
type options struct { ... }
type Option func(*options) error
```

## Summary

The functional options pattern is one of Go's most powerful API design tools:

- **Option functions with error returns** provide per-option validation, are composable, and enable conditional logic at the option level
- **Option structs** are preferable when serializability, inspectability, or config-file integration is required
- **Return concrete types** from constructors unless multiple implementations are expected — avoid speculative interface abstraction
- **Test options individually** by constructing objects with single options and verifying behavior, and inject mock dependencies via option functions rather than global state
- **Document every option** with examples in godoc — options are the primary API surface callers interact with

The key principle: options should be cheap to define, composable without coordination, and safe to add without breaking existing callers. When in doubt, err toward validation at construction time rather than at method call time.
