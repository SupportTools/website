---
title: "Go Plugin Architecture: Building Extensible Systems with HashiCorp go-plugin"
date: 2028-09-26T00:00:00-05:00
draft: false
tags: ["Go", "Plugin Architecture", "HashiCorp", "gRPC", "Software Design"]
categories:
- Go
- Software Design
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go plugin architecture including native Go plugins caveats, HashiCorp go-plugin framework with gRPC transport, versioned interfaces, plugin discovery, subprocess isolation, health checking, and building a production-grade plugin system with dynamic loading."
more_link: "yes"
url: "/go-plugin-architecture-hashicorp-plugin-guide/"
---

Go's standard `plugin` package exists but is rarely the right choice for production plugin systems. Shared object plugins require identical Go toolchain versions, identical dependency trees, and the same `GOPATH` layout. In practice this means plugins must be compiled as part of the same build process as the host — which defeats the purpose of dynamic extensibility.

HashiCorp's `go-plugin` library takes a different approach: each plugin runs as a separate subprocess communicating over gRPC (or net/rpc). This provides process isolation, versioned interfaces, and complete independence from the host's build toolchain. Terraform, Packer, and Vault all use this model.

This guide builds a complete plugin system from interface definition through discovery and lifecycle management.

<!--more-->

# Go Plugin Architecture: Building Extensible Systems with HashiCorp go-plugin

## Why Not Native Go Plugins?

```go
// The standard plugin package (go/plugin) has severe limitations:
// 1. Plugin and host must be compiled with identical Go versions
// 2. All shared packages must match exactly (same import paths and versions)
// 3. Plugins cannot be unloaded (memory leak risk)
// 4. No Windows support
// 5. CGO must be enabled

// This works... barely:
p, err := plugin.Open("/path/to/plugin.so")
sym, err := p.Lookup("MyFunc")
f := sym.(func() string)
f()

// In practice: any dependency version mismatch causes:
// "plugin was built with a different version of package X"
```

For systems where plugins come from third parties, run in production, or need OS compatibility, the subprocess model is far more practical.

## HashiCorp go-plugin Architecture

```
Host Process                  Plugin Process
┌─────────────────────┐      ┌─────────────────────┐
│  Plugin Client      │      │  Plugin Server       │
│  ├─ grpc.Client     │◄────►│  ├─ grpc.Server      │
│  ├─ Health check    │  gRPC│  ├─ Plugin impl       │
│  └─ Reattach logic  │      │  └─ Graceful shutdown │
└─────────────────────┘      └─────────────────────┘
         │                             │
         └──── subprocess managed ─────┘
              via os/exec
```

The host starts the plugin binary as a child process. The plugin server listens on a random local port (or Unix socket), prints the address on stdout in a specific format, and the host client connects to it. Health checking runs continuously; if the plugin process dies, the client returns errors immediately.

## Project Structure

```
plugin-system/
├── go.mod
├── shared/
│   ├── interface.go        # Plugin interface definitions
│   ├── grpc.go             # gRPC protocol implementation
│   └── proto/
│       └── plugin.proto    # Protobuf service definition
├── host/
│   ├── main.go             # Host application
│   ├── registry.go         # Plugin registry/discovery
│   └── loader.go           # Plugin loader
├── plugin-greeter/
│   ├── main.go             # Plugin entry point (separate binary)
│   └── greeter.go          # Plugin implementation
└── plugin-transformer/
    ├── main.go
    └── transformer.go
```

## Step 1: Define the Plugin Interface

The interface lives in a shared package imported by both host and plugin:

```go
// shared/interface.go
package shared

import (
    "context"
)

// Greeter is the interface all greeter plugins must implement.
// This is the contract between host and plugin.
type Greeter interface {
    // Greet generates a greeting for the given name
    Greet(ctx context.Context, req *GreetRequest) (*GreetResponse, error)

    // Capabilities returns metadata about what this plugin supports
    Capabilities(ctx context.Context) (*CapabilitiesResponse, error)
}

// GreetRequest is the input to Greet
type GreetRequest struct {
    Name     string
    Language string
    Formal   bool
}

// GreetResponse is the output from Greet
type GreetResponse struct {
    Greeting string
    Plugin   string  // Which plugin generated this
}

// CapabilitiesResponse describes plugin features
type CapabilitiesResponse struct {
    PluginName    string
    PluginVersion string
    Languages     []string
    APIVersion    int
}

// Transformer is a second plugin interface (demonstrates multi-interface plugins)
type Transformer interface {
    Transform(ctx context.Context, input string, options map[string]string) (string, error)
}
```

## Step 2: Define the Protobuf Service

```protobuf
// shared/proto/plugin.proto
syntax = "proto3";

package plugin;
option go_package = "github.com/example/plugin-system/shared/proto";

service GreeterPlugin {
    rpc Greet(GreetRequest) returns (GreetResponse);
    rpc Capabilities(Empty) returns (CapabilitiesResponse);
}

service TransformerPlugin {
    rpc Transform(TransformRequest) returns (TransformResponse);
}

message Empty {}

message GreetRequest {
    string name = 1;
    string language = 2;
    bool formal = 3;
}

message GreetResponse {
    string greeting = 1;
    string plugin = 2;
}

message CapabilitiesResponse {
    string plugin_name = 1;
    string plugin_version = 2;
    repeated string languages = 3;
    int32 api_version = 4;
}

message TransformRequest {
    string input = 1;
    map<string, string> options = 2;
}

message TransformResponse {
    string output = 1;
}
```

```bash
# Generate Go code from proto
protoc \
    --go_out=. \
    --go-grpc_out=. \
    shared/proto/plugin.proto
```

## Step 3: Implement the gRPC Bridge

The gRPC bridge adapts between the Go interface and the generated proto stubs:

```go
// shared/grpc.go
package shared

import (
    "context"

    "google.golang.org/grpc"
    pb "github.com/example/plugin-system/shared/proto"
)

// ---- gRPC Client (runs in host process) ----

// GRPCGreeterClient wraps the generated gRPC client and implements Greeter
type GRPCGreeterClient struct {
    client pb.GreeterPluginClient
}

func (c *GRPCGreeterClient) Greet(ctx context.Context, req *GreetRequest) (*GreetResponse, error) {
    resp, err := c.client.Greet(ctx, &pb.GreetRequest{
        Name:     req.Name,
        Language: req.Language,
        Formal:   req.Formal,
    })
    if err != nil {
        return nil, err
    }
    return &GreetResponse{
        Greeting: resp.Greeting,
        Plugin:   resp.Plugin,
    }, nil
}

func (c *GRPCGreeterClient) Capabilities(ctx context.Context) (*CapabilitiesResponse, error) {
    resp, err := c.client.Capabilities(ctx, &pb.Empty{})
    if err != nil {
        return nil, err
    }
    return &CapabilitiesResponse{
        PluginName:    resp.PluginName,
        PluginVersion: resp.PluginVersion,
        Languages:     resp.Languages,
        APIVersion:    int(resp.ApiVersion),
    }, nil
}

// ---- gRPC Server (runs in plugin process) ----

// GRPCGreeterServer wraps a Greeter implementation and serves gRPC requests
type GRPCGreeterServer struct {
    pb.UnimplementedGreeterPluginServer
    Impl Greeter
}

func (s *GRPCGreeterServer) Greet(ctx context.Context, req *pb.GreetRequest) (*pb.GreetResponse, error) {
    resp, err := s.Impl.Greet(ctx, &GreetRequest{
        Name:     req.Name,
        Language: req.Language,
        Formal:   req.Formal,
    })
    if err != nil {
        return nil, err
    }
    return &pb.GreetResponse{
        Greeting: resp.Greeting,
        Plugin:   resp.Plugin,
    }, nil
}

func (s *GRPCGreeterServer) Capabilities(ctx context.Context, _ *pb.Empty) (*pb.CapabilitiesResponse, error) {
    resp, err := s.Impl.Capabilities(ctx)
    if err != nil {
        return nil, err
    }
    return &pb.CapabilitiesResponse{
        PluginName:    resp.PluginName,
        PluginVersion: resp.PluginVersion,
        Languages:     resp.Languages,
        ApiVersion:    int32(resp.APIVersion),
    }, nil
}

// ---- Plugin Map for go-plugin ----

// PluginMap maps plugin names to their go-plugin Plugin interfaces.
// Both host and plugin import this map.
var PluginMap = map[string]goplugin.Plugin{
    "greeter":     &GreeterPlugin{},
    "transformer": &TransformerPlugin{},
}

// Handshake configuration — host and plugin must agree on these values
// for the connection to succeed
var HandshakeConfig = goplugin.HandshakeConfig{
    ProtocolVersion:  1,
    MagicCookieKey:   "PLUGIN_MAGIC_COOKIE",
    MagicCookieValue: "c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2",
}
```

```go
// shared/plugin_interface.go
package shared

import (
    "context"

    "github.com/hashicorp/go-plugin"
    "google.golang.org/grpc"
    pb "github.com/example/plugin-system/shared/proto"
)

// GreeterPlugin implements the go-plugin Plugin interface for Greeter
type GreeterPlugin struct {
    Impl Greeter  // Used by the plugin side
}

// GRPCServer is called in the plugin subprocess to register the gRPC server
func (p *GreeterPlugin) GRPCServer(broker *plugin.GRPCBroker, s *grpc.Server) error {
    pb.RegisterGreeterPluginServer(s, &GRPCGreeterServer{Impl: p.Impl})
    return nil
}

// GRPCClient is called in the host to get a client implementation
func (p *GreeterPlugin) GRPCClient(ctx context.Context, broker *plugin.GRPCBroker, c *grpc.ClientConn) (interface{}, error) {
    return &GRPCGreeterClient{client: pb.NewGreeterPluginClient(c)}, nil
}
```

## Step 4: Implement the Plugin

```go
// plugin-greeter/greeter.go
package main

import (
    "context"
    "fmt"
    "strings"

    "github.com/example/plugin-system/shared"
)

// GreeterImpl is the actual plugin implementation
type GreeterImpl struct{}

func (g *GreeterImpl) Greet(ctx context.Context, req *shared.GreetRequest) (*shared.GreetResponse, error) {
    var greeting string

    switch strings.ToLower(req.Language) {
    case "spanish", "es":
        if req.Formal {
            greeting = fmt.Sprintf("Buenos días, %s. Es un placer.", req.Name)
        } else {
            greeting = fmt.Sprintf("¡Hola, %s!", req.Name)
        }
    case "french", "fr":
        if req.Formal {
            greeting = fmt.Sprintf("Bonjour, %s. Enchanté.", req.Name)
        } else {
            greeting = fmt.Sprintf("Salut, %s!", req.Name)
        }
    default:  // English
        if req.Formal {
            greeting = fmt.Sprintf("Good day, %s. A pleasure to meet you.", req.Name)
        } else {
            greeting = fmt.Sprintf("Hello, %s!", req.Name)
        }
    }

    return &shared.GreetResponse{
        Greeting: greeting,
        Plugin:   "greeter-v1",
    }, nil
}

func (g *GreeterImpl) Capabilities(ctx context.Context) (*shared.CapabilitiesResponse, error) {
    return &shared.CapabilitiesResponse{
        PluginName:    "greeter",
        PluginVersion: "1.0.0",
        Languages:     []string{"english", "spanish", "french"},
        APIVersion:    1,
    }, nil
}
```

```go
// plugin-greeter/main.go
package main

import (
    "github.com/hashicorp/go-plugin"
    "github.com/example/plugin-system/shared"
)

func main() {
    // plugin.Serve blocks until the host terminates the subprocess
    plugin.Serve(&plugin.ServeConfig{
        HandshakeConfig: shared.HandshakeConfig,
        Plugins: plugin.PluginSet{
            "greeter": &shared.GreeterPlugin{Impl: &GreeterImpl{}},
        },
        // Use gRPC (not net/rpc)
        GRPCServer: plugin.DefaultGRPCServer,

        // Enable auto-mTLS between host and plugin
        // This generates certificates automatically for the subprocess transport
        TLSProvider: plugin.AutoMTLS,
    })
}
```

## Step 5: Build the Host Loader

```go
// host/loader.go
package main

import (
    "context"
    "fmt"
    "os/exec"
    "path/filepath"
    "sync"

    "github.com/hashicorp/go-plugin"
    "go.uber.org/zap"
    "github.com/example/plugin-system/shared"
)

// LoadedPlugin holds a loaded plugin client and its raw interface
type LoadedPlugin struct {
    client   *plugin.Client
    greeter  shared.Greeter
    pluginID string
}

// PluginLoader manages loading and lifecycle of plugins
type PluginLoader struct {
    mu      sync.RWMutex
    plugins map[string]*LoadedPlugin
    log     *zap.Logger
}

func NewPluginLoader(log *zap.Logger) *PluginLoader {
    return &PluginLoader{
        plugins: make(map[string]*LoadedPlugin),
        log:     log,
    }
}

// Load loads a plugin from a binary path
func (l *PluginLoader) Load(pluginID string, binaryPath string) error {
    l.mu.Lock()
    defer l.mu.Unlock()

    // If already loaded, unload first
    if existing, ok := l.plugins[pluginID]; ok {
        existing.client.Kill()
        delete(l.plugins, pluginID)
    }

    absPath, err := filepath.Abs(binaryPath)
    if err != nil {
        return fmt.Errorf("resolving plugin path: %w", err)
    }

    // Create the go-plugin client
    client := plugin.NewClient(&plugin.ClientConfig{
        HandshakeConfig: shared.HandshakeConfig,
        Plugins:         shared.PluginMap,
        Cmd:             exec.Command(absPath),

        // Allowed protocols
        AllowedProtocols: []plugin.Protocol{
            plugin.ProtocolGRPC,
        },

        // Auto-mTLS: the client generates a CA and sends the cert
        // to the plugin via environment variable; the plugin uses it
        AutoMTLS: true,

        // Stderr logging from the plugin process
        Logger: &hclogAdapter{log: l.log.Named(pluginID)},

        // Security: restrict which plugins can be loaded
        SecureConfig: &plugin.SecureConfig{
            // Checksum: sha256 hash of the plugin binary
            // In production, verify this against a known-good value
            Checksum: nil,  // Set to []byte{...} for production
        },
    })

    // Connect to the plugin (starts the subprocess)
    rpcClient, err := client.Client()
    if err != nil {
        client.Kill()
        return fmt.Errorf("connecting to plugin %s: %w", pluginID, err)
    }

    // Dispense the specific plugin type
    raw, err := rpcClient.Dispense("greeter")
    if err != nil {
        client.Kill()
        return fmt.Errorf("dispensing greeter from %s: %w", pluginID, err)
    }

    greeter, ok := raw.(shared.Greeter)
    if !ok {
        client.Kill()
        return fmt.Errorf("plugin %s does not implement Greeter interface", pluginID)
    }

    // Verify the plugin responds correctly
    ctx := context.Background()
    caps, err := greeter.Capabilities(ctx)
    if err != nil {
        client.Kill()
        return fmt.Errorf("getting capabilities from %s: %w", pluginID, err)
    }

    l.log.Info("loaded plugin",
        zap.String("id", pluginID),
        zap.String("name", caps.PluginName),
        zap.String("version", caps.PluginVersion),
        zap.Strings("languages", caps.Languages),
        zap.Int("api_version", caps.APIVersion),
    )

    l.plugins[pluginID] = &LoadedPlugin{
        client:   client,
        greeter:  greeter,
        pluginID: pluginID,
    }

    return nil
}

// Get retrieves a loaded plugin by ID
func (l *PluginLoader) Get(pluginID string) (shared.Greeter, error) {
    l.mu.RLock()
    defer l.mu.RUnlock()

    loaded, ok := l.plugins[pluginID]
    if !ok {
        return nil, fmt.Errorf("plugin %q not loaded", pluginID)
    }

    // Check if the plugin process is still alive
    if loaded.client.Exited() {
        return nil, fmt.Errorf("plugin %q process has exited", pluginID)
    }

    return loaded.greeter, nil
}

// Unload kills the plugin subprocess and removes it from the registry
func (l *PluginLoader) Unload(pluginID string) {
    l.mu.Lock()
    defer l.mu.Unlock()

    if loaded, ok := l.plugins[pluginID]; ok {
        loaded.client.Kill()
        delete(l.plugins, pluginID)
        l.log.Info("unloaded plugin", zap.String("id", pluginID))
    }
}

// UnloadAll shuts down all plugins
func (l *PluginLoader) UnloadAll() {
    l.mu.Lock()
    defer l.mu.Unlock()

    for id, loaded := range l.plugins {
        loaded.client.Kill()
        delete(l.plugins, id)
        l.log.Info("unloaded plugin", zap.String("id", id))
    }
}

// hclogAdapter adapts zap.Logger to the hclog.Logger interface
type hclogAdapter struct {
    log *zap.Logger
}

func (a *hclogAdapter) Log(level plugin.LogLevel, msg string, args ...interface{}) {
    a.log.Sugar().Infof("[plugin] "+msg, args...)
}
```

## Step 6: Plugin Discovery

```go
// host/registry.go
package main

import (
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
    "strings"

    "go.uber.org/zap"
)

// PluginManifest describes a plugin binary
type PluginManifest struct {
    ID       string   `json:"id"`
    Path     string   `json:"path"`
    Type     string   `json:"type"`      // "greeter", "transformer"
    Version  string   `json:"version"`
    Checksum string   `json:"checksum"`  // SHA256 of the binary
    Tags     []string `json:"tags"`
}

// PluginRegistry discovers and manages plugin manifests
type PluginRegistry struct {
    pluginDir string
    loader    *PluginLoader
    log       *zap.Logger
}

func NewPluginRegistry(pluginDir string, loader *PluginLoader, log *zap.Logger) *PluginRegistry {
    return &PluginRegistry{
        pluginDir: pluginDir,
        loader:    loader,
        log:       log,
    }
}

// Discover scans the plugin directory for plugin manifests and binaries
func (r *PluginRegistry) Discover() ([]PluginManifest, error) {
    var manifests []PluginManifest

    // Look for .plugin.json manifest files
    jsonFiles, err := filepath.Glob(filepath.Join(r.pluginDir, "*.plugin.json"))
    if err != nil {
        return nil, fmt.Errorf("globbing plugin manifests: %w", err)
    }

    for _, jsonFile := range jsonFiles {
        data, err := os.ReadFile(jsonFile)
        if err != nil {
            r.log.Warn("failed to read plugin manifest",
                zap.String("file", jsonFile),
                zap.Error(err))
            continue
        }

        var manifest PluginManifest
        if err := json.Unmarshal(data, &manifest); err != nil {
            r.log.Warn("failed to parse plugin manifest",
                zap.String("file", jsonFile),
                zap.Error(err))
            continue
        }

        // Resolve relative paths
        if !filepath.IsAbs(manifest.Path) {
            manifest.Path = filepath.Join(r.pluginDir, manifest.Path)
        }

        manifests = append(manifests, manifest)
    }

    // Also discover executables with a naming convention: plugin-<name>
    entries, err := os.ReadDir(r.pluginDir)
    if err != nil {
        return nil, fmt.Errorf("reading plugin directory: %w", err)
    }

    for _, entry := range entries {
        if entry.IsDir() {
            continue
        }
        name := entry.Name()
        if !strings.HasPrefix(name, "plugin-") {
            continue
        }

        // Check if this was already covered by a manifest
        fullPath := filepath.Join(r.pluginDir, name)
        alreadyLoaded := false
        for _, m := range manifests {
            if m.Path == fullPath {
                alreadyLoaded = true
                break
            }
        }

        if !alreadyLoaded {
            // Auto-discover without a manifest
            id := strings.TrimPrefix(name, "plugin-")
            manifests = append(manifests, PluginManifest{
                ID:   id,
                Path: fullPath,
                Type: "greeter",  // Default assumption
            })
        }
    }

    return manifests, nil
}

// LoadAll discovers and loads all available plugins
func (r *PluginRegistry) LoadAll() error {
    manifests, err := r.Discover()
    if err != nil {
        return fmt.Errorf("discovering plugins: %w", err)
    }

    for _, manifest := range manifests {
        r.log.Info("loading discovered plugin",
            zap.String("id", manifest.ID),
            zap.String("path", manifest.Path))

        if err := r.loader.Load(manifest.ID, manifest.Path); err != nil {
            r.log.Error("failed to load plugin",
                zap.String("id", manifest.ID),
                zap.Error(err))
            // Continue loading other plugins even if one fails
        }
    }

    return nil
}
```

## Step 7: The Host Application

```go
// host/main.go
package main

import (
    "context"
    "fmt"
    "os"
    "os/signal"
    "syscall"

    "go.uber.org/zap"
)

func main() {
    log, _ := zap.NewProduction()
    defer log.Sync()

    // Initialize loader and registry
    loader := NewPluginLoader(log)
    defer loader.UnloadAll()

    registry := NewPluginRegistry("./plugins", loader, log)

    // Discover and load all plugins from the plugins/ directory
    if err := registry.LoadAll(); err != nil {
        log.Fatal("failed to load plugins", zap.Error(err))
    }

    // Use a specific plugin
    greeter, err := loader.Get("greeter")
    if err != nil {
        log.Fatal("greeter plugin not loaded", zap.Error(err))
    }

    ctx := context.Background()

    // Call the plugin
    resp, err := greeter.Greet(ctx, &shared.GreetRequest{
        Name:     "Alice",
        Language: "french",
        Formal:   true,
    })
    if err != nil {
        log.Fatal("greet failed", zap.Error(err))
    }

    fmt.Printf("Response from plugin '%s': %s\n", resp.Plugin, resp.Greeting)

    // Hot-reload: replace the plugin with a new version
    // The old subprocess is killed and a new one is started
    if err := loader.Load("greeter", "./plugins/plugin-greeter-v2"); err != nil {
        log.Error("failed to reload plugin", zap.Error(err))
    } else {
        log.Info("plugin reloaded successfully")
    }

    // Block until signal
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
    <-sigCh

    log.Info("shutting down")
}
```

## Versioned Interfaces

When the plugin API needs to change, use protocol versioning:

```go
// shared/versioned.go
package shared

import (
    "context"

    "github.com/hashicorp/go-plugin"
)

// Interface versions
const (
    GreeterAPIV1 = 1
    GreeterAPIV2 = 2  // New version with additional fields
)

// GreeterV2 extends Greeter with new capabilities
type GreeterV2 interface {
    Greeter  // Embed V1 for backward compatibility

    // New in V2
    GreetBatch(ctx context.Context, reqs []*GreetRequest) ([]*GreetResponse, error)
}

// VersionedPluginMap maps API version numbers to plugin implementations
// Allows negotiation between host and plugin
var VersionedPluginMap = map[int]plugin.PluginSet{
    GreeterAPIV1: {
        "greeter": &GreeterPlugin{},
    },
    GreeterAPIV2: {
        "greeter": &GreeterPluginV2{},
    },
}

// NegotiateVersion determines the highest mutually supported API version
func NegotiateVersion(clientSupports []int, serverSupports []int) (int, bool) {
    serverSet := make(map[int]bool)
    for _, v := range serverSupports {
        serverSet[v] = true
    }

    // Find highest version client supports that server also supports
    best := 0
    for _, v := range clientSupports {
        if serverSet[v] && v > best {
            best = v
        }
    }

    return best, best > 0
}
```

## Testing Plugin Systems

```go
// host/loader_test.go
package main

import (
    "context"
    "os/exec"
    "path/filepath"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "go.uber.org/zap"
)

func TestPluginLoad(t *testing.T) {
    // Build the plugin binary for testing
    pluginBin := filepath.Join(t.TempDir(), "plugin-greeter")
    cmd := exec.Command("go", "build",
        "-o", pluginBin,
        "./plugin-greeter",
    )
    require.NoError(t, cmd.Run(), "failed to build plugin")

    log := zap.NewNop()
    loader := NewPluginLoader(log)
    defer loader.UnloadAll()

    // Load the plugin
    err := loader.Load("test-greeter", pluginBin)
    require.NoError(t, err)

    // Verify it works
    greeter, err := loader.Get("test-greeter")
    require.NoError(t, err)

    ctx := context.Background()

    caps, err := greeter.Capabilities(ctx)
    require.NoError(t, err)
    assert.Equal(t, "greeter", caps.PluginName)
    assert.Equal(t, 1, caps.APIVersion)

    resp, err := greeter.Greet(ctx, &shared.GreetRequest{
        Name:     "Test",
        Language: "english",
    })
    require.NoError(t, err)
    assert.Contains(t, resp.Greeting, "Test")
}

func TestPluginReload(t *testing.T) {
    pluginBin := filepath.Join(t.TempDir(), "plugin-greeter")
    cmd := exec.Command("go", "build", "-o", pluginBin, "./plugin-greeter")
    require.NoError(t, cmd.Run())

    log := zap.NewNop()
    loader := NewPluginLoader(log)
    defer loader.UnloadAll()

    require.NoError(t, loader.Load("greeter", pluginBin))

    // Reload with the same binary (simulating a hot reload)
    require.NoError(t, loader.Load("greeter", pluginBin))

    greeter, err := loader.Get("greeter")
    require.NoError(t, err)

    ctx := context.Background()
    _, err = greeter.Capabilities(ctx)
    assert.NoError(t, err, "reloaded plugin should be functional")
}

// Mock implementation for unit testing host logic without subprocess
type MockGreeter struct {
    greetFn func(ctx context.Context, req *shared.GreetRequest) (*shared.GreetResponse, error)
}

func (m *MockGreeter) Greet(ctx context.Context, req *shared.GreetRequest) (*shared.GreetResponse, error) {
    if m.greetFn != nil {
        return m.greetFn(ctx, req)
    }
    return &shared.GreetResponse{Greeting: "mock-greeting", Plugin: "mock"}, nil
}

func (m *MockGreeter) Capabilities(ctx context.Context) (*shared.CapabilitiesResponse, error) {
    return &shared.CapabilitiesResponse{
        PluginName:    "mock",
        PluginVersion: "0.0.1",
        Languages:     []string{"english"},
        APIVersion:    1,
    }, nil
}
```

## Summary

The HashiCorp go-plugin framework solves the real-world problems with Go's native plugin package:

- **Process isolation** — a panicking plugin cannot crash the host; it is simply a child process that exits
- **Independent compilation** — plugin binaries compile against their own dependency versions; only the interface package must be shared
- **Hot reload** — kill the old subprocess, start a new one; the host continues serving
- **Auto-mTLS** — the transport between host and plugin is encrypted by default; no manual certificate management
- **Versioned interfaces** — negotiate API version at connection time; ship new plugin APIs without breaking old plugins

When designing your plugin interface:
- Keep the shared package minimal — only the interface types, request/response structs, and gRPC bridge
- Version your interfaces from day one; adding a V2 interface is much cleaner than breaking V1
- Use `ClusterTriggerAuthentication`-style centralized credential management for plugins that need external access
- Write integration tests that compile and run real plugin binaries; mock tests only validate the host logic
