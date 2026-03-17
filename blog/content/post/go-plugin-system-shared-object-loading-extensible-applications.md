---
title: "Go: Implementing a Plugin System with Go Plugins and Shared Object Loading"
date: 2031-08-08T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Plugins", "Architecture", "Extensibility", "Systems Programming"]
categories:
- Go
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building extensible Go applications using the plugin package, shared object (.so) loading, and interface-based plugin contracts for enterprise-grade extensibility."
more_link: "yes"
url: "/go-plugin-system-shared-object-loading-extensible-applications/"
---

Go's `plugin` package, introduced in Go 1.8, provides the ability to load shared object files at runtime. While often overlooked in favor of other extension patterns, native Go plugins offer unique advantages when you need true runtime extensibility without recompilation. This post builds a complete, production-grade plugin system with discovery, versioning, dependency injection, and safe unload patterns.

<!--more-->

# Go: Implementing a Plugin System with Go Plugins and Shared Object Loading

## Overview

The Go plugin system enables you to compile Go code as a shared library (`.so` on Linux, `.dylib` on macOS) and load it dynamically at runtime. This is particularly valuable for:

- **Extensible data pipelines** — load transform or sink plugins without redeploying
- **Authentication providers** — swap or add auth backends at runtime
- **Monitoring exporters** — add new metric backends without core service changes
- **Business logic extensions** — let customers provide custom processing logic

This guide covers the full lifecycle: defining plugin contracts, building plugins, loading them safely, handling versioning, and integrating with dependency injection.

---

## Section 1: Plugin System Architecture

### 1.1 Core Concepts

A Go plugin system has three layers:

```
┌─────────────────────────────────────────────────────┐
│                  Host Application                    │
│                                                      │
│  ┌──────────────┐    ┌──────────────────────────┐   │
│  │   Plugin     │    │      Plugin Registry      │   │
│  │   Loader     │───▶│  (discovery + lifecycle)  │   │
│  └──────────────┘    └──────────────────────────┘   │
│           │                       │                  │
│           ▼                       ▼                  │
│  ┌──────────────────────────────────────────────┐   │
│  │            Shared Interfaces Package          │   │
│  │    (contracts shared between host + plugins)  │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
    ┌──────────┐  ┌──────────┐  ┌──────────┐
    │ plugin-a │  │ plugin-b │  │ plugin-c │
    │  (.so)   │  │  (.so)   │  │  (.so)   │
    └──────────┘  └──────────┘  └──────────┘
```

### 1.2 Project Structure

```
plugin-system/
├── cmd/
│   └── host/
│       └── main.go
├── pkg/
│   ├── contracts/          # Shared interfaces (imported by both host and plugins)
│   │   ├── plugin.go
│   │   ├── processor.go
│   │   └── version.go
│   └── loader/             # Plugin loading and registry
│       ├── loader.go
│       ├── registry.go
│       └── watcher.go
├── plugins/
│   ├── json-transform/
│   │   └── main.go
│   ├── csv-parser/
│   │   └── main.go
│   └── kafka-sink/
│       └── main.go
├── go.mod
└── Makefile
```

---

## Section 2: Defining Plugin Contracts

The contracts package must be a stable, versioned interface that both the host application and all plugins import.

### 2.1 Core Plugin Interface

```go
// pkg/contracts/plugin.go
package contracts

import "context"

// APIVersion is the plugin API contract version.
// Plugins with incompatible API versions will be rejected.
const APIVersion = "v1.2.0"

// PluginInfo contains metadata about a plugin.
type PluginInfo struct {
    Name        string
    Version     string
    APIVersion  string
    Description string
    Author      string
    Tags        []string
}

// Plugin is the base interface that every plugin must implement.
// The symbol "Plugin" must be exported from the .so file.
type Plugin interface {
    // Info returns plugin metadata. Called once during registration.
    Info() PluginInfo

    // Init initializes the plugin with configuration. Called after loading.
    Init(cfg map[string]interface{}) error

    // Shutdown performs a graceful shutdown. Called before unloading.
    Shutdown(ctx context.Context) error

    // HealthCheck returns nil if the plugin is healthy.
    HealthCheck(ctx context.Context) error
}

// Configurable plugins can expose their schema.
type Configurable interface {
    Plugin
    // ConfigSchema returns a JSON Schema describing accepted configuration.
    ConfigSchema() []byte
}
```

### 2.2 Processor Plugin Interface

```go
// pkg/contracts/processor.go
package contracts

import "context"

// Record represents a data record flowing through the pipeline.
type Record struct {
    ID       string
    Data     map[string]interface{}
    Metadata map[string]string
    Tags     []string
}

// ProcessResult contains the output of processing a record.
type ProcessResult struct {
    Records []*Record
    Dropped bool
    Error   error
}

// Processor plugins transform data records.
// Must also implement Plugin.
type Processor interface {
    Plugin

    // Process transforms a record. May return multiple records (fan-out),
    // a single modified record, or indicate the record should be dropped.
    Process(ctx context.Context, record *Record) (*ProcessResult, error)

    // BatchProcess processes multiple records at once for efficiency.
    // Default implementations can delegate to Process.
    BatchProcess(ctx context.Context, records []*Record) ([]*ProcessResult, error)
}

// Sink plugins write records to external destinations.
type Sink interface {
    Plugin

    // Write sends a record to the destination.
    Write(ctx context.Context, record *Record) error

    // Flush forces any buffered records to be written.
    Flush(ctx context.Context) error
}

// Source plugins read records from external sources.
type Source interface {
    Plugin

    // Start begins emitting records into the provided channel.
    Start(ctx context.Context, out chan<- *Record) error
}
```

### 2.3 Version Compatibility

```go
// pkg/contracts/version.go
package contracts

import (
    "fmt"
    "strconv"
    "strings"
)

// SemVer is a simple semantic version representation.
type SemVer struct {
    Major int
    Minor int
    Patch int
}

// ParseSemVer parses a "vX.Y.Z" string.
func ParseSemVer(s string) (SemVer, error) {
    s = strings.TrimPrefix(s, "v")
    parts := strings.Split(s, ".")
    if len(parts) != 3 {
        return SemVer{}, fmt.Errorf("invalid semver: %q", s)
    }
    var v SemVer
    var err error
    if v.Major, err = strconv.Atoi(parts[0]); err != nil {
        return SemVer{}, fmt.Errorf("invalid major: %w", err)
    }
    if v.Minor, err = strconv.Atoi(parts[1]); err != nil {
        return SemVer{}, fmt.Errorf("invalid minor: %w", err)
    }
    if v.Patch, err = strconv.Atoi(parts[2]); err != nil {
        return SemVer{}, fmt.Errorf("invalid patch: %w", err)
    }
    return v, nil
}

// IsCompatible returns true if pluginAPIVersion is compatible with hostAPIVersion.
// A plugin is compatible if its major version matches and its minor version
// is less than or equal to the host's minor version.
func IsCompatible(hostVersion, pluginVersion string) bool {
    host, err := ParseSemVer(hostVersion)
    if err != nil {
        return false
    }
    plugin, err := ParseSemVer(pluginVersion)
    if err != nil {
        return false
    }
    return host.Major == plugin.Major && plugin.Minor <= host.Minor
}
```

---

## Section 3: Plugin Loader Implementation

### 3.1 Core Loader

```go
// pkg/loader/loader.go
package loader

import (
    "fmt"
    "os"
    "path/filepath"
    "plugin"
    "sync"
    "time"

    "github.com/yourorg/plugin-system/pkg/contracts"
    "go.uber.org/zap"
)

// LoadedPlugin represents a plugin that has been successfully loaded.
type LoadedPlugin struct {
    Info       contracts.PluginInfo
    Plugin     contracts.Plugin
    Path       string
    LoadedAt   time.Time
    handle     *plugin.Plugin  // keep reference to prevent GC
}

// Loader handles loading and unloading of plugin .so files.
type Loader struct {
    mu      sync.RWMutex
    loaded  map[string]*LoadedPlugin
    logger  *zap.Logger
}

// NewLoader creates a new plugin loader.
func NewLoader(logger *zap.Logger) *Loader {
    return &Loader{
        loaded: make(map[string]*LoadedPlugin),
        logger: logger,
    }
}

// Load loads a plugin from a .so file path.
func (l *Loader) Load(path string) (*LoadedPlugin, error) {
    l.logger.Info("loading plugin", zap.String("path", path))

    // Verify file exists and is readable
    if _, err := os.Stat(path); err != nil {
        return nil, fmt.Errorf("plugin file not accessible: %w", err)
    }

    // Open the shared object
    p, err := plugin.Open(path)
    if err != nil {
        return nil, fmt.Errorf("failed to open plugin %q: %w", path, err)
    }

    // Look up the exported "Plugin" symbol
    sym, err := p.Lookup("Plugin")
    if err != nil {
        return nil, fmt.Errorf("plugin %q missing exported 'Plugin' symbol: %w", path, err)
    }

    // Assert the symbol implements our Plugin interface
    // The .so must export: var Plugin contracts.Plugin = &MyPlugin{}
    pluginImpl, ok := sym.(contracts.Plugin)
    if !ok {
        // Try pointer-to-interface pattern
        pluginPtr, ok := sym.(*contracts.Plugin)
        if !ok {
            return nil, fmt.Errorf("plugin %q exported 'Plugin' symbol does not implement contracts.Plugin", path)
        }
        pluginImpl = *pluginPtr
    }

    info := pluginImpl.Info()

    // Check API version compatibility
    if !contracts.IsCompatible(contracts.APIVersion, info.APIVersion) {
        return nil, fmt.Errorf(
            "plugin %q API version %q is incompatible with host API version %q",
            info.Name, info.APIVersion, contracts.APIVersion,
        )
    }

    lp := &LoadedPlugin{
        Info:     info,
        Plugin:   pluginImpl,
        Path:     path,
        LoadedAt: time.Now(),
        handle:   p,
    }

    l.mu.Lock()
    l.loaded[info.Name] = lp
    l.mu.Unlock()

    l.logger.Info("plugin loaded successfully",
        zap.String("name", info.Name),
        zap.String("version", info.Version),
        zap.String("api_version", info.APIVersion),
    )

    return lp, nil
}

// LoadDirectory loads all .so files from a directory.
func (l *Loader) LoadDirectory(dir string) ([]*LoadedPlugin, error) {
    entries, err := os.ReadDir(dir)
    if err != nil {
        return nil, fmt.Errorf("failed to read plugin directory %q: %w", dir, err)
    }

    var loaded []*LoadedPlugin
    var lastErr error

    for _, entry := range entries {
        if entry.IsDir() || filepath.Ext(entry.Name()) != ".so" {
            continue
        }
        path := filepath.Join(dir, entry.Name())
        lp, err := l.Load(path)
        if err != nil {
            l.logger.Error("failed to load plugin",
                zap.String("path", path),
                zap.Error(err),
            )
            lastErr = err
            continue
        }
        loaded = append(loaded, lp)
    }

    return loaded, lastErr
}

// Get returns a loaded plugin by name.
func (l *Loader) Get(name string) (*LoadedPlugin, bool) {
    l.mu.RLock()
    defer l.mu.RUnlock()
    lp, ok := l.loaded[name]
    return lp, ok
}

// List returns all loaded plugins.
func (l *Loader) List() []*LoadedPlugin {
    l.mu.RLock()
    defer l.mu.RUnlock()
    result := make([]*LoadedPlugin, 0, len(l.loaded))
    for _, lp := range l.loaded {
        result = append(result, lp)
    }
    return result
}
```

### 3.2 Plugin Registry with Initialization

```go
// pkg/loader/registry.go
package loader

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/yourorg/plugin-system/pkg/contracts"
    "go.uber.org/zap"
)

// Registry manages plugin lifecycle including initialization and health checks.
type Registry struct {
    mu       sync.RWMutex
    plugins  map[string]*RegisteredPlugin
    loader   *Loader
    logger   *zap.Logger
}

// RegisteredPlugin wraps a loaded plugin with its runtime state.
type RegisteredPlugin struct {
    *LoadedPlugin
    Config      map[string]interface{}
    InitializedAt time.Time
    Healthy     bool
    LastHealthAt time.Time
    lastErr     error
}

// NewRegistry creates a new plugin registry.
func NewRegistry(loader *Loader, logger *zap.Logger) *Registry {
    return &Registry{
        plugins: make(map[string]*RegisteredPlugin),
        loader:  loader,
        logger:  logger,
    }
}

// Register loads, validates, and initializes a plugin.
func (r *Registry) Register(path string, cfg map[string]interface{}) error {
    lp, err := r.loader.Load(path)
    if err != nil {
        return fmt.Errorf("load failed: %w", err)
    }

    // Initialize the plugin
    if err := lp.Plugin.Init(cfg); err != nil {
        return fmt.Errorf("plugin %q initialization failed: %w", lp.Info.Name, err)
    }

    rp := &RegisteredPlugin{
        LoadedPlugin:  lp,
        Config:        cfg,
        InitializedAt: time.Now(),
        Healthy:       true,
    }

    r.mu.Lock()
    r.plugins[lp.Info.Name] = rp
    r.mu.Unlock()

    r.logger.Info("plugin registered",
        zap.String("name", lp.Info.Name),
        zap.String("version", lp.Info.Version),
    )
    return nil
}

// GetProcessor returns a registered plugin cast to the Processor interface.
func (r *Registry) GetProcessor(name string) (contracts.Processor, error) {
    r.mu.RLock()
    rp, ok := r.plugins[name]
    r.mu.RUnlock()

    if !ok {
        return nil, fmt.Errorf("plugin %q not registered", name)
    }
    if !rp.Healthy {
        return nil, fmt.Errorf("plugin %q is not healthy: %v", name, rp.lastErr)
    }

    proc, ok := rp.Plugin.(contracts.Processor)
    if !ok {
        return nil, fmt.Errorf("plugin %q does not implement contracts.Processor", name)
    }
    return proc, nil
}

// GetSink returns a registered plugin cast to the Sink interface.
func (r *Registry) GetSink(name string) (contracts.Sink, error) {
    r.mu.RLock()
    rp, ok := r.plugins[name]
    r.mu.RUnlock()

    if !ok {
        return nil, fmt.Errorf("plugin %q not registered", name)
    }

    sink, ok := rp.Plugin.(contracts.Sink)
    if !ok {
        return nil, fmt.Errorf("plugin %q does not implement contracts.Sink", name)
    }
    return sink, nil
}

// RunHealthChecks runs health checks on all plugins concurrently.
func (r *Registry) RunHealthChecks(ctx context.Context) map[string]error {
    r.mu.RLock()
    names := make([]string, 0, len(r.plugins))
    for name := range r.plugins {
        names = append(names, name)
    }
    r.mu.RUnlock()

    results := make(map[string]error, len(names))
    var mu sync.Mutex
    var wg sync.WaitGroup

    for _, name := range names {
        wg.Add(1)
        go func(n string) {
            defer wg.Done()

            r.mu.RLock()
            rp, ok := r.plugins[n]
            r.mu.RUnlock()
            if !ok {
                return
            }

            err := rp.Plugin.HealthCheck(ctx)

            r.mu.Lock()
            rp.Healthy = err == nil
            rp.lastErr = err
            rp.LastHealthAt = time.Now()
            r.mu.Unlock()

            mu.Lock()
            results[n] = err
            mu.Unlock()
        }(name)
    }

    wg.Wait()
    return results
}

// Shutdown gracefully shuts down all plugins.
func (r *Registry) Shutdown(ctx context.Context) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    var lastErr error
    for name, rp := range r.plugins {
        if err := rp.Plugin.Shutdown(ctx); err != nil {
            r.logger.Error("plugin shutdown failed",
                zap.String("name", name),
                zap.Error(err),
            )
            lastErr = err
        }
    }
    return lastErr
}
```

### 3.3 Hot-Reload Watcher

```go
// pkg/loader/watcher.go
package loader

import (
    "context"
    "path/filepath"
    "time"

    "github.com/fsnotify/fsnotify"
    "go.uber.org/zap"
)

// WatchConfig configures the filesystem watcher.
type WatchConfig struct {
    Directory    string
    PollInterval time.Duration
    // DefaultConfig is applied to newly discovered plugins.
    DefaultConfig map[string]interface{}
}

// Watcher monitors a directory for new or updated plugin .so files.
type Watcher struct {
    cfg      WatchConfig
    registry *Registry
    logger   *zap.Logger
}

// NewWatcher creates a filesystem watcher for plugin hot-reload.
func NewWatcher(cfg WatchConfig, registry *Registry, logger *zap.Logger) *Watcher {
    return &Watcher{cfg: cfg, registry: registry, logger: logger}
}

// Watch starts watching the plugin directory. Blocks until ctx is cancelled.
func (w *Watcher) Watch(ctx context.Context) error {
    watcher, err := fsnotify.NewWatcher()
    if err != nil {
        return err
    }
    defer watcher.Close()

    if err := watcher.Add(w.cfg.Directory); err != nil {
        return err
    }

    w.logger.Info("watching plugin directory", zap.String("dir", w.cfg.Directory))

    // Debounce map to avoid reloading on partial writes
    pending := make(map[string]time.Time)
    ticker := time.NewTicker(500 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()

        case event, ok := <-watcher.Events:
            if !ok {
                return nil
            }
            if filepath.Ext(event.Name) == ".so" {
                pending[event.Name] = time.Now()
            }

        case err, ok := <-watcher.Errors:
            if !ok {
                return nil
            }
            w.logger.Error("watcher error", zap.Error(err))

        case <-ticker.C:
            now := time.Now()
            for path, t := range pending {
                if now.Sub(t) > 300*time.Millisecond {
                    delete(pending, path)
                    w.logger.Info("reloading plugin", zap.String("path", path))
                    if err := w.registry.Register(path, w.cfg.DefaultConfig); err != nil {
                        w.logger.Error("hot-reload failed",
                            zap.String("path", path),
                            zap.Error(err),
                        )
                    }
                }
            }
        }
    }
}
```

---

## Section 4: Writing a Plugin

### 4.1 JSON Transform Plugin

```go
// plugins/json-transform/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "strings"

    "github.com/yourorg/plugin-system/pkg/contracts"
)

// jsonTransformPlugin implements contracts.Processor
type jsonTransformPlugin struct {
    fieldMappings map[string]string
    dropFields    []string
    addFields     map[string]interface{}
}

// Plugin is the exported symbol the loader looks for.
// IMPORTANT: The variable name must match what the loader expects.
var Plugin contracts.Plugin = &jsonTransformPlugin{}

func (p *jsonTransformPlugin) Info() contracts.PluginInfo {
    return contracts.PluginInfo{
        Name:        "json-transform",
        Version:     "1.0.0",
        APIVersion:  contracts.APIVersion,
        Description: "Transforms JSON records: rename fields, drop fields, add static fields",
        Author:      "support.tools",
        Tags:        []string{"transform", "json", "processor"},
    }
}

func (p *jsonTransformPlugin) Init(cfg map[string]interface{}) error {
    // Parse field_mappings: {"old_name": "new_name"}
    if mappings, ok := cfg["field_mappings"]; ok {
        raw, err := json.Marshal(mappings)
        if err != nil {
            return fmt.Errorf("invalid field_mappings: %w", err)
        }
        if err := json.Unmarshal(raw, &p.fieldMappings); err != nil {
            return fmt.Errorf("invalid field_mappings format: %w", err)
        }
    }

    // Parse drop_fields: ["field1", "field2"]
    if drops, ok := cfg["drop_fields"]; ok {
        if dropSlice, ok := drops.([]interface{}); ok {
            for _, d := range dropSlice {
                if s, ok := d.(string); ok {
                    p.dropFields = append(p.dropFields, s)
                }
            }
        }
    }

    // Parse add_fields: {"new_field": "static_value"}
    if adds, ok := cfg["add_fields"]; ok {
        raw, err := json.Marshal(adds)
        if err != nil {
            return fmt.Errorf("invalid add_fields: %w", err)
        }
        if err := json.Unmarshal(raw, &p.addFields); err != nil {
            return fmt.Errorf("invalid add_fields format: %w", err)
        }
    }

    return nil
}

func (p *jsonTransformPlugin) Shutdown(_ context.Context) error {
    return nil
}

func (p *jsonTransformPlugin) HealthCheck(_ context.Context) error {
    return nil
}

func (p *jsonTransformPlugin) Process(_ context.Context, record *contracts.Record) (*contracts.ProcessResult, error) {
    out := &contracts.Record{
        ID:       record.ID,
        Data:     make(map[string]interface{}, len(record.Data)),
        Metadata: record.Metadata,
        Tags:     record.Tags,
    }

    // Copy existing fields
    for k, v := range record.Data {
        out.Data[k] = v
    }

    // Rename fields
    for oldName, newName := range p.fieldMappings {
        if val, exists := out.Data[oldName]; exists {
            out.Data[newName] = val
            delete(out.Data, oldName)
        }
    }

    // Drop fields
    for _, field := range p.dropFields {
        delete(out.Data, field)
    }

    // Add static fields
    for k, v := range p.addFields {
        out.Data[k] = v
    }

    // Normalize string values: trim whitespace
    for k, v := range out.Data {
        if s, ok := v.(string); ok {
            out.Data[k] = strings.TrimSpace(s)
        }
    }

    return &contracts.ProcessResult{Records: []*contracts.Record{out}}, nil
}

func (p *jsonTransformPlugin) BatchProcess(ctx context.Context, records []*contracts.Record) ([]*contracts.ProcessResult, error) {
    results := make([]*contracts.ProcessResult, len(records))
    for i, r := range records {
        res, err := p.Process(ctx, r)
        if err != nil {
            return nil, fmt.Errorf("record %d: %w", i, err)
        }
        results[i] = res
    }
    return results, nil
}

func (p *jsonTransformPlugin) ConfigSchema() []byte {
    schema := `{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "field_mappings": {
          "type": "object",
          "additionalProperties": {"type": "string"},
          "description": "Map of old field names to new field names"
        },
        "drop_fields": {
          "type": "array",
          "items": {"type": "string"},
          "description": "Fields to remove from the record"
        },
        "add_fields": {
          "type": "object",
          "description": "Static fields to add to every record"
        }
      }
    }`
    return []byte(schema)
}
```

### 4.2 Build Script for Plugins

```makefile
# Makefile

PLUGIN_DIR := ./plugins
BUILD_DIR  := ./dist/plugins
GO         := go

.PHONY: all plugins clean

all: plugins

plugins: $(BUILD_DIR)
	@for dir in $(PLUGIN_DIR)/*/; do \
		name=$$(basename $$dir); \
		echo "Building plugin: $$name"; \
		$(GO) build \
			-buildmode=plugin \
			-trimpath \
			-ldflags="-s -w" \
			-o $(BUILD_DIR)/$$name.so \
			./$(PLUGIN_DIR)/$$name/...; \
	done

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

clean:
	rm -rf $(BUILD_DIR)

# Build plugin for testing without trimpath (enables race detector)
test-plugin:
	$(GO) build \
		-buildmode=plugin \
		-race \
		-o $(BUILD_DIR)/json-transform-test.so \
		./plugins/json-transform/...
```

---

## Section 5: Host Application Integration

### 5.1 Main Application

```go
// cmd/host/main.go
package main

import (
    "context"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/yourorg/plugin-system/pkg/loader"
    "go.uber.org/zap"
)

func main() {
    logger, _ := zap.NewProduction()
    defer logger.Sync()

    ctx, cancel := signal.NotifyContext(context.Background(),
        os.Interrupt, syscall.SIGTERM,
    )
    defer cancel()

    // Initialize plugin infrastructure
    pluginLoader := loader.NewLoader(logger)
    registry := loader.NewRegistry(pluginLoader, logger)

    // Load plugins from directory
    pluginsDir := os.Getenv("PLUGINS_DIR")
    if pluginsDir == "" {
        pluginsDir = "./dist/plugins"
    }

    loaded, err := pluginLoader.LoadDirectory(pluginsDir)
    if err != nil {
        logger.Warn("some plugins failed to load", zap.Error(err))
    }

    // Initialize each loaded plugin
    defaultCfg := map[string]interface{}{
        "add_fields": map[string]interface{}{
            "processed_by": "plugin-system",
            "host":         "production-worker-1",
        },
    }

    for _, lp := range loaded {
        if err := registry.Register(lp.Path, defaultCfg); err != nil {
            logger.Error("plugin registration failed",
                zap.String("name", lp.Info.Name),
                zap.Error(err),
            )
        }
    }

    // Start hot-reload watcher
    watcher := loader.NewWatcher(loader.WatchConfig{
        Directory:     pluginsDir,
        DefaultConfig: defaultCfg,
    }, registry, logger)

    go func() {
        if err := watcher.Watch(ctx); err != nil && ctx.Err() == nil {
            logger.Error("watcher stopped", zap.Error(err))
        }
    }()

    // Start health check loop
    go func() {
        ticker := time.NewTicker(30 * time.Second)
        defer ticker.Stop()
        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                results := registry.RunHealthChecks(ctx)
                for name, err := range results {
                    if err != nil {
                        logger.Warn("plugin unhealthy",
                            zap.String("plugin", name),
                            zap.Error(err),
                        )
                    }
                }
            }
        }
    }()

    // Run the pipeline
    if err := runPipeline(ctx, registry, logger); err != nil {
        logger.Error("pipeline failed", zap.Error(err))
    }

    // Shutdown
    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()

    if err := registry.Shutdown(shutdownCtx); err != nil {
        logger.Error("registry shutdown error", zap.Error(err))
    }

    logger.Info("shutdown complete")
}

func runPipeline(ctx context.Context, registry *loader.Registry, logger *zap.Logger) error {
    processor, err := registry.GetProcessor("json-transform")
    if err != nil {
        return err
    }

    // Example: process a batch of records
    records := []*contracts.Record{
        {
            ID: "record-001",
            Data: map[string]interface{}{
                "user_id":   "12345",
                "event":     "page_view",
                "url":       "  /dashboard  ",
                "timestamp": "2031-08-08T12:00:00Z",
            },
        },
    }

    // Import contracts for the Record type used above
    // (omitted for brevity - would be a proper import)

    results, err := processor.BatchProcess(ctx, records)
    if err != nil {
        return err
    }

    for _, result := range results {
        if result.Dropped {
            continue
        }
        for _, r := range result.Records {
            logger.Info("processed record",
                zap.String("id", r.ID),
                zap.Any("data", r.Data),
            )
        }
    }

    return nil
}
```

---

## Section 6: Go Plugin Constraints and Workarounds

### 6.1 Known Constraints

Go plugins have important constraints that affect production deployments:

| Constraint | Impact | Mitigation |
|------------|--------|------------|
| Same Go version | Plugin and host must use identical Go toolchain | Pin Go version in CI |
| Same build flags | `-trimpath`, `-race`, etc. must match | Enforce via Makefile |
| Linux/macOS only | No Windows support | Use Docker for cross-platform |
| No unloading | Plugins cannot be unloaded after first load | Restart process to unload |
| Shared packages must match | Imported packages must be identical | Vendor dependencies |

### 6.2 Handling Same-Package Requirement

The most common issue is that interfaces defined in the contracts package must be the exact same compiled instance in both the host and plugin:

```bash
# Both host and plugin MUST be built from the same go.mod
# Verify with:
go version -m ./dist/plugins/json-transform.so
go version -m ./cmd/host/host

# They must show identical module versions for shared packages
```

### 6.3 Alternative: HashiCorp go-plugin (RPC-based)

For teams that need cross-platform support or isolation, the HashiCorp `go-plugin` library provides an RPC-based alternative:

```go
// Using hashicorp/go-plugin for gRPC-based plugins
import (
    "github.com/hashicorp/go-plugin"
)

// Plugin interfaces over gRPC - works on all platforms
var pluginMap = map[string]goplugin.Plugin{
    "processor": &ProcessorGRPCPlugin{},
}

// Start as subprocess
client := goplugin.NewClient(&goplugin.ClientConfig{
    HandshakeConfig: HandshakeConfig,
    Plugins:         pluginMap,
    Cmd:             exec.Command("./plugins/json-transform"),
    AllowedProtocols: []goplugin.Protocol{
        goplugin.ProtocolGRPC,
    },
})
```

The RPC approach sacrifices some performance but gains:
- Cross-platform support including Windows
- Plugin crash isolation (plugin crash does not crash host)
- Different Go versions between host and plugin
- True dynamic loading/unloading

---

## Section 7: Testing Plugin Systems

### 7.1 Unit Testing Plugin Logic Without .so

```go
// plugins/json-transform/transform_test.go
package main

import (
    "context"
    "testing"

    "github.com/yourorg/plugin-system/pkg/contracts"
)

func TestJSONTransformProcess(t *testing.T) {
    p := &jsonTransformPlugin{}
    err := p.Init(map[string]interface{}{
        "field_mappings": map[string]interface{}{
            "user_id": "userId",
        },
        "drop_fields": []interface{}{"internal_debug"},
        "add_fields": map[string]interface{}{
            "source": "test",
        },
    })
    if err != nil {
        t.Fatalf("Init failed: %v", err)
    }

    record := &contracts.Record{
        ID: "test-001",
        Data: map[string]interface{}{
            "user_id":        "abc123",
            "event":          "login",
            "internal_debug": "should-be-dropped",
            "url":            "  /api/v1  ",
        },
    }

    result, err := p.Process(context.Background(), record)
    if err != nil {
        t.Fatalf("Process failed: %v", err)
    }

    if result.Dropped {
        t.Fatal("record should not be dropped")
    }
    if len(result.Records) != 1 {
        t.Fatalf("expected 1 record, got %d", len(result.Records))
    }

    out := result.Records[0]

    if _, exists := out.Data["user_id"]; exists {
        t.Error("old field 'user_id' should have been renamed")
    }
    if out.Data["userId"] != "abc123" {
        t.Errorf("renamed field 'userId' = %v, want 'abc123'", out.Data["userId"])
    }
    if _, exists := out.Data["internal_debug"]; exists {
        t.Error("field 'internal_debug' should have been dropped")
    }
    if out.Data["source"] != "test" {
        t.Errorf("added field 'source' = %v, want 'test'", out.Data["source"])
    }
    if out.Data["url"] != "/api/v1" {
        t.Errorf("url should be trimmed, got %q", out.Data["url"])
    }
}
```

### 7.2 Integration Testing with Built Plugins

```go
// pkg/loader/loader_integration_test.go
//go:build integration

package loader_test

import (
    "context"
    "os"
    "os/exec"
    "testing"

    "github.com/yourorg/plugin-system/pkg/loader"
    "go.uber.org/zap"
)

func buildTestPlugin(t *testing.T, pluginDir string) string {
    t.Helper()

    outPath := t.TempDir() + "/test-plugin.so"
    cmd := exec.Command("go", "build",
        "-buildmode=plugin",
        "-o", outPath,
        pluginDir,
    )
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr
    if err := cmd.Run(); err != nil {
        t.Fatalf("failed to build test plugin: %v", err)
    }
    return outPath
}

func TestLoadPlugin(t *testing.T) {
    logger, _ := zap.NewDevelopment()
    l := loader.NewLoader(logger)

    soPath := buildTestPlugin(t, "../../plugins/json-transform")

    lp, err := l.Load(soPath)
    if err != nil {
        t.Fatalf("Load failed: %v", err)
    }

    if lp.Info.Name != "json-transform" {
        t.Errorf("unexpected plugin name: %s", lp.Info.Name)
    }

    ctx := context.Background()
    if err := lp.Plugin.HealthCheck(ctx); err != nil {
        t.Errorf("health check failed: %v", err)
    }
}
```

---

## Section 8: Production Deployment Considerations

### 8.1 Kubernetes Plugin Volume Mount

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pipeline-worker
spec:
  template:
    spec:
      initContainers:
        - name: plugin-downloader
          image: aws-cli:latest
          command:
            - sh
            - -c
            - |
              aws s3 sync s3://<your-plugins-bucket>/plugins/v1.2.0/ /plugins/
          env:
            - name: AWS_DEFAULT_REGION
              value: us-east-1
          volumeMounts:
            - name: plugins
              mountPath: /plugins
      containers:
        - name: worker
          image: yourorg/pipeline-worker:latest
          env:
            - name: PLUGINS_DIR
              value: /plugins
          volumeMounts:
            - name: plugins
              mountPath: /plugins
              readOnly: true
      volumes:
        - name: plugins
          emptyDir: {}
```

### 8.2 Plugin Signing and Verification

Never load untrusted .so files. Implement signature verification:

```go
// Verify plugin signature before loading
func verifyPluginSignature(path, sigPath, pubKeyPath string) error {
    pubKeyData, err := os.ReadFile(pubKeyPath)
    if err != nil {
        return fmt.Errorf("read public key: %w", err)
    }

    sigData, err := os.ReadFile(sigPath)
    if err != nil {
        return fmt.Errorf("read signature: %w", err)
    }

    pluginData, err := os.ReadFile(path)
    if err != nil {
        return fmt.Errorf("read plugin: %w", err)
    }

    // Parse Ed25519 public key and verify signature
    // Implementation depends on key format (PEM, raw bytes, etc.)
    _ = pubKeyData
    _ = sigData
    _ = pluginData

    // Use crypto/ed25519 or similar for actual verification
    return nil
}
```

---

## Summary

Go's native plugin system, while constrained in certain ways, provides genuine runtime extensibility for Linux-based production deployments. The key principles for a production-grade plugin system:

1. **Stable interface contracts** — put all shared interfaces in a dedicated package with semantic versioning
2. **Version compatibility checking** — reject plugins with incompatible API versions at load time
3. **Initialization separation** — separate loading from initialization to support pre-flight validation
4. **Health checking** — periodically verify plugins are healthy and mark them unhealthy on failure
5. **Build discipline** — enforce identical Go version and build flags between host and plugins in CI
6. **Sign your plugins** — never load unsigned .so files from untrusted sources
7. **Consider go-plugin** — for cross-platform requirements or stronger isolation, the HashiCorp RPC approach is more robust

For teams that cannot tolerate the Go version constraint, the HashiCorp `go-plugin` gRPC approach is the production-standard choice used by tools like Terraform and Vault.
