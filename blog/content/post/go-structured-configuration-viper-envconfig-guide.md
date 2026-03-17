---
title: "Go Structured Configuration: Viper, envconfig, and Configuration Validation with Production Best Practices"
date: 2028-08-23T00:00:00-05:00
draft: false
tags: ["Go", "Configuration", "Viper", "envconfig", "Validation", "12-Factor"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to structured configuration in Go using Viper and envconfig, covering environment variable binding, file-based config, validation, 12-factor principles, and production patterns for Kubernetes-deployed services."
more_link: "yes"
url: "/go-structured-configuration-viper-envconfig-guide/"
---

Configuration management is one of those areas where teams make the same mistakes repeatedly: hardcoded values in source, inconsistent environment variable naming, missing validation, and configuration that works locally but breaks in production. Go's ecosystem provides excellent libraries for building robust configuration systems. This guide covers the two most widely used approaches — Viper for feature-rich hierarchical config and envconfig for strict 12-factor environment variable mapping — along with validation, secrets integration, and patterns for Kubernetes-deployed services.

<!--more-->

# [Go Structured Configuration: Viper, envconfig, and Configuration Validation](#go-structured-configuration)

## Section 1: Configuration Principles for Production Go Services

### 12-Factor App Configuration

The 12-Factor methodology states that configuration should be stored in the environment. In practice, this means:

1. **No config in code** — No hardcoded hostnames, credentials, or feature flags
2. **Environment-per-deploy distinction** — Dev, staging, and prod differ only in environment variables
3. **Not in version control** — Secrets and environment-specific values never committed
4. **Fail fast on missing config** — Services should refuse to start with invalid configuration

### Configuration Source Priority (Most to Least Specific)

A well-designed Go service should support this priority order:

```
CLI flags > Environment variables > Config file > Remote config (Consul/etcd) > Defaults
```

Viper implements all of these layers. envconfig focuses purely on environment variables with strong typing and validation.

## Section 2: envconfig — Simple, Strict 12-Factor Configuration

`github.com/kelseyhightower/envconfig` is the minimal, correct way to map environment variables to a typed Go struct.

### Installation

```bash
go get github.com/kelseyhightower/envconfig
```

### Basic Usage

```go
package config

import (
	"log"
	"time"

	"github.com/kelseyhightower/envconfig"
)

type Config struct {
	// Server settings
	HTTPPort    int           `envconfig:"HTTP_PORT"    default:"8080"`
	MetricsPort int           `envconfig:"METRICS_PORT" default:"9090"`
	ReadTimeout  time.Duration `envconfig:"READ_TIMEOUT"  default:"30s"`
	WriteTimeout time.Duration `envconfig:"WRITE_TIMEOUT" default:"30s"`

	// Database settings
	DatabaseURL      string `envconfig:"DATABASE_URL"      required:"true"`
	DatabaseMaxConns int    `envconfig:"DATABASE_MAX_CONNS" default:"25"`
	DatabaseMinConns int    `envconfig:"DATABASE_MIN_CONNS" default:"5"`

	// Redis settings
	RedisAddr     string `envconfig:"REDIS_ADDR"     default:"localhost:6379"`
	RedisPassword string `envconfig:"REDIS_PASSWORD" default:""`
	RedisDB       int    `envconfig:"REDIS_DB"       default:"0"`

	// Feature flags
	EnableMetrics  bool `envconfig:"ENABLE_METRICS"  default:"true"`
	EnableTracing  bool `envconfig:"ENABLE_TRACING"  default:"false"`
	EnableProfiling bool `envconfig:"ENABLE_PROFILING" default:"false"`

	// Logging
	LogLevel  string `envconfig:"LOG_LEVEL"  default:"info"`
	LogFormat string `envconfig:"LOG_FORMAT" default:"json"`

	// Application
	AppName    string `envconfig:"APP_NAME"    default:"myservice"`
	AppVersion string `envconfig:"APP_VERSION" default:"unknown"`
	AppEnv     string `envconfig:"APP_ENV"     required:"true"`
}

func Load() (*Config, error) {
	var cfg Config
	if err := envconfig.Process("", &cfg); err != nil {
		return nil, fmt.Errorf("processing config: %w", err)
	}
	return &cfg, nil
}
```

### envconfig Struct Tags Reference

| Tag | Description | Example |
|-----|-------------|---------|
| `envconfig:"NAME"` | Environment variable name | `envconfig:"DB_HOST"` |
| `default:"value"` | Default if env var absent | `default:"localhost"` |
| `required:"true"` | Fail if env var absent | `required:"true"` |
| `split_words:"true"` | Auto-generate name from field | `split_words:"true"` |

### Using split_words for Clean Struct Definitions

```go
// With prefix "MYAPP", field DatabaseURL becomes MYAPP_DATABASE_URL
type Config struct {
	DatabaseURL  string `required:"true"`        // MYAPP_DATABASE_URL
	HTTPPort     int    `default:"8080"`          // MYAPP_HTTP_PORT
	LogLevel     string `default:"info"`          // MYAPP_LOG_LEVEL
}

func Load() (*Config, error) {
	var cfg Config
	// Process with prefix "MYAPP" — all env vars prefixed
	if err := envconfig.Process("MYAPP", &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}
```

### Custom Decoders for Complex Types

```go
package config

import (
	"fmt"
	"net/url"
	"strings"
)

// StringSlice decodes comma-separated strings
type StringSlice []string

func (s *StringSlice) Decode(value string) error {
	parts := strings.Split(value, ",")
	for i, p := range parts {
		parts[i] = strings.TrimSpace(p)
	}
	*s = parts
	return nil
}

// URLList decodes comma-separated URLs with validation
type URLList []*url.URL

func (u *URLList) Decode(value string) error {
	parts := strings.Split(value, ",")
	result := make([]*url.URL, 0, len(parts))
	for _, p := range parts {
		parsed, err := url.Parse(strings.TrimSpace(p))
		if err != nil {
			return fmt.Errorf("invalid URL %q: %w", p, err)
		}
		result = append(result, parsed)
	}
	*u = result
	return nil
}

type Config struct {
	AllowedOrigins StringSlice `envconfig:"ALLOWED_ORIGINS" default:"http://localhost:3000"`
	BootstrapNodes URLList     `envconfig:"BOOTSTRAP_NODES" required:"true"`
	TrustedProxies StringSlice `envconfig:"TRUSTED_PROXIES" default:""`
}
```

### Generating Usage Documentation

```go
func PrintUsage() {
	var cfg Config
	if err := envconfig.Usage("MYAPP", &cfg); err != nil {
		log.Fatal(err)
	}
}
```

Output:
```
KEY                          TYPE             DEFAULT    REQUIRED    DESCRIPTION
MYAPP_DATABASE_URL           String                      true
MYAPP_HTTP_PORT              Integer          8080
MYAPP_LOG_LEVEL              String           info
```

## Section 3: Viper — Hierarchical Multi-Source Configuration

Viper is the industry standard for Go services that need configuration from multiple sources: files, environment variables, remote key-value stores, and CLI flags.

### Installation

```bash
go get github.com/spf13/viper
go get github.com/spf13/cobra  # Optional: for CLI flag integration
```

### Complete Viper Setup

```go
package config

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/viper"
)

type ServerConfig struct {
	Host         string        `mapstructure:"host"`
	Port         int           `mapstructure:"port"`
	ReadTimeout  time.Duration `mapstructure:"read_timeout"`
	WriteTimeout time.Duration `mapstructure:"write_timeout"`
	IdleTimeout  time.Duration `mapstructure:"idle_timeout"`
}

type DatabaseConfig struct {
	DSN         string `mapstructure:"dsn"`
	MaxOpenConns int   `mapstructure:"max_open_conns"`
	MaxIdleConns int   `mapstructure:"max_idle_conns"`
	MaxLifetime  time.Duration `mapstructure:"max_lifetime"`
	SSLMode     string `mapstructure:"ssl_mode"`
}

type RedisConfig struct {
	Addr         string `mapstructure:"addr"`
	Password     string `mapstructure:"password"`
	DB           int    `mapstructure:"db"`
	PoolSize     int    `mapstructure:"pool_size"`
	DialTimeout  time.Duration `mapstructure:"dial_timeout"`
	ReadTimeout  time.Duration `mapstructure:"read_timeout"`
}

type ObservabilityConfig struct {
	MetricsEnabled bool   `mapstructure:"metrics_enabled"`
	TracingEnabled bool   `mapstructure:"tracing_enabled"`
	OTLPEndpoint   string `mapstructure:"otlp_endpoint"`
	SampleRate     float64 `mapstructure:"sample_rate"`
}

type Config struct {
	App           AppConfig           `mapstructure:"app"`
	Server        ServerConfig        `mapstructure:"server"`
	Database      DatabaseConfig      `mapstructure:"database"`
	Redis         RedisConfig         `mapstructure:"redis"`
	Observability ObservabilityConfig `mapstructure:"observability"`
}

type AppConfig struct {
	Name        string `mapstructure:"name"`
	Version     string `mapstructure:"version"`
	Environment string `mapstructure:"environment"`
	Debug       bool   `mapstructure:"debug"`
}

func setDefaults(v *viper.Viper) {
	// App defaults
	v.SetDefault("app.name", "myservice")
	v.SetDefault("app.version", "unknown")
	v.SetDefault("app.environment", "development")
	v.SetDefault("app.debug", false)

	// Server defaults
	v.SetDefault("server.host", "0.0.0.0")
	v.SetDefault("server.port", 8080)
	v.SetDefault("server.read_timeout", "30s")
	v.SetDefault("server.write_timeout", "30s")
	v.SetDefault("server.idle_timeout", "120s")

	// Database defaults
	v.SetDefault("database.max_open_conns", 25)
	v.SetDefault("database.max_idle_conns", 5)
	v.SetDefault("database.max_lifetime", "10m")
	v.SetDefault("database.ssl_mode", "require")

	// Redis defaults
	v.SetDefault("redis.addr", "localhost:6379")
	v.SetDefault("redis.db", 0)
	v.SetDefault("redis.pool_size", 10)
	v.SetDefault("redis.dial_timeout", "5s")
	v.SetDefault("redis.read_timeout", "3s")

	// Observability defaults
	v.SetDefault("observability.metrics_enabled", true)
	v.SetDefault("observability.tracing_enabled", false)
	v.SetDefault("observability.sample_rate", 0.1)
}

func Load(configFile string) (*Config, error) {
	v := viper.New()

	// Set defaults
	setDefaults(v)

	// Config file
	if configFile != "" {
		v.SetConfigFile(configFile)
	} else {
		v.SetConfigName("config")
		v.SetConfigType("yaml")
		v.AddConfigPath(".")
		v.AddConfigPath("/etc/myservice/")
		v.AddConfigPath("$HOME/.myservice")
	}

	if err := v.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, fmt.Errorf("reading config file: %w", err)
		}
		// Config file not found is acceptable; env vars cover it
	}

	// Environment variable binding
	// APP_SERVER_PORT maps to server.port
	v.SetEnvPrefix("APP")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("unmarshaling config: %w", err)
	}

	return &cfg, nil
}
```

### Config File Example (config.yaml)

```yaml
app:
  name: "payment-service"
  version: "2.3.1"
  environment: "production"
  debug: false

server:
  host: "0.0.0.0"
  port: 8080
  read_timeout: "30s"
  write_timeout: "30s"
  idle_timeout: "120s"

database:
  dsn: ""  # Set via APP_DATABASE_DSN environment variable
  max_open_conns: 50
  max_idle_conns: 10
  max_lifetime: "15m"
  ssl_mode: "require"

redis:
  addr: "redis-cluster:6379"
  db: 0
  pool_size: 20
  dial_timeout: "5s"
  read_timeout: "3s"

observability:
  metrics_enabled: true
  tracing_enabled: true
  otlp_endpoint: "http://otel-collector:4317"
  sample_rate: 0.05
```

### Environment Variable Override Pattern

```bash
# Config file sets redis.addr = "localhost:6379"
# Override in Kubernetes via environment variable:
export APP_REDIS_ADDR="redis-cluster.cache.svc.cluster.local:6379"
export APP_DATABASE_DSN="postgres://user:pass@pg.db.svc:5432/mydb?sslmode=require"
export APP_OBSERVABILITY_TRACING_ENABLED="true"
```

## Section 4: Configuration Validation

Neither Viper nor envconfig provide semantic validation. Add it with the `go-playground/validator` package.

### Installation

```bash
go get github.com/go-playground/validator/v10
```

### Struct Tags for Validation

```go
package config

import (
	"fmt"

	"github.com/go-playground/validator/v10"
)

type Config struct {
	App      AppConfig      `mapstructure:"app"      validate:"required"`
	Server   ServerConfig   `mapstructure:"server"   validate:"required"`
	Database DatabaseConfig `mapstructure:"database" validate:"required"`
}

type AppConfig struct {
	Name        string `mapstructure:"name"        validate:"required,min=1,max=64"`
	Environment string `mapstructure:"environment" validate:"required,oneof=development staging production"`
	Debug       bool   `mapstructure:"debug"`
}

type ServerConfig struct {
	Host string `mapstructure:"host" validate:"required,ip|hostname"`
	Port int    `mapstructure:"port" validate:"required,min=1,max=65535"`
}

type DatabaseConfig struct {
	DSN          string `mapstructure:"dsn"           validate:"required,url"`
	MaxOpenConns int    `mapstructure:"max_open_conns" validate:"min=1,max=1000"`
	MaxIdleConns int    `mapstructure:"max_idle_conns" validate:"min=0"`
	SSLMode      string `mapstructure:"ssl_mode"       validate:"oneof=disable allow prefer require verify-ca verify-full"`
}

var validate = validator.New()

func (c *Config) Validate() error {
	if err := validate.Struct(c); err != nil {
		var validationErrors validator.ValidationErrors
		if errors.As(err, &validationErrors) {
			msgs := make([]string, 0, len(validationErrors))
			for _, e := range validationErrors {
				msgs = append(msgs, fmt.Sprintf(
					"field %s: failed %s validation (value: %v)",
					e.Field(), e.Tag(), e.Value(),
				))
			}
			return fmt.Errorf("configuration validation failed:\n  %s", strings.Join(msgs, "\n  "))
		}
		return fmt.Errorf("validation error: %w", err)
	}
	return nil
}
```

### Custom Validation Rules

```go
func registerCustomValidations(v *validator.Validate) {
	// Validate DSN format
	v.RegisterValidation("postgres_dsn", func(fl validator.FieldLevel) bool {
		dsn := fl.Field().String()
		return strings.HasPrefix(dsn, "postgres://") ||
			strings.HasPrefix(dsn, "postgresql://")
	})

	// Validate log level
	v.RegisterValidation("log_level", func(fl validator.FieldLevel) bool {
		level := strings.ToLower(fl.Field().String())
		validLevels := map[string]bool{
			"debug": true, "info": true, "warn": true,
			"error": true, "fatal": true, "panic": true,
		}
		return validLevels[level]
	})

	// Validate duration string
	v.RegisterValidation("duration", func(fl validator.FieldLevel) bool {
		_, err := time.ParseDuration(fl.Field().String())
		return err == nil
	})
}
```

## Section 5: Cross-Validation and Business Logic Validation

Some validation rules require comparing multiple fields:

```go
func (c *Config) validateBusinessRules() error {
	var errs []string

	// MaxIdleConns must be <= MaxOpenConns
	if c.Database.MaxIdleConns > c.Database.MaxOpenConns {
		errs = append(errs, fmt.Sprintf(
			"database.max_idle_conns (%d) must not exceed max_open_conns (%d)",
			c.Database.MaxIdleConns, c.Database.MaxOpenConns,
		))
	}

	// Tracing requires OTLP endpoint
	if c.Observability.TracingEnabled && c.Observability.OTLPEndpoint == "" {
		errs = append(errs, "observability.otlp_endpoint is required when tracing is enabled")
	}

	// Production requires TLS
	if c.App.Environment == "production" && c.Database.SSLMode == "disable" {
		errs = append(errs, "database SSL must be enabled in production")
	}

	// Production disallows debug mode
	if c.App.Environment == "production" && c.App.Debug {
		errs = append(errs, "debug mode must be disabled in production")
	}

	// Sample rate bounds check
	if c.Observability.SampleRate < 0 || c.Observability.SampleRate > 1.0 {
		errs = append(errs, fmt.Sprintf(
			"observability.sample_rate must be between 0 and 1, got %f",
			c.Observability.SampleRate,
		))
	}

	if len(errs) > 0 {
		return fmt.Errorf("business rule violations:\n  %s", strings.Join(errs, "\n  "))
	}
	return nil
}

// Complete validation
func (c *Config) ValidateAll() error {
	if err := c.Validate(); err != nil {
		return err
	}
	return c.validateBusinessRules()
}
```

## Section 6: Secrets Management Integration

### Kubernetes Secrets as Environment Variables

The simplest approach: mount Kubernetes Secrets as env vars. Works with both envconfig and Viper.

```yaml
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - name: app
        env:
        - name: APP_DATABASE_DSN
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: database-dsn
        - name: APP_REDIS_PASSWORD
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: redis-password
        - name: APP_JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: jwt-secret
```

### Vault Agent Sidecar Secret Injection

For dynamic secrets that rotate, use Vault Agent to write secrets to a file, then read the file in Go:

```go
package config

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

// DynamicSecrets reads secrets from files written by Vault Agent
type DynamicSecrets struct {
	mu           sync.RWMutex
	dbPassword   string
	apiKey       string
	lastModified time.Time
	secretsFile  string
}

type secretsFile struct {
	DatabasePassword string `json:"database_password"`
	APIKey           string `json:"api_key"`
}

func NewDynamicSecrets(path string) (*DynamicSecrets, error) {
	ds := &DynamicSecrets{secretsFile: path}
	if err := ds.reload(); err != nil {
		return nil, fmt.Errorf("loading initial secrets: %w", err)
	}
	go ds.watchForChanges()
	return ds, nil
}

func (ds *DynamicSecrets) reload() error {
	data, err := os.ReadFile(ds.secretsFile)
	if err != nil {
		return fmt.Errorf("reading secrets file: %w", err)
	}

	var s secretsFile
	if err := json.Unmarshal(data, &s); err != nil {
		return fmt.Errorf("parsing secrets file: %w", err)
	}

	ds.mu.Lock()
	defer ds.mu.Unlock()
	ds.dbPassword = s.DatabasePassword
	ds.apiKey = s.APIKey
	ds.lastModified = time.Now()
	return nil
}

func (ds *DynamicSecrets) watchForChanges() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if err := ds.reload(); err != nil {
			slog.Error("Failed to reload secrets", "error", err)
		}
	}
}

func (ds *DynamicSecrets) DatabasePassword() string {
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	return ds.dbPassword
}
```

## Section 7: Configuration Hot Reloading with Viper

Viper supports watching config files for changes:

```go
package config

import (
	"log/slog"
	"sync"

	"github.com/fsnotify/fsnotify"
	"github.com/spf13/viper"
)

type Manager struct {
	mu      sync.RWMutex
	current *Config
	viper   *viper.Viper
	onChange []func(*Config)
}

func NewManager(configFile string) (*Manager, error) {
	m := &Manager{
		viper: viper.New(),
	}

	setDefaults(m.viper)

	m.viper.SetConfigFile(configFile)
	if err := m.viper.ReadInConfig(); err != nil {
		return nil, fmt.Errorf("reading config: %w", err)
	}

	cfg, err := m.unmarshalAndValidate()
	if err != nil {
		return nil, err
	}
	m.current = cfg

	// Watch for changes
	m.viper.WatchConfig()
	m.viper.OnConfigChange(func(e fsnotify.Event) {
		slog.Info("Config file changed", "file", e.Name)

		newCfg, err := m.unmarshalAndValidate()
		if err != nil {
			slog.Error("Invalid config change, keeping previous config", "error", err)
			return
		}

		m.mu.Lock()
		m.current = newCfg
		m.mu.Unlock()

		// Notify registered handlers
		for _, handler := range m.onChange {
			handler(newCfg)
		}

		slog.Info("Configuration reloaded successfully")
	})

	return m, nil
}

func (m *Manager) Get() *Config {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.current
}

func (m *Manager) OnChange(fn func(*Config)) {
	m.onChange = append(m.onChange, fn)
}

func (m *Manager) unmarshalAndValidate() (*Config, error) {
	var cfg Config
	if err := m.viper.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("unmarshaling: %w", err)
	}
	if err := cfg.ValidateAll(); err != nil {
		return nil, err
	}
	return &cfg, nil
}
```

## Section 8: Kubernetes ConfigMap Integration

### Mounting ConfigMap as a Config File

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: myservice-config
  namespace: production
data:
  config.yaml: |
    app:
      name: "payment-service"
      environment: "production"
      debug: false

    server:
      port: 8080
      read_timeout: "30s"
      write_timeout: "30s"

    database:
      max_open_conns: 50
      max_idle_conns: 10
      ssl_mode: "require"

    observability:
      metrics_enabled: true
      tracing_enabled: true
      otlp_endpoint: "http://otel-collector.monitoring:4317"
      sample_rate: 0.05
---
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - name: app
        image: payment-service:v2.3.1
        args: ["--config", "/etc/myservice/config.yaml"]
        volumeMounts:
        - name: config
          mountPath: /etc/myservice
          readOnly: true
        env:
        - name: APP_DATABASE_DSN
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: dsn

      volumes:
      - name: config
        configMap:
          name: myservice-config
```

### Hot Reloading ConfigMap Changes

When a ConfigMap is mounted as a volume, Kubernetes updates the file when the ConfigMap changes (with a short delay, ~1 minute by default). Viper's `WatchConfig()` picks this up automatically.

```go
// In main.go
manager, err := config.NewManager("/etc/myservice/config.yaml")
if err != nil {
    log.Fatalf("Failed to load config: %v", err)
}

// Register handlers for dynamic reloads
manager.OnChange(func(cfg *config.Config) {
    // Update rate limiters, feature flags, etc.
    rateLimiter.SetRate(cfg.App.RateLimit)
    logger.SetLevel(parseLogLevel(cfg.App.LogLevel))
})
```

## Section 9: CLI Flag Integration with Cobra + Viper

```go
package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

var cfgFile string

var rootCmd = &cobra.Command{
	Use:   "myservice",
	Short: "Payment processing service",
	RunE:  runServer,
}

func init() {
	cobra.OnInitialize(initConfig)

	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default: config.yaml)")
	rootCmd.PersistentFlags().String("log-level", "info", "log level (debug, info, warn, error)")
	rootCmd.PersistentFlags().Int("port", 8080, "HTTP server port")
	rootCmd.PersistentFlags().Bool("debug", false, "enable debug mode")

	// Bind flags to Viper keys
	viper.BindPFlag("app.debug", rootCmd.PersistentFlags().Lookup("debug"))
	viper.BindPFlag("server.port", rootCmd.PersistentFlags().Lookup("port"))
	viper.BindPFlag("app.log_level", rootCmd.PersistentFlags().Lookup("log-level"))
}

func initConfig() {
	if cfgFile != "" {
		viper.SetConfigFile(cfgFile)
	} else {
		viper.SetConfigName("config")
		viper.SetConfigType("yaml")
		viper.AddConfigPath(".")
		viper.AddConfigPath("/etc/myservice/")
	}

	viper.SetEnvPrefix("APP")
	viper.AutomaticEnv()

	if err := viper.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			fmt.Fprintln(os.Stderr, "Error reading config:", err)
			os.Exit(1)
		}
	}
}

func runServer(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		return fmt.Errorf("loading config: %w", err)
	}
	if err := cfg.ValidateAll(); err != nil {
		return fmt.Errorf("invalid configuration: %w", err)
	}

	server := app.NewServer(cfg)
	return server.Run()
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}
```

## Section 10: Testing Configuration

### Unit Testing Config Loading

```go
package config_test

import (
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/myorg/myservice/internal/config"
)

func TestLoadFromEnvironment(t *testing.T) {
	// Set required environment variables
	t.Setenv("APP_DATABASE_DSN", "postgres://user:pass@localhost:5432/testdb?sslmode=disable")
	t.Setenv("APP_APP_ENVIRONMENT", "development")

	cfg, err := config.Load("")
	require.NoError(t, err)
	require.NotNil(t, cfg)

	assert.Equal(t, "postgres://user:pass@localhost:5432/testdb?sslmode=disable", cfg.Database.DSN)
	assert.Equal(t, "development", cfg.App.Environment)
	assert.Equal(t, 8080, cfg.Server.Port)               // default
	assert.Equal(t, 30*time.Second, cfg.Server.ReadTimeout) // default
}

func TestValidationFailsInProductionWithDebug(t *testing.T) {
	t.Setenv("APP_DATABASE_DSN", "postgres://user:pass@localhost:5432/testdb?sslmode=require")
	t.Setenv("APP_APP_ENVIRONMENT", "production")
	t.Setenv("APP_APP_DEBUG", "true")  // Debug in production: should fail

	cfg, err := config.Load("")
	require.NoError(t, err)

	err = cfg.ValidateAll()
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "debug mode must be disabled in production")
}

func TestValidationFailsMissingTracingEndpoint(t *testing.T) {
	t.Setenv("APP_DATABASE_DSN", "postgres://user:pass@localhost:5432/testdb?sslmode=require")
	t.Setenv("APP_APP_ENVIRONMENT", "production")
	t.Setenv("APP_OBSERVABILITY_TRACING_ENABLED", "true")
	// Intentionally NOT setting APP_OBSERVABILITY_OTLP_ENDPOINT

	cfg, err := config.Load("")
	require.NoError(t, err)

	err = cfg.ValidateAll()
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "otlp_endpoint is required when tracing is enabled")
}

func TestConfigFromFile(t *testing.T) {
	// Write a temp config file
	content := `
app:
  name: "test-service"
  environment: "development"
server:
  port: 9090
database:
  dsn: "postgres://localhost/testdb?sslmode=disable"
  max_open_conns: 10
  max_idle_conns: 3
`
	f, err := os.CreateTemp("", "config-*.yaml")
	require.NoError(t, err)
	defer os.Remove(f.Name())

	_, err = f.WriteString(content)
	require.NoError(t, err)
	f.Close()

	cfg, err := config.Load(f.Name())
	require.NoError(t, err)

	assert.Equal(t, "test-service", cfg.App.Name)
	assert.Equal(t, 9090, cfg.Server.Port)
	assert.Equal(t, 10, cfg.Database.MaxOpenConns)
}
```

## Section 11: Logging Config at Startup

Always log the active configuration at startup — excluding secrets. This is invaluable for debugging production issues.

```go
package config

import (
	"log/slog"
)

// LogSafeConfig returns a copy with secrets redacted
func (c *Config) LogSafe() map[string]any {
	return map[string]any{
		"app": map[string]any{
			"name":        c.App.Name,
			"version":     c.App.Version,
			"environment": c.App.Environment,
			"debug":       c.App.Debug,
		},
		"server": map[string]any{
			"host":          c.Server.Host,
			"port":          c.Server.Port,
			"read_timeout":  c.Server.ReadTimeout.String(),
			"write_timeout": c.Server.WriteTimeout.String(),
		},
		"database": map[string]any{
			"dsn":            "[REDACTED]",  // Never log the DSN
			"max_open_conns": c.Database.MaxOpenConns,
			"max_idle_conns": c.Database.MaxIdleConns,
			"ssl_mode":       c.Database.SSLMode,
		},
		"redis": map[string]any{
			"addr":      c.Redis.Addr,
			"db":        c.Redis.DB,
			"pool_size": c.Redis.PoolSize,
			// password omitted
		},
		"observability": map[string]any{
			"metrics_enabled": c.Observability.MetricsEnabled,
			"tracing_enabled": c.Observability.TracingEnabled,
			"otlp_endpoint":   c.Observability.OTLPEndpoint,
			"sample_rate":     c.Observability.SampleRate,
		},
	}
}

// In main.go:
func main() {
	cfg, err := config.Load(configFile)
	if err != nil {
		slog.Error("Failed to load configuration", "error", err)
		os.Exit(1)
	}

	if err := cfg.ValidateAll(); err != nil {
		slog.Error("Invalid configuration", "error", err)
		os.Exit(1)
	}

	slog.Info("Configuration loaded", "config", cfg.LogSafe())
	// Continue with server startup...
}
```

## Section 12: Production Checklist

### Configuration Security

```bash
# Check that secrets are not in environment variable names that log automatically
# Audit env vars in CI
env | grep -i "password\|secret\|key\|token\|credential" | wc -l

# Ensure ConfigMaps don't contain secrets
kubectl get configmap myservice-config -n production -o yaml | \
  grep -iE "password|secret|token|key"
```

### Kubernetes ConfigMap Immutable (for versioning)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: myservice-config-v2-3-1  # Version in the name
  namespace: production
immutable: true  # Kubernetes 1.21+: prevents accidental changes
data:
  config.yaml: |
    # ... config content
```

### Summary of Configuration Library Choice

| Criteria | envconfig | Viper |
|----------|-----------|-------|
| 12-Factor strict env-only | Excellent | Good (AutomaticEnv) |
| Config file support | No | Yes (YAML, TOML, JSON, HCL) |
| Remote config (Consul/etcd) | No | Yes |
| CLI flag integration | No | Yes (Cobra) |
| Hot reload | No | Yes (WatchConfig) |
| Simplicity | High | Medium |
| Type safety | High | Medium (mapstructure) |
| Nested config | Limited | Excellent |

Use envconfig for microservices that should be purely environment-driven. Use Viper when you need file-based config, remote config stores, or deep CLI integration. Use both together: envconfig for secrets (required env vars), Viper for everything else.
