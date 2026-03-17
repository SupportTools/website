---
title: "Go Plugin Architecture: Hashicorp go-plugin and Native Plugins"
date: 2029-05-25T00:00:00-05:00
draft: false
tags: ["Go", "Plugins", "Hashicorp", "go-plugin", "Architecture", "gRPC", "golang"]
categories: ["Go", "Software Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go plugin architecture covering net/rpc plugin interfaces, hashicorp/go-plugin gRPC mode, plugin versioning, hot reload patterns, and security isolation for production plugin systems."
more_link: "yes"
url: "/go-plugin-architecture-hashicorp-go-plugin-native/"
---

Plugin architectures let you extend applications at runtime without recompilation or redeployment. In Go, you have two main options: the native `plugin` package (shared library `.so` files) and the `hashicorp/go-plugin` framework (subprocess-based with gRPC). The native approach is simpler but severely constrained — it requires identical Go toolchains and does not provide isolation. Hashicorp's approach, which powers Terraform providers, Vault plugins, and Packer builders, uses subprocess isolation via gRPC and provides versioning, health checking, and real security boundaries. This guide covers both approaches comprehensively.

<!--more-->

# Go Plugin Architecture: Hashicorp go-plugin and Native Plugins

## Why Plugins Are Hard in Go

Go's compilation model makes plugins challenging:

```
Native .so plugins:
  - Host and plugin must be compiled with identical Go versions
  - Identical module paths for shared dependencies
  - No hot reload without process restart
  - Single process — plugin crash = host crash
  - Cannot use CGO in plugins if host does not

hashicorp/go-plugin:
  + Plugin runs in separate process
  + Plugin crash does not affect host
  + Any Go version (communicate via gRPC)
  + Versioned protocol negotiation
  + Auto-restart crashed plugins
  - More complex setup
  - Higher latency (IPC overhead)
  - Serialization overhead
```

## Section 1: Go Native Plugin Package

### Basic Native Plugin

The Go `plugin` package loads `.so` files at runtime.

**Plugin implementation:**

```go
// plugins/greeter/main.go
package main

import "fmt"

// Exported symbol — must be exported (capital letter)
var GreeterPlugin Greeter = greeterImpl{}

type Greeter interface {
    Greet(name string) string
}

type greeterImpl struct{}

func (g greeterImpl) Greet(name string) string {
    return fmt.Sprintf("Hello, %s! (from plugin)", name)
}

// Exported function that returns version
func Version() string {
    return "1.0.0"
}

// main function required but not called
func main() {}
```

```bash
# Build as a shared library
go build -buildmode=plugin -o greeter.so ./plugins/greeter/
```

**Host loading the plugin:**

```go
// main.go
package main

import (
    "fmt"
    "plugin"
    "log"
)

type Greeter interface {
    Greet(name string) string
}

func main() {
    // Load the plugin
    p, err := plugin.Open("./greeter.so")
    if err != nil {
        log.Fatalf("loading plugin: %v", err)
    }

    // Look up an exported symbol
    sym, err := p.Lookup("GreeterPlugin")
    if err != nil {
        log.Fatalf("looking up symbol: %v", err)
    }

    // Assert the type
    greeter, ok := sym.(*Greeter)
    if !ok {
        log.Fatal("unexpected type from module symbol")
    }

    // Use the plugin
    fmt.Println((*greeter).Greet("World"))
    // Output: Hello, World! (from plugin)

    // Look up a function
    versionFn, err := p.Lookup("Version")
    if err != nil {
        log.Fatalf("looking up Version: %v", err)
    }
    fmt.Println("Plugin version:", versionFn.(func() string)())
}
```

### Native Plugin Limitations and When to Avoid

```bash
# This FAILS if compiled with different Go versions:
# plugin.Open: plugin was built with a different version of package ...

# Check Go version compatibility
go version              # host
go version -m greeter.so  # plugin version info

# Verify module compatibility
go list -m -json all > host_modules.json
# In plugin directory:
go list -m -json all > plugin_modules.json
diff <(jq -r '.Path + " " + .Version' host_modules.json | sort) \
     <(jq -r '.Path + " " + .Version' plugin_modules.json | sort)
```

### Native Plugin with Version Negotiation

```go
// shared/interface.go — shared between host and plugins
package shared

const ProtocolVersion = 1

type PluginMetadata struct {
    Name     string
    Version  string
    Protocol int
}

type Plugin interface {
    Metadata() PluginMetadata
    Execute(input map[string]interface{}) (map[string]interface{}, error)
}
```

## Section 2: Hashicorp go-plugin Framework

`hashicorp/go-plugin` is production-tested at scale — it powers Terraform's provider architecture which has hundreds of providers serving millions of users.

### Architecture

```
Host Process                    Plugin Process
    |                               |
    |  1. Launch plugin binary      |
    |------------------------------->|
    |                               |
    |  2. Plugin prints gRPC server |
    |     address to stdout         |
    |<-------------------------------|
    |                               |
    |  3. Host connects via gRPC    |
    |------------------------------->|
    |                               |
    |  4. Version negotiation       |
    |<------------------------------>|
    |                               |
    |  5. Method calls via gRPC     |
    |------------------------------->|
    |<-------------------------------|
    |                               |
    |  6. Plugin crash detected     |
    |     Host auto-restarts plugin |
    |------------------------------->|
```

### Installation

```bash
go get github.com/hashicorp/go-plugin
```

### Step 1: Define the Plugin Interface with Proto

```protobuf
// proto/greeter.proto
syntax = "proto3";

package proto;
option go_package = "./proto";

service Greeter {
    rpc Greet(GreetRequest) returns (GreetResponse);
    rpc GetInfo(Empty) returns (PluginInfo);
}

message GreetRequest {
    string name = 1;
    map<string, string> options = 2;
}

message GreetResponse {
    string message = 1;
    bool success = 2;
    string error = 3;
}

message PluginInfo {
    string name = 1;
    string version = 2;
    string description = 3;
}

message Empty {}
```

```bash
# Generate gRPC code
protoc --go_out=. --go-grpc_out=. proto/greeter.proto
```

### Step 2: Define the Go Interface and gRPC Bridge

```go
// shared/interface.go
package shared

import (
    "context"

    "github.com/hashicorp/go-plugin"
    "google.golang.org/grpc"

    "example.com/app/proto"
)

// Handshake configuration — must match between host and plugin
var Handshake = plugin.HandshakeConfig{
    ProtocolVersion:  1,
    MagicCookieKey:   "GREETER_PLUGIN",
    MagicCookieValue: "hello-from-host",
}

// PluginMap maps plugin names to implementations
var PluginMap = map[string]plugin.Plugin{
    "greeter": &GreeterPlugin{},
}

// Greeter is the interface that plugins must implement
type Greeter interface {
    Greet(ctx context.Context, name string, opts map[string]string) (string, error)
    GetInfo(ctx context.Context) (*PluginInfo, error)
}

type PluginInfo struct {
    Name        string
    Version     string
    Description string
}

// GreeterPlugin implements plugin.GRPCPlugin
type GreeterPlugin struct {
    plugin.Plugin
    // Concrete implementation — set by plugin binary
    Impl Greeter
}

func (p *GreeterPlugin) GRPCServer(broker *plugin.GRPCBroker, s *grpc.Server) error {
    proto.RegisterGreeterServer(s, &GRPCServer{Impl: p.Impl})
    return nil
}

func (p *GreeterPlugin) GRPCClient(ctx context.Context, broker *plugin.GRPCBroker, c *grpc.ClientConn) (interface{}, error) {
    return &GRPCClient{client: proto.NewGreeterClient(c)}, nil
}

// GRPCServer is the server-side gRPC bridge (runs in plugin process)
type GRPCServer struct {
    proto.UnimplementedGreeterServer
    Impl Greeter
}

func (s *GRPCServer) Greet(ctx context.Context, req *proto.GreetRequest) (*proto.GreetResponse, error) {
    msg, err := s.Impl.Greet(ctx, req.Name, req.Options)
    if err != nil {
        return &proto.GreetResponse{Success: false, Error: err.Error()}, nil
    }
    return &proto.GreetResponse{Message: msg, Success: true}, nil
}

func (s *GRPCServer) GetInfo(ctx context.Context, _ *proto.Empty) (*proto.PluginInfo, error) {
    info, err := s.Impl.GetInfo(ctx)
    if err != nil {
        return nil, err
    }
    return &proto.PluginInfo{
        Name:        info.Name,
        Version:     info.Version,
        Description: info.Description,
    }, nil
}

// GRPCClient is the client-side gRPC bridge (runs in host process)
type GRPCClient struct {
    client proto.GreeterClient
}

func (c *GRPCClient) Greet(ctx context.Context, name string, opts map[string]string) (string, error) {
    resp, err := c.client.Greet(ctx, &proto.GreetRequest{
        Name:    name,
        Options: opts,
    })
    if err != nil {
        return "", err
    }
    if !resp.Success {
        return "", fmt.Errorf("%s", resp.Error)
    }
    return resp.Message, nil
}

func (c *GRPCClient) GetInfo(ctx context.Context) (*PluginInfo, error) {
    resp, err := c.client.GetInfo(ctx, &proto.Empty{})
    if err != nil {
        return nil, err
    }
    return &PluginInfo{
        Name:        resp.Name,
        Version:     resp.Version,
        Description: resp.Description,
    }, nil
}
```

### Step 3: Implement a Plugin Binary

```go
// plugins/formal-greeter/main.go
package main

import (
    "context"
    "fmt"

    "github.com/hashicorp/go-plugin"
    "example.com/app/shared"
)

// FormalGreeter is a plugin implementation
type FormalGreeter struct{}

func (g *FormalGreeter) Greet(ctx context.Context, name string, opts map[string]string) (string, error) {
    title := opts["title"]
    if title == "" {
        title = "Mr/Ms"
    }
    return fmt.Sprintf("Good day, %s %s. How may I be of service?", title, name), nil
}

func (g *FormalGreeter) GetInfo(ctx context.Context) (*shared.PluginInfo, error) {
    return &shared.PluginInfo{
        Name:        "formal-greeter",
        Version:     "1.2.0",
        Description: "A formal greeting plugin",
    }, nil
}

func main() {
    plugin.Serve(&plugin.ServeConfig{
        HandshakeConfig: shared.Handshake,
        Plugins: map[string]plugin.Plugin{
            "greeter": &shared.GreeterPlugin{Impl: &FormalGreeter{}},
        },
        GRPCServer: plugin.DefaultGRPCServer,
    })
}
```

```bash
# Build plugin binary
go build -o formal-greeter ./plugins/formal-greeter/
```

### Step 4: Host Plugin Loading and Usage

```go
// host/main.go
package main

import (
    "context"
    "fmt"
    "log"
    "os"
    "os/exec"

    "github.com/hashicorp/go-plugin"
    "example.com/app/shared"
)

func main() {
    // Start plugin process — note: path comes from trusted config, not user input
    pluginPath := getPluginPath() // from config file, not direct user input
    cmd := exec.Command(pluginPath)  // #nosec G204 — path is from trusted config

    client := plugin.NewClient(&plugin.ClientConfig{
        HandshakeConfig: shared.Handshake,
        Plugins:         shared.PluginMap,
        Cmd:             cmd,
        AllowedProtocols: []plugin.Protocol{
            plugin.ProtocolGRPC,
        },
        Logger: logger,
    })
    defer client.Kill()

    // Connect via RPC
    rpcClient, err := client.Client()
    if err != nil {
        log.Fatalf("getting plugin client: %v", err)
    }

    // Request the plugin
    raw, err := rpcClient.Dispense("greeter")
    if err != nil {
        log.Fatalf("dispensing greeter plugin: %v", err)
    }

    greeter := raw.(shared.Greeter)

    // Get plugin info
    info, err := greeter.GetInfo(context.Background())
    if err != nil {
        log.Fatalf("getting plugin info: %v", err)
    }
    fmt.Printf("Loaded plugin: %s v%s - %s\n", info.Name, info.Version, info.Description)

    // Use the plugin
    msg, err := greeter.Greet(context.Background(), "Johnson", map[string]string{
        "title": "Dr.",
    })
    if err != nil {
        log.Fatalf("greeting: %v", err)
    }
    fmt.Println(msg)
    // Output: Good day, Dr. Johnson. How may I be of service?
}

func getPluginPath() string {
    // Read from config — never from direct user input
    path := os.Getenv("GREETER_PLUGIN_PATH")
    if path == "" {
        return "./formal-greeter"
    }
    return path
}
```

## Section 3: Plugin Manager — Loading Multiple Plugins

```go
// pluginmgr/manager.go
package pluginmgr

import (
    "context"
    "fmt"
    "os"
    "os/exec"
    "path/filepath"
    "sync"

    "github.com/hashicorp/go-plugin"
    "example.com/app/shared"
)

// PluginEntry holds a loaded plugin instance
type PluginEntry struct {
    Name    string
    Path    string
    Client  *plugin.Client
    Greeter shared.Greeter
}

// PluginManager manages multiple plugin instances
type PluginManager struct {
    mu      sync.RWMutex
    plugins map[string]*PluginEntry
    dir     string
}

func NewPluginManager(pluginDir string) *PluginManager {
    return &PluginManager{
        plugins: make(map[string]*PluginEntry),
        dir:     pluginDir,
    }
}

// LoadAll discovers and loads all plugins in the plugin directory
func (m *PluginManager) LoadAll(ctx context.Context) error {
    entries, err := os.ReadDir(m.dir)
    if err != nil {
        return fmt.Errorf("reading plugin dir: %w", err)
    }

    for _, entry := range entries {
        if entry.IsDir() {
            continue
        }

        path := filepath.Join(m.dir, entry.Name())

        // Skip non-executable files
        info, err := entry.Info()
        if err != nil {
            continue
        }
        if info.Mode()&0111 == 0 {
            continue
        }

        if err := m.Load(ctx, entry.Name(), path); err != nil {
            log.Printf("Failed to load plugin %s: %v", entry.Name(), err)
            continue
        }

        log.Printf("Loaded plugin: %s", entry.Name())
    }

    return nil
}

// Load loads a single plugin by path
func (m *PluginManager) Load(ctx context.Context, name, path string) error {
    // path comes from directory listing of trusted plugin directory
    cmd := exec.Command(filepath.Clean(path)) // #nosec G204

    client := plugin.NewClient(&plugin.ClientConfig{
        HandshakeConfig:  shared.Handshake,
        Plugins:          shared.PluginMap,
        Cmd:              cmd,
        AllowedProtocols: []plugin.Protocol{plugin.ProtocolGRPC},
    })

    rpcClient, err := client.Client()
    if err != nil {
        client.Kill()
        return fmt.Errorf("connecting to plugin: %w", err)
    }

    raw, err := rpcClient.Dispense("greeter")
    if err != nil {
        client.Kill()
        return fmt.Errorf("dispensing plugin: %w", err)
    }

    greeter, ok := raw.(shared.Greeter)
    if !ok {
        client.Kill()
        return fmt.Errorf("plugin does not implement Greeter interface")
    }

    // Verify the plugin is healthy
    if _, err := greeter.GetInfo(ctx); err != nil {
        client.Kill()
        return fmt.Errorf("plugin health check failed: %w", err)
    }

    m.mu.Lock()
    defer m.mu.Unlock()

    // Kill any existing plugin with the same name
    if existing, ok := m.plugins[name]; ok {
        existing.Client.Kill()
    }

    m.plugins[name] = &PluginEntry{
        Name:    name,
        Path:    path,
        Client:  client,
        Greeter: greeter,
    }

    return nil
}

// Get retrieves a loaded plugin by name
func (m *PluginManager) Get(name string) (shared.Greeter, error) {
    m.mu.RLock()
    defer m.mu.RUnlock()

    entry, ok := m.plugins[name]
    if !ok {
        return nil, fmt.Errorf("plugin %q not found", name)
    }

    return entry.Greeter, nil
}

// List returns all loaded plugin names
func (m *PluginManager) List() []string {
    m.mu.RLock()
    defer m.mu.RUnlock()

    names := make([]string, 0, len(m.plugins))
    for name := range m.plugins {
        names = append(names, name)
    }
    return names
}

// Unload kills a plugin and removes it from the registry
func (m *PluginManager) Unload(name string) {
    m.mu.Lock()
    defer m.mu.Unlock()

    if entry, ok := m.plugins[name]; ok {
        entry.Client.Kill()
        delete(m.plugins, name)
    }
}

// Shutdown kills all plugins
func (m *PluginManager) Shutdown() {
    m.mu.Lock()
    defer m.mu.Unlock()

    for name, entry := range m.plugins {
        entry.Client.Kill()
        delete(m.plugins, name)
    }
}
```

## Section 4: Plugin Versioning

### Protocol Versioning

```go
// shared/versions.go
package shared

import "github.com/hashicorp/go-plugin"

// VersionedHandshake supports multiple protocol versions
var VersionedHandshake = plugin.HandshakeConfig{
    ProtocolVersion:  2,  // Increment when protocol changes
    MagicCookieKey:   "GREETER_PLUGIN",
    MagicCookieValue: "hello-from-host",
}

// VersionedPluginMap maps protocol versions to plugin implementations
// This allows backward compatibility
var VersionedPluginMap = map[int]plugin.PluginSet{
    1: {
        "greeter": &GreeterPluginV1{},
    },
    2: {
        "greeter": &GreeterPlugin{},  // Current version
    },
}

// loadVersionedPlugin demonstrates using versioned plugin map
func loadVersionedPlugin(path string) (shared.Greeter, error) {
    cmd := exec.Command(filepath.Clean(path)) // #nosec G204
    client := plugin.NewClient(&plugin.ClientConfig{
        HandshakeConfig:  shared.VersionedHandshake,
        VersionedPlugins: shared.VersionedPluginMap,
        Cmd:              cmd,
        AllowedProtocols: []plugin.Protocol{plugin.ProtocolGRPC},
    })

    rpcClient, err := client.Client()
    if err != nil {
        return nil, err
    }

    raw, err := rpcClient.Dispense("greeter")
    if err != nil {
        return nil, err
    }

    return raw.(shared.Greeter), nil
}
```

### Semantic Plugin Versioning

```go
// shared/semver.go
package shared

import (
    "fmt"
    "strconv"
    "strings"
)

type SemVer struct {
    Major, Minor, Patch int
}

func ParseSemVer(v string) (SemVer, error) {
    parts := strings.Split(strings.TrimPrefix(v, "v"), ".")
    if len(parts) != 3 {
        return SemVer{}, fmt.Errorf("invalid semver: %s", v)
    }
    major, err := strconv.Atoi(parts[0])
    if err != nil {
        return SemVer{}, err
    }
    minor, err := strconv.Atoi(parts[1])
    if err != nil {
        return SemVer{}, err
    }
    patch, err := strconv.Atoi(parts[2])
    if err != nil {
        return SemVer{}, err
    }
    return SemVer{major, minor, patch}, nil
}

// Compatible returns true if the plugin version is compatible with the host requirement
func (sv SemVer) Compatible(required SemVer) bool {
    // Same major version = compatible (semantic versioning)
    return sv.Major == required.Major && sv.Minor >= required.Minor
}

// LoadWithVersionCheck wraps Load to add semver compatibility checking
func (m *PluginManager) LoadWithVersionCheck(ctx context.Context, name, path, minVersion string) error {
    if err := m.Load(ctx, name, path); err != nil {
        return err
    }

    entry := m.plugins[name]
    info, err := entry.Greeter.GetInfo(ctx)
    if err != nil {
        m.Unload(name)
        return fmt.Errorf("getting plugin info: %w", err)
    }

    pluginVer, err := ParseSemVer(info.Version)
    if err != nil {
        m.Unload(name)
        return fmt.Errorf("parsing plugin version %q: %w", info.Version, err)
    }

    minVer, err := ParseSemVer(minVersion)
    if err != nil {
        m.Unload(name)
        return fmt.Errorf("parsing min version %q: %w", minVersion, err)
    }

    if !pluginVer.Compatible(minVer) {
        m.Unload(name)
        return fmt.Errorf("plugin %s version %s is not compatible with minimum %s",
            name, info.Version, minVersion)
    }

    return nil
}
```

## Section 5: Hot Reload Pattern

```go
// pluginmgr/watcher.go
package pluginmgr

import (
    "context"
    "log"
    "path/filepath"
    "time"

    "github.com/fsnotify/fsnotify"
)

// WatchAndReload watches the plugin directory for changes and hot-reloads plugins
func (m *PluginManager) WatchAndReload(ctx context.Context) error {
    watcher, err := fsnotify.NewWatcher()
    if err != nil {
        return fmt.Errorf("creating watcher: %w", err)
    }
    defer watcher.Close()

    if err := watcher.Add(m.dir); err != nil {
        return fmt.Errorf("watching plugin dir: %w", err)
    }

    // Debounce rapid changes
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

            if event.Op&(fsnotify.Create|fsnotify.Write) != 0 {
                name := filepath.Base(event.Name)
                pending[name] = time.Now()
                log.Printf("Plugin change detected: %s", name)
            }

            if event.Op&fsnotify.Remove != 0 {
                name := filepath.Base(event.Name)
                log.Printf("Plugin removed: %s", name)
                m.Unload(name)
            }

        case <-ticker.C:
            // Process pending reloads (debounced)
            now := time.Now()
            for name, t := range pending {
                if now.Sub(t) >= 500*time.Millisecond {
                    path := filepath.Join(m.dir, name)
                    log.Printf("Reloading plugin: %s", name)
                    if err := m.Load(ctx, name, path); err != nil {
                        log.Printf("Failed to reload plugin %s: %v", name, err)
                    } else {
                        log.Printf("Plugin %s reloaded successfully", name)
                    }
                    delete(pending, name)
                }
            }

        case err, ok := <-watcher.Errors:
            if !ok {
                return nil
            }
            log.Printf("Watcher error: %v", err)
        }
    }
}
```

### Graceful Reload with Connection Draining

```go
// pluginmgr/reload.go
package pluginmgr

import (
    "context"
    "sync"
    "sync/atomic"
    "time"
)

// SafePlugin wraps a plugin with reference counting for safe reload
type SafePlugin struct {
    mu      sync.RWMutex
    current *PluginEntry
    refs    atomic.Int64
}

// Acquire returns the current plugin and increments the reference count
func (sp *SafePlugin) Acquire() (*PluginEntry, func()) {
    sp.mu.RLock()
    entry := sp.current
    sp.refs.Add(1)
    sp.mu.RUnlock()

    release := func() {
        sp.refs.Add(-1)
    }

    return entry, release
}

// Replace atomically replaces the plugin, waiting for in-flight requests to drain
func (sp *SafePlugin) Replace(ctx context.Context, newEntry *PluginEntry) error {
    sp.mu.Lock()
    old := sp.current
    sp.current = newEntry
    sp.mu.Unlock()

    if old == nil {
        return nil
    }

    // Wait for all in-flight requests to complete before killing old plugin
    deadline := time.Now().Add(30 * time.Second)
    for {
        if sp.refs.Load() == 0 {
            break
        }
        if time.Now().After(deadline) {
            log.Printf("Warning: timed out waiting for plugin drain, forcefully killing")
            break
        }
        if ctx.Err() != nil {
            return ctx.Err()
        }
        time.Sleep(10 * time.Millisecond)
    }

    old.Client.Kill()
    log.Printf("Old plugin %s killed after hot reload", old.Name)
    return nil
}
```

## Section 6: Security Isolation

### Plugin Binary Verification

```go
// security/checksum.go
package security

import (
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "os"
)

// VerifyPluginChecksum checks plugin binary integrity before loading
func VerifyPluginChecksum(path, expectedChecksum string) error {
    data, err := os.ReadFile(path)
    if err != nil {
        return fmt.Errorf("reading plugin: %w", err)
    }

    sum := sha256.Sum256(data)
    actual := hex.EncodeToString(sum[:])

    if actual != expectedChecksum {
        return fmt.Errorf("plugin checksum mismatch: expected %s, got %s",
            expectedChecksum, actual)
    }

    return nil
}
```

### Checksum-Verified Plugin Loading

```go
// Using go-plugin's SecureConfig for binary verification
func newSecurePluginClient(pluginPath, checksumHex string) (*plugin.Client, error) {
    checksumBytes, err := hex.DecodeString(checksumHex)
    if err != nil {
        return nil, fmt.Errorf("decoding checksum: %w", err)
    }

    cmd := exec.Command(filepath.Clean(pluginPath)) // #nosec G204 — path from trusted config

    return plugin.NewClient(&plugin.ClientConfig{
        HandshakeConfig: shared.Handshake,
        Plugins:         shared.PluginMap,
        Cmd:             cmd,
        AllowedProtocols: []plugin.Protocol{plugin.ProtocolGRPC},

        // Verify binary checksum before starting the subprocess
        SecureConfig: &plugin.SecureConfig{
            Checksum: checksumBytes,
            Hash:     crypto.SHA256,
        },

        // Restrict environment passed to plugin subprocess
        Env: []string{
            "HOME=/tmp/plugin-sandbox",
            "PATH=/usr/local/bin:/usr/bin:/bin",
            // Intentionally not passing through the host environment
        },
    }), nil
}
```

### Plugin Registry with Signed Manifests

```go
// registry/registry.go
package registry

import (
    "crypto/ed25519"
    "encoding/json"
    "encoding/pem"
    "fmt"
    "os"
)

type PluginManifest struct {
    Name        string `json:"name"`
    Version     string `json:"version"`
    BinaryPath  string `json:"binary_path"`
    Checksum    string `json:"checksum"`  // SHA-256 hex of binary
    Description string `json:"description"`
    Author      string `json:"author"`
    Signature   string `json:"signature"` // Base64 ed25519 of JSON without this field
}

type Registry struct {
    plugins   map[string]*PluginManifest
    publicKey ed25519.PublicKey
}

func NewRegistry(publicKeyPath string) (*Registry, error) {
    keyData, err := os.ReadFile(publicKeyPath)
    if err != nil {
        return nil, fmt.Errorf("reading public key: %w", err)
    }

    block, _ := pem.Decode(keyData)
    if block == nil {
        return nil, fmt.Errorf("invalid PEM data")
    }

    return &Registry{
        plugins:   make(map[string]*PluginManifest),
        publicKey: ed25519.PublicKey(block.Bytes),
    }, nil
}

func (r *Registry) Register(manifestPath string) error {
    data, err := os.ReadFile(manifestPath)
    if err != nil {
        return fmt.Errorf("reading manifest: %w", err)
    }

    var manifest PluginManifest
    if err := json.Unmarshal(data, &manifest); err != nil {
        return fmt.Errorf("parsing manifest: %w", err)
    }

    // Verify signature
    sig, err := base64.StdEncoding.DecodeString(manifest.Signature)
    if err != nil {
        return fmt.Errorf("decoding signature: %w", err)
    }

    // Create payload without signature field for verification
    payload := manifest
    payload.Signature = ""
    payloadJSON, _ := json.Marshal(payload)

    if !ed25519.Verify(r.publicKey, payloadJSON, sig) {
        return fmt.Errorf("manifest signature verification failed for plugin %s", manifest.Name)
    }

    r.plugins[manifest.Name] = &manifest
    return nil
}

func (r *Registry) Get(name string) (*PluginManifest, error) {
    manifest, ok := r.plugins[name]
    if !ok {
        return nil, fmt.Errorf("plugin %q not registered", name)
    }
    return manifest, nil
}
```

## Section 7: Testing Plugin Systems

```go
// pluginmgr/manager_test.go
package pluginmgr_test

import (
    "context"
    "fmt"
    "os"
    "os/exec"
    "path/filepath"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func buildTestPlugin(t *testing.T, name string) string {
    t.Helper()

    tmpDir := t.TempDir()
    pluginPath := filepath.Join(tmpDir, name)

    // Build the test plugin from testdata
    cmd := exec.Command("go", "build",  // #nosec G204 — running 'go build' with known args
        "-o", pluginPath,
        fmt.Sprintf("./testdata/plugins/%s/", name),
    )
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr

    if err := cmd.Run(); err != nil {
        t.Fatalf("building test plugin %s: %v", name, err)
    }

    return pluginPath
}

func TestPluginManagerLoadAndUse(t *testing.T) {
    pluginPath := buildTestPlugin(t, "test-greeter")

    mgr := NewPluginManager(filepath.Dir(pluginPath))
    defer mgr.Shutdown()

    ctx := context.Background()
    err := mgr.Load(ctx, "test-greeter", pluginPath)
    require.NoError(t, err)

    greeter, err := mgr.Get("test-greeter")
    require.NoError(t, err)

    msg, err := greeter.Greet(ctx, "World", nil)
    require.NoError(t, err)
    assert.Contains(t, msg, "World")
}

func TestPluginManagerHandlesCrash(t *testing.T) {
    pluginPath := buildTestPlugin(t, "crashy-greeter")

    mgr := NewPluginManager(filepath.Dir(pluginPath))
    defer mgr.Shutdown()

    ctx := context.Background()
    err := mgr.Load(ctx, "crashy-greeter", pluginPath)
    require.NoError(t, err)

    greeter, err := mgr.Get("crashy-greeter")
    require.NoError(t, err)

    // Call with magic string that triggers a panic in the test plugin
    _, err = greeter.Greet(ctx, "crash", nil)
    assert.Error(t, err, "Expected error when plugin crashes")

    // Reload should succeed after crash
    err = mgr.Load(ctx, "crashy-greeter", pluginPath)
    require.NoError(t, err)
}

// MockGreeter for testing hosts without a real plugin process
type MockGreeter struct {
    GreetFn   func(ctx context.Context, name string, opts map[string]string) (string, error)
    GetInfoFn func(ctx context.Context) (*shared.PluginInfo, error)
}

func (m *MockGreeter) Greet(ctx context.Context, name string, opts map[string]string) (string, error) {
    if m.GreetFn != nil {
        return m.GreetFn(ctx, name, opts)
    }
    return fmt.Sprintf("Hello, %s!", name), nil
}

func (m *MockGreeter) GetInfo(ctx context.Context) (*shared.PluginInfo, error) {
    if m.GetInfoFn != nil {
        return m.GetInfoFn(ctx)
    }
    return &shared.PluginInfo{Name: "mock", Version: "1.0.0"}, nil
}
```

## Conclusion

Go plugin architecture is a spectrum from simple (native .so) to robust (hashicorp/go-plugin). For any production use case, `hashicorp/go-plugin` is the clear choice: it provides process isolation (plugin crashes do not kill the host), versioned protocol negotiation (deploy host and plugins independently), binary checksum verification (prevent loading tampered plugins), and automatic reconnection when plugins crash.

The pattern of defining a clean gRPC interface, bridging it to a Go interface, and running plugins as subprocesses has proven itself at massive scale in Terraform's provider ecosystem. If your application needs extensibility — whether for third-party integrations, customer customizations, or team-by-team feature ownership — this architecture delivers the isolation and safety that production systems require.
