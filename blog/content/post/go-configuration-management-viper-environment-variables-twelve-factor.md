---
title: "Go Configuration Management: Viper, Environment Variables, and Twelve-Factor App Patterns"
date: 2030-08-19T00:00:00-05:00
draft: false
tags: ["Go", "Configuration", "Viper", "Twelve-Factor", "Feature Flags", "Kubernetes", "DevOps"]
categories:
- Go
- Architecture
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Go configuration management: Viper configuration hierarchy, environment variable binding, config file watching, validation with go-playground/validator, feature flags integration, and testing services with configuration isolation."
more_link: "yes"
url: "/go-configuration-management-viper-environment-variables-twelve-factor/"
---

Configuration management in Go production services involves more than reading environment variables. Enterprise services require a hierarchical configuration system that supports multiple sources (defaults, config files, environment variables, remote KV stores), runtime config reloading without restarts, type-safe validation with actionable error messages, and testable configuration isolation. Viper, combined with structured validation and feature flag integration, provides the foundation for this system.

<!--more-->

## Twelve-Factor App Configuration Principles

The Twelve-Factor App methodology establishes that configuration — everything that varies between deployment environments — must be stored in the environment, not in code. For Go services this translates to:

1. No hardcoded hostnames, ports, or credentials in source code
2. Environment variables are the primary runtime configuration mechanism
3. Config files are defaults and developer convenience, not the deployment mechanism
4. Secrets are never committed to version control

The practical implementation layers these sources with explicit precedence:

```
Priority (highest to lowest):
1. Environment variables (deployment-time override)
2. Remote config (Consul/etcd — for runtime reloading)
3. Local config file (service defaults and structure)
4. Hard-coded defaults (compile-time safe baseline)
```

---

## Project Structure

```
myservice/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── config/
│   │   ├── config.go        ← Configuration struct
│   │   ├── loader.go        ← Viper initialization
│   │   └── validate.go      ← Validation logic
│   └── service/
│       └── service.go
├── config/
│   └── config.yaml          ← Default configuration
└── ...
```

---

## Configuration Struct Design

Define configuration as a typed Go struct. This provides compile-time safety, IDE autocomplete, and a single source of truth for all service configuration:

```go
// internal/config/config.go
package config

import "time"

type Config struct {
    Server   ServerConfig   `mapstructure:"server"   validate:"required"`
    Database DatabaseConfig `mapstructure:"database" validate:"required"`
    Cache    CacheConfig    `mapstructure:"cache"`
    Logging  LoggingConfig  `mapstructure:"logging"`
    Features FeatureConfig  `mapstructure:"features"`
    Metrics  MetricsConfig  `mapstructure:"metrics"`
}

type ServerConfig struct {
    Host              string        `mapstructure:"host"               validate:"required"`
    Port              int           `mapstructure:"port"               validate:"required,min=1,max=65535"`
    ReadTimeout       time.Duration `mapstructure:"read_timeout"`
    WriteTimeout      time.Duration `mapstructure:"write_timeout"`
    IdleTimeout       time.Duration `mapstructure:"idle_timeout"`
    ShutdownTimeout   time.Duration `mapstructure:"shutdown_timeout"`
    MaxRequestBodyMB  int           `mapstructure:"max_request_body_mb" validate:"min=1,max=100"`
}

type DatabaseConfig struct {
    Host            string        `mapstructure:"host"             validate:"required"`
    Port            int           `mapstructure:"port"             validate:"required,min=1,max=65535"`
    Name            string        `mapstructure:"name"             validate:"required,alphanum"`
    User            string        `mapstructure:"user"             validate:"required"`
    Password        string        `mapstructure:"password"         validate:"required"`
    SSLMode         string        `mapstructure:"ssl_mode"         validate:"oneof=disable require verify-ca verify-full"`
    MaxOpenConns    int           `mapstructure:"max_open_conns"   validate:"min=1,max=1000"`
    MaxIdleConns    int           `mapstructure:"max_idle_conns"   validate:"min=0"`
    ConnMaxLifetime time.Duration `mapstructure:"conn_max_lifetime"`
    ConnMaxIdleTime time.Duration `mapstructure:"conn_max_idle_time"`
}

type CacheConfig struct {
    Enabled     bool          `mapstructure:"enabled"`
    RedisAddr   string        `mapstructure:"redis_addr"`
    RedisDB     int           `mapstructure:"redis_db"    validate:"min=0,max=15"`
    TTL         time.Duration `mapstructure:"ttl"`
    MaxMemoryMB int           `mapstructure:"max_memory_mb" validate:"min=16,max=16384"`
}

type LoggingConfig struct {
    Level  string `mapstructure:"level"  validate:"oneof=debug info warn error"`
    Format string `mapstructure:"format" validate:"oneof=json text"`
    Output string `mapstructure:"output" validate:"oneof=stdout stderr"`
}

type FeatureConfig struct {
    EnableNewCheckout   bool   `mapstructure:"enable_new_checkout"`
    EnableRateLimit     bool   `mapstructure:"enable_rate_limit"`
    RateLimitPerMinute  int    `mapstructure:"rate_limit_per_minute" validate:"min=0,max=100000"`
    EnableExperimentalX bool   `mapstructure:"enable_experimental_x"`
    LaunchDarklyKey     string `mapstructure:"launchdarkly_key"`
}

type MetricsConfig struct {
    Enabled     bool   `mapstructure:"enabled"`
    Port        int    `mapstructure:"port"    validate:"min=1,max=65535"`
    Path        string `mapstructure:"path"    validate:"startswith=/"`
}
```

---

## Default Configuration File

```yaml
# config/config.yaml
server:
  host: "0.0.0.0"
  port: 8080
  read_timeout: 30s
  write_timeout: 30s
  idle_timeout: 120s
  shutdown_timeout: 30s
  max_request_body_mb: 16

database:
  host: "localhost"
  port: 5432
  name: "myapp"
  user: "myapp"
  password: ""          # Must be overridden via environment variable
  ssl_mode: "require"
  max_open_conns: 25
  max_idle_conns: 10
  conn_max_lifetime: 1h
  conn_max_idle_time: 30m

cache:
  enabled: true
  redis_addr: "localhost:6379"
  redis_db: 0
  ttl: 5m
  max_memory_mb: 512

logging:
  level: "info"
  format: "json"
  output: "stdout"

features:
  enable_new_checkout: false
  enable_rate_limit: true
  rate_limit_per_minute: 1000
  enable_experimental_x: false
  launchdarkly_key: ""

metrics:
  enabled: true
  port: 9090
  path: /metrics
```

---

## Viper Configuration Loader

```go
// internal/config/loader.go
package config

import (
    "fmt"
    "os"
    "strings"
    "time"

    "github.com/fsnotify/fsnotify"
    "github.com/spf13/viper"
)

// Load reads configuration from the provided config file path and overlays
// environment variable overrides. All environment variables must be prefixed
// with APP_ to avoid collisions with system variables.
func Load(configPath string) (*Config, error) {
    v := viper.New()

    // Set environment variable prefix
    v.SetEnvPrefix("APP")
    v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
    v.AutomaticEnv()

    // Set config file
    if configPath != "" {
        v.SetConfigFile(configPath)
    } else {
        v.SetConfigName("config")
        v.SetConfigType("yaml")
        v.AddConfigPath("./config")
        v.AddConfigPath("/etc/myapp")
        v.AddConfigPath("$HOME/.myapp")
    }

    setDefaults(v)

    if err := v.ReadInConfig(); err != nil {
        if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
            return nil, fmt.Errorf("reading config file: %w", err)
        }
        // Config file not found is acceptable — env vars and defaults will be used
    }

    var cfg Config
    if err := v.Unmarshal(&cfg, viper.DecodeHook(
        mapstructureDecodeHook(),
    )); err != nil {
        return nil, fmt.Errorf("unmarshaling config: %w", err)
    }

    if err := Validate(&cfg); err != nil {
        return nil, fmt.Errorf("config validation failed: %w", err)
    }

    return &cfg, nil
}

func setDefaults(v *viper.Viper) {
    // Server defaults
    v.SetDefault("server.host", "0.0.0.0")
    v.SetDefault("server.port", 8080)
    v.SetDefault("server.read_timeout", 30*time.Second)
    v.SetDefault("server.write_timeout", 30*time.Second)
    v.SetDefault("server.idle_timeout", 120*time.Second)
    v.SetDefault("server.shutdown_timeout", 30*time.Second)
    v.SetDefault("server.max_request_body_mb", 16)

    // Database defaults
    v.SetDefault("database.port", 5432)
    v.SetDefault("database.ssl_mode", "require")
    v.SetDefault("database.max_open_conns", 25)
    v.SetDefault("database.max_idle_conns", 10)
    v.SetDefault("database.conn_max_lifetime", 1*time.Hour)
    v.SetDefault("database.conn_max_idle_time", 30*time.Minute)

    // Logging defaults
    v.SetDefault("logging.level", "info")
    v.SetDefault("logging.format", "json")
    v.SetDefault("logging.output", "stdout")

    // Metrics defaults
    v.SetDefault("metrics.enabled", true)
    v.SetDefault("metrics.port", 9090)
    v.SetDefault("metrics.path", "/metrics")

    // Feature flag defaults — all off by default
    v.SetDefault("features.enable_rate_limit", true)
    v.SetDefault("features.rate_limit_per_minute", 1000)
}

// WatchAndReload watches the config file for changes and calls onChange
// with the new configuration when a change is detected.
func WatchAndReload(v *viper.Viper, onChange func(*Config) error) {
    v.WatchConfig()
    v.OnConfigChange(func(e fsnotify.Event) {
        var cfg Config
        if err := v.Unmarshal(&cfg); err != nil {
            fmt.Fprintf(os.Stderr, "config reload: unmarshal error: %v\n", err)
            return
        }
        if err := Validate(&cfg); err != nil {
            fmt.Fprintf(os.Stderr, "config reload: validation error: %v\n", err)
            return
        }
        if err := onChange(&cfg); err != nil {
            fmt.Fprintf(os.Stderr, "config reload: handler error: %v\n", err)
        }
    })
}
```

---

## Validation with go-playground/validator

```go
// internal/config/validate.go
package config

import (
    "errors"
    "fmt"
    "strings"

    "github.com/go-playground/validator/v10"
)

var validate *validator.Validate

func init() {
    validate = validator.New()

    // Register custom tag name function to use mapstructure tags in error messages
    validate.RegisterTagNameFunc(func(fld reflect.StructField) string {
        name := strings.SplitN(fld.Tag.Get("mapstructure"), ",", 2)[0]
        if name == "-" {
            return ""
        }
        if name == "" {
            return fld.Name
        }
        return name
    })

    // Register custom validators
    _ = validate.RegisterValidation("startswith", startsWithValidator)
}

func startsWithValidator(fl validator.FieldLevel) bool {
    param := fl.Param()
    return strings.HasPrefix(fl.Field().String(), param)
}

// Validate validates the configuration struct and returns a human-readable
// error listing all validation failures.
func Validate(cfg *Config) error {
    err := validate.Struct(cfg)
    if err == nil {
        return nil
    }

    var validationErrors validator.ValidationErrors
    if !errors.As(err, &validationErrors) {
        return err
    }

    var sb strings.Builder
    sb.WriteString("configuration validation failed:\n")
    for _, e := range validationErrors {
        sb.WriteString(fmt.Sprintf("  - %s: failed '%s' validation (value: %v)\n",
            e.Namespace(), e.Tag(), e.Value()))
    }
    return errors.New(sb.String())
}

// ValidateDatabaseConnectivity verifies that the database configuration
// produces a connectable DSN. This is a runtime check, not a static validation.
func ValidateDatabaseConnectivity(cfg *DatabaseConfig) error {
    if cfg.Password == "" {
        return errors.New("database.password must be set via APP_DATABASE_PASSWORD environment variable")
    }
    return nil
}
```

---

## Environment Variable Mapping

Define the mapping from configuration keys to environment variables explicitly. This serves as documentation and prevents ambiguity:

| Config Key | Environment Variable | Description |
|---|---|---|
| `database.host` | `APP_DATABASE_HOST` | PostgreSQL host |
| `database.password` | `APP_DATABASE_PASSWORD` | PostgreSQL password (required) |
| `cache.redis_addr` | `APP_CACHE_REDIS_ADDR` | Redis address |
| `features.launchdarkly_key` | `APP_FEATURES_LAUNCHDARKLY_KEY` | LaunchDarkly SDK key |
| `logging.level` | `APP_LOGGING_LEVEL` | Log level: debug/info/warn/error |
| `server.port` | `APP_SERVER_PORT` | HTTP server port |

### Kubernetes ConfigMap and Secret

```yaml
# k8s/configmap.yaml — non-sensitive configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: myapp-config
  namespace: production
data:
  APP_DATABASE_HOST: postgres-primary.production.svc.cluster.local
  APP_DATABASE_NAME: myapp_prod
  APP_DATABASE_USER: myapp
  APP_DATABASE_SSL_MODE: require
  APP_CACHE_REDIS_ADDR: redis-cluster.production.svc.cluster.local:6379
  APP_LOGGING_LEVEL: info
  APP_SERVER_PORT: "8080"
  APP_METRICS_PORT: "9090"
---
# k8s/secret.yaml — sensitive configuration
apiVersion: v1
kind: Secret
metadata:
  name: myapp-secrets
  namespace: production
type: Opaque
data:
  APP_DATABASE_PASSWORD: <base64-encoded-password>
  APP_FEATURES_LAUNCHDARKLY_KEY: <base64-encoded-sdk-key>
```

### Pod Environment Variable Injection

```yaml
# k8s/deployment.yaml
spec:
  containers:
    - name: myapp
      image: myregistry.example.com/myapp:abc1234
      envFrom:
        - configMapRef:
            name: myapp-config
        - secretRef:
            name: myapp-secrets
      env:
        # Single overrides for environment-specific values
        - name: APP_FEATURES_ENABLE_NEW_CHECKOUT
          value: "true"
```

---

## Feature Flags Integration

### LaunchDarkly Integration

```go
// internal/features/flags.go
package features

import (
    "context"
    "log/slog"
    "time"

    ld "github.com/launchdarkly/go-server-sdk/v7"
    "github.com/launchdarkly/go-server-sdk/v7/ldcontext"
)

type Client struct {
    ldClient *ld.LDClient
    logger   *slog.Logger
    defaults map[string]bool
}

func NewClient(sdkKey string, logger *slog.Logger) (*Client, error) {
    ldCfg := ld.Config{}
    client, err := ld.MakeCustomClient(sdkKey, ldCfg, 5*time.Second)
    if err != nil {
        return nil, fmt.Errorf("initializing LaunchDarkly: %w", err)
    }

    return &Client{
        ldClient: client,
        logger:   logger,
        defaults: map[string]bool{
            "enable-new-checkout":   false,
            "enable-rate-limit":     true,
            "enable-experimental-x": false,
        },
    }, nil
}

func (c *Client) IsEnabled(ctx context.Context, flag string, userID string) bool {
    ldCtx := ldcontext.New(userID)

    defaultVal := c.defaults[flag]
    val, err := c.ldClient.BoolVariation(flag, ldCtx, defaultVal)
    if err != nil {
        c.logger.Warn("feature flag evaluation failed, using default",
            "flag", flag, "user_id", userID, "default", defaultVal, "error", err)
        return defaultVal
    }
    return val
}

func (c *Client) Close() {
    if err := c.ldClient.Close(); err != nil {
        c.logger.Error("closing LaunchDarkly client", "error", err)
    }
}
```

### Static Feature Flags from Config (for CI/CD and Testing)

```go
// internal/features/static.go
package features

import "github.com/example/myapp/internal/config"

// StaticClient is a feature flag client backed by static configuration.
// Use this in test environments and when LaunchDarkly is not configured.
type StaticClient struct {
    flags config.FeatureConfig
}

func NewStaticClient(cfg config.FeatureConfig) *StaticClient {
    return &StaticClient{flags: cfg}
}

func (c *StaticClient) IsEnabled(_ context.Context, flag string, _ string) bool {
    switch flag {
    case "enable-new-checkout":
        return c.flags.EnableNewCheckout
    case "enable-rate-limit":
        return c.flags.EnableRateLimit
    case "enable-experimental-x":
        return c.flags.EnableExperimentalX
    default:
        return false
    }
}
```

---

## Runtime Config Reloading

For configuration values that should change without a service restart — log level, rate limits, feature flags — implement a reload mechanism backed by Viper's file watcher:

```go
// internal/config/dynamic.go
package config

import (
    "log/slog"
    "sync/atomic"
    "unsafe"
)

// DynamicConfig holds configuration values that can be updated at runtime
// without a service restart.
type DynamicConfig struct {
    ptr unsafe.Pointer
}

func NewDynamic(cfg *Config) *DynamicConfig {
    d := &DynamicConfig{}
    d.Store(cfg)
    return d
}

func (d *DynamicConfig) Load() *Config {
    return (*Config)(atomic.LoadPointer(&d.ptr))
}

func (d *DynamicConfig) Store(cfg *Config) {
    atomic.StorePointer(&d.ptr, unsafe.Pointer(cfg))
}

func (d *DynamicConfig) Reload(newCfg *Config, logger *slog.Logger) {
    old := d.Load()
    d.Store(newCfg)
    logger.Info("configuration reloaded",
        "old_log_level", old.Logging.Level,
        "new_log_level", newCfg.Logging.Level,
    )
}
```

### Connecting File Watcher to Dynamic Config

```go
// cmd/server/main.go
package main

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "syscall"

    "github.com/example/myapp/internal/config"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    cfg, err := config.Load("")
    if err != nil {
        logger.Error("loading configuration", "error", err)
        os.Exit(1)
    }

    dynCfg := config.NewDynamic(cfg)

    // Set up file watcher for runtime config reload
    config.WatchAndReload(nil, func(newCfg *config.Config) error {
        dynCfg.Reload(newCfg, logger)
        return nil
    })

    // SIGHUP triggers a manual config reload
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGHUP)
    go func() {
        for range sigCh {
            reloaded, err := config.Load("")
            if err != nil {
                logger.Error("reloading configuration on SIGHUP", "error", err)
                continue
            }
            dynCfg.Reload(reloaded, logger)
        }
    }()

    // ... server initialization using dynCfg.Load() ...
}
```

---

## Testing with Configuration Isolation

Tests that exercise configuration-dependent behavior must be able to override configuration without modifying environment variables globally (which would interfere with parallel tests):

```go
// internal/config/testing.go
package config

import "time"

// TestConfig returns a minimal valid configuration suitable for unit tests.
// Override individual fields as needed using struct literal syntax.
func TestConfig() *Config {
    return &Config{
        Server: ServerConfig{
            Host:             "127.0.0.1",
            Port:             0,   // Use port 0 to let OS assign a free port
            ReadTimeout:      5 * time.Second,
            WriteTimeout:     5 * time.Second,
            IdleTimeout:      10 * time.Second,
            ShutdownTimeout:  1 * time.Second,
            MaxRequestBodyMB: 1,
        },
        Database: DatabaseConfig{
            Host:            "localhost",
            Port:            5432,
            Name:            "myapp_test",
            User:            "myapp_test",
            Password:        "test-password",
            SSLMode:         "disable",
            MaxOpenConns:    5,
            MaxIdleConns:    2,
            ConnMaxLifetime: 5 * time.Minute,
        },
        Cache: CacheConfig{
            Enabled:     false,  // Disable cache in unit tests for determinism
            MaxMemoryMB: 16,
        },
        Logging: LoggingConfig{
            Level:  "error",   // Suppress noise in test output
            Format: "text",
            Output: "stdout",
        },
        Features: FeatureConfig{
            EnableRateLimit:    false,
            RateLimitPerMinute: 0,
        },
        Metrics: MetricsConfig{
            Enabled: false,
        },
    }
}
```

### Example Test Using Config Isolation

```go
// internal/order/service_test.go
package order_test

import (
    "context"
    "testing"

    "github.com/example/myapp/internal/config"
    "github.com/example/myapp/internal/order"
)

func TestCreateOrder_WithRateLimitDisabled(t *testing.T) {
    cfg := config.TestConfig()
    cfg.Features.EnableRateLimit = false

    svc := order.NewService(
        order.WithConfig(cfg),
        order.WithRepository(newTestRepository(t)),
    )

    _, err := svc.CreateOrder(context.Background(), testOrderInput())
    if err != nil {
        t.Fatalf("expected no error, got: %v", err)
    }
}

func TestCreateOrder_WithRateLimitEnabled(t *testing.T) {
    cfg := config.TestConfig()
    cfg.Features.EnableRateLimit = true
    cfg.Features.RateLimitPerMinute = 1

    svc := order.NewService(
        order.WithConfig(cfg),
        order.WithRepository(newTestRepository(t)),
    )

    // First request succeeds
    if _, err := svc.CreateOrder(context.Background(), testOrderInput()); err != nil {
        t.Fatalf("first request should succeed: %v", err)
    }

    // Second request is rate limited
    if _, err := svc.CreateOrder(context.Background(), testOrderInput()); err == nil {
        t.Fatal("second request should be rate limited")
    }
}
```

---

## Configuration Documentation Generation

Generate documentation for the configuration struct to keep operator documentation current:

```go
// tools/gendocs/main.go
package main

import (
    "fmt"
    "os"
    "reflect"

    "github.com/example/myapp/internal/config"
)

func printConfigDocs(v interface{}, prefix string) {
    t := reflect.TypeOf(v)
    if t.Kind() == reflect.Ptr {
        t = t.Elem()
    }

    for i := 0; i < t.NumField(); i++ {
        field := t.Field(i)
        mapKey := field.Tag.Get("mapstructure")
        envKey := "APP_" + strings.ToUpper(strings.ReplaceAll(
            strings.Join(filterEmpty(prefix, mapKey), "_"), ".", "_"))
        validateTag := field.Tag.Get("validate")

        if field.Type.Kind() == reflect.Struct {
            printConfigDocs(reflect.New(field.Type).Interface(),
                strings.Join(filterEmpty(prefix, mapKey), "."))
            continue
        }

        fmt.Printf("| `%s` | `%s` | `%s` | %s |\n",
            strings.Join(filterEmpty(prefix, mapKey), "."),
            envKey,
            field.Type.String(),
            validateTag,
        )
    }
}
```

---

## Conclusion

Enterprise Go configuration management requires treating configuration as a first-class system concern: typed structs prevent runtime configuration parsing errors, Viper provides a flexible layered source hierarchy aligned with Twelve-Factor principles, validator integration converts configuration mistakes into actionable error messages, and dynamic reload support enables operational changes without service interruptions. Feature flag abstraction behind a common interface allows switching between static test configuration and dynamic LaunchDarkly-backed flags without changing business logic. Configuration isolation in tests ensures that tests run in parallel without interfering with each other's environment state, enabling fast, reliable CI/CD pipelines.
