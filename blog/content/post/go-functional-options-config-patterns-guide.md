---
title: "Go Configuration Patterns: Functional Options, Builder, and Config Structs"
date: 2028-10-27T00:00:00-05:00
draft: false
tags: ["Go", "Software Design", "Configuration", "Architecture", "Patterns"]
categories:
- Go
- Software Design
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Go configuration patterns including functional options, builder pattern, config structs with validation, environment variable binding, multi-source merging, and testing considerations for library vs application design."
more_link: "yes"
url: "/go-functional-options-config-patterns-guide/"
---

How a Go package accepts configuration is an API decision that affects every consumer forever. The wrong choice — a positional constructor, a deeply nested config struct, or global variables — creates maintenance debt that compounds over time. This guide covers the three mainstream patterns, when to use each, and how to build robust multi-source configuration that works correctly from tests to production.

<!--more-->

# Go Configuration Patterns in Production

## Pattern 1: Config Struct with Validation

The simplest pattern for application-level configuration. One struct holds everything; validation runs at startup.

```go
package config

import (
	"errors"
	"fmt"
	"net/url"
	"time"
)

// ServerConfig holds the complete application configuration.
type ServerConfig struct {
	// HTTP server settings
	HTTPAddr     string        `env:"HTTP_ADDR"     default:":8080"`
	ReadTimeout  time.Duration `env:"READ_TIMEOUT"  default:"30s"`
	WriteTimeout time.Duration `env:"WRITE_TIMEOUT" default:"30s"`
	IdleTimeout  time.Duration `env:"IDLE_TIMEOUT"  default:"120s"`

	// Database settings
	DatabaseURL     string        `env:"DATABASE_URL"     required:"true"`
	DatabaseMaxOpen int           `env:"DB_MAX_OPEN"      default:"25"`
	DatabaseMaxIdle int           `env:"DB_MAX_IDLE"      default:"5"`
	DatabaseTimeout time.Duration `env:"DB_TIMEOUT"       default:"10s"`

	// Redis settings
	RedisAddr     string        `env:"REDIS_ADDR"     default:"localhost:6379"`
	RedisPassword string        `env:"REDIS_PASSWORD"`
	RedisDB       int           `env:"REDIS_DB"       default:"0"`
	RedisPoolSize int           `env:"REDIS_POOL"     default:"10"`

	// TLS settings
	TLSEnabled  bool   `env:"TLS_ENABLED"  default:"false"`
	TLSCertFile string `env:"TLS_CERT"`
	TLSKeyFile  string `env:"TLS_KEY"`

	// Feature flags
	EnableMetrics  bool   `env:"ENABLE_METRICS"  default:"true"`
	MetricsAddr    string `env:"METRICS_ADDR"    default:":9090"`
	LogLevel       string `env:"LOG_LEVEL"       default:"info"`
	Environment    string `env:"ENVIRONMENT"     default:"development"`
}

// Validate checks that all required fields are set and values are in range.
func (c *ServerConfig) Validate() error {
	var errs []error

	if c.DatabaseURL == "" {
		errs = append(errs, errors.New("DATABASE_URL is required"))
	} else if _, err := url.Parse(c.DatabaseURL); err != nil {
		errs = append(errs, fmt.Errorf("DATABASE_URL is invalid: %w", err))
	}

	if c.DatabaseMaxOpen < 1 {
		errs = append(errs, errors.New("DB_MAX_OPEN must be >= 1"))
	}
	if c.DatabaseMaxIdle > c.DatabaseMaxOpen {
		errs = append(errs, errors.New("DB_MAX_IDLE must be <= DB_MAX_OPEN"))
	}

	if c.TLSEnabled {
		if c.TLSCertFile == "" {
			errs = append(errs, errors.New("TLS_CERT is required when TLS_ENABLED=true"))
		}
		if c.TLSKeyFile == "" {
			errs = append(errs, errors.New("TLS_KEY is required when TLS_ENABLED=true"))
		}
	}

	validLevels := map[string]bool{"debug": true, "info": true, "warn": true, "error": true}
	if !validLevels[c.LogLevel] {
		errs = append(errs, fmt.Errorf("LOG_LEVEL must be one of: debug, info, warn, error; got %q", c.LogLevel))
	}

	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}
```

### Environment variable loading with envconfig

```go
package main

import (
	"log"

	"github.com/kelseyhightower/envconfig"
	"myapp/config"
)

func main() {
	var cfg config.ServerConfig
	if err := envconfig.Process("", &cfg); err != nil {
		log.Fatalf("config: %v", err)
	}
	if err := cfg.Validate(); err != nil {
		log.Fatalf("config validation: %v", err)
	}

	app := NewApp(cfg)
	app.Run()
}
```

### YAML file loading with validation

```go
package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// LoadFromFile reads a YAML file and merges environment variable overrides.
func LoadFromFile(path string) (*ServerConfig, error) {
	cfg := ServerConfig{}

	// Load file if it exists
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil && !os.IsNotExist(err) {
			return nil, fmt.Errorf("reading config file: %w", err)
		}
		if err == nil {
			if err := yaml.Unmarshal(data, &cfg); err != nil {
				return nil, fmt.Errorf("parsing config file: %w", err)
			}
		}
	}

	// Environment variables override file values
	if err := envconfig.Process("", &cfg); err != nil {
		return nil, fmt.Errorf("processing env vars: %w", err)
	}

	// Apply defaults for zero values
	applyDefaults(&cfg)

	return &cfg, nil
}

func applyDefaults(cfg *ServerConfig) {
	if cfg.HTTPAddr == "" {
		cfg.HTTPAddr = ":8080"
	}
	if cfg.ReadTimeout == 0 {
		cfg.ReadTimeout = 30 * time.Second
	}
	if cfg.WriteTimeout == 0 {
		cfg.WriteTimeout = 30 * time.Second
	}
	if cfg.IdleTimeout == 0 {
		cfg.IdleTimeout = 120 * time.Second
	}
	if cfg.DatabaseMaxOpen == 0 {
		cfg.DatabaseMaxOpen = 25
	}
	if cfg.DatabaseMaxIdle == 0 {
		cfg.DatabaseMaxIdle = 5
	}
	if cfg.LogLevel == "" {
		cfg.LogLevel = "info"
	}
	if cfg.Environment == "" {
		cfg.Environment = "development"
	}
}
```

## Pattern 2: Functional Options

Functional options are the standard pattern for Go libraries. They allow backward-compatible evolution: adding new `WithX` functions never breaks existing callers because the zero value of the options struct is always valid.

Rob Pike and Dave Cheney popularized this pattern; it is now the dominant idiom for configuring library types in the Go ecosystem.

```go
package cache

import (
	"context"
	"fmt"
	"time"
)

// options holds the complete configuration for a Cache.
type options struct {
	maxSize     int
	ttl         time.Duration
	onEvict     func(key string, value interface{})
	compression bool
	namespace   string
	metrics     MetricsCollector
}

// defaultOptions returns sensible defaults.
func defaultOptions() options {
	return options{
		maxSize: 1000,
		ttl:     5 * time.Minute,
		onEvict: func(string, interface{}) {},
	}
}

// Option is a function that modifies options.
type Option func(*options)

// WithMaxSize sets the maximum number of entries in the cache.
// Defaults to 1000.
func WithMaxSize(n int) Option {
	return func(o *options) {
		if n > 0 {
			o.maxSize = n
		}
	}
}

// WithTTL sets the time-to-live for cache entries.
// Defaults to 5 minutes. Use 0 for no expiry.
func WithTTL(d time.Duration) Option {
	return func(o *options) {
		o.ttl = d
	}
}

// WithEvictionCallback registers a function called when an entry is evicted.
func WithEvictionCallback(fn func(key string, value interface{})) Option {
	return func(o *options) {
		if fn != nil {
			o.onEvict = fn
		}
	}
}

// WithCompression enables LZ4 compression for stored values.
func WithCompression() Option {
	return func(o *options) {
		o.compression = true
	}
}

// WithNamespace prefixes all cache keys with a namespace.
func WithNamespace(ns string) Option {
	return func(o *options) {
		o.namespace = ns
	}
}

// WithMetrics attaches a metrics collector to the cache.
func WithMetrics(m MetricsCollector) Option {
	return func(o *options) {
		o.metrics = m
	}
}

// Cache is the main type.
type Cache struct {
	opts options
	data map[string]entry
}

type entry struct {
	value   interface{}
	expires time.Time
}

// New creates a new Cache with the provided options.
func New(opts ...Option) *Cache {
	o := defaultOptions()
	for _, opt := range opts {
		opt(&o)
	}
	return &Cache{
		opts: o,
		data: make(map[string]entry, o.maxSize),
	}
}

func (c *Cache) key(k string) string {
	if c.opts.namespace != "" {
		return c.opts.namespace + ":" + k
	}
	return k
}

func (c *Cache) Set(k string, v interface{}) {
	exp := time.Time{}
	if c.opts.ttl > 0 {
		exp = time.Now().Add(c.opts.ttl)
	}
	c.data[c.key(k)] = entry{value: v, expires: exp}
}

func (c *Cache) Get(k string) (interface{}, bool) {
	e, ok := c.data[c.key(k)]
	if !ok {
		return nil, false
	}
	if !e.expires.IsZero() && time.Now().After(e.expires) {
		delete(c.data, c.key(k))
		c.opts.onEvict(k, e.value)
		return nil, false
	}
	return e.value, true
}
```

### Usage demonstrating backward compatibility

```go
// Minimum configuration — all defaults apply
c1 := cache.New()

// Production configuration
c2 := cache.New(
	cache.WithMaxSize(10000),
	cache.WithTTL(15*time.Minute),
	cache.WithNamespace("api"),
	cache.WithCompression(),
	cache.WithEvictionCallback(func(key string, _ interface{}) {
		log.Printf("evicted key: %s", key)
	}),
	cache.WithMetrics(prometheusMetrics),
)

// Test configuration — disable TTL so tests are deterministic
c3 := cache.New(
	cache.WithTTL(0),
	cache.WithMaxSize(100),
)
```

### Adding an option without breaking existing callers

```go
// New option added in v2.0 — all existing callers compile unchanged
func WithReadThrough(fn func(ctx context.Context, key string) (interface{}, error)) Option {
	return func(o *options) {
		o.readThrough = fn
	}
}
```

## Pattern 3: Builder Pattern

The builder pattern provides method chaining and can enforce required fields at `Build()` time. It works well when configuration has complex dependencies or when you want to prevent partial construction.

```go
package httpserver

import (
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"
)

// ServerBuilder constructs an http.Server step by step.
type ServerBuilder struct {
	addr         string
	handler      http.Handler
	readTimeout  time.Duration
	writeTimeout time.Duration
	idleTimeout  time.Duration
	tlsConfig    *tls.Config
	certFile     string
	keyFile      string
	errs         []error // Accumulated validation errors
}

// NewServerBuilder creates a builder with defaults applied.
func NewServerBuilder() *ServerBuilder {
	return &ServerBuilder{
		addr:         ":8080",
		readTimeout:  30 * time.Second,
		writeTimeout: 30 * time.Second,
		idleTimeout:  120 * time.Second,
	}
}

func (b *ServerBuilder) Addr(addr string) *ServerBuilder {
	if _, _, err := net.SplitHostPort(addr); err != nil {
		b.errs = append(b.errs, fmt.Errorf("invalid address %q: %w", addr, err))
	}
	b.addr = addr
	return b
}

func (b *ServerBuilder) Handler(h http.Handler) *ServerBuilder {
	if h == nil {
		b.errs = append(b.errs, errors.New("handler cannot be nil"))
	}
	b.handler = h
	return b
}

func (b *ServerBuilder) Timeouts(read, write, idle time.Duration) *ServerBuilder {
	if read <= 0 {
		b.errs = append(b.errs, errors.New("read timeout must be positive"))
	}
	b.readTimeout = read
	b.writeTimeout = write
	b.idleTimeout = idle
	return b
}

func (b *ServerBuilder) WithTLS(certFile, keyFile string) *ServerBuilder {
	if certFile == "" || keyFile == "" {
		b.errs = append(b.errs, errors.New("TLS cert and key files are required"))
	}
	b.certFile = certFile
	b.keyFile = keyFile
	b.addr = ":443"
	return b
}

func (b *ServerBuilder) WithTLSConfig(cfg *tls.Config) *ServerBuilder {
	b.tlsConfig = cfg
	return b
}

// Build validates accumulated state and constructs the server.
func (b *ServerBuilder) Build() (*http.Server, error) {
	if len(b.errs) > 0 {
		return nil, errors.Join(b.errs...)
	}
	if b.handler == nil {
		return nil, errors.New("handler is required")
	}

	srv := &http.Server{
		Addr:         b.addr,
		Handler:      b.handler,
		ReadTimeout:  b.readTimeout,
		WriteTimeout: b.writeTimeout,
		IdleTimeout:  b.idleTimeout,
		TLSConfig:    b.tlsConfig,
	}
	return srv, nil
}
```

Usage:

```go
srv, err := httpserver.NewServerBuilder().
	Addr(":8443").
	Handler(mux).
	Timeouts(30*time.Second, 60*time.Second, 120*time.Second).
	WithTLS("/etc/tls/cert.pem", "/etc/tls/key.pem").
	Build()
if err != nil {
	log.Fatal(err)
}
```

## Multi-Source Configuration Merging

Production applications often need configuration from multiple sources with a defined priority order:

```
defaults < config file < environment variables < command-line flags
```

```go
package config

import (
	"flag"
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

// Config is the merged application configuration.
type Config struct {
	HTTP     HTTPConfig
	Database DatabaseConfig
	Redis    RedisConfig
	Log      LogConfig
}

type HTTPConfig struct {
	Addr         string        `yaml:"addr"`
	ReadTimeout  time.Duration `yaml:"read_timeout"`
	WriteTimeout time.Duration `yaml:"write_timeout"`
}

type DatabaseConfig struct {
	URL      string `yaml:"url"`
	MaxOpen  int    `yaml:"max_open"`
	MaxIdle  int    `yaml:"max_idle"`
}

type RedisConfig struct {
	Addr     string `yaml:"addr"`
	Password string `yaml:"password"`
	DB       int    `yaml:"db"`
}

type LogConfig struct {
	Level  string `yaml:"level"`
	Format string `yaml:"format"` // "json" or "text"
}

// Load merges configuration from file, environment, and flags in priority order.
func Load() (*Config, error) {
	// Step 1: Defaults
	cfg := defaults()

	// Step 2: Config file
	configFile := os.Getenv("CONFIG_FILE")
	if configFile == "" {
		configFile = "/etc/myapp/config.yaml"
	}
	if err := loadFile(configFile, &cfg); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("loading config file %s: %w", configFile, err)
	}

	// Step 3: Environment variables (override file)
	loadEnvVars(&cfg)

	// Step 4: Command-line flags (highest priority)
	flags := &flagValues{}
	registerFlags(flags)
	flag.Parse()
	applyFlags(flags, &cfg)

	// Step 5: Validate
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("config validation: %w", err)
	}

	return &cfg, nil
}

func defaults() Config {
	return Config{
		HTTP: HTTPConfig{
			Addr:         ":8080",
			ReadTimeout:  30 * time.Second,
			WriteTimeout: 30 * time.Second,
		},
		Database: DatabaseConfig{
			MaxOpen: 25,
			MaxIdle: 5,
		},
		Redis: RedisConfig{
			Addr: "localhost:6379",
			DB:   0,
		},
		Log: LogConfig{
			Level:  "info",
			Format: "json",
		},
	}
}

func loadFile(path string, cfg *Config) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return yaml.Unmarshal(data, cfg)
}

func loadEnvVars(cfg *Config) {
	if v := os.Getenv("HTTP_ADDR"); v != "" {
		cfg.HTTP.Addr = v
	}
	if v := os.Getenv("DATABASE_URL"); v != "" {
		cfg.Database.URL = v
	}
	if v := os.Getenv("REDIS_ADDR"); v != "" {
		cfg.Redis.Addr = v
	}
	if v := os.Getenv("REDIS_PASSWORD"); v != "" {
		cfg.Redis.Password = v
	}
	if v := os.Getenv("LOG_LEVEL"); v != "" {
		cfg.Log.Level = v
	}
}

type flagValues struct {
	httpAddr    string
	dbURL       string
	logLevel    string
}

func registerFlags(f *flagValues) {
	flag.StringVar(&f.httpAddr, "http-addr", "", "HTTP listen address (overrides env)")
	flag.StringVar(&f.dbURL, "db-url", "", "Database URL (overrides env)")
	flag.StringVar(&f.logLevel, "log-level", "", "Log level (overrides env)")
}

func applyFlags(f *flagValues, cfg *Config) {
	if f.httpAddr != "" {
		cfg.HTTP.Addr = f.httpAddr
	}
	if f.dbURL != "" {
		cfg.Database.URL = f.dbURL
	}
	if f.logLevel != "" {
		cfg.Log.Level = f.logLevel
	}
}

func (c *Config) Validate() error {
	var errs []error
	if c.Database.URL == "" {
		errs = append(errs, errors.New("database URL is required (DATABASE_URL or --db-url)"))
	}
	validLevels := map[string]bool{"debug": true, "info": true, "warn": true, "error": true}
	if !validLevels[c.Log.Level] {
		errs = append(errs, fmt.Errorf("invalid log level %q", c.Log.Level))
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}
```

## Versioned Configuration with Migration

Long-running applications need configuration format versioning to enable zero-downtime upgrades.

```go
package config

import "fmt"

// Versioned config envelope
type VersionedConfig struct {
	Version int            `yaml:"version"`
	Config  map[string]any `yaml:"config"`
}

// Migrate converts an old config version to the latest version.
func Migrate(data []byte) ([]byte, error) {
	var vc VersionedConfig
	if err := yaml.Unmarshal(data, &vc); err != nil {
		// Try parsing as v1 (no version field)
		vc.Version = 1
	}

	switch vc.Version {
	case 1:
		data, err := migrateV1ToV2(data)
		if err != nil {
			return nil, fmt.Errorf("migrating v1->v2: %w", err)
		}
		return data, nil
	case 2:
		return data, nil // Current version
	default:
		return nil, fmt.Errorf("unknown config version: %d", vc.Version)
	}
}

func migrateV1ToV2(data []byte) ([]byte, error) {
	// V1 had "database_url" at top level
	// V2 has "database.url" nested
	var v1 struct {
		DatabaseURL string `yaml:"database_url"`
		HTTPAddr    string `yaml:"http_addr"`
	}
	if err := yaml.Unmarshal(data, &v1); err != nil {
		return nil, err
	}

	v2 := map[string]any{
		"version": 2,
		"database": map[string]any{
			"url": v1.DatabaseURL,
		},
		"http": map[string]any{
			"addr": v1.HTTPAddr,
		},
	}
	return yaml.Marshal(v2)
}
```

## Testability: Dependency Injection via Config

Configuration patterns directly impact testability. Prefer interfaces over concrete types in config, and provide test helpers:

```go
package config_test

import (
	"os"
	"testing"
	"time"
)

// TestConfig returns a minimal valid config for unit tests.
func TestConfig(t testing.TB) *Config {
	t.Helper()
	return &Config{
		HTTP: HTTPConfig{
			Addr:         ":0", // OS-assigned port
			ReadTimeout:  5 * time.Second,
			WriteTimeout: 5 * time.Second,
		},
		Database: DatabaseConfig{
			URL:     "postgres://test:test@localhost:5432/testdb?sslmode=disable",
			MaxOpen: 5,
			MaxIdle: 2,
		},
		Redis: RedisConfig{
			Addr: "localhost:6379",
			DB:   15, // Use DB 15 for tests, not production DB 0
		},
		Log: LogConfig{
			Level:  "debug",
			Format: "text",
		},
	}
}

// WithEnv temporarily sets environment variables for the duration of a test.
func WithEnv(t testing.TB, vars map[string]string) {
	t.Helper()
	for k, v := range vars {
		old, hadOld := os.LookupEnv(k)
		os.Setenv(k, v)
		t.Cleanup(func() {
			if hadOld {
				os.Setenv(k, old)
			} else {
				os.Unsetenv(k)
			}
		})
	}
}

// Example test using the helpers
func TestLoadEnvOverride(t *testing.T) {
	WithEnv(t, map[string]string{
		"DATABASE_URL": "postgres://test:test@localhost:5432/override_db",
		"LOG_LEVEL":    "debug",
	})

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Database.URL != "postgres://test:test@localhost:5432/override_db" {
		t.Errorf("unexpected database URL: %s", cfg.Database.URL)
	}
	if cfg.Log.Level != "debug" {
		t.Errorf("unexpected log level: %s", cfg.Log.Level)
	}
}
```

## Comparing Approaches: Library vs Application

| Concern | Library (use functional options) | Application (use config struct) |
|---|---|---|
| API stability | Critical — options are additive | Less critical — you control all callers |
| Zero-value safety | Required — `New()` must work | Validate at startup instead |
| Config sources | Single source (caller provides) | Multiple: file, env, flags |
| Testability | Easy — pass options directly | Use test helpers, env injection |
| Documentation | Each `WithX` is self-documenting | Struct tags serve as docs |
| Versioning | Not needed for options | Use version field in config file |
| Complexity | Low — each option is small | Medium — requires merge logic |

### When to mix patterns

Real applications often combine patterns:

```go
// Application-level config uses structs
type AppConfig struct {
	HTTP     HTTPConfig
	Database DatabaseConfig
}

// But constructs library clients using functional options
func NewFromConfig(cfg AppConfig) (*App, error) {
	cacheClient := cache.New(
		cache.WithMaxSize(cfg.Cache.MaxSize),
		cache.WithTTL(cfg.Cache.TTL),
	)

	dbPool, err := pgxpool.New(context.Background(),
		cfg.Database.URL,
	)
	// ...
}
```

## Summary

Choose the configuration pattern based on who your consumers are:

- **Config struct + validation**: Best for applications where you control all callers. Explicit, easy to serialize to YAML/JSON, and straightforward to test.
- **Functional options**: Best for libraries intended for external consumers. Never breaks existing callers when new options are added, and the zero value is always safe.
- **Builder pattern**: Best when construction has complex dependencies or required fields that must be validated together.

For production applications, always implement multi-source merging with a clear priority order (defaults < file < env < flags), validate all configuration at startup before any I/O begins, and provide test helpers that make it easy to construct minimal valid configurations without touching real infrastructure.
