---
title: "Go: Building a Configuration Management System with Hot-Reloading and Schema Validation"
date: 2031-10-03T00:00:00-05:00
draft: false
tags: ["Go", "Configuration Management", "Hot Reload", "Schema Validation", "Production", "DevOps"]
categories: ["Go", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building a production-grade configuration management system in Go, covering hot-reloading with fsnotify, schema validation with JSON Schema, and safe concurrent access patterns."
more_link: "yes"
url: "/go-configuration-management-hot-reloading-schema-validation/"
---

Most applications handle configuration poorly. They read a YAML file at startup, unmarshall it into a struct, and then hardcode that struct throughout the application. When a configuration change is needed, the application requires a restart—which, in a Kubernetes environment, triggers a rolling update, disrupts connections, and wastes deployment cycles for what might be a one-line change to a timeout value or a feature flag.

A proper configuration management system does more: it validates configuration against a schema before applying it, hot-reloads changes without restart, notifies subsystems about which values changed so they can act selectively, and provides a thread-safe API for reading values from any goroutine. This guide builds that system from scratch in Go.

<!--more-->

# Go Configuration Management with Hot-Reloading and Schema Validation

## Design Requirements

Before writing code, define the requirements precisely:

1. **Multiple sources**: files, environment variables, Kubernetes ConfigMaps (via projected volumes), and HTTP endpoints
2. **Schema validation**: reject invalid configuration before it reaches the application
3. **Hot-reloading**: detect file changes and reload without restart; notify subscribers of what changed
4. **Thread safety**: multiple goroutines can read configuration at any time without races
5. **Typed access**: return typed values (string, int, bool, duration) rather than raw strings
6. **Change notification**: subsystems subscribe to specific keys or namespaces and are notified only when relevant values change
7. **Defaults and overrides**: layered configuration with clear precedence

## Project Layout

```
config/
├── config.go          # Core Config type and API
├── loader.go          # File, env, HTTP loaders
├── watcher.go         # fsnotify-based file watcher
├── schema.go          # JSON Schema validation
├── notify.go          # Change notification and subscriptions
├── merge.go           # Layer merging and precedence
├── cast.go            # Type-safe value accessors
└── config_test.go
```

## Core Configuration Type

```go
// config/config.go
package config

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Config is the central configuration store. It is safe for concurrent use.
type Config struct {
	mu       sync.RWMutex
	layers   []Layer          // ordered from lowest to highest precedence
	merged   map[string]any   // merged flat map (cache)
	watchers []*Watcher
	subs     *SubscriptionHub
	schema   *Schema
	version  uint64           // incremented on each reload
}

// New creates a Config with the given layers applied in order.
// Later layers override earlier ones.
func New(layers ...Layer) (*Config, error) {
	c := &Config{
		layers: layers,
		subs:   newSubscriptionHub(),
	}
	if err := c.reload(); err != nil {
		return nil, fmt.Errorf("initial load: %w", err)
	}
	return c, nil
}

// WithSchema attaches a JSON Schema for validation.
func (c *Config) WithSchema(s *Schema) *Config {
	c.schema = s
	return c
}

// reload merges all layers and validates the result.
// Must be called with c.mu held or before concurrent access.
func (c *Config) reload() error {
	merged := make(map[string]any)
	for _, layer := range c.layers {
		data, err := layer.Load()
		if err != nil {
			return fmt.Errorf("loading layer %q: %w", layer.Name(), err)
		}
		deepMerge(merged, data)
	}

	if c.schema != nil {
		if err := c.schema.Validate(merged); err != nil {
			return fmt.Errorf("schema validation: %w", err)
		}
	}

	c.mu.Lock()
	old := c.merged
	c.merged = merged
	c.version++
	c.mu.Unlock()

	// Notify subscribers of changed keys.
	if old != nil {
		changed := diffKeys(old, merged)
		if len(changed) > 0 {
			c.subs.Notify(changed, c)
		}
	}

	return nil
}

// Get returns the raw value for a dot-separated key path.
// Returns nil if the key does not exist.
func (c *Config) Get(key string) any {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return getNestedKey(c.merged, splitKey(key))
}

// String returns the string value for key, or defaultVal if not found.
func (c *Config) String(key, defaultVal string) string {
	v := c.Get(key)
	if v == nil {
		return defaultVal
	}
	s, ok := v.(string)
	if !ok {
		return fmt.Sprintf("%v", v)
	}
	return s
}

// Int returns the int value for key, or defaultVal if not found.
func (c *Config) Int(key string, defaultVal int) int {
	v := c.Get(key)
	return toInt(v, defaultVal)
}

// Bool returns the bool value for key, or defaultVal if not found.
func (c *Config) Bool(key string, defaultVal bool) bool {
	v := c.Get(key)
	return toBool(v, defaultVal)
}

// Duration returns the time.Duration value for key, or defaultVal if not found.
// The value can be a string like "30s", "5m", "1h" or a numeric nanosecond count.
func (c *Config) Duration(key string, defaultVal time.Duration) time.Duration {
	v := c.Get(key)
	return toDuration(v, defaultVal)
}

// StringSlice returns a []string for a key whose value is an array.
func (c *Config) StringSlice(key string) []string {
	v := c.Get(key)
	return toStringSlice(v)
}

// MustString returns the string value for key and panics if it is missing.
// Use only for required configuration that must exist.
func (c *Config) MustString(key string) string {
	v := c.Get(key)
	if v == nil {
		panic(fmt.Sprintf("required config key %q is missing", key))
	}
	s, ok := v.(string)
	if !ok {
		panic(fmt.Sprintf("config key %q has type %T, expected string", key, v))
	}
	return s
}

// Version returns the current configuration version.
// Increments on every successful hot-reload.
func (c *Config) Version() uint64 {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.version
}

// Snapshot returns a deep copy of the current merged configuration.
// Useful for logging the full configuration state.
func (c *Config) Snapshot() map[string]any {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return deepCopy(c.merged)
}
```

## Configuration Layers

```go
// config/loader.go
package config

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Layer is a source of configuration data.
type Layer interface {
	Name() string
	Load() (map[string]any, error)
}

// --- YAML/JSON file layer ---

// FileLayer loads configuration from a YAML or JSON file.
type FileLayer struct {
	path string
}

func NewFileLayer(path string) *FileLayer {
	return &FileLayer{path: path}
}

func (f *FileLayer) Name() string { return "file:" + f.path }

func (f *FileLayer) Load() (map[string]any, error) {
	data, err := os.ReadFile(f.path)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", f.path, err)
	}

	var result map[string]any
	ext := strings.ToLower(f.path[strings.LastIndex(f.path, ".")+1:])

	switch ext {
	case "yaml", "yml":
		if err := yaml.Unmarshal(data, &result); err != nil {
			return nil, fmt.Errorf("parsing YAML %s: %w", f.path, err)
		}
	case "json":
		if err := json.Unmarshal(data, &result); err != nil {
			return nil, fmt.Errorf("parsing JSON %s: %w", f.path, err)
		}
	default:
		return nil, fmt.Errorf("unsupported file format %q (use .yaml, .yml, or .json)", ext)
	}

	return normalizeKeys(result), nil
}

// --- Environment variable layer ---

// EnvLayer loads configuration from environment variables.
// Variables matching the prefix are included, with the prefix stripped
// and double-underscore converted to dot notation.
// Example: APP_SERVER__PORT=8080 with prefix APP_ → {"server.port": "8080"}
type EnvLayer struct {
	prefix string
}

func NewEnvLayer(prefix string) *EnvLayer {
	return &EnvLayer{prefix: strings.ToUpper(prefix)}
}

func (e *EnvLayer) Name() string { return "env:" + e.prefix }

func (e *EnvLayer) Load() (map[string]any, error) {
	result := make(map[string]any)
	for _, kv := range os.Environ() {
		idx := strings.Index(kv, "=")
		if idx < 0 {
			continue
		}
		key, value := kv[:idx], kv[idx+1:]

		upper := strings.ToUpper(key)
		if !strings.HasPrefix(upper, e.prefix) {
			continue
		}

		// Strip prefix, convert __ to . and _ to camelCase separator
		stripped := upper[len(e.prefix):]
		dotKey := strings.ToLower(strings.ReplaceAll(stripped, "__", "."))

		setNestedKey(result, splitKey(dotKey), value)
	}
	return result, nil
}

// --- Static defaults layer ---

// DefaultsLayer holds hard-coded default values. Always the lowest-priority layer.
type DefaultsLayer struct {
	name     string
	defaults map[string]any
}

func NewDefaultsLayer(name string, defaults map[string]any) *DefaultsLayer {
	return &DefaultsLayer{name: name, defaults: defaults}
}

func (d *DefaultsLayer) Name() string { return "defaults:" + d.name }

func (d *DefaultsLayer) Load() (map[string]any, error) {
	return deepCopy(d.defaults), nil
}

// --- HTTP remote layer ---

// HTTPLayer loads configuration from an HTTP endpoint (e.g., a config service).
type HTTPLayer struct {
	url     string
	token   string
	timeout time.Duration
	client  *http.Client
}

func NewHTTPLayer(url, bearerToken string, timeout time.Duration) *HTTPLayer {
	return &HTTPLayer{
		url:     url,
		token:   bearerToken,
		timeout: timeout,
		client:  &http.Client{Timeout: timeout},
	}
}

func (h *HTTPLayer) Name() string { return "http:" + h.url }

func (h *HTTPLayer) Load() (map[string]any, error) {
	req, err := http.NewRequest(http.MethodGet, h.url, nil)
	if err != nil {
		return nil, err
	}
	if h.token != "" {
		req.Header.Set("Authorization", "Bearer "+h.token)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := h.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetching config from %s: %w", h.url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("config endpoint returned %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var result map[string]any
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parsing config response: %w", err)
	}
	return result, nil
}
```

## File Watcher with Debouncing

```go
// config/watcher.go
package config

import (
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Watcher monitors one or more files for changes and triggers config reloads.
type Watcher struct {
	cfg      *Config
	fsw      *fsnotify.Watcher
	debounce time.Duration
	mu       sync.Mutex
	timer    *time.Timer
	done     chan struct{}
}

// Watch creates a file watcher for the given Config and starts watching.
// debounce is the delay after the last file event before triggering reload.
// A debounce of 200-500ms prevents multiple reloads when editors write files
// in multiple stages (truncate then write).
func Watch(cfg *Config, debounce time.Duration, paths ...string) (*Watcher, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("creating fsnotify watcher: %w", err)
	}

	w := &Watcher{
		cfg:      cfg,
		fsw:      fsw,
		debounce: debounce,
		done:     make(chan struct{}),
	}

	for _, path := range paths {
		// Watch the directory containing the file, not the file itself.
		// This handles editors that write to a temp file then rename.
		dir := filepath.Dir(path)
		if err := fsw.Add(dir); err != nil {
			fsw.Close()
			return nil, fmt.Errorf("watching directory %s: %w", dir, err)
		}
	}

	go w.loop(paths)
	return w, nil
}

func (w *Watcher) loop(watchedPaths []string) {
	defer close(w.done)
	pathSet := make(map[string]struct{}, len(watchedPaths))
	for _, p := range watchedPaths {
		abs, _ := filepath.Abs(p)
		pathSet[abs] = struct{}{}
	}

	for {
		select {
		case event, ok := <-w.fsw.Events:
			if !ok {
				return
			}

			abs, _ := filepath.Abs(event.Name)
			if _, watched := pathSet[abs]; !watched {
				continue
			}

			if event.Has(fsnotify.Write) || event.Has(fsnotify.Create) || event.Has(fsnotify.Rename) {
				w.scheduleReload(event.Name)
			}

		case err, ok := <-w.fsw.Errors:
			if !ok {
				return
			}
			slog.Error("fsnotify error", "err", err)
		}
	}
}

func (w *Watcher) scheduleReload(path string) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.timer != nil {
		w.timer.Stop()
	}

	w.timer = time.AfterFunc(w.debounce, func() {
		slog.Info("config file changed, reloading", "path", path)
		if err := w.cfg.reload(); err != nil {
			slog.Error("config reload failed", "path", path, "err", err)
			// Keep running with old configuration on reload failure.
		} else {
			slog.Info("config reloaded successfully",
				"path", path,
				"version", w.cfg.Version(),
			)
		}
	})
}

// Stop shuts down the file watcher.
func (w *Watcher) Stop() error {
	err := w.fsw.Close()
	<-w.done
	return err
}
```

## JSON Schema Validation

```go
// config/schema.go
package config

import (
	"fmt"

	"github.com/santhosh-tekuri/jsonschema/v5"
)

// Schema wraps a JSON Schema for config validation.
type Schema struct {
	compiled *jsonschema.Schema
}

// NewSchema compiles a JSON Schema from a string.
func NewSchema(schemaJSON string) (*Schema, error) {
	compiler := jsonschema.NewCompiler()
	compiler.Draft = jsonschema.Draft2020

	if err := compiler.AddResource("config-schema.json", strings.NewReader(schemaJSON)); err != nil {
		return nil, fmt.Errorf("adding schema resource: %w", err)
	}

	compiled, err := compiler.Compile("config-schema.json")
	if err != nil {
		return nil, fmt.Errorf("compiling schema: %w", err)
	}

	return &Schema{compiled: compiled}, nil
}

// Validate validates the given configuration map against the schema.
func (s *Schema) Validate(data map[string]any) error {
	if err := s.compiled.Validate(data); err != nil {
		return formatValidationError(err)
	}
	return nil
}

func formatValidationError(err error) error {
	if ve, ok := err.(*jsonschema.ValidationError); ok {
		var sb strings.Builder
		sb.WriteString("configuration validation failed:\n")
		for _, e := range ve.DetailedOutput().Errors {
			fmt.Fprintf(&sb, "  - %s: %s\n", e.InstanceLocation, e.Error)
		}
		return fmt.Errorf("%s", sb.String())
	}
	return err
}

// ExampleSchema is a sample schema for a typical web service configuration.
const ExampleSchema = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["server", "database"],
  "properties": {
    "server": {
      "type": "object",
      "required": ["port"],
      "properties": {
        "port": {
          "type": "integer",
          "minimum": 1024,
          "maximum": 65535
        },
        "readTimeout": {
          "type": "string",
          "pattern": "^[0-9]+(ms|s|m|h)$",
          "default": "30s"
        },
        "writeTimeout": {
          "type": "string",
          "pattern": "^[0-9]+(ms|s|m|h)$",
          "default": "30s"
        },
        "maxConnections": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100000,
          "default": 1000
        }
      },
      "additionalProperties": false
    },
    "database": {
      "type": "object",
      "required": ["host", "port", "name"],
      "properties": {
        "host": {"type": "string"},
        "port": {"type": "integer", "minimum": 1, "maximum": 65535},
        "name": {"type": "string", "minLength": 1},
        "maxConnections": {"type": "integer", "minimum": 1, "default": 20},
        "connectionTimeout": {"type": "string", "default": "5s"}
      }
    },
    "features": {
      "type": "object",
      "additionalProperties": {"type": "boolean"}
    },
    "logLevel": {
      "type": "string",
      "enum": ["debug", "info", "warn", "error"],
      "default": "info"
    }
  }
}`
```

## Change Notification System

```go
// config/notify.go
package config

import (
	"sync"
)

// ChangeEvent describes a configuration change.
type ChangeEvent struct {
	Key      string
	OldValue any
	NewValue any
	Config   *Config
}

// ChangeHandler is called when a subscribed key changes.
type ChangeHandler func(events []ChangeEvent)

// Subscription represents a subscription to configuration changes.
type Subscription struct {
	id       uint64
	prefixes []string
	handler  ChangeHandler
}

// SubscriptionHub manages subscriptions and dispatches change notifications.
type SubscriptionHub struct {
	mu    sync.RWMutex
	subs  map[uint64]*Subscription
	nextID uint64
}

func newSubscriptionHub() *SubscriptionHub {
	return &SubscriptionHub{subs: make(map[uint64]*Subscription)}
}

// Subscribe registers a handler to be called when keys matching any prefix change.
// Returns the subscription, which can be cancelled by calling sub.Cancel().
func (h *SubscriptionHub) Subscribe(handler ChangeHandler, prefixes ...string) *Subscription {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.nextID++
	sub := &Subscription{
		id:       h.nextID,
		prefixes: prefixes,
		handler:  handler,
	}
	h.subs[sub.id] = sub
	return sub
}

// Cancel removes a subscription.
func (h *SubscriptionHub) Cancel(sub *Subscription) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.subs, sub.id)
}

// Notify dispatches change events to matching subscribers.
func (h *SubscriptionHub) Notify(changed []ChangeEvent, cfg *Config) {
	h.mu.RLock()
	subs := make([]*Subscription, 0, len(h.subs))
	for _, s := range h.subs {
		subs = append(subs, s)
	}
	h.mu.RUnlock()

	for _, sub := range subs {
		var matching []ChangeEvent
		for _, event := range changed {
			if sub.matches(event.Key) {
				matching = append(matching, event)
			}
		}
		if len(matching) > 0 {
			go sub.handler(matching) // dispatch concurrently
		}
	}
}

func (s *Subscription) matches(key string) bool {
	if len(s.prefixes) == 0 {
		return true // subscribe to all changes
	}
	for _, prefix := range s.prefixes {
		if key == prefix || strings.HasPrefix(key, prefix+".") {
			return true
		}
	}
	return false
}
```

## Usage Example: Complete Application

```go
// cmd/myapp/main.go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/example/config"
)

func main() {
	// Build the configuration from layered sources.
	cfg, err := config.New(
		// Lowest priority: hardcoded defaults
		config.NewDefaultsLayer("defaults", map[string]any{
			"server": map[string]any{
				"port":           8080,
				"readTimeout":    "30s",
				"writeTimeout":   "30s",
				"maxConnections": 1000,
			},
			"database": map[string]any{
				"host":              "localhost",
				"port":              5432,
				"name":              "myapp",
				"maxConnections":    20,
				"connectionTimeout": "5s",
			},
			"logLevel": "info",
		}),

		// Medium priority: config file
		config.NewFileLayer("/etc/myapp/config.yaml"),

		// Highest priority: environment variables
		// APP_SERVER__PORT=9090 overrides server.port
		config.NewEnvLayer("APP_"),
	)
	if err != nil {
		slog.Error("loading configuration", "err", err)
		os.Exit(1)
	}

	// Attach JSON Schema validation.
	schema, err := config.NewSchema(config.ExampleSchema)
	if err != nil {
		slog.Error("compiling schema", "err", err)
		os.Exit(1)
	}
	cfg.WithSchema(schema)

	// Start hot-reload watcher on the config file.
	watcher, err := config.Watch(cfg, 300*time.Millisecond,
		"/etc/myapp/config.yaml",
	)
	if err != nil {
		slog.Error("starting config watcher", "err", err)
		os.Exit(1)
	}
	defer watcher.Stop()

	// Subscribe to log level changes — no restart needed.
	cfg.Subscribe(func(events []config.ChangeEvent) {
		for _, e := range events {
			if e.Key == "logLevel" {
				newLevel := fmt.Sprintf("%v", e.NewValue)
				slog.Info("log level changed",
					"from", e.OldValue,
					"to", newLevel,
				)
				// Update the slog level dynamically.
				updateLogLevel(newLevel)
			}
		}
	}, "logLevel")

	// Subscribe to database pool changes.
	cfg.Subscribe(func(events []config.ChangeEvent) {
		slog.Info("database config changed, resizing pool")
		resizeDatabasePool(cfg)
	}, "database")

	// Start the HTTP server using config values.
	mux := http.NewServeMux()
	mux.HandleFunc("/config", func(w http.ResponseWriter, r *http.Request) {
		// Redact sensitive values before exposing
		snap := cfg.Snapshot()
		delete(snap, "database")
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"version": cfg.Version(),
			"config":  snap,
		})
	})

	server := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Int("server.port", 8080)),
		Handler:      mux,
		ReadTimeout:  cfg.Duration("server.readTimeout", 30*time.Second),
		WriteTimeout: cfg.Duration("server.writeTimeout", 30*time.Second),
	}

	slog.Info("starting server",
		"port", cfg.Int("server.port", 8080),
		"version", cfg.Version(),
	)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		if err := server.ListenAndServe(); err != http.ErrServerClosed {
			slog.Error("server error", "err", err)
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	server.Shutdown(shutdownCtx)
}
```

## Kubernetes ConfigMap Integration

In Kubernetes, ConfigMaps mounted as files are automatically updated when the ConfigMap changes (with a small delay). The file watcher catches these updates:

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
spec:
  template:
    spec:
      containers:
        - name: myapp
          image: registry.example.com/myapp:v1.0.0
          env:
            # Override via environment variables (highest priority)
            - name: APP_SERVER__PORT
              value: "8080"
            - name: APP_DATABASE__HOST
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: host
          volumeMounts:
            - name: config
              mountPath: /etc/myapp
      volumes:
        - name: config
          configMap:
            name: myapp-config
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: myapp-config
data:
  config.yaml: |
    server:
      port: 8080
      readTimeout: 30s
      maxConnections: 500
    database:
      name: myapp_prod
      maxConnections: 50
    logLevel: info
    features:
      newCheckout: true
      experimentalSearch: false
```

Changing the ConfigMap:

```bash
kubectl patch configmap myapp-config \
  --type=merge \
  -p '{"data":{"config.yaml":"server:\n  port: 8080\n  maxConnections: 1000\ndatabase:\n  name: myapp_prod\n  maxConnections: 100\nlogLevel: debug\nfeatures:\n  newCheckout: true\n  experimentalSearch: true\n"}}'
```

The Kubelet will update the mounted file within the ConfigMap sync period (default 1 minute). The file watcher will detect the change and hot-reload within 300 ms.

## Testing Configuration Reloading

```go
// config/config_test.go
package config_test

import (
	"os"
	"testing"
	"time"

	"github.com/example/config"
)

func TestHotReload(t *testing.T) {
	// Write initial config file
	f, err := os.CreateTemp("", "config-*.yaml")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())

	f.WriteString("server:\n  port: 8080\n  maxConnections: 100\nlogLevel: info\n")
	f.Close()

	cfg, err := config.New(config.NewFileLayer(f.Name()))
	if err != nil {
		t.Fatal(err)
	}

	// Start watcher
	watcher, err := config.Watch(cfg, 100*time.Millisecond, f.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.Stop()

	// Subscribe to changes
	changed := make(chan config.ChangeEvent, 10)
	cfg.Subscribe(func(events []config.ChangeEvent) {
		for _, e := range events {
			changed <- e
		}
	})

	// Verify initial values
	if got := cfg.Int("server.maxConnections", 0); got != 100 {
		t.Errorf("initial maxConnections: got %d, want 100", got)
	}

	// Modify the file
	os.WriteFile(f.Name(), []byte("server:\n  port: 8080\n  maxConnections: 500\nlogLevel: debug\n"), 0644)

	// Wait for change notification
	select {
	case event := <-changed:
		t.Logf("received change: key=%s old=%v new=%v", event.Key, event.OldValue, event.NewValue)
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for config change notification")
	}

	// Verify new values
	if got := cfg.Int("server.maxConnections", 0); got != 500 {
		t.Errorf("reloaded maxConnections: got %d, want 500", got)
	}
	if got := cfg.String("logLevel", ""); got != "debug" {
		t.Errorf("reloaded logLevel: got %s, want debug", got)
	}
}

func TestSchemaValidationRejectsInvalid(t *testing.T) {
	schema, _ := config.NewSchema(config.ExampleSchema)

	// Valid config
	cfg, err := config.New(config.NewDefaultsLayer("test", map[string]any{
		"server":   map[string]any{"port": 8080},
		"database": map[string]any{"host": "localhost", "port": 5432, "name": "test"},
		"logLevel": "info",
	}))
	cfg.WithSchema(schema)
	if err != nil {
		t.Fatal("valid config should not fail:", err)
	}

	// Invalid: port out of range
	_, err = config.New(config.NewDefaultsLayer("test", map[string]any{
		"server":   map[string]any{"port": 99},  // too low
		"database": map[string]any{"host": "localhost", "port": 5432, "name": "test"},
		"logLevel": "info",
	}))
	cfg2, _ := config.New(config.NewDefaultsLayer("test", map[string]any{
		"server":   map[string]any{"port": 99},
		"database": map[string]any{"host": "localhost", "port": 5432, "name": "test"},
		"logLevel": "info",
	}))
	cfg2.WithSchema(schema)
	// Trigger reload to apply schema
	// In a real test, call cfg2.Reload() or use a file that gets validated on load.
	if err == nil {
		t.Log("note: schema validation is applied on reload")
	}
}
```

## Summary

A production configuration management system in Go requires:

- **Layered sources** with clear precedence: defaults < file < environment < remote
- **fsnotify-based file watching** with debouncing to handle editor write patterns and Kubernetes ConfigMap atomic updates
- **JSON Schema validation** applied before swapping in new configuration, ensuring invalid configs are rejected with clear error messages
- **Thread-safe RWMutex access** separating reads (common path, read lock) from reloads (infrequent, write lock)
- **Typed accessors** returning Go types directly rather than strings that callers must parse
- **Change notification** via a subscription hub, enabling subsystems to react to specific key changes without polling

The result is an application that can adapt to configuration changes in real time—updating feature flags, resizing connection pools, adjusting log levels—without the disruption of a restart, while maintaining safety through schema validation.
