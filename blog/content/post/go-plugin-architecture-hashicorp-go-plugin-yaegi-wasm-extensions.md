---
title: "Go Plugin Architecture: HashiCorp go-plugin, yaegi Interpreter, and WASM Extensions"
date: 2029-12-25T00:00:00-05:00
draft: false
tags: ["Go", "Plugins", "HashiCorp", "WebAssembly", "WASM", "yaegi", "wazero", "go-plugin", "gRPC", "Enterprise"]
categories:
- Go
- Architecture
- WebAssembly
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide covering HashiCorp go-plugin RPC/gRPC plugins, yaegi runtime evaluation, WebAssembly plugins with wazero, and hot-reload patterns for extensible Go applications."
more_link: "yes"
url: "/go-plugin-architecture-hashicorp-go-plugin-yaegi-wasm-extensions/"
---

Building extensible Go applications at enterprise scale requires choosing the right plugin strategy. Whether you need isolation boundaries, dynamic scripting, or portable WASM modules, each approach involves different tradeoffs in safety, performance, and developer experience. This guide covers the three dominant patterns — HashiCorp go-plugin, yaegi interpreter, and WebAssembly via wazero — including production hot-reload strategies.

<!--more-->

## Section 1: HashiCorp go-plugin — Process-Isolated RPC Plugins

HashiCorp go-plugin is the foundation of Terraform, Vault, and Packer's extensibility model. It runs each plugin as a separate OS process, communicating over local Unix sockets or TCP using either net/rpc or gRPC. The process boundary provides strong isolation: a crashing plugin does not crash the host.

### Installing go-plugin

```bash
go get github.com/hashicorp/go-plugin@v1.6.0
```

### Defining the Plugin Interface

Every go-plugin integration starts with a shared interface that both host and plugin implement.

```go
// shared/interface.go
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
}

// GreeterPlugin is the go-plugin Plugin implementation for Greeter.
type GreeterPlugin struct {
    Impl Greeter
}

func (p *GreeterPlugin) Server(*plugin.MuxBroker) (interface{}, error) {
    return &GreeterRPCServer{Impl: p.Impl}, nil
}

func (p *GreeterPlugin) Client(b *plugin.MuxBroker, c *rpc.Client) (interface{}, error) {
    return &GreeterRPCClient{client: c}, nil
}

// RPC server wraps the implementation.
type GreeterRPCServer struct {
    Impl Greeter
}

type GreeterArgs struct{ Name string }
type GreeterResp struct{ Greeting string }

func (s *GreeterRPCServer) Greet(args GreeterArgs, resp *GreeterResp) error {
    result, err := s.Impl.Greet(args.Name)
    resp.Greeting = result
    return err
}

// RPC client forwards calls to the plugin process.
type GreeterRPCClient struct{ client *rpc.Client }

func (c *GreeterRPCClient) Greet(name string) (string, error) {
    args := GreeterArgs{Name: name}
    var resp GreeterResp
    err := c.client.Call("Plugin.Greet", args, &resp)
    return resp.Greeting, err
}

// HandshakeConfig prevents accidental mismatches.
var HandshakeConfig = plugin.HandshakeConfig{
    ProtocolVersion:  1,
    MagicCookieKey:   "GREETER_PLUGIN",
    MagicCookieValue: "greeter",
}

// PluginMap is the map of plugins served/consumed.
var PluginMap = map[string]plugin.Plugin{
    "greeter": &GreeterPlugin{},
}
```

### Implementing a Plugin Binary

The plugin is a standalone Go binary that calls `plugin.Serve`.

```go
// plugin-impl/main.go
package main

import (
    "fmt"

    goplugin "github.com/hashicorp/go-plugin"
    "github.com/example/myapp/shared"
)

type EnglishGreeter struct{}

func (g *EnglishGreeter) Greet(name string) (string, error) {
    return fmt.Sprintf("Hello, %s!", name), nil
}

func main() {
    goplugin.Serve(&goplugin.ServeConfig{
        HandshakeConfig: shared.HandshakeConfig,
        Plugins: goplugin.PluginSet{
            "greeter": &shared.GreeterPlugin{Impl: &EnglishGreeter{}},
        },
    })
}
```

### Loading Plugins from the Host

```go
// host/main.go
package main

import (
    "fmt"
    "log"
    "os/exec"

    goplugin "github.com/hashicorp/go-plugin"
    "github.com/example/myapp/shared"
)

func main() {
    client := goplugin.NewClient(&goplugin.ClientConfig{
        HandshakeConfig: shared.HandshakeConfig,
        Plugins:         shared.PluginMap,
        Cmd:             exec.Command("./plugin-impl"),
        AllowedProtocols: []goplugin.Protocol{
            goplugin.ProtocolNetRPC,
        },
    })
    defer client.Kill()

    rpcClient, err := client.Client()
    if err != nil {
        log.Fatalf("error getting plugin client: %v", err)
    }

    raw, err := rpcClient.Dispense("greeter")
    if err != nil {
        log.Fatalf("error dispensing greeter: %v", err)
    }

    greeter := raw.(shared.Greeter)
    msg, err := greeter.Greet("World")
    if err != nil {
        log.Fatalf("greet error: %v", err)
    }
    fmt.Println(msg) // Hello, World!
}
```

### Upgrading to gRPC Transport

For higher throughput and bidirectional streaming, replace net/rpc with gRPC. Define a `.proto` file:

```proto
syntax = "proto3";
package greeter;
option go_package = "github.com/example/myapp/proto";

service Greeter {
    rpc Greet(GreetRequest) returns (GreetResponse);
}

message GreetRequest { string name = 1; }
message GreetResponse { string greeting = 1; }
```

Generate Go code and implement `GRPCPlugin` instead of the `Plugin` interface:

```go
type GreeterGRPCPlugin struct {
    plugin.Plugin
    Impl Greeter
}

func (p *GreeterGRPCPlugin) GRPCServer(broker *plugin.GRPCBroker, s *grpc.Server) error {
    proto.RegisterGreeterServer(s, &GRPCServer{Impl: p.Impl})
    return nil
}

func (p *GreeterGRPCPlugin) GRPCClient(
    ctx context.Context, broker *plugin.GRPCBroker, c *grpc.ClientConn,
) (interface{}, error) {
    return &GRPCClient{client: proto.NewGreeterClient(c)}, nil
}
```

## Section 2: yaegi — Runtime Go Evaluation

yaegi (Yet Another Go Interpreter) is Traefik's embedded interpreter that evaluates Go source code at runtime. It requires no compilation step and shares the host's type system, making it ideal for configuration-driven logic, dynamic rule evaluation, and operator-supplied scripts.

### Installing yaegi

```bash
go get github.com/traefik/yaegi@v0.16.1
```

### Embedding a Script Engine

```go
package main

import (
    "fmt"
    "log"

    "github.com/traefik/yaegi/interp"
    "github.com/traefik/yaegi/stdlib"
)

const script = `
import "fmt"

func Greet(name string) string {
    return fmt.Sprintf("Greetings, %s!", name)
}
`

func main() {
    i := interp.New(interp.Options{})
    i.Use(stdlib.Symbols) // expose standard library

    _, err := i.Eval(script)
    if err != nil {
        log.Fatalf("eval error: %v", err)
    }

    v, err := i.Eval(`Greet`)
    if err != nil {
        log.Fatalf("symbol error: %v", err)
    }

    greetFn := v.Interface().(func(string) string)
    fmt.Println(greetFn("Enterprise")) // Greetings, Enterprise!
}
```

### Exposing Host Packages to Scripts

yaegi allows scripts to call host application APIs through symbol registration:

```go
package main

import (
    "reflect"

    "github.com/traefik/yaegi/interp"
    "github.com/traefik/yaegi/stdlib"
)

// hostapi is the package scripts will import as "hostapp/api".
package hostapi

var Symbols = map[string]map[string]reflect.Value{
    "hostapp/api/api": {
        "Log": reflect.ValueOf(Log),
    },
}

func Log(msg string) {
    println("[HOST]", msg)
}

// In main:
func setupInterp() *interp.Interpreter {
    i := interp.New(interp.Options{})
    i.Use(stdlib.Symbols)
    i.Use(hostapi.Symbols) // scripts can now import "hostapp/api"
    return i
}
```

### Loading Scripts from Disk with Hot-Reload

```go
package scriptengine

import (
    "crypto/sha256"
    "io"
    "log"
    "os"
    "sync"
    "time"

    "github.com/traefik/yaegi/interp"
    "github.com/traefik/yaegi/stdlib"
)

type Engine struct {
    mu       sync.RWMutex
    interp   *interp.Interpreter
    scriptPath string
    lastHash [32]byte
}

func New(path string) *Engine {
    e := &Engine{scriptPath: path}
    e.reload()
    go e.watchLoop()
    return e
}

func (e *Engine) reload() {
    f, err := os.Open(e.scriptPath)
    if err != nil {
        log.Printf("script open error: %v", err)
        return
    }
    defer f.Close()

    h := sha256.New()
    src, _ := io.ReadAll(io.TeeReader(f, h))
    var hash [32]byte
    copy(hash[:], h.Sum(nil))

    e.mu.Lock()
    defer e.mu.Unlock()
    if hash == e.lastHash {
        return
    }
    i := interp.New(interp.Options{})
    i.Use(stdlib.Symbols)
    if _, err := i.Eval(string(src)); err != nil {
        log.Printf("script eval error: %v", err)
        return
    }
    e.interp = i
    e.lastHash = hash
    log.Printf("script reloaded: %s", e.scriptPath)
}

func (e *Engine) watchLoop() {
    ticker := time.NewTicker(5 * time.Second)
    for range ticker.C {
        e.reload()
    }
}

func (e *Engine) Interp() *interp.Interpreter {
    e.mu.RLock()
    defer e.mu.RUnlock()
    return e.interp
}
```

## Section 3: WebAssembly Plugins with wazero

wazero is a zero-dependency WASM runtime written in pure Go. It runs WebAssembly modules compiled from any language — Go, Rust, C, AssemblyScript — inside the host process with a configurable sandbox. This enables plugins without OS process overhead while maintaining memory isolation between modules.

### Installing wazero

```bash
go get github.com/tetratelabs/wazero@v1.7.3
```

### Compiling a Go Plugin to WASM

```go
// plugin-wasm/main.go — compile with: GOOS=wasip1 GOARCH=wasm go build -o greeter.wasm .
//go:build wasip1

package main

import "fmt"

//export greet
func greet(namePtr uint32, nameLen uint32) uint64 {
    // WASI memory access handled by the host
    _ = namePtr
    _ = nameLen
    return 0
}

func main() {}
```

For production, use TinyGo or the `wasm-bindgen`-style host function approach. A cleaner pattern uses a shared memory region:

```go
// host/wasm_host.go
package main

import (
    "context"
    "fmt"
    "log"
    "os"

    "github.com/tetratelabs/wazero"
    "github.com/tetratelabs/wazero/api"
    "github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

func runWASMPlugin(wasmPath string, input string) string {
    ctx := context.Background()

    // Compilation cache persists compiled modules across instantiations.
    cache := wazero.NewCompilationCache()
    defer cache.Close(ctx)

    rt := wazero.NewRuntimeWithConfig(ctx,
        wazero.NewRuntimeConfig().WithCompilationCache(cache))
    defer rt.Close(ctx)

    // Instantiate WASI support.
    wasi_snapshot_preview1.MustInstantiate(ctx, rt)

    wasmBytes, err := os.ReadFile(wasmPath)
    if err != nil {
        log.Fatalf("read wasm: %v", err)
    }

    mod, err := rt.InstantiateWithConfig(ctx, wasmBytes,
        wazero.NewModuleConfig().
            WithStdin(os.Stdin).
            WithStdout(os.Stdout).
            WithStderr(os.Stderr))
    if err != nil {
        log.Fatalf("instantiate: %v", err)
    }
    defer mod.Close(ctx)

    // Call an exported function.
    fn := mod.ExportedFunction("greet")
    if fn == nil {
        log.Fatal("greet function not exported")
    }

    // Allocate memory in the WASM linear memory and write the input.
    mem := mod.Memory()
    allocFn := mod.ExportedFunction("alloc")
    results, _ := allocFn.Call(ctx, uint64(len(input)))
    ptr := uint32(results[0])
    mem.Write(ptr, []byte(input))

    // Call greet with pointer and length.
    results, err = fn.Call(ctx, uint64(ptr), uint64(len(input)))
    if err != nil {
        log.Fatalf("call greet: %v", err)
    }

    // Read result from WASM memory (ptr encoded in high 32 bits, len in low 32).
    retPtr := uint32(results[0] >> 32)
    retLen := uint32(results[0])
    result, ok := mem.Read(retPtr, retLen)
    if !ok {
        log.Fatal("memory read failed")
    }
    return string(result)
}

func main() {
    result := runWASMPlugin("./greeter.wasm", "World")
    fmt.Println(result)
}
```

### Host Function Registration

wazero allows WASM modules to call back into the host:

```go
// Register a host function "env.log" callable from WASM.
_, err := rt.NewHostModuleBuilder("env").
    NewFunctionBuilder().
    WithFunc(func(ctx context.Context, m api.Module, ptr, len uint32) {
        bytes, _ := m.Memory().Read(ptr, len)
        log.Printf("[WASM plugin]: %s", bytes)
    }).
    Export("log").
    Instantiate(ctx)
if err != nil {
    log.Fatalf("host module: %v", err)
}
```

### WASM Plugin Manager with Hot-Reload

```go
package pluginmanager

import (
    "context"
    "log"
    "os"
    "sync"
    "time"

    "github.com/tetratelabs/wazero"
    "github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

type WASMManager struct {
    mu       sync.RWMutex
    rt       wazero.Runtime
    mod      api.Module
    path     string
    modTime  time.Time
    ctx      context.Context
}

func NewWASMManager(ctx context.Context, path string) (*WASMManager, error) {
    cache := wazero.NewCompilationCache()
    rt := wazero.NewRuntimeWithConfig(ctx,
        wazero.NewRuntimeConfig().WithCompilationCache(cache))
    wasi_snapshot_preview1.MustInstantiate(ctx, rt)

    m := &WASMManager{rt: rt, path: path, ctx: ctx}
    if err := m.load(); err != nil {
        return nil, err
    }
    go m.watchLoop()
    return m, nil
}

func (m *WASMManager) load() error {
    info, err := os.Stat(m.path)
    if err != nil {
        return err
    }
    if !info.ModTime().After(m.modTime) {
        return nil
    }
    wasmBytes, err := os.ReadFile(m.path)
    if err != nil {
        return err
    }
    mod, err := m.rt.InstantiateWithConfig(m.ctx, wasmBytes,
        wazero.NewModuleConfig())
    if err != nil {
        return err
    }
    m.mu.Lock()
    if m.mod != nil {
        m.mod.Close(m.ctx)
    }
    m.mod = mod
    m.modTime = info.ModTime()
    m.mu.Unlock()
    log.Printf("WASM module reloaded: %s", m.path)
    return nil
}

func (m *WASMManager) watchLoop() {
    t := time.NewTicker(10 * time.Second)
    for range t.C {
        if err := m.load(); err != nil {
            log.Printf("WASM reload error: %v", err)
        }
    }
}

func (m *WASMManager) Module() api.Module {
    m.mu.RLock()
    defer m.mu.RUnlock()
    return m.mod
}
```

## Section 4: Choosing the Right Plugin Strategy

The three approaches serve different needs:

| Criterion | go-plugin | yaegi | wazero |
|---|---|---|---|
| Isolation level | OS process | In-process goroutine | WASM sandbox |
| Languages supported | Go only | Go only | Any WASM target |
| Startup overhead | High (fork+exec) | Low | Medium (JIT compile) |
| Hot-reload | Kill + restart | Re-eval script | Close + re-instantiate |
| Memory sharing | Requires serialization | Direct (same heap) | Linear memory only |
| Crash containment | Full (process boundary) | None | Partial (WASM trap) |
| Best for | Untrusted third-party plugins | Operator-supplied scripts | Multi-language ecosystems |

### Plugin Discovery Pattern

Regardless of mechanism, use a registry pattern for plugin discovery:

```go
package registry

import (
    "fmt"
    "sync"
)

type PluginFactory func(config map[string]string) (interface{}, error)

type Registry struct {
    mu      sync.RWMutex
    plugins map[string]PluginFactory
}

var Global = &Registry{plugins: make(map[string]PluginFactory)}

func (r *Registry) Register(name string, factory PluginFactory) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.plugins[name] = factory
}

func (r *Registry) Create(name string, config map[string]string) (interface{}, error) {
    r.mu.RLock()
    factory, ok := r.plugins[name]
    r.mu.RUnlock()
    if !ok {
        return nil, fmt.Errorf("plugin %q not registered", name)
    }
    return factory(config)
}

func (r *Registry) List() []string {
    r.mu.RLock()
    defer r.mu.RUnlock()
    names := make([]string, 0, len(r.plugins))
    for name := range r.plugins {
        names = append(names, name)
    }
    return names
}
```

## Section 5: Production Patterns and Operational Concerns

### Version Negotiation

Always embed version negotiation to handle plugin/host mismatches gracefully:

```go
type VersionedPlugin interface {
    Version() (major, minor int)
    Capabilities() []string
}

func negotiate(host, plugin VersionedPlugin) error {
    hMaj, hMin := host.Version()
    pMaj, pMin := plugin.Version()
    if pMaj != hMaj {
        return fmt.Errorf("major version mismatch: host=%d plugin=%d", hMaj, pMaj)
    }
    if pMin > hMin {
        return fmt.Errorf("plugin minor version %d exceeds host %d", pMin, hMin)
    }
    return nil
}
```

### Metrics and Observability

Wrap plugin calls with Prometheus instrumentation:

```go
package pluginmetrics

import (
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    pluginCalls = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "plugin_calls_total",
        Help: "Total plugin invocations by name and status.",
    }, []string{"plugin", "method", "status"})

    pluginLatency = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "plugin_call_duration_seconds",
        Help:    "Plugin call latency.",
        Buckets: prometheus.DefBuckets,
    }, []string{"plugin", "method"})
)

func Record(plugin, method string, start time.Time, err error) {
    status := "ok"
    if err != nil {
        status = "error"
    }
    pluginCalls.WithLabelValues(plugin, method, status).Inc()
    pluginLatency.WithLabelValues(plugin, method).Observe(
        time.Since(start).Seconds())
}
```

### Security Considerations

- For go-plugin, validate plugin binaries with SHA-256 checksums before execution
- For yaegi, restrict imported packages with a custom `Use` symbol set that excludes `os/exec`, `net`, and `syscall`
- For wazero, enable WASI filesystem sandboxing using `WithFSConfig` to restrict file access to a designated plugin directory

```go
// Restrict WASM plugin file access to /plugins/data only.
fsConfig := wazero.NewFSConfig().
    WithDirMount("/plugins/data", "/data")

mod, err := rt.InstantiateWithConfig(ctx, wasmBytes,
    wazero.NewModuleConfig().WithFSConfig(fsConfig))
```

Building a plugin system into your Go application from day one costs far less than retrofitting it later. The go-plugin model dominates when you need third-party extensibility with strong isolation guarantees. yaegi excels for internal operator scripts where startup latency matters. wazero is the path forward for polyglot ecosystems where plugins may be written in Rust, C, or AssemblyScript alongside Go.
