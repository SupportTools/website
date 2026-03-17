---
title: "Go Configuration Management: Viper, Environment Variables, and Secrets"
date: 2028-03-30T00:00:00-05:00
draft: false
tags: ["Go", "Viper", "Configuration", "Kubernetes", "Secrets", "Vault", "ConfigMap"]
categories: ["Go", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production-grade Go configuration management covering Viper precedence (flags, env, config files, defaults), Kubernetes ConfigMap file mounting, secret injection patterns, dynamic reloading with fsnotify, startup validation, multi-environment profiles, and HashiCorp Vault dynamic secrets integration."
more_link: "yes"
url: "/go-configuration-management-viper-guide-advanced/"
---

Configuration management is a deceptively complex problem. A configuration system must handle a dozen different sources with well-defined precedence, reload without restarting the process, validate values at startup before any damage is done, and protect sensitive values from appearing in logs or error messages. This guide builds a production-grade configuration system in Go using Viper as the foundation, with patterns specific to Kubernetes deployment environments.

<!--more-->

## Viper Configuration Precedence

Viper resolves configuration values from multiple sources in this strict precedence order (highest to lowest):

1. Explicit `Set()` calls (programmatic overrides)
2. Command-line flags (via pflag)
3. Environment variables
4. Configuration file values
5. Default values

This order enables the Kubernetes operator pattern: base configuration in a ConfigMap-mounted file, secrets injected via environment variables, and feature flags as command-line arguments in the Pod spec.

## Complete Viper Setup

```go
package config

import (
    "fmt"
    "log/slog"
    "os"
    "strings"
    "time"

    "github.com/fsnotify/fsnotify"
    "github.com/spf13/pflag"
    "github.com/spf13/viper"
)

// Config holds all application configuration with typed fields.
type Config struct {
    Server   ServerConfig   `mapstructure:"server"`
    Database DatabaseConfig `mapstructure:"database"`
    Redis    RedisConfig    `mapstructure:"redis"`
    Auth     AuthConfig     `mapstructure:"auth"`
    Features FeatureFlags   `mapstructure:"features"`
    Logging  LoggingConfig  `mapstructure:"logging"`
}

type ServerConfig struct {
    Host            string        `mapstructure:"host"`
    Port            int           `mapstructure:"port"`
    ReadTimeout     time.Duration `mapstructure:"read_timeout"`
    WriteTimeout    time.Duration `mapstructure:"write_timeout"`
    ShutdownTimeout time.Duration `mapstructure:"shutdown_timeout"`
    TLSCertFile     string        `mapstructure:"tls_cert_file"`
    TLSKeyFile      string        `mapstructure:"tls_key_file"`
}

type DatabaseConfig struct {
    DSN             string        `mapstructure:"dsn"`  // Sensitive: loaded from env
    MaxOpenConns    int           `mapstructure:"max_open_conns"`
    MaxIdleConns    int           `mapstructure:"max_idle_conns"`
    ConnMaxLifetime time.Duration `mapstructure:"conn_max_lifetime"`
    ConnMaxIdleTime time.Duration `mapstructure:"conn_max_idle_time"`
    SSLMode         string        `mapstructure:"ssl_mode"`
}

type AuthConfig struct {
    JWTSecret      string        `mapstructure:"jwt_secret"`    // Sensitive
    JWTExpiry      time.Duration `mapstructure:"jwt_expiry"`
    APIKeyHeader   string        `mapstructure:"api_key_header"`
}

type FeatureFlags struct {
    EnableNewCheckout bool `mapstructure:"enable_new_checkout"`
    EnableBetaAPI     bool `mapstructure:"enable_beta_api"`
    MaxUploadMB       int  `mapstructure:"max_upload_mb"`
}

type LoggingConfig struct {
    Level  string `mapstructure:"level"`
    Format string `mapstructure:"format"`  // json or text
}

type RedisConfig struct {
    Addr     string `mapstructure:"addr"`
    Password string `mapstructure:"password"` // Sensitive
    DB       int    `mapstructure:"db"`
}
```

## Loader Implementation

```go
// Loader manages configuration loading, watching, and validation.
type Loader struct {
    v      *viper.Viper
    logger *slog.Logger
    hooks  []func(Config)
}

func NewLoader(logger *slog.Logger) *Loader {
    return &Loader{
        v:      viper.New(),
        logger: logger,
    }
}

// Load initializes Viper with all configuration sources and validates.
func (l *Loader) Load(configFile string, flags *pflag.FlagSet) (*Config, error) {
    v := l.v

    // 1. Register defaults (lowest precedence)
    l.registerDefaults()

    // 2. Bind command-line flags
    if flags != nil {
        if err := v.BindPFlags(flags); err != nil {
            return nil, fmt.Errorf("bind flags: %w", err)
        }
    }

    // 3. Configure environment variable binding
    v.SetEnvPrefix("APP")
    v.SetEnvKeyReplacer(strings.NewReplacer(".", "_", "-", "_"))
    v.AutomaticEnv()

    // Explicitly bind sensitive env vars that don't follow the prefix pattern
    // (e.g., DATABASE_URL is a common convention rather than APP_DATABASE_DSN)
    envBindings := map[string]string{
        "database.dsn":    "DATABASE_URL",
        "auth.jwt_secret": "JWT_SECRET",
        "redis.password":  "REDIS_PASSWORD",
    }
    for key, envVar := range envBindings {
        if err := v.BindEnv(key, envVar); err != nil {
            return nil, fmt.Errorf("bind env %s: %w", envVar, err)
        }
    }

    // 4. Load configuration file
    if configFile != "" {
        v.SetConfigFile(configFile)
    } else {
        v.SetConfigName("config")
        v.SetConfigType("yaml")
        v.AddConfigPath("/etc/app/")        // Kubernetes ConfigMap mount
        v.AddConfigPath("$HOME/.app/")
        v.AddConfigPath(".")
    }

    if err := v.ReadInConfig(); err != nil {
        if _, ok := err.(viper.ConfigFileNotFoundError); ok {
            l.logger.Info("no config file found, using env vars and defaults")
        } else {
            return nil, fmt.Errorf("read config file: %w", err)
        }
    } else {
        l.logger.Info("loaded config file", "path", v.ConfigFileUsed())
    }

    // 5. Unmarshal into typed struct
    var cfg Config
    if err := v.Unmarshal(&cfg); err != nil {
        return nil, fmt.Errorf("unmarshal config: %w", err)
    }

    // 6. Validate all values before returning
    if err := validate(cfg); err != nil {
        return nil, fmt.Errorf("config validation: %w", err)
    }

    return &cfg, nil
}

func (l *Loader) registerDefaults() {
    v := l.v

    // Server defaults
    v.SetDefault("server.host", "0.0.0.0")
    v.SetDefault("server.port", 8080)
    v.SetDefault("server.read_timeout", "30s")
    v.SetDefault("server.write_timeout", "30s")
    v.SetDefault("server.shutdown_timeout", "30s")

    // Database defaults
    v.SetDefault("database.max_open_conns", 25)
    v.SetDefault("database.max_idle_conns", 5)
    v.SetDefault("database.conn_max_lifetime", "30m")
    v.SetDefault("database.conn_max_idle_time", "5m")
    v.SetDefault("database.ssl_mode", "require")

    // Auth defaults
    v.SetDefault("auth.jwt_expiry", "24h")
    v.SetDefault("auth.api_key_header", "X-API-Key")

    // Feature flag defaults
    v.SetDefault("features.enable_new_checkout", false)
    v.SetDefault("features.enable_beta_api", false)
    v.SetDefault("features.max_upload_mb", 10)

    // Logging defaults
    v.SetDefault("logging.level", "info")
    v.SetDefault("logging.format", "json")

    // Redis defaults
    v.SetDefault("redis.db", 0)
}
```

## Startup Validation

Validation at startup prevents the service from starting with dangerous misconfigurations:

```go
package config

import (
    "fmt"
    "net"
    "strconv"
    "strings"
)

type ValidationError struct {
    Field   string
    Message string
}

func (e ValidationError) Error() string {
    return fmt.Sprintf("config validation error: field=%s message=%s", e.Field, e.Message)
}

type MultiValidationError []ValidationError

func (e MultiValidationError) Error() string {
    msgs := make([]string, len(e))
    for i, ve := range e {
        msgs[i] = ve.Error()
    }
    return strings.Join(msgs, "; ")
}

func validate(cfg Config) error {
    var errs MultiValidationError

    // Server validation
    if cfg.Server.Port < 1 || cfg.Server.Port > 65535 {
        errs = append(errs, ValidationError{
            Field:   "server.port",
            Message: fmt.Sprintf("must be between 1 and 65535, got %d", cfg.Server.Port),
        })
    }

    if cfg.Server.ReadTimeout <= 0 {
        errs = append(errs, ValidationError{
            Field:   "server.read_timeout",
            Message: "must be positive",
        })
    }

    // Database validation
    if cfg.Database.DSN == "" {
        errs = append(errs, ValidationError{
            Field:   "database.dsn",
            Message: "required (set DATABASE_URL environment variable)",
        })
    }

    if cfg.Database.MaxOpenConns < 1 {
        errs = append(errs, ValidationError{
            Field:   "database.max_open_conns",
            Message: "must be at least 1",
        })
    }

    if cfg.Database.MaxIdleConns > cfg.Database.MaxOpenConns {
        errs = append(errs, ValidationError{
            Field:   "database.max_idle_conns",
            Message: fmt.Sprintf("cannot exceed max_open_conns (%d)", cfg.Database.MaxOpenConns),
        })
    }

    // Auth validation
    if len(cfg.Auth.JWTSecret) < 32 {
        errs = append(errs, ValidationError{
            Field:   "auth.jwt_secret",
            Message: "must be at least 32 characters (set JWT_SECRET environment variable)",
        })
    }

    // Redis validation
    if cfg.Redis.Addr != "" {
        host, portStr, err := net.SplitHostPort(cfg.Redis.Addr)
        if err != nil {
            errs = append(errs, ValidationError{
                Field:   "redis.addr",
                Message: fmt.Sprintf("invalid format (expected host:port): %v", err),
            })
        } else if host == "" {
            errs = append(errs, ValidationError{Field: "redis.addr", Message: "host is empty"})
        } else if _, err := strconv.Atoi(portStr); err != nil {
            errs = append(errs, ValidationError{Field: "redis.addr", Message: "port is not a number"})
        }
    }

    // Logging validation
    validLevels := map[string]bool{"debug": true, "info": true, "warn": true, "error": true}
    if !validLevels[strings.ToLower(cfg.Logging.Level)] {
        errs = append(errs, ValidationError{
            Field:   "logging.level",
            Message: fmt.Sprintf("must be one of: debug, info, warn, error; got %q", cfg.Logging.Level),
        })
    }

    if len(errs) > 0 {
        return errs
    }
    return nil
}
```

## Dynamic Configuration Reloading

```go
// WatchAndReload starts watching the config file for changes.
// When a change is detected, the new configuration is loaded, validated,
// and all registered hooks are called.
func (l *Loader) WatchAndReload(ctx context.Context) {
    l.v.OnConfigChange(func(e fsnotify.Event) {
        l.logger.Info("config file changed", "event", e.Op, "file", e.Name)

        var newCfg Config
        if err := l.v.Unmarshal(&newCfg); err != nil {
            l.logger.Error("failed to unmarshal config after reload", "error", err)
            return
        }

        if err := validate(newCfg); err != nil {
            l.logger.Error("config validation failed after reload",
                "error", err,
                "note", "keeping previous configuration",
            )
            return
        }

        l.logger.Info("configuration reloaded successfully")

        for _, hook := range l.hooks {
            hook(newCfg)
        }
    })

    l.v.WatchConfig()

    // Stop watching when context is canceled
    <-ctx.Done()
    // Viper has no StopWatchConfig; the goroutine will exit with the process
}

// OnChange registers a callback to be called when configuration changes.
func (l *Loader) OnChange(hook func(Config)) {
    l.hooks = append(l.hooks, hook)
}
```

## Kubernetes ConfigMap as Configuration File

```yaml
# configmap.yaml — mounted as /etc/app/config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-service-config
  namespace: production
data:
  config.yaml: |
    server:
      host: "0.0.0.0"
      port: 8080
      read_timeout: "30s"
      write_timeout: "30s"
      shutdown_timeout: "60s"

    database:
      max_open_conns: 50
      max_idle_conns: 10
      conn_max_lifetime: "30m"
      conn_max_idle_time: "5m"
      ssl_mode: "require"

    redis:
      addr: "redis-master.redis.svc.cluster.local:6379"
      db: 0

    features:
      enable_new_checkout: true
      enable_beta_api: false
      max_upload_mb: 25

    logging:
      level: "info"
      format: "json"
```

```yaml
# deployment.yaml (relevant sections)
spec:
  template:
    spec:
      containers:
        - name: api-service
          image: registry.example.com/api-service:v1.2.0
          env:
            # Sensitive values from Secrets
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: api-service-db-credentials
                  key: dsn
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: api-service-auth
                  key: jwt_secret
            - name: REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: redis-credentials
                  key: password
            # Non-sensitive env overrides
            - name: APP_LOGGING_LEVEL
              value: "debug"   # Override for staging
          volumeMounts:
            - name: config
              mountPath: /etc/app
              readOnly: true
      volumes:
        - name: config
          configMap:
            name: api-service-config
```

## Secret Injection: Files vs Environment Variables

There is ongoing debate about whether secrets are safer as environment variables or mounted files. The relevant considerations:

| Concern | Env Variables | Mounted Files |
|---|---|---|
| Visible in `ps auxe` | Yes (some systems) | No |
| Visible in /proc/{pid}/environ | Yes | No |
| Child process inheritance | Yes | No (unless file is readable) |
| Automatic rotation without restart | No | Yes (with inotify watch) |
| Kubernetes audit log exposure | Yes (in Pod spec) | Less (in Secret data) |
| Application complexity | Lower | Higher (file read + watch) |

For most applications, mounted files are preferable for long-lived secrets. The implementation:

```go
package config

import (
    "fmt"
    "os"
    "path/filepath"
    "strings"
    "sync"

    "github.com/fsnotify/fsnotify"
)

// SecretFile manages a secret loaded from a mounted file with automatic rotation.
type SecretFile struct {
    path    string
    value   string
    mu      sync.RWMutex
    watcher *fsnotify.Watcher
}

func NewSecretFile(path string) (*SecretFile, error) {
    sf := &SecretFile{path: path}

    // Load initial value
    if err := sf.reload(); err != nil {
        return nil, fmt.Errorf("load secret from %s: %w", path, err)
    }

    // Watch for updates (Kubernetes Secret rotation updates the symlink)
    watcher, err := fsnotify.NewWatcher()
    if err != nil {
        return nil, fmt.Errorf("create file watcher: %w", err)
    }
    sf.watcher = watcher

    // Watch the directory, not the file (Kubernetes uses atomic rename via symlink)
    if err := watcher.Add(filepath.Dir(path)); err != nil {
        watcher.Close()
        return nil, fmt.Errorf("watch dir: %w", err)
    }

    go sf.watchLoop()
    return sf, nil
}

func (sf *SecretFile) Value() string {
    sf.mu.RLock()
    defer sf.mu.RUnlock()
    return sf.value
}

func (sf *SecretFile) reload() error {
    data, err := os.ReadFile(sf.path)
    if err != nil {
        return err
    }
    sf.mu.Lock()
    sf.value = strings.TrimSpace(string(data))
    sf.mu.Unlock()
    return nil
}

func (sf *SecretFile) watchLoop() {
    for {
        select {
        case event, ok := <-sf.watcher.Events:
            if !ok {
                return
            }
            // Kubernetes writes secrets via ..data symlink update
            if strings.Contains(event.Name, "..data") ||
               filepath.Base(event.Name) == filepath.Base(sf.path) {
                _ = sf.reload()
            }
        case err, ok := <-sf.watcher.Errors:
            if !ok {
                return
            }
            _ = err // Log in production
        }
    }
}
```

## Vault Dynamic Secrets Integration

HashiCorp Vault can generate short-lived database credentials on demand:

```go
package vault

import (
    "context"
    "fmt"
    "time"

    vault "github.com/hashicorp/vault/api"
    auth "github.com/hashicorp/vault/api/auth/kubernetes"
)

type VaultConfig struct {
    Addr      string
    Role      string
    MountPath string  // e.g., "database"
    CredsPath string  // e.g., "creds/readonly-role"
}

type DynamicCredentials struct {
    Username  string
    Password  string
    LeaseDuration time.Duration
    LeaseID   string
}

// GetDatabaseCredentials fetches short-lived credentials from Vault.
func GetDatabaseCredentials(ctx context.Context, cfg VaultConfig) (*DynamicCredentials, error) {
    config := vault.DefaultConfig()
    config.Address = cfg.Addr

    client, err := vault.NewClient(config)
    if err != nil {
        return nil, fmt.Errorf("create vault client: %w", err)
    }

    // Kubernetes auth (uses ServiceAccount token)
    k8sAuth, err := auth.NewKubernetesAuth(cfg.Role,
        auth.WithMountPath("kubernetes"),
    )
    if err != nil {
        return nil, fmt.Errorf("create k8s auth: %w", err)
    }

    authInfo, err := client.Auth().Login(ctx, k8sAuth)
    if err != nil {
        return nil, fmt.Errorf("vault login: %w", err)
    }
    if authInfo == nil {
        return nil, fmt.Errorf("vault login returned no auth info")
    }

    // Read dynamic credentials
    secret, err := client.Logical().ReadWithContext(ctx,
        fmt.Sprintf("%s/%s", cfg.MountPath, cfg.CredsPath),
    )
    if err != nil {
        return nil, fmt.Errorf("read credentials: %w", err)
    }
    if secret == nil || secret.Data == nil {
        return nil, fmt.Errorf("vault returned empty credential response")
    }

    username, ok := secret.Data["username"].(string)
    if !ok {
        return nil, fmt.Errorf("vault response missing username field")
    }
    password, ok := secret.Data["password"].(string)
    if !ok {
        return nil, fmt.Errorf("vault response missing password field")
    }

    return &DynamicCredentials{
        Username:      username,
        Password:      password,
        LeaseDuration: time.Duration(secret.LeaseDuration) * time.Second,
        LeaseID:       secret.LeaseID,
    }, nil
}
```

### Credential Rotation

```go
// CredentialManager handles automatic credential rotation before lease expiry.
type CredentialManager struct {
    vaultCfg    VaultConfig
    current     *DynamicCredentials
    mu          sync.RWMutex
    onRotate    func(username, password string) error
    stopCh      chan struct{}
}

func (cm *CredentialManager) Start(ctx context.Context) {
    go func() {
        for {
            cm.mu.RLock()
            lease := cm.current.LeaseDuration
            cm.mu.RUnlock()

            // Renew at 75% of lease duration
            renewAt := time.Duration(float64(lease) * 0.75)
            timer := time.NewTimer(renewAt)

            select {
            case <-ctx.Done():
                timer.Stop()
                return
            case <-cm.stopCh:
                timer.Stop()
                return
            case <-timer.C:
                newCreds, err := GetDatabaseCredentials(ctx, cm.vaultCfg)
                if err != nil {
                    // Log and retry with shorter interval
                    continue
                }
                cm.mu.Lock()
                cm.current = newCreds
                cm.mu.Unlock()

                if cm.onRotate != nil {
                    _ = cm.onRotate(newCreds.Username, newCreds.Password)
                }
            }
        }
    }()
}
```

## Multi-Environment Config with Profiles

```yaml
# config.yaml — base configuration (committed to source control)
server:
  host: "0.0.0.0"
  port: 8080
  shutdown_timeout: "30s"

database:
  max_open_conns: 25
  ssl_mode: "require"

logging:
  level: "info"
  format: "json"
```

```yaml
# config.staging.yaml — staging overrides
logging:
  level: "debug"

features:
  enable_beta_api: true
  max_upload_mb: 100

database:
  max_open_conns: 10
```

```go
// Load with profile overlay
func LoadWithProfile(baseFile, profileFile string, flags *pflag.FlagSet) (*Config, error) {
    v := viper.New()
    v.SetConfigFile(baseFile)
    if err := v.ReadInConfig(); err != nil {
        return nil, fmt.Errorf("read base config: %w", err)
    }

    if profileFile != "" {
        overlay := viper.New()
        overlay.SetConfigFile(profileFile)
        if err := overlay.ReadInConfig(); err != nil && !os.IsNotExist(err) {
            return nil, fmt.Errorf("read profile config %s: %w", profileFile, err)
        }

        // Merge overlay into base
        if err := v.MergeConfigMap(overlay.AllSettings()); err != nil {
            return nil, fmt.Errorf("merge profile: %w", err)
        }
    }

    // ... rest of loading logic
}
```

## Safe Configuration Logging

Never log sensitive configuration values:

```go
// SafeConfig is a version of Config safe for logging and debug endpoints.
type SafeConfig struct {
    Server   ServerConfig   `json:"server"`
    Database DatabaseSafeConfig `json:"database"`
    Features FeatureFlags   `json:"features"`
    Logging  LoggingConfig  `json:"logging"`
}

type DatabaseSafeConfig struct {
    MaxOpenConns    int    `json:"max_open_conns"`
    MaxIdleConns    int    `json:"max_idle_conns"`
    SSLMode         string `json:"ssl_mode"`
    DSNConfigured   bool   `json:"dsn_configured"`  // Boolean, not the actual DSN
}

func (cfg Config) ToSafe() SafeConfig {
    return SafeConfig{
        Server:   cfg.Server,
        Features: cfg.Features,
        Logging:  cfg.Logging,
        Database: DatabaseSafeConfig{
            MaxOpenConns:  cfg.Database.MaxOpenConns,
            MaxIdleConns:  cfg.Database.MaxIdleConns,
            SSLMode:       cfg.Database.SSLMode,
            DSNConfigured: cfg.Database.DSN != "",
        },
    }
}
```

## Configuration Observability: Audit Trail and Change Detection

In production, it is important to know when configuration changed and what changed. This is particularly useful for post-incident analysis.

```go
package config

import (
    "crypto/sha256"
    "encoding/json"
    "fmt"
    "log/slog"
    "reflect"
    "time"
)

// AuditEntry records a configuration change event.
type AuditEntry struct {
    Timestamp   time.Time         `json:"timestamp"`
    Source      string            `json:"source"`    // file, env, flag
    Checksum    string            `json:"checksum"`
    ChangedKeys []string          `json:"changed_keys,omitempty"`
}

// ConfigAuditor tracks configuration changes and emits audit events.
type ConfigAuditor struct {
    logger   *slog.Logger
    previous *Config
    mu       sync.Mutex
}

func NewConfigAuditor(logger *slog.Logger) *ConfigAuditor {
    return &ConfigAuditor{logger: logger}
}

// Record computes a checksum and logs any changed fields.
func (a *ConfigAuditor) Record(cfg *Config, source string) {
    a.mu.Lock()
    defer a.mu.Unlock()

    checksum := computeChecksum(cfg)
    changed := a.findChangedKeys(a.previous, cfg)

    entry := AuditEntry{
        Timestamp:   time.Now().UTC(),
        Source:      source,
        Checksum:    checksum,
        ChangedKeys: changed,
    }

    if len(changed) > 0 || a.previous == nil {
        a.logger.Info("configuration updated",
            "source", entry.Source,
            "checksum", entry.Checksum,
            "changed_keys", entry.ChangedKeys,
            "timestamp", entry.Timestamp,
        )
    }

    // Deep copy for next comparison
    cfgCopy := *cfg
    a.previous = &cfgCopy
}

func computeChecksum(cfg *Config) string {
    // Exclude sensitive fields before hashing
    safe := cfg.ToSafe()
    data, _ := json.Marshal(safe)
    sum := sha256.Sum256(data)
    return fmt.Sprintf("%x", sum[:8])
}

func (a *ConfigAuditor) findChangedKeys(old, new *Config) []string {
    if old == nil {
        return []string{"<initial-load>"}
    }

    var changed []string

    // Compare non-sensitive fields using reflection
    oldSafe := old.ToSafe()
    newSafe := new.ToSafe()

    oldVal := reflect.ValueOf(oldSafe)
    newVal := reflect.ValueOf(newSafe)

    for i := 0; i < oldVal.NumField(); i++ {
        fieldName := oldVal.Type().Field(i).Name
        if !reflect.DeepEqual(oldVal.Field(i).Interface(), newVal.Field(i).Interface()) {
            changed = append(changed, fieldName)
        }
    }

    return changed
}
```

### Configuration Health Endpoint

Expose a non-sensitive configuration summary for debugging:

```go
// ConfigHandler serves a debug endpoint showing current non-sensitive config.
func ConfigHandler(loader *Loader) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        cfg := loader.Current()
        if cfg == nil {
            http.Error(w, "configuration not loaded", http.StatusServiceUnavailable)
            return
        }

        // Return safe (non-sensitive) config only
        safe := cfg.ToSafe()

        w.Header().Set("Content-Type", "application/json")
        if err := json.NewEncoder(w).Encode(map[string]interface{}{
            "config":    safe,
            "source":    loader.v.ConfigFileUsed(),
            "loaded_at": loader.loadedAt,
        }); err != nil {
            http.Error(w, "encode error", http.StatusInternalServerError)
        }
    }
}
```

## Summary

The configuration system described here handles every scenario encountered in production Kubernetes deployments. Viper's precedence chain handles the layered override model. Startup validation catches misconfiguration before any network connections are opened. Dynamic reloading enables ConfigMap updates to propagate without restarts. Mounted secret files with fsnotify watchers enable credential rotation without downtime. Vault integration provides short-lived, audited credentials for database access.

The critical operational principle: treat the absence of a required configuration value as a fatal startup error, not a runtime warning. A service that starts with a missing database credential and then fails every request is harder to diagnose than a service that refuses to start with a clear validation error message.
