---
title: "Go Configuration Management: Viper, Environment Variables, and Secrets Integration"
date: 2027-09-10T00:00:00-05:00
draft: false
tags: ["Go", "Configuration", "Viper", "Secrets"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Go configuration patterns using Viper: multi-source config with precedence, env var binding, Kubernetes ConfigMap mounting, hot-reload via fsnotify, and HashiCorp Vault and AWS Secrets Manager integration."
more_link: "yes"
url: "/go-configuration-management-viper-guide/"
---

Configuration management is one of those problems that looks simple until a production service fails because a default was wrong, an environment variable was silently ignored, or a secret rotation restarted a pod mid-request. A robust Go configuration layer reads from multiple sources with a well-defined precedence order, validates every value at startup, supports hot-reload for non-sensitive settings, and integrates cleanly with secret backends like HashiCorp Vault and AWS Secrets Manager. This guide builds that layer step by step.

<!--more-->

## Section 1: Viper Fundamentals

`spf13/viper` reads configuration from files, environment variables, remote key-value stores, and defaults, merging them with a clear precedence order:

```text
1. explicit Set()           (highest priority)
2. flags (pflags)
3. environment variables
4. config file
5. key/value store
6. defaults                 (lowest priority)
```

```bash
go get github.com/spf13/viper@v1.19.0
go get github.com/spf13/cobra@v1.8.1  # optional, pairs naturally with viper
```

### Minimal Setup

```go
package config

import (
    "fmt"
    "strings"
    "time"

    "github.com/spf13/viper"
)

// Config holds all application configuration.
type Config struct {
    Server   ServerConfig
    Database DatabaseConfig
    Cache    CacheConfig
    Log      LogConfig
}

type ServerConfig struct {
    Port            int           `mapstructure:"port"`
    ReadTimeout     time.Duration `mapstructure:"read_timeout"`
    WriteTimeout    time.Duration `mapstructure:"write_timeout"`
    ShutdownTimeout time.Duration `mapstructure:"shutdown_timeout"`
}

type DatabaseConfig struct {
    Host     string `mapstructure:"host"`
    Port     int    `mapstructure:"port"`
    Name     string `mapstructure:"name"`
    User     string `mapstructure:"user"`
    Password string `mapstructure:"password"` // injected from secret backend
    SSLMode  string `mapstructure:"ssl_mode"`
    MaxConns int    `mapstructure:"max_conns"`
}

type CacheConfig struct {
    Addr     string        `mapstructure:"addr"`
    Password string        `mapstructure:"password"`
    DB       int           `mapstructure:"db"`
    TTL      time.Duration `mapstructure:"ttl"`
}

type LogConfig struct {
    Level  string `mapstructure:"level"`
    Format string `mapstructure:"format"` // json or text
}
```

## Section 2: Multi-Source Configuration with Precedence

```go
package config

import (
    "fmt"
    "strings"

    "github.com/spf13/viper"
)

// Load builds a Config from defaults, a config file, and environment variables.
func Load(configPath string) (*Config, error) {
    v := viper.New()

    setDefaults(v)
    bindEnvVars(v)

    if configPath != "" {
        v.SetConfigFile(configPath)
    } else {
        v.SetConfigName("config")
        v.SetConfigType("yaml")
        v.AddConfigPath("/etc/myapp/")
        v.AddConfigPath("$HOME/.myapp")
        v.AddConfigPath(".")
    }

    if err := v.ReadInConfig(); err != nil {
        if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
            return nil, fmt.Errorf("read config file: %w", err)
        }
        // Config file not found is acceptable; use defaults + env vars.
    }

    var cfg Config
    if err := v.Unmarshal(&cfg); err != nil {
        return nil, fmt.Errorf("unmarshal config: %w", err)
    }

    if err := validate(&cfg); err != nil {
        return nil, fmt.Errorf("config validation: %w", err)
    }

    return &cfg, nil
}

func setDefaults(v *viper.Viper) {
    v.SetDefault("server.port", 8080)
    v.SetDefault("server.read_timeout", "15s")
    v.SetDefault("server.write_timeout", "30s")
    v.SetDefault("server.shutdown_timeout", "30s")

    v.SetDefault("database.host", "localhost")
    v.SetDefault("database.port", 5432)
    v.SetDefault("database.ssl_mode", "disable")
    v.SetDefault("database.max_conns", 25)

    v.SetDefault("cache.db", 0)
    v.SetDefault("cache.ttl", "5m")

    v.SetDefault("log.level", "info")
    v.SetDefault("log.format", "json")
}

func bindEnvVars(v *viper.Viper) {
    // APP_ prefix for all environment variables.
    v.SetEnvPrefix("APP")
    v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
    v.AutomaticEnv()

    // Explicit bindings for non-obvious mappings.
    _ = v.BindEnv("database.host", "APP_DB_HOST")
    _ = v.BindEnv("database.port", "APP_DB_PORT")
    _ = v.BindEnv("database.name", "APP_DB_NAME")
    _ = v.BindEnv("database.user", "APP_DB_USER")
    _ = v.BindEnv("database.password", "APP_DB_PASSWORD")
    _ = v.BindEnv("cache.addr", "APP_REDIS_ADDR")
    _ = v.BindEnv("cache.password", "APP_REDIS_PASSWORD")
}
```

### YAML Config File Example

```yaml
# /etc/myapp/config.yaml
server:
  port: 8080
  read_timeout: 15s
  write_timeout: 30s
  shutdown_timeout: 30s

database:
  host: postgres.internal
  port: 5432
  name: myapp
  user: myapp_user
  ssl_mode: require
  max_conns: 50

cache:
  addr: redis.internal:6379
  db: 0
  ttl: 10m

log:
  level: info
  format: json
```

## Section 3: Kubernetes ConfigMap Mounting

Mount the YAML file as a ConfigMap volume and reference environment-specific files:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: myapp-config
  namespace: production
data:
  config.yaml: |
    server:
      port: 8080
      read_timeout: 15s
    database:
      host: postgres.production.svc.cluster.local
      port: 5432
      name: myapp
      user: myapp_user
      ssl_mode: require
      max_conns: 100
    log:
      level: warn
      format: json
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
spec:
  template:
    spec:
      containers:
      - name: myapp
        image: myapp:latest
        args: ["--config=/etc/myapp/config.yaml"]
        env:
        - name: APP_DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: myapp-db-secret
              key: password
        - name: APP_REDIS_PASSWORD
          valueFrom:
            secretKeyRef:
              name: myapp-redis-secret
              key: password
        volumeMounts:
        - name: config
          mountPath: /etc/myapp
          readOnly: true
      volumes:
      - name: config
        configMap:
          name: myapp-config
```

## Section 4: Hot-Reload via fsnotify

Viper uses `fsnotify` under the hood. Register a callback to reload non-sensitive configuration without restarting the process:

```go
package config

import (
    "log/slog"
    "sync/atomic"
    "unsafe"

    "github.com/fsnotify/fsnotify"
    "github.com/spf13/viper"
)

// Manager holds an atomically updated Config pointer.
type Manager struct {
    v      *viper.Viper
    cfg    atomic.Pointer[Config]
    logger *slog.Logger
}

// NewManager loads config and starts the file watcher.
func NewManager(configPath string, logger *slog.Logger) (*Manager, error) {
    m := &Manager{v: viper.New(), logger: logger}
    setDefaults(m.v)
    bindEnvVars(m.v)

    if configPath != "" {
        m.v.SetConfigFile(configPath)
    }
    if err := m.v.ReadInConfig(); err != nil {
        return nil, err
    }

    cfg, err := unmarshalAndValidate(m.v)
    if err != nil {
        return nil, err
    }
    m.cfg.Store(cfg)

    m.v.OnConfigChange(func(e fsnotify.Event) {
        logger.Info("config file changed", slog.String("file", e.Name))
        newCfg, err := unmarshalAndValidate(m.v)
        if err != nil {
            logger.Error("config reload failed", slog.String("error", err.Error()))
            return
        }
        // Preserve secrets injected at startup — do not overwrite from file.
        current := m.cfg.Load()
        newCfg.Database.Password = current.Database.Password
        newCfg.Cache.Password = current.Cache.Password
        m.cfg.Store(newCfg)
        logger.Info("config reloaded successfully")
    })
    m.v.WatchConfig()

    return m, nil
}

// Get returns the current Config snapshot.
func (m *Manager) Get() *Config {
    return m.cfg.Load()
}

func unmarshalAndValidate(v *viper.Viper) (*Config, error) {
    var cfg Config
    if err := v.Unmarshal(&cfg); err != nil {
        return nil, err
    }
    return &cfg, validate(&cfg)
}
```

## Section 5: Configuration Validation

Validate all fields at startup to surface misconfiguration before serving traffic:

```go
package config

import (
    "errors"
    "fmt"
    "net"
    "strings"
)

func validate(cfg *Config) error {
    var errs []string

    if cfg.Server.Port < 1 || cfg.Server.Port > 65535 {
        errs = append(errs, fmt.Sprintf("server.port %d is not in range 1-65535", cfg.Server.Port))
    }
    if cfg.Server.ReadTimeout <= 0 {
        errs = append(errs, "server.read_timeout must be positive")
    }
    if cfg.Database.Host == "" {
        errs = append(errs, "database.host is required")
    }
    if cfg.Database.Name == "" {
        errs = append(errs, "database.name is required")
    }
    if cfg.Database.User == "" {
        errs = append(errs, "database.user is required")
    }
    if cfg.Database.MaxConns < 1 {
        errs = append(errs, "database.max_conns must be at least 1")
    }
    validSSLModes := map[string]bool{
        "disable": true, "require": true,
        "verify-ca": true, "verify-full": true,
    }
    if !validSSLModes[cfg.Database.SSLMode] {
        errs = append(errs, fmt.Sprintf("database.ssl_mode %q is invalid", cfg.Database.SSLMode))
    }

    if cfg.Cache.Addr != "" {
        if _, _, err := net.SplitHostPort(cfg.Cache.Addr); err != nil {
            errs = append(errs, fmt.Sprintf("cache.addr %q is not a valid host:port", cfg.Cache.Addr))
        }
    }

    validLevels := map[string]bool{"debug": true, "info": true, "warn": true, "error": true}
    if !validLevels[strings.ToLower(cfg.Log.Level)] {
        errs = append(errs, fmt.Sprintf("log.level %q is invalid", cfg.Log.Level))
    }

    if len(errs) > 0 {
        return errors.New("configuration errors:\n  - " + strings.Join(errs, "\n  - "))
    }
    return nil
}
```

## Section 6: HashiCorp Vault Integration

Inject secrets from Vault at startup without using the Viper remote backend (which uses a polling model inappropriate for secrets):

```go
package secrets

import (
    "context"
    "fmt"

    vault "github.com/hashicorp/vault/api"
    auth "github.com/hashicorp/vault/api/auth/kubernetes"
)

// VaultClient wraps the Vault API client.
type VaultClient struct {
    client *vault.Client
}

// NewVaultClient creates a Vault client authenticated via Kubernetes service account.
func NewVaultClient(addr, role string) (*VaultClient, error) {
    cfg := vault.DefaultConfig()
    cfg.Address = addr

    client, err := vault.NewClient(cfg)
    if err != nil {
        return nil, fmt.Errorf("vault client: %w", err)
    }

    k8sAuth, err := auth.NewKubernetesAuth(role)
    if err != nil {
        return nil, fmt.Errorf("kubernetes auth: %w", err)
    }

    authInfo, err := client.Auth().Login(context.Background(), k8sAuth)
    if err != nil {
        return nil, fmt.Errorf("vault login: %w", err)
    }
    if authInfo == nil {
        return nil, fmt.Errorf("vault login returned empty auth info")
    }

    return &VaultClient{client: client}, nil
}

// GetSecret reads a KV v2 secret and returns its data map.
func (v *VaultClient) GetSecret(ctx context.Context, path string) (map[string]interface{}, error) {
    secret, err := v.client.KVv2("secret").Get(ctx, path)
    if err != nil {
        return nil, fmt.Errorf("get secret %q: %w", path, err)
    }
    if secret == nil || secret.Data == nil {
        return nil, fmt.Errorf("secret %q not found", path)
    }
    return secret.Data, nil
}

// GetString retrieves a single string value from a KV v2 secret.
func (v *VaultClient) GetString(ctx context.Context, path, key string) (string, error) {
    data, err := v.GetSecret(ctx, path)
    if err != nil {
        return "", err
    }
    val, ok := data[key]
    if !ok {
        return "", fmt.Errorf("key %q not found in secret %q", key, path)
    }
    str, ok := val.(string)
    if !ok {
        return "", fmt.Errorf("key %q in secret %q is not a string", key, path)
    }
    return str, nil
}
```

### Injecting Vault Secrets into Config

```go
package config

import (
    "context"
    "fmt"

    "github.com/example/myapp/internal/secrets"
)

// InjectVaultSecrets loads secrets from Vault and populates the sensitive
// fields in cfg that should not come from environment variables or config files.
func InjectVaultSecrets(ctx context.Context, cfg *Config, vc *secrets.VaultClient) error {
    dbPass, err := vc.GetString(ctx, "myapp/database", "password")
    if err != nil {
        return fmt.Errorf("database password: %w", err)
    }
    cfg.Database.Password = dbPass

    redisPass, err := vc.GetString(ctx, "myapp/redis", "password")
    if err != nil {
        return fmt.Errorf("redis password: %w", err)
    }
    cfg.Cache.Password = redisPass

    return nil
}
```

## Section 7: AWS Secrets Manager Integration

```go
package secrets

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/secretsmanager"
)

// AWSSecretsClient wraps the AWS Secrets Manager client.
type AWSSecretsClient struct {
    client *secretsmanager.Client
}

// NewAWSSecretsClient creates a client using the default credential chain
// (IAM role, environment variables, or EC2 instance profile).
func NewAWSSecretsClient(ctx context.Context, region string) (*AWSSecretsClient, error) {
    cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
    if err != nil {
        return nil, fmt.Errorf("aws config: %w", err)
    }
    return &AWSSecretsClient{client: secretsmanager.NewFromConfig(cfg)}, nil
}

// GetJSON retrieves a secret and unmarshals its JSON value into dst.
func (a *AWSSecretsClient) GetJSON(ctx context.Context, secretName string, dst interface{}) error {
    out, err := a.client.GetSecretValue(ctx, &secretsmanager.GetSecretValueInput{
        SecretId: &secretName,
    })
    if err != nil {
        return fmt.Errorf("get secret %q: %w", secretName, err)
    }
    if out.SecretString == nil {
        return fmt.Errorf("secret %q has no string value", secretName)
    }
    if err := json.Unmarshal([]byte(*out.SecretString), dst); err != nil {
        return fmt.Errorf("unmarshal secret %q: %w", secretName, err)
    }
    return nil
}

// DatabaseCredentials matches the JSON structure stored in AWS Secrets Manager.
type DatabaseCredentials struct {
    Username string `json:"username"`
    Password string `json:"password"`
    Host     string `json:"host"`
    Port     int    `json:"port"`
    DBName   string `json:"dbname"`
}

// InjectAWSSecrets loads database credentials from AWS Secrets Manager.
func InjectAWSSecrets(ctx context.Context, cfg *Config, asc *AWSSecretsClient) error {
    var creds DatabaseCredentials
    secretName := fmt.Sprintf("myapp/%s/database", cfg.Environment)
    if err := asc.GetJSON(ctx, secretName, &creds); err != nil {
        return fmt.Errorf("database credentials: %w", err)
    }
    cfg.Database.Host = creds.Host
    cfg.Database.Port = creds.Port
    cfg.Database.Name = creds.DBName
    cfg.Database.User = creds.Username
    cfg.Database.Password = creds.Password
    return nil
}
```

## Section 8: main.go Wiring

Assemble the configuration pipeline in `main.go` before starting any services:

```go
package main

import (
    "context"
    "flag"
    "log/slog"
    "os"

    "github.com/example/myapp/internal/config"
    "github.com/example/myapp/internal/secrets"
)

func main() {
    configPath := flag.String("config", "", "path to config file (default: auto-discover)")
    flag.Parse()

    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    cfgMgr, err := config.NewManager(*configPath, logger)
    if err != nil {
        logger.Error("config load failed", slog.String("error", err.Error()))
        os.Exit(1)
    }
    cfg := cfgMgr.Get()

    ctx := context.Background()

    // Inject secrets based on the runtime environment.
    switch os.Getenv("APP_SECRET_BACKEND") {
    case "vault":
        vc, err := secrets.NewVaultClient(
            os.Getenv("VAULT_ADDR"),
            os.Getenv("VAULT_ROLE"),
        )
        if err != nil {
            logger.Error("vault client init failed", slog.String("error", err.Error()))
            os.Exit(1)
        }
        if err := config.InjectVaultSecrets(ctx, cfg, vc); err != nil {
            logger.Error("vault secret injection failed", slog.String("error", err.Error()))
            os.Exit(1)
        }
    case "aws":
        asc, err := secrets.NewAWSSecretsClient(ctx, os.Getenv("AWS_REGION"))
        if err != nil {
            logger.Error("aws secrets client init failed", slog.String("error", err.Error()))
            os.Exit(1)
        }
        if err := config.InjectAWSSecrets(ctx, cfg, asc); err != nil {
            logger.Error("aws secret injection failed", slog.String("error", err.Error()))
            os.Exit(1)
        }
    case "env":
        // Secrets already available via environment variables; validation covers them.
    default:
        logger.Warn("APP_SECRET_BACKEND not set; using environment variables only")
    }

    // Re-validate after secret injection.
    if err := config.Validate(cfg); err != nil {
        logger.Error("post-injection validation failed", slog.String("error", err.Error()))
        os.Exit(1)
    }

    logger.Info("configuration loaded successfully",
        slog.String("db_host", cfg.Database.Host),
        slog.Int("server_port", cfg.Server.Port),
        slog.String("log_level", cfg.Log.Level),
    )

    // Start the application...
}
```

## Section 9: Testing Configuration Loading

```go
package config_test

import (
    "os"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "github.com/example/myapp/internal/config"
)

func TestLoad_Defaults(t *testing.T) {
    // Clear any env vars that might bleed in from the test environment.
    t.Setenv("APP_DB_HOST", "")
    t.Setenv("APP_DB_NAME", "")
    t.Setenv("APP_DB_USER", "")

    cfg, err := config.Load("")
    require.NoError(t, err)
    assert.Equal(t, 8080, cfg.Server.Port)
    assert.Equal(t, 15*time.Second, cfg.Server.ReadTimeout)
    assert.Equal(t, 25, cfg.Database.MaxConns)
}

func TestLoad_EnvVarOverridesDefault(t *testing.T) {
    t.Setenv("APP_SERVER_PORT", "9090")
    t.Setenv("APP_DB_HOST", "pg.test")
    t.Setenv("APP_DB_NAME", "testdb")
    t.Setenv("APP_DB_USER", "testuser")

    cfg, err := config.Load("")
    require.NoError(t, err)
    assert.Equal(t, 9090, cfg.Server.Port)
    assert.Equal(t, "pg.test", cfg.Database.Host)
}

func TestLoad_InvalidPort(t *testing.T) {
    t.Setenv("APP_SERVER_PORT", "99999")
    t.Setenv("APP_DB_HOST", "pg.test")
    t.Setenv("APP_DB_NAME", "testdb")
    t.Setenv("APP_DB_USER", "testuser")

    _, err := config.Load("")
    require.Error(t, err)
    assert.Contains(t, err.Error(), "server.port")
}

func TestLoad_FromFile(t *testing.T) {
    yaml := `
server:
  port: 7070
database:
  host: db.test
  name: mydb
  user: admin
  ssl_mode: require
`
    f, err := os.CreateTemp(t.TempDir(), "config*.yaml")
    require.NoError(t, err)
    _, err = f.WriteString(yaml)
    require.NoError(t, err)
    f.Close()

    cfg, err := config.Load(f.Name())
    require.NoError(t, err)
    assert.Equal(t, 7070, cfg.Server.Port)
    assert.Equal(t, "db.test", cfg.Database.Host)
    assert.Equal(t, "require", cfg.Database.SSLMode)
}
```
