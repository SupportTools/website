---
title: "Go Plugin Systems with hashicorp/go-plugin: RPC Plugins, gRPC, and Production Architecture"
date: 2028-05-23T00:00:00-05:00
draft: false
tags: ["Go", "Plugins", "hashicorp/go-plugin", "gRPC", "Architecture", "Terraform", "Vault", "Extensibility"]
categories: ["Go", "Software Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go plugin systems using hashicorp/go-plugin: RPC vs gRPC plugin transports, interface versioning, process isolation, health checking, and production patterns from Terraform and Vault."
more_link: "yes"
url: "/go-plugin-system-hashicorp-guide/"
---

Go's native `plugin` package offers in-process shared library loading, but it comes with severe limitations: plugins must be compiled with the exact same Go version and all dependencies must match. In practice, this makes the standard plugin package unsuitable for anything beyond toy use cases. HashiCorp's `go-plugin` library takes a fundamentally different approach: plugins run as separate processes and communicate via RPC over a local socket. This is the architecture behind Terraform providers, Vault plugins, and dozens of other extensible Go systems. This guide covers the complete go-plugin system from basic RPC interfaces to gRPC-based plugins with versioning and production health checking.

<!--more-->

## Why Process-Isolated Plugins

Process isolation solves the dependency hell problem completely. Each plugin:

- Compiles with its own Go version and dependencies
- Cannot crash the host process (plugin panic = plugin restart, not host crash)
- Can be written in any language that speaks gRPC or net/rpc
- Can be versioned and updated independently
- Can be security sandboxed at the OS level (seccomp, namespaces)

The cost is RPC overhead. For plugins called frequently (millions of times per second), this matters. For plugins called occasionally (Terraform provider operations, Vault auth methods, configuration validators), the overhead is negligible.

**Production systems using go-plugin:**
- Terraform providers (AWS, GCP, Azure, etc.)
- Vault secret engines and auth methods
- Packer builders
- Consul service mesh plugins
- Waypoint builders/deployers

## Library Architecture

```
Host Process                    Plugin Process
┌──────────────────┐           ┌──────────────────┐
│  plugin.Client   │◄─stdin───►│  plugin.Serve()  │
│  (handshake)     │◄─net/rpc──►│  (handshake)     │
│                  │◄─gRPC─────►│                  │
│  MyPlugin        │           │  MyPlugin impl   │
│  (Go interface)  │           │  (actual code)   │
└──────────────────┘           └──────────────────┘
```

The host process launches the plugin binary as a subprocess. The plugin binary calls `plugin.Serve()` which writes the negotiated RPC address to stdout. The host reads this and establishes the RPC connection. From that point, the host calls plugin methods via RPC as if they were local function calls.

## Installation

```bash
go get github.com/hashicorp/go-plugin@latest
```

## Basic RPC Plugin System

### Define the Interface

Both host and plugin share the interface definition:

```go
// shared/interface.go
package shared

// Greeter is the interface that plugins must implement.
type Greeter interface {
    Greet(name string) (string, error)
}

// GreeterPlugin implements plugin.Plugin for Greeter.
// It connects the interface to the RPC implementation.
type GreeterPlugin struct {
    // For RPC-based plugins, Impl is set only on the server side
    Impl Greeter
}
```

### RPC Implementations

```go
// shared/rpc.go
package shared

import "net/rpc"

// GreeterRPCServer is the RPC server the plugin binary runs.
// It wraps the actual implementation.
type GreeterRPCServer struct {
    Impl Greeter
}

type GreetArgs struct {
    Name string
}

type GreetReply struct {
    Message string
    Err     string
}

func (s *GreeterRPCServer) Greet(args GreetArgs, resp *GreetReply) error {
    msg, err := s.Impl.Greet(args.Name)
    resp.Message = msg
    if err != nil {
        resp.Err = err.Error()
    }
    return nil
}

// GreeterRPCClient is the RPC client used by the host.
// It implements the Greeter interface.
type GreeterRPCClient struct {
    client *rpc.Client
}

func (c *GreeterRPCClient) Greet(name string) (string, error) {
    var reply GreetReply
    err := c.client.Call("Plugin.Greet", GreetArgs{Name: name}, &reply)
    if err != nil {
        return "", err
    }
    if reply.Err != "" {
        return "", fmt.Errorf(reply.Err)
    }
    return reply.Message, nil
}
```

### Plugin Interface Implementation

```go
// shared/plugin.go
package shared

import (
    "net/rpc"

    "github.com/hashicorp/go-plugin"
)

func (p *GreeterPlugin) Server(*plugin.MuxBroker) (interface{}, error) {
    return &GreeterRPCServer{Impl: p.Impl}, nil
}

func (p *GreeterPlugin) Client(b *plugin.MuxBroker, c *rpc.Client) (interface{}, error) {
    return &GreeterRPCClient{client: c}, nil
}

// HandshakeConfig is shared between host and plugin.
// ProtocolVersion ensures compatibility.
var HandshakeConfig = plugin.HandshakeConfig{
    ProtocolVersion:  1,
    MagicCookieKey:   "GREETER_PLUGIN",
    MagicCookieValue: "greeter-v1",
}

// PluginMap maps plugin names to their implementations.
var PluginMap = map[string]plugin.Plugin{
    "greeter": &GreeterPlugin{},
}
```

### Plugin Binary (greeter-plugin/main.go)

```go
package main

import (
    "fmt"

    "github.com/hashicorp/go-plugin"
    "github.com/example/plugindemo/shared"
)

// GreeterImpl is the actual plugin implementation.
type GreeterImpl struct{}

func (g *GreeterImpl) Greet(name string) (string, error) {
    return fmt.Sprintf("Hello, %s! (from plugin process %d)", name, os.Getpid()), nil
}

func main() {
    plugin.Serve(&plugin.ServeConfig{
        HandshakeConfig: shared.HandshakeConfig,
        Plugins: map[string]plugin.Plugin{
            "greeter": &shared.GreeterPlugin{Impl: &GreeterImpl{}},
        },
    })
}
```

### Host Process

```go
// host/main.go
package main

import (
    "fmt"
    "log"
    "os"
    "os/exec"

    "github.com/hashicorp/go-plugin"
    "github.com/example/plugindemo/shared"
)

func main() {
    // Locate plugin binary
    pluginPath := os.Getenv("GREETER_PLUGIN_PATH")
    if pluginPath == "" {
        pluginPath = "./greeter-plugin"
    }

    // Create plugin client
    client := plugin.NewClient(&plugin.ClientConfig{
        HandshakeConfig: shared.HandshakeConfig,
        Plugins:         shared.PluginMap,
        Cmd:             exec.Command(pluginPath),
        // Logger for plugin output
        Logger: logger,
        // Timeout for plugin startup
        StartTimeout: 5 * time.Second,
        // Reattach to running plugin instead of starting new one
        // Reattach: reattachConfig,
    })
    defer client.Kill()

    // Connect via RPC
    rpcClient, err := client.Client()
    if err != nil {
        log.Fatal("Error getting plugin client:", err)
    }

    // Get the plugin interface
    raw, err := rpcClient.Dispense("greeter")
    if err != nil {
        log.Fatal("Error dispensing plugin:", err)
    }

    greeter := raw.(shared.Greeter)

    // Use the plugin
    msg, err := greeter.Greet("World")
    if err != nil {
        log.Fatal("Error calling plugin:", err)
    }

    fmt.Println(msg)
    // Output: Hello, World! (from plugin process 12345)
}
```

## gRPC-Based Plugin System

For production systems, gRPC is preferred over net/rpc:
- Protocol Buffers provide typed schema
- Better error handling
- Streaming support
- Language-agnostic (write plugins in Rust, Python, etc.)

### Define the Proto Schema

```protobuf
// proto/greeter.proto
syntax = "proto3";
package greeter;
option go_package = "github.com/example/plugindemo/proto";

service Greeter {
    rpc Greet(GreetRequest) returns (GreetResponse);
    rpc GreetStream(GreetRequest) returns (stream GreetResponse);
}

message GreetRequest {
    string name = 1;
    map<string, string> metadata = 2;
}

message GreetResponse {
    string message = 1;
    string plugin_version = 2;
    int64 timestamp = 3;
}
```

```bash
protoc --go_out=. --go-grpc_out=. proto/greeter.proto
```

### gRPC Plugin Implementation

```go
// shared/grpc.go
package shared

import (
    "context"
    "fmt"
    "time"

    "google.golang.org/grpc"
    "github.com/hashicorp/go-plugin"
    proto "github.com/example/plugindemo/proto"
)

// GRPCGreeterPlugin implements plugin.GRPCPlugin
type GRPCGreeterPlugin struct {
    plugin.NetRPCUnsupportedPlugin
    Impl Greeter
}

func (p *GRPCGreeterPlugin) GRPCServer(broker *plugin.GRPCBroker, s *grpc.Server) error {
    proto.RegisterGreeterServer(s, &GRPCGreeterServer{Impl: p.Impl})
    return nil
}

func (p *GRPCGreeterPlugin) GRPCClient(
    ctx context.Context,
    broker *plugin.GRPCBroker,
    c *grpc.ClientConn,
) (interface{}, error) {
    return &GRPCGreeterClient{client: proto.NewGreeterClient(c)}, nil
}

// Server-side implementation
type GRPCGreeterServer struct {
    proto.UnimplementedGreeterServer
    Impl Greeter
}

func (s *GRPCGreeterServer) Greet(
    ctx context.Context,
    req *proto.GreetRequest,
) (*proto.GreetResponse, error) {
    msg, err := s.Impl.Greet(req.Name)
    if err != nil {
        return nil, err
    }
    return &proto.GreetResponse{
        Message:       msg,
        PluginVersion: "1.0.0",
        Timestamp:     time.Now().UnixNano(),
    }, nil
}

// Client-side implementation (runs in host process)
type GRPCGreeterClient struct {
    client proto.GreeterClient
}

func (c *GRPCGreeterClient) Greet(name string) (string, error) {
    resp, err := c.client.Greet(context.Background(), &proto.GreetRequest{
        Name: name,
    })
    if err != nil {
        return "", err
    }
    return resp.Message, nil
}
```

### gRPC Plugin Binary

```go
// greeter-grpc-plugin/main.go
package main

import (
    "context"
    "fmt"
    "os"

    "github.com/hashicorp/go-plugin"
    "github.com/example/plugindemo/shared"
    proto "github.com/example/plugindemo/proto"
)

type GRPCGreeterImpl struct {
    proto.UnimplementedGreeterServer
}

func (g *GRPCGreeterImpl) Greet(name string) (string, error) {
    return fmt.Sprintf("Hello from gRPC plugin! Process: %d, Name: %s", os.Getpid(), name), nil
}

func main() {
    plugin.Serve(&plugin.ServeConfig{
        HandshakeConfig: shared.HandshakeConfig,
        Plugins: map[string]plugin.Plugin{
            "greeter": &shared.GRPCGreeterPlugin{Impl: &GRPCGreeterImpl{}},
        },
        GRPCServer: plugin.DefaultGRPCServer,
    })
}
```

### gRPC Host Process

```go
// host-grpc/main.go
package main

import (
    "fmt"
    "log"
    "os/exec"
    "time"

    "github.com/hashicorp/go-plugin"
    "github.com/example/plugindemo/shared"
    hclog "github.com/hashicorp/go-hclog"
)

func main() {
    logger := hclog.New(&hclog.LoggerOptions{
        Name:   "plugin-host",
        Output: os.Stdout,
        Level:  hclog.Info,
    })

    client := plugin.NewClient(&plugin.ClientConfig{
        HandshakeConfig:  shared.HandshakeConfig,
        Plugins:          shared.GRPCPluginMap,
        Cmd:              exec.Command("./greeter-grpc-plugin"),
        Logger:           logger,
        AllowedProtocols: []plugin.Protocol{plugin.ProtocolGRPC},
        StartTimeout:     10 * time.Second,
    })
    defer client.Kill()

    rpcClient, err := client.Client()
    if err != nil {
        log.Fatal(err)
    }

    raw, err := rpcClient.Dispense("greeter")
    if err != nil {
        log.Fatal(err)
    }

    greeter := raw.(shared.Greeter)
    msg, err := greeter.Greet("Production")
    if err != nil {
        log.Fatal(err)
    }

    fmt.Println(msg)
}
```

## Protocol Versioning

Managing breaking changes across plugin versions:

```go
// shared/versioning.go
package shared

import "github.com/hashicorp/go-plugin"

// Version 1: Basic greeter
var HandshakeConfigV1 = plugin.HandshakeConfig{
    ProtocolVersion:  1,
    MagicCookieKey:   "GREETER_PLUGIN",
    MagicCookieValue: "greeter",
}

// Version 2: Greeter with metadata support
var HandshakeConfigV2 = plugin.HandshakeConfig{
    ProtocolVersion:  2,
    MagicCookieKey:   "GREETER_PLUGIN",
    MagicCookieValue: "greeter",
}

// VersionedPlugins registers multiple protocol versions
// Allows host to support old and new plugins simultaneously
var VersionedPlugins = map[int]plugin.PluginSet{
    1: {
        "greeter": &GreeterPluginV1{},
    },
    2: {
        "greeter": &GRPCGreeterPlugin{},
    },
}
```

Host negotiates the highest shared version:

```go
client := plugin.NewClient(&plugin.ClientConfig{
    HandshakeConfig: HandshakeConfig,
    // Negotiate highest version both sides support
    VersionedPlugins: VersionedPlugins,
    Cmd:              exec.Command(pluginPath),
    AllowedProtocols: []plugin.Protocol{
        plugin.ProtocolNetRPC,
        plugin.ProtocolGRPC,
    },
})
```

## Plugin Discovery and Registry

Production systems need to discover available plugins dynamically:

```go
// registry/registry.go
package registry

import (
    "fmt"
    "os"
    "os/exec"
    "path/filepath"
    "sync"

    "github.com/hashicorp/go-plugin"
    "github.com/example/plugindemo/shared"
)

type PluginRegistry struct {
    mu          sync.RWMutex
    clients     map[string]*plugin.Client
    instances   map[string]shared.Greeter
    pluginDir   string
}

func NewPluginRegistry(pluginDir string) *PluginRegistry {
    return &PluginRegistry{
        clients:   make(map[string]*plugin.Client),
        instances: make(map[string]shared.Greeter),
        pluginDir: pluginDir,
    }
}

func (r *PluginRegistry) Discover() error {
    entries, err := os.ReadDir(r.pluginDir)
    if err != nil {
        return fmt.Errorf("reading plugin dir: %w", err)
    }

    for _, entry := range entries {
        if entry.IsDir() || !isExecutable(entry) {
            continue
        }

        name := entry.Name()
        pluginPath := filepath.Join(r.pluginDir, name)

        if err := r.Load(name, pluginPath); err != nil {
            fmt.Printf("Warning: failed to load plugin %s: %v\n", name, err)
            continue
        }

        fmt.Printf("Loaded plugin: %s\n", name)
    }

    return nil
}

func (r *PluginRegistry) Load(name, path string) error {
    client := plugin.NewClient(&plugin.ClientConfig{
        HandshakeConfig:  shared.HandshakeConfig,
        Plugins:          shared.GRPCPluginMap,
        Cmd:              exec.Command(path),
        AllowedProtocols: []plugin.Protocol{plugin.ProtocolGRPC},
        StartTimeout:     10 * time.Second,
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

    r.mu.Lock()
    defer r.mu.Unlock()

    // Kill existing plugin if reloading
    if existing, exists := r.clients[name]; exists {
        existing.Kill()
    }

    r.clients[name] = client
    r.instances[name] = greeter

    return nil
}

func (r *PluginRegistry) Get(name string) (shared.Greeter, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    instance, exists := r.instances[name]
    if !exists {
        return nil, fmt.Errorf("plugin not found: %s", name)
    }

    return instance, nil
}

func (r *PluginRegistry) Close() {
    r.mu.Lock()
    defer r.mu.Unlock()

    for name, client := range r.clients {
        client.Kill()
        fmt.Printf("Killed plugin: %s\n", name)
    }
}
```

## Plugin Health Checking and Auto-Restart

go-plugin's `client.Client()` detects plugin process termination. Implement auto-restart:

```go
// health/watchdog.go
package health

import (
    "context"
    "fmt"
    "log"
    "sync"
    "time"

    "github.com/example/plugindemo/registry"
    "github.com/example/plugindemo/shared"
)

type PluginWatchdog struct {
    registry    *registry.PluginRegistry
    pluginPaths map[string]string
    interval    time.Duration
    mu          sync.Mutex
}

func NewPluginWatchdog(
    reg *registry.PluginRegistry,
    pluginPaths map[string]string,
    interval time.Duration,
) *PluginWatchdog {
    return &PluginWatchdog{
        registry:    reg,
        pluginPaths: pluginPaths,
        interval:    interval,
    }
}

func (w *PluginWatchdog) Run(ctx context.Context) {
    ticker := time.NewTicker(w.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            w.checkAndRestartPlugins()
        case <-ctx.Done():
            return
        }
    }
}

func (w *PluginWatchdog) checkAndRestartPlugins() {
    for name, path := range w.pluginPaths {
        if err := w.pingPlugin(name); err != nil {
            log.Printf("Plugin %s health check failed: %v, restarting...", name, err)
            if err := w.registry.Load(name, path); err != nil {
                log.Printf("Failed to restart plugin %s: %v", name, err)
            } else {
                log.Printf("Plugin %s restarted successfully", name)
            }
        }
    }
}

func (w *PluginWatchdog) pingPlugin(name string) error {
    instance, err := w.registry.Get(name)
    if err != nil {
        return err
    }

    // Ping with a test call
    ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
    defer cancel()

    done := make(chan error, 1)
    go func() {
        _, err := instance.Greet("_health_check_")
        done <- err
    }()

    select {
    case err := <-done:
        return err
    case <-ctx.Done():
        return fmt.Errorf("plugin health check timeout")
    }
}
```

## Security: Plugin Sandboxing

For untrusted plugins (e.g., customer-provided extensions), add OS-level sandboxing:

```go
// Restrict plugin process capabilities
client := plugin.NewClient(&plugin.ClientConfig{
    HandshakeConfig: shared.HandshakeConfig,
    Plugins:         shared.GRPCPluginMap,
    Cmd: &exec.Cmd{
        Path: pluginPath,
        SysProcAttr: &syscall.SysProcAttr{
            // Drop all capabilities
            AmbientCaps:   []uintptr{},
            // Run in new user namespace (requires CAP_SYS_ADMIN or user namespaces enabled)
            Cloneflags: syscall.CLONE_NEWPID | syscall.CLONE_NEWNS,
            // Set resource limits
            Rlimit: []syscall.Rlimit{
                {
                    Type: syscall.RLIMIT_AS,
                    Cur:  1 << 30, // 1GB virtual memory limit
                    Max:  1 << 30,
                },
                {
                    Type: syscall.RLIMIT_NOFILE,
                    Cur:  256,
                    Max:  256,
                },
            },
        },
    },
    SecureConfig: &plugin.SecureConfig{
        Checksum: []byte(expectedChecksum),
        Hash:     sha256.New,
    },
})
```

Plugin binary checksum verification:

```go
// Verify plugin binary hash before execution
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
        return fmt.Errorf("checksum mismatch: expected %s, got %s", expectedSHA256, actual)
    }

    return nil
}
```

## Terraform Provider Pattern

Terraform providers use go-plugin extensively. The pattern for a simple resource provider:

```go
// provider/main.go (Terraform provider binary)
package main

import (
    "github.com/hashicorp/terraform-plugin-sdk/v2/plugin"
    "github.com/hashicorp/terraform-plugin-sdk/v2/helper/schema"
)

func main() {
    plugin.Serve(&plugin.ServeOpts{
        ProviderFunc: func() *schema.Provider {
            return &schema.Provider{
                Schema: map[string]*schema.Schema{
                    "api_endpoint": {
                        Type:     schema.TypeString,
                        Required: true,
                    },
                    "api_key": {
                        Type:      schema.TypeString,
                        Required:  true,
                        Sensitive: true,
                    },
                },
                ResourcesMap: map[string]*schema.Resource{
                    "mycloud_instance": resourceInstance(),
                },
                ConfigureContextFunc: providerConfigure,
            }
        },
    })
}
```

## Testing Plugin Systems

Testing go-plugin systems requires both unit tests (mocking the interface) and integration tests (real plugin process):

```go
// Unit test: mock the interface
func TestGreeterService_WithMock(t *testing.T) {
    // Use the interface directly, no plugin process needed
    mockGreeter := &MockGreeter{}
    mockGreeter.On("Greet", "Alice").Return("Hello, Alice!", nil)

    svc := NewService(mockGreeter)
    result, err := svc.WelcomeUser("Alice")

    assert.NoError(t, err)
    assert.Equal(t, "Welcome: Hello, Alice!", result)
    mockGreeter.AssertExpectations(t)
}

// Integration test: real plugin process
func TestGreeterPlugin_Integration(t *testing.T) {
    if testing.Short() {
        t.Skip("Skipping integration test")
    }

    // Build plugin binary
    cmd := exec.Command("go", "build", "-o", "/tmp/test-greeter-plugin",
        "./greeter-plugin")
    require.NoError(t, cmd.Run())

    // Create client
    client := plugin.NewClient(&plugin.ClientConfig{
        HandshakeConfig:  shared.HandshakeConfig,
        Plugins:          shared.GRPCPluginMap,
        Cmd:              exec.Command("/tmp/test-greeter-plugin"),
        AllowedProtocols: []plugin.Protocol{plugin.ProtocolGRPC},
        Logger:           hclog.NewNullLogger(),
    })
    defer client.Kill()

    rpcClient, err := client.Client()
    require.NoError(t, err)

    raw, err := rpcClient.Dispense("greeter")
    require.NoError(t, err)

    greeter := raw.(shared.Greeter)

    msg, err := greeter.Greet("Test")
    assert.NoError(t, err)
    assert.Contains(t, msg, "Test")
}
```

## Production Deployment Patterns

### Plugin Directory Structure

```
/opt/myapp/
├── bin/
│   └── myapp              # Host binary
├── plugins/
│   ├── greeter-v1.0.0     # Plugin binary
│   ├── greeter-v1.1.0     # Updated plugin
│   ├── analytics-v2.3.1   # Different plugin
│   └── checksums.sha256   # Verification file
└── config/
    └── plugins.yaml       # Plugin configuration
```

```yaml
# plugins.yaml
plugins:
  greeter:
    path: /opt/myapp/plugins/greeter-v1.1.0
    checksum: "sha256:abc123..."
    timeout: 30s
    restartOnFailure: true
    maxRestarts: 5

  analytics:
    path: /opt/myapp/plugins/analytics-v2.3.1
    checksum: "sha256:def456..."
    timeout: 60s
    restartOnFailure: false
```

### Plugin Updates Without Restart

```go
func (r *PluginRegistry) HotReload(name, newPath string) error {
    // Load new plugin
    newClient := plugin.NewClient(&plugin.ClientConfig{
        HandshakeConfig:  shared.HandshakeConfig,
        Plugins:          shared.GRPCPluginMap,
        Cmd:              exec.Command(newPath),
        AllowedProtocols: []plugin.Protocol{plugin.ProtocolGRPC},
    })

    rpcClient, err := newClient.Client()
    if err != nil {
        newClient.Kill()
        return fmt.Errorf("new plugin failed to start: %w", err)
    }

    raw, err := rpcClient.Dispense("greeter")
    if err != nil {
        newClient.Kill()
        return fmt.Errorf("new plugin failed to initialize: %w", err)
    }

    r.mu.Lock()
    oldClient := r.clients[name]
    r.clients[name] = newClient
    r.instances[name] = raw.(shared.Greeter)
    r.mu.Unlock()

    // Kill old plugin after swap
    if oldClient != nil {
        // Brief delay to let in-flight calls complete
        time.AfterFunc(5*time.Second, oldClient.Kill)
    }

    return nil
}
```

## Summary

HashiCorp's go-plugin library provides a robust, production-tested foundation for extensible Go applications. The process-isolation model solves the dependency compatibility problems that make Go's native plugin package impractical. gRPC-based plugins are language-agnostic, typed, and efficient. The versioned protocol system handles breaking changes without coordination between host and plugin releases. Pattern validation from production systems like Terraform and Vault demonstrates that this architecture scales to hundreds of plugins with millions of deployments. For any Go application requiring extensibility by third parties or independent release cycles, go-plugin is the established standard.
