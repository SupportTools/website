---
title: "Go Plugin Architecture: Dynamic Loading, Interface Contracts, and Registry Patterns"
date: 2030-06-30T00:00:00-05:00
draft: false
tags: ["Go", "Plugins", "Architecture", "hashicorp/go-plugin", "Interface Design", "Hot Reload", "Production"]
categories:
- Go
- Software Engineering
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Go plugin patterns: net/rpc-based plugins, hashicorp/go-plugin framework, interface versioning, plugin registry design, shared state management, and hot-reload without downtime."
more_link: "yes"
url: "/go-plugin-architecture-dynamic-loading-interface-contracts-registry/"
---

Go's native plugin system (`plugin` package) is deceptively limited: plugins must be compiled with the same Go version, same dependencies, and same build flags as the host. A version mismatch produces a runtime panic, not an error. Cross-platform support is partial. In practice, production plugin systems in Go use either compiled-in registration patterns or the hashicorp/go-plugin framework, which isolates plugins in separate processes and communicates over gRPC or net/rpc. Understanding the trade-offs between these approaches — and implementing them correctly — is essential for teams building extensible platforms.

<!--more-->

## Go's Native Plugin Package: Limitations and Use Cases

The `plugin` package loads Go shared libraries (`.so` files on Linux) into the host process:

```go
package main

import (
    "fmt"
    "plugin"
)

func main() {
    p, err := plugin.Open("./myplugin.so")
    if err != nil {
        panic(err)
    }

    sym, err := p.Lookup("Greet")
    if err != nil {
        panic(err)
    }

    greetFn, ok := sym.(func(string) string)
    if !ok {
        panic("unexpected type from module symbol")
    }

    fmt.Println(greetFn("World"))
}
```

### Native Plugin Constraints

- Linux only (macOS has partial support, Windows none)
- Plugin and host must be compiled with identical Go versions
- All shared dependencies must be identical (same import paths, same versions)
- No unloading: once loaded, a plugin cannot be removed from the process
- Crashes in plugins crash the host process
- No isolation: a plugin's goroutines and memory are in the same address space

These constraints make native plugins suitable for one scenario: loading application-specific extensions at startup on Linux servers where version pinning is absolute. For any other use case — especially plugins from third parties or plugins that need updates without host restarts — process-isolated plugins are the correct choice.

## Compiled-In Plugin Registration

For many "plugin" use cases, the best architecture is not dynamic loading at all. Compile all plugins in, use a registry to select them by name at runtime:

### Registry Pattern

```go
package plugin

import (
    "fmt"
    "sync"
)

// Processor is the interface all plugins must implement.
type Processor interface {
    Name() string
    Version() string
    Process(ctx context.Context, input *ProcessInput) (*ProcessOutput, error)
    Validate(config map[string]string) error
}

// ProcessInput and ProcessOutput define the data contract.
type ProcessInput struct {
    Data     []byte
    Metadata map[string]string
}

type ProcessOutput struct {
    Data     []byte
    Metrics  map[string]float64
}

// Registry maintains a thread-safe map of named processors.
type Registry struct {
    mu         sync.RWMutex
    processors map[string]Processor
}

var defaultRegistry = &Registry{
    processors: make(map[string]Processor),
}

// Register adds a processor to the default registry.
// Intended to be called from init() functions.
func Register(p Processor) {
    defaultRegistry.mu.Lock()
    defer defaultRegistry.mu.Unlock()

    name := p.Name()
    if _, exists := defaultRegistry.processors[name]; exists {
        panic(fmt.Sprintf("plugin: processor %q already registered", name))
    }
    defaultRegistry.processors[name] = p
}

// Get retrieves a processor by name.
func Get(name string) (Processor, bool) {
    defaultRegistry.mu.RLock()
    defer defaultRegistry.mu.RUnlock()
    p, ok := defaultRegistry.processors[name]
    return p, ok
}

// List returns all registered processor names.
func List() []string {
    defaultRegistry.mu.RLock()
    defer defaultRegistry.mu.RUnlock()
    names := make([]string, 0, len(defaultRegistry.processors))
    for name := range defaultRegistry.processors {
        names = append(names, name)
    }
    return names
}
```

### Plugin Implementation

```go
// processors/json/json.go
package json

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/company/platform/plugin"
)

func init() {
    plugin.Register(&JSONProcessor{})
}

type JSONProcessor struct{}

func (j *JSONProcessor) Name() string    { return "json" }
func (j *JSONProcessor) Version() string { return "1.2.0" }

func (j *JSONProcessor) Validate(config map[string]string) error {
    if _, ok := config["schema_url"]; !ok {
        return fmt.Errorf("json processor requires 'schema_url' config key")
    }
    return nil
}

func (j *JSONProcessor) Process(ctx context.Context, input *plugin.ProcessInput) (*plugin.ProcessOutput, error) {
    var data map[string]interface{}
    if err := json.Unmarshal(input.Data, &data); err != nil {
        return nil, fmt.Errorf("json unmarshal: %w", err)
    }

    output, err := json.Marshal(data)
    if err != nil {
        return nil, fmt.Errorf("json marshal: %w", err)
    }

    return &plugin.ProcessOutput{
        Data: output,
        Metrics: map[string]float64{
            "fields_count": float64(len(data)),
        },
    }, nil
}
```

### Main Program Imports All Plugins

```go
// main.go
package main

import (
    _ "github.com/company/platform/processors/avro"   // Register Avro processor
    _ "github.com/company/platform/processors/json"   // Register JSON processor
    _ "github.com/company/platform/processors/parquet" // Register Parquet processor
    _ "github.com/company/platform/processors/protobuf" // Register Protobuf processor

    "github.com/company/platform/plugin"
)

func main() {
    // All processors available via registry
    proc, ok := plugin.Get("json")
    if !ok {
        panic("json processor not registered")
    }

    fmt.Printf("Available processors: %v\n", plugin.List())
    _ = proc
}
```

## hashicorp/go-plugin Framework

The hashicorp/go-plugin framework runs each plugin as a separate subprocess and communicates over gRPC or net/rpc. This provides crash isolation, security boundaries, and the ability to update plugins without restarting the host.

### Architecture

```
Host Process
├── Plugin Client (gRPC client)
│   └── net.Conn (localhost Unix socket or TCP)
│       └── Plugin Process (subprocess)
│           └── gRPC Server
│               └── Plugin Implementation
```

### Defining the Plugin Interface

```go
// shared/plugin.go - shared between host and plugin
package shared

import (
    "context"
    "net/rpc"

    "github.com/hashicorp/go-plugin"
    "google.golang.org/grpc"
)

// Greeter is the interface plugins must implement.
type Greeter interface {
    Greet(name string) (string, error)
    GreetWithContext(ctx context.Context, name string) (string, error)
}

// Handshake config must match between host and plugin.
var Handshake = plugin.HandshakeConfig{
    ProtocolVersion:  1,
    MagicCookieKey:   "GREETER_PLUGIN",
    MagicCookieValue: "greeter-v1",
}

// PluginMap maps plugin names to implementations.
var PluginMap = map[string]plugin.Plugin{
    "greeter": &GreeterPlugin{},
}

// GreeterPlugin is the plugin implementation for go-plugin.
type GreeterPlugin struct {
    // Impl is the concrete implementation (used on server side).
    Impl Greeter
}

// Server returns an RPC server for the plugin.
func (p *GreeterPlugin) Server(*plugin.MuxBroker) (interface{}, error) {
    return &GreeterRPCServer{Impl: p.Impl}, nil
}

// Client returns an RPC client for the plugin.
func (p *GreeterPlugin) Client(b *plugin.MuxBroker, c *rpc.Client) (interface{}, error) {
    return &GreeterRPCClient{client: c}, nil
}

// GRPCServer registers the plugin implementation as a gRPC server.
func (p *GreeterPlugin) GRPCServer(broker *plugin.GRPCBroker, s *grpc.Server) error {
    // Register the gRPC server here (if using gRPC transport)
    return nil
}

// GRPCClient returns a gRPC client for the plugin.
func (p *GreeterPlugin) GRPCClient(ctx context.Context, broker *plugin.GRPCBroker, c *grpc.ClientConn) (interface{}, error) {
    return nil, nil
}
```

### RPC Wrappers

```go
// shared/rpc.go
package shared

import "net/rpc"

// GreeterRPCClient is the client-side RPC wrapper.
type GreeterRPCClient struct {
    client *rpc.Client
}

func (c *GreeterRPCClient) Greet(name string) (string, error) {
    var resp string
    err := c.client.Call("Plugin.Greet", name, &resp)
    if err != nil {
        return "", err
    }
    return resp, nil
}

func (c *GreeterRPCClient) GreetWithContext(ctx context.Context, name string) (string, error) {
    // For simplicity: net/rpc doesn't natively support context.
    // Use gRPC transport for context support.
    return c.Greet(name)
}

// GreeterRPCServer is the server-side RPC wrapper.
type GreeterRPCServer struct {
    Impl Greeter
}

func (s *GreeterRPCServer) Greet(name string, resp *string) error {
    result, err := s.Impl.Greet(name)
    if err != nil {
        return err
    }
    *resp = result
    return nil
}
```

### Plugin Implementation (Subprocess)

```go
// plugins/formal-greeter/main.go
package main

import (
    "fmt"

    "github.com/hashicorp/go-plugin"
    "github.com/company/platform/shared"
)

// formalGreeter implements the Greeter interface.
type formalGreeter struct{}

func (f *formalGreeter) Greet(name string) (string, error) {
    return fmt.Sprintf("Good day, %s. How do you do?", name), nil
}

func (f *formalGreeter) GreetWithContext(ctx context.Context, name string) (string, error) {
    return f.Greet(name)
}

func main() {
    plugin.Serve(&plugin.ServeConfig{
        HandshakeConfig: shared.Handshake,
        Plugins: map[string]plugin.Plugin{
            "greeter": &shared.GreeterPlugin{Impl: &formalGreeter{}},
        },
    })
}
```

### Host Plugin Client

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
    "github.com/company/platform/shared"
)

func loadGreeterPlugin(pluginPath string) (shared.Greeter, *plugin.Client, error) {
    client := plugin.NewClient(&plugin.ClientConfig{
        HandshakeConfig: shared.Handshake,
        Plugins:         shared.PluginMap,
        Cmd:             exec.Command(pluginPath),
        Logger:          hclog.Default(),
        // Security: allowlist the plugin binary
        SecureConfig: &plugin.SecureConfig{
            Checksum: mustReadChecksum(pluginPath + ".sha256"),
            Hash:     sha256.New,
        },
        // Kill the plugin on host exit
        AutoMTLS: true,
    })

    rpcClient, err := client.Client()
    if err != nil {
        client.Kill()
        return nil, nil, fmt.Errorf("get client: %w", err)
    }

    raw, err := rpcClient.Dispense("greeter")
    if err != nil {
        client.Kill()
        return nil, nil, fmt.Errorf("dispense greeter: %w", err)
    }

    greeter, ok := raw.(shared.Greeter)
    if !ok {
        client.Kill()
        return nil, nil, fmt.Errorf("unexpected type: %T", raw)
    }

    return greeter, client, nil
}

func mustReadChecksum(path string) []byte {
    data, err := os.ReadFile(path)
    if err != nil {
        log.Fatalf("cannot read checksum file %s: %v", path, err)
    }
    // Parse hex checksum
    decoded, err := hex.DecodeString(strings.TrimSpace(string(data)))
    if err != nil {
        log.Fatalf("invalid checksum in %s: %v", path, err)
    }
    return decoded
}

func main() {
    greeter, client, err := loadGreeterPlugin("./plugins/formal-greeter")
    if err != nil {
        log.Fatalf("load plugin: %v", err)
    }
    defer client.Kill()

    result, err := greeter.Greet("World")
    if err != nil {
        log.Fatalf("greet: %v", err)
    }
    fmt.Println(result)
}
```

## Interface Versioning

Plugin interfaces must evolve without breaking existing plugins. Two strategies handle versioning:

### Strategy 1: Versioned Interfaces

```go
// shared/interfaces.go
package shared

// GreeterV1 is the original interface.
type GreeterV1 interface {
    Greet(name string) (string, error)
}

// GreeterV2 adds context support and metadata.
type GreeterV2 interface {
    GreeterV1
    GreetWithContext(ctx context.Context, name string) (string, error)
    Capabilities() []string
}

// GetGreeterVersion inspects which version of the interface the plugin supports.
func GetGreeterVersion(raw interface{}) (GreeterV2, bool) {
    v2, ok := raw.(GreeterV2)
    return v2, ok
}

// GreeterV1Adapter wraps a V1 plugin to satisfy the V2 interface.
type GreeterV1Adapter struct {
    v1 GreeterV1
}

func (a *GreeterV1Adapter) Greet(name string) (string, error) {
    return a.v1.Greet(name)
}

func (a *GreeterV1Adapter) GreetWithContext(ctx context.Context, name string) (string, error) {
    // V1 plugins don't support context; use background behavior
    return a.v1.Greet(name)
}

func (a *GreeterV1Adapter) Capabilities() []string {
    return []string{"greet"}
}
```

### Strategy 2: Protocol Version in Handshake

```go
var HandshakeV1 = plugin.HandshakeConfig{
    ProtocolVersion:  1,
    MagicCookieKey:   "GREETER_PLUGIN",
    MagicCookieValue: "greeter-v1",
}

var HandshakeV2 = plugin.HandshakeConfig{
    ProtocolVersion:  2,
    MagicCookieKey:   "GREETER_PLUGIN",
    MagicCookieValue: "greeter-v2",
}

// Host tries V2 first, falls back to V1
func loadPlugin(path string) (GreeterV2, *plugin.Client, error) {
    client, err := tryLoadV2(path)
    if err != nil {
        log.Printf("plugin does not support V2, falling back to V1: %v", err)
        v1client, v1err := tryLoadV1(path)
        if v1err != nil {
            return nil, nil, fmt.Errorf("plugin load failed: V2: %v, V1: %v", err, v1err)
        }
        // Wrap V1 in V2 adapter
        raw, _ := v1client.Client()
        rawGreeter, _ := raw.Dispense("greeter")
        return &GreeterV1Adapter{v1: rawGreeter.(GreeterV1)}, v1client, nil
    }
    return client
}
```

## Plugin Registry with Metadata

A production plugin registry tracks metadata, health, and lifecycle:

```go
package registry

import (
    "context"
    "fmt"
    "sync"
    "time"
)

type PluginInfo struct {
    Name        string
    Version     string
    Path        string
    Checksum    string
    LoadedAt    time.Time
    LastHealthy time.Time
    Healthy     bool
}

type PluginEntry struct {
    Info    PluginInfo
    Plugin  shared.Greeter
    Client  *plugin.Client
    mu      sync.Mutex
}

type PluginRegistry struct {
    mu      sync.RWMutex
    plugins map[string]*PluginEntry
}

func NewPluginRegistry() *PluginRegistry {
    return &PluginRegistry{
        plugins: make(map[string]*PluginEntry),
    }
}

func (r *PluginRegistry) Load(name, path string) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    // Unload existing plugin with this name if present
    if existing, ok := r.plugins[name]; ok {
        existing.Client.Kill()
        delete(r.plugins, name)
    }

    greeter, client, err := loadGreeterPlugin(path)
    if err != nil {
        return fmt.Errorf("load plugin %s from %s: %w", name, path, err)
    }

    info := PluginInfo{
        Name:     name,
        Path:     path,
        LoadedAt: time.Now(),
        Healthy:  true,
    }

    r.plugins[name] = &PluginEntry{
        Info:   info,
        Plugin: greeter,
        Client: client,
    }

    return nil
}

func (r *PluginRegistry) Get(name string) (shared.Greeter, bool) {
    r.mu.RLock()
    defer r.mu.RUnlock()
    entry, ok := r.plugins[name]
    if !ok || !entry.Info.Healthy {
        return nil, false
    }
    return entry.Plugin, true
}

func (r *PluginRegistry) HealthCheck(ctx context.Context) {
    r.mu.RLock()
    names := make([]string, 0, len(r.plugins))
    for name := range r.plugins {
        names = append(names, name)
    }
    r.mu.RUnlock()

    for _, name := range names {
        r.mu.Lock()
        entry, ok := r.plugins[name]
        r.mu.Unlock()
        if !ok {
            continue
        }

        // Ping the plugin process
        if entry.Client.Exited() {
            entry.mu.Lock()
            entry.Info.Healthy = false
            entry.mu.Unlock()
            log.Printf("plugin %s has exited", name)
        } else {
            entry.mu.Lock()
            entry.Info.Healthy = true
            entry.Info.LastHealthy = time.Now()
            entry.mu.Unlock()
        }
    }
}

func (r *PluginRegistry) Unload(name string) {
    r.mu.Lock()
    defer r.mu.Unlock()
    if entry, ok := r.plugins[name]; ok {
        entry.Client.Kill()
        delete(r.plugins, name)
    }
}

func (r *PluginRegistry) List() []PluginInfo {
    r.mu.RLock()
    defer r.mu.RUnlock()
    infos := make([]PluginInfo, 0, len(r.plugins))
    for _, entry := range r.plugins {
        infos = append(infos, entry.Info)
    }
    return infos
}
```

## Hot Reload Without Downtime

Hot reload replaces a plugin binary with a new version while the host continues serving traffic. The key is to keep the old plugin alive until in-flight requests complete:

```go
func (r *PluginRegistry) HotReload(ctx context.Context, name, newPath string) error {
    // Step 1: Load the new plugin under a temporary name
    tmpName := name + "-incoming"
    if err := r.Load(tmpName, newPath); err != nil {
        return fmt.Errorf("load new plugin version: %w", err)
    }

    // Step 2: Verify the new plugin is healthy
    newPlugin, ok := r.Get(tmpName)
    if !ok {
        r.Unload(tmpName)
        return fmt.Errorf("new plugin version failed health check")
    }

    // Step 3: Verify backward compatibility
    _, err := newPlugin.Greet("health-check")
    if err != nil {
        r.Unload(tmpName)
        return fmt.Errorf("new plugin version failed compatibility test: %w", err)
    }

    // Step 4: Atomic swap
    r.mu.Lock()
    oldEntry, hadOld := r.plugins[name]
    newEntry := r.plugins[tmpName]
    newEntry.Info.Name = name
    r.plugins[name] = newEntry
    delete(r.plugins, tmpName)
    r.mu.Unlock()

    // Step 5: Drain and kill the old plugin after a grace period
    if hadOld {
        go func() {
            // Allow in-flight requests to complete
            time.Sleep(30 * time.Second)
            oldEntry.Client.Kill()
            log.Printf("hot reload complete: plugin %s updated", name)
        }()
    }

    return nil
}
```

## Shared State Management

Plugins in separate processes cannot share Go data structures. Options for sharing state:

### Option 1: Pass State in Each Call

```protobuf
// plugin.proto
message GreetRequest {
    string name = 1;
    map<string, string> session_context = 2;  // Pass state per request
}
```

### Option 2: Shared Memory via mmap

For high-frequency low-latency state sharing (read-only or append-only):

```go
// sharedmem/sharedmem.go
package sharedmem

import (
    "os"
    "unsafe"
    "golang.org/x/sys/unix"
)

type SharedConfig struct {
    RateLimitRPS uint64
    FeatureFlags uint64
    Updated      int64  // Unix timestamp
}

func OpenSharedConfig(path string) (*SharedConfig, error) {
    f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    if err := f.Truncate(int64(unsafe.Sizeof(SharedConfig{}))); err != nil {
        return nil, err
    }

    data, err := unix.Mmap(
        int(f.Fd()),
        0,
        int(unsafe.Sizeof(SharedConfig{})),
        unix.PROT_READ|unix.PROT_WRITE,
        unix.MAP_SHARED,
    )
    if err != nil {
        return nil, err
    }

    return (*SharedConfig)(unsafe.Pointer(&data[0])), nil
}
```

### Option 3: Redis or etcd for Shared State

For configuration that changes infrequently, plugins read from Redis/etcd with local caching and a TTL.

## Plugin Security

```go
// Verify plugin binary before loading
func verifyPlugin(path string, expectedSHA256 string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    h := sha256.New()
    if _, err := io.Copy(h, f); err != nil {
        return err
    }

    actual := hex.EncodeToString(h.Sum(nil))
    if actual != expectedSHA256 {
        return fmt.Errorf("plugin checksum mismatch: expected %s, got %s",
            expectedSHA256, actual)
    }
    return nil
}

// Plugin manifest for tracking approved versions
type PluginManifest struct {
    Name     string            `json:"name"`
    Version  string            `json:"version"`
    Path     string            `json:"path"`
    SHA256   string            `json:"sha256"`
    Approved bool              `json:"approved"`
    Tags     []string          `json:"tags"`
    Config   map[string]string `json:"config"`
}
```

## Testing Plugin Architectures

```go
package registry_test

import (
    "context"
    "testing"

    "github.com/company/platform/registry"
    "github.com/company/platform/shared"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

// mockGreeter implements the Greeter interface for tests.
type mockGreeter struct {
    greeting string
    err      error
}

func (m *mockGreeter) Greet(name string) (string, error) {
    if m.err != nil {
        return "", m.err
    }
    return m.greeting + ", " + name, nil
}

func (m *mockGreeter) GreetWithContext(ctx context.Context, name string) (string, error) {
    return m.Greet(name)
}

func TestRegistryGetMissingPlugin(t *testing.T) {
    r := registry.NewPluginRegistry()
    _, ok := r.Get("nonexistent")
    assert.False(t, ok)
}

func TestRegistryLoadAndGet(t *testing.T) {
    r := registry.NewPluginRegistry()

    // Inject mock without actually launching a subprocess
    r.InjectForTest("formal", &mockGreeter{greeting: "Good day"})

    p, ok := r.Get("formal")
    require.True(t, ok)

    result, err := p.Greet("World")
    require.NoError(t, err)
    assert.Equal(t, "Good day, World", result)
}
```

## Choosing the Right Plugin Approach

| Approach | Binary Size | Update Without Restart | Crash Isolation | Complexity |
|---|---|---|---|---|
| Compiled-in registration | Small | No | No | Low |
| Native `plugin` package | Medium | No | No | Medium |
| hashicorp/go-plugin (RPC) | Large | Yes | Yes | High |
| hashicorp/go-plugin (gRPC) | Large | Yes | Yes | High |
| Subprocess with protocol | Medium | Yes | Yes | Medium |

For most enterprise platforms:
- **Compiled-in registration** for internal extensions where all code is owned by the team
- **hashicorp/go-plugin with gRPC** for third-party extensions, marketplace plugins, or any code that must be isolated from the host process

The hashicorp/go-plugin approach's overhead — one process per plugin, gRPC serialization — is negligible for plugins that handle request-level work. The crash isolation and update-without-restart properties justify the complexity in production systems where a buggy plugin should not take down the platform.
