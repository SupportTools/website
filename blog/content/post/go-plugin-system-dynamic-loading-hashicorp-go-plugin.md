---
title: "Go Plugin System: Dynamic Loading with hashicorp/go-plugin and Native Plugins"
date: 2030-11-25T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Plugins", "hashicorp/go-plugin", "gRPC", "Dynamic Loading", "Extensibility", "CLI"]
categories:
- Go
- Development
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go plugin systems covering hashicorp/go-plugin architecture with gRPC-based plugin communication, native Go .so plugin limitations, versioning strategies, and practical patterns for building extensible CLI tools and service platforms."
more_link: "yes"
url: "/go-plugin-system-dynamic-loading-hashicorp-go-plugin/"
---

Building extensible software in Go requires careful architectural decisions. Native Go plugins (`.so` files via `plugin.Open`) offer zero-overhead dynamic loading but carry severe constraints: plugins must be compiled with the same Go version and dependencies as the host, and they share the same process memory space. The `hashicorp/go-plugin` library takes a fundamentally different approach — each plugin runs as a separate process, communicating via gRPC or net/rpc over a local socket. This process isolation model trades some performance for reliability, security, and practical deployability.

This guide covers both approaches in depth: the native plugin system for constrained environments where its limitations are acceptable, and hashicorp/go-plugin for production-grade plugin architectures. We will build a complete extensible CLI tool that loads scanner plugins for a hypothetical security audit framework.

<!--more-->

# Go Plugin System: Dynamic Loading with hashicorp/go-plugin and Native Plugins

## Section 1: Native Go Plugins — Capabilities and Constraints

The native `plugin` package in Go supports loading `.so` shared objects at runtime. A plugin is any Go package compiled with `go build -buildmode=plugin`.

### Native Plugin Constraints

These constraints make native plugins impractical for most production use cases:

1. **Go version lock**: The plugin must be compiled with exactly the same Go version as the host binary
2. **Shared module lock**: All modules used by both plugin and host must be at identical versions
3. **Linux/macOS only**: Windows is not supported
4. **No plugin unloading**: Once loaded, a plugin cannot be unloaded
5. **Interface incompatibility**: Interface changes break plugins without a clear error message
6. **CGo dependency**: The plugin system requires CGo, complicating cross-compilation

### When Native Plugins Are Appropriate

- Tight performance requirements (function calls vs. gRPC round trips)
- Controlled deployment where the build environment is fully managed
- Single-vendor plugin ecosystem (e.g., internal corporate tools)
- Read-only plugins (plugins that cannot crash the host process safely anyway)

### Basic Native Plugin Example

```go
// plugins/greeter/main.go
package main

// Greeter is the exported symbol the host will look up
type Greeter interface {
    Greet(name string) string
    Version() string
}

type englishGreeter struct{}

func (g englishGreeter) Greet(name string) string {
    return "Hello, " + name + "!"
}

func (g englishGreeter) Version() string {
    return "1.0.0"
}

// Plugin must export a symbol of the expected type
// The variable name is used by plugin.Lookup
var GreeterPlugin Greeter = englishGreeter{}
```

```bash
# Build the plugin
go build -buildmode=plugin -o plugins/greeter.so ./plugins/greeter/
```

```go
// host/main.go
package main

import (
    "fmt"
    "plugin"
)

type Greeter interface {
    Greet(name string) string
    Version() string
}

func main() {
    // Load the plugin
    p, err := plugin.Open("plugins/greeter.so")
    if err != nil {
        panic(fmt.Sprintf("open plugin: %v", err))
    }

    // Look up the exported symbol
    sym, err := p.Lookup("GreeterPlugin")
    if err != nil {
        panic(fmt.Sprintf("lookup symbol: %v", err))
    }

    // Type assertion - note: sym is a *Greeter, not Greeter
    greeter, ok := sym.(*Greeter)
    if !ok {
        panic("unexpected type from module symbol")
    }

    fmt.Println((*greeter).Greet("World"))
    fmt.Println((*greeter).Version())
}
```

## Section 2: hashicorp/go-plugin Architecture

The hashicorp/go-plugin library solves the native plugin constraints by using OS processes as the isolation boundary. Each plugin is a separate executable that:

1. Starts as a child process launched by the host
2. Listens on a Unix socket or TCP port
3. Communicates with the host via gRPC (recommended) or net/rpc
4. Is health-checked by the host via a keepalive protocol
5. Can be killed and restarted independently of the host

```
Host Process                    Plugin Process
─────────────────────────────   ─────────────────────────────
plugin.Client                   plugin.Server
  │                               │
  ├─ exec(plugin-binary)─────────▶│
  │                               ├─ listens on Unix socket
  │◀──────── ready signal ────────│
  │                               │
  ├─ gRPC client ─────────────────┼─▶ gRPC server
  │     (GetUser request)         │    (GRPCPlugin.GRPCServer())
  │◀─────────────────────────────┤
  │     (GetUser response)        │
  │                               │
  ├─ health check (keepalive) ───▶│
  └─ Kill()                       └─ exits
```

### Core Concepts

**PluginMap**: Maps string names to plugin implementations. Used by both host (to load) and plugin binary (to serve).

**Plugin interface**: Each plugin type implements either `GRPCPlugin` (recommended) or `Plugin` (for net/rpc) interface.

**Handshake**: A shared configuration struct that prevents accidental loading of incompatible plugins.

## Section 3: Building an Extensible Security Scanner with go-plugin

We will build a security scanning framework where scanners are plugins. The host binary orchestrates scanning and collects results; each scanner plugin implements a specific check.

### Project Structure

```
security-scanner/
├── cmd/
│   ├── host/
│   │   └── main.go           # Host application
│   └── plugins/
│       ├── port-scanner/
│       │   └── main.go       # Port scanner plugin
│       └── ssl-checker/
│           └── main.go       # SSL certificate checker plugin
├── pkg/
│   └── scanner/
│       ├── interface.go      # Shared interface definitions
│       ├── grpc.go           # gRPC implementation of the plugin
│       └── proto/
│           ├── scanner.proto
│           └── scanner.pb.go # Generated
├── go.mod
└── go.sum
```

### Step 1: Define the Plugin Interface

```go
// pkg/scanner/interface.go
package scanner

import (
    "context"

    hcplugin "github.com/hashicorp/go-plugin"
)

// Finding represents a single scan result
type Finding struct {
    Severity    string
    Title       string
    Description string
    Target      string
    Remediation string
    Evidence    map[string]string
}

// ScanRequest is the input to a scan operation
type ScanRequest struct {
    Target  string
    Options map[string]string
    Timeout int64 // seconds
}

// ScanResult is the output from a scan operation
type ScanResult struct {
    PluginName string
    Version    string
    Findings   []Finding
    Error      string
    Duration   int64 // milliseconds
}

// PluginInfo describes a plugin's capabilities
type PluginInfo struct {
    Name         string
    Version      string
    Description  string
    Author       string
    Capabilities []string
}

// Scanner is the interface that all scanner plugins must implement
type Scanner interface {
    Info() (*PluginInfo, error)
    Scan(ctx context.Context, req *ScanRequest) (*ScanResult, error)
}

// Handshake prevents accidental loading of incompatible plugins
var Handshake = hcplugin.HandshakeConfig{
    ProtocolVersion:  1,
    MagicCookieKey:   "SCANNER_PLUGIN",
    MagicCookieValue: "security-scanner-v1",
}

// PluginMap maps plugin names to implementations
var PluginMap = map[string]hcplugin.Plugin{
    "scanner": &GRPCPlugin{},
}
```

### Step 2: Implement the gRPC Plugin Bridge

```protobuf
// pkg/scanner/proto/scanner.proto
syntax = "proto3";
package scanner;
option go_package = "github.com/example/security-scanner/pkg/scanner/proto";

service ScannerPlugin {
    rpc Info(InfoRequest) returns (InfoResponse);
    rpc Scan(ScanRequest) returns (ScanResponse);
}

message InfoRequest {}

message InfoResponse {
    string name = 1;
    string version = 2;
    string description = 3;
    string author = 4;
    repeated string capabilities = 5;
}

message ScanRequest {
    string target = 1;
    map<string, string> options = 2;
    int64 timeout = 3;
}

message Finding {
    string severity = 1;
    string title = 2;
    string description = 3;
    string target = 4;
    string remediation = 5;
    map<string, string> evidence = 6;
}

message ScanResponse {
    string plugin_name = 1;
    string version = 2;
    repeated Finding findings = 3;
    string error = 4;
    int64 duration_ms = 5;
}
```

```go
// pkg/scanner/grpc.go
package scanner

import (
    "context"
    "time"

    hcplugin "github.com/hashicorp/go-plugin"
    "google.golang.org/grpc"

    proto "github.com/example/security-scanner/pkg/scanner/proto"
)

// GRPCPlugin implements the go-plugin Plugin interface for our Scanner
type GRPCPlugin struct {
    hcplugin.Plugin
    Impl Scanner
}

func (p *GRPCPlugin) GRPCServer(broker *hcplugin.GRPCBroker, s *grpc.Server) error {
    proto.RegisterScannerPluginServer(s, &grpcServer{impl: p.Impl})
    return nil
}

func (p *GRPCPlugin) GRPCClient(
    ctx context.Context,
    broker *hcplugin.GRPCBroker,
    c *grpc.ClientConn,
) (interface{}, error) {
    return &grpcClient{client: proto.NewScannerPluginClient(c)}, nil
}

type grpcServer struct {
    proto.UnimplementedScannerPluginServer
    impl Scanner
}

func (s *grpcServer) Info(
    ctx context.Context,
    req *proto.InfoRequest,
) (*proto.InfoResponse, error) {
    info, err := s.impl.Info()
    if err != nil {
        return nil, err
    }
    return &proto.InfoResponse{
        Name:         info.Name,
        Version:      info.Version,
        Description:  info.Description,
        Author:       info.Author,
        Capabilities: info.Capabilities,
    }, nil
}

func (s *grpcServer) Scan(
    ctx context.Context,
    req *proto.ScanRequest,
) (*proto.ScanResponse, error) {
    start := time.Now()

    result, err := s.impl.Scan(ctx, &ScanRequest{
        Target:  req.Target,
        Options: req.Options,
        Timeout: req.Timeout,
    })
    if err != nil {
        return &proto.ScanResponse{
            Error:      err.Error(),
            DurationMs: time.Since(start).Milliseconds(),
        }, nil
    }

    resp := &proto.ScanResponse{
        PluginName: result.PluginName,
        Version:    result.Version,
        DurationMs: result.Duration,
    }

    for _, f := range result.Findings {
        resp.Findings = append(resp.Findings, &proto.Finding{
            Severity:    f.Severity,
            Title:       f.Title,
            Description: f.Description,
            Target:      f.Target,
            Remediation: f.Remediation,
            Evidence:    f.Evidence,
        })
    }

    return resp, nil
}

type grpcClient struct {
    client proto.ScannerPluginClient
}

func (c *grpcClient) Info() (*PluginInfo, error) {
    resp, err := c.client.Info(context.Background(), &proto.InfoRequest{})
    if err != nil {
        return nil, err
    }
    return &PluginInfo{
        Name:         resp.Name,
        Version:      resp.Version,
        Description:  resp.Description,
        Author:       resp.Author,
        Capabilities: resp.Capabilities,
    }, nil
}

func (c *grpcClient) Scan(ctx context.Context, req *ScanRequest) (*ScanResult, error) {
    resp, err := c.client.Scan(ctx, &proto.ScanRequest{
        Target:  req.Target,
        Options: req.Options,
        Timeout: req.Timeout,
    })
    if err != nil {
        return nil, err
    }

    result := &ScanResult{
        PluginName: resp.PluginName,
        Version:    resp.Version,
        Duration:   resp.DurationMs,
        Error:      resp.Error,
    }

    for _, f := range resp.Findings {
        result.Findings = append(result.Findings, Finding{
            Severity:    f.Severity,
            Title:       f.Title,
            Description: f.Description,
            Target:      f.Target,
            Remediation: f.Remediation,
            Evidence:    f.Evidence,
        })
    }

    return result, nil
}
```

### Step 3: Implement the Port Scanner Plugin

```go
// cmd/plugins/port-scanner/main.go
package main

import (
    "context"
    "fmt"
    "net"
    "sync"
    "time"

    hcplugin "github.com/hashicorp/go-plugin"
    "github.com/example/security-scanner/pkg/scanner"
)

type PortScanner struct{}

func (p *PortScanner) Info() (*scanner.PluginInfo, error) {
    return &scanner.PluginInfo{
        Name:         "port-scanner",
        Version:      "1.2.0",
        Description:  "TCP port scanner with service detection",
        Author:       "Security Team",
        Capabilities: []string{"port-scan", "service-detection"},
    }, nil
}

func (p *PortScanner) Scan(
    ctx context.Context,
    req *scanner.ScanRequest,
) (*scanner.ScanResult, error) {
    start := time.Now()
    result := &scanner.ScanResult{
        PluginName: "port-scanner",
        Version:    "1.2.0",
    }

    startPort := 1
    endPort := 1024

    if v, ok := req.Options["start_port"]; ok {
        fmt.Sscanf(v, "%d", &startPort)
    }
    if v, ok := req.Options["end_port"]; ok {
        fmt.Sscanf(v, "%d", &endPort)
    }

    dangerousPorts := map[int]string{
        21:    "FTP",
        23:    "Telnet",
        135:   "RPC",
        139:   "NetBIOS",
        445:   "SMB",
        1433:  "MSSQL",
        3306:  "MySQL",
        3389:  "RDP",
        5432:  "PostgreSQL",
        6379:  "Redis",
        27017: "MongoDB",
    }

    openPorts := p.scanPorts(ctx, req.Target, startPort, endPort, 100)

    for _, port := range openPorts {
        severity := "info"
        description := fmt.Sprintf("Port %d is open", port)

        if service, isDangerous := dangerousPorts[port]; isDangerous {
            severity = "medium"
            description = fmt.Sprintf("Port %d (%s) is open and potentially exposed",
                port, service)
        }

        if port == 23 || port == 21 {
            severity = "high"
            description = fmt.Sprintf("Port %d (%s) is open — uses unencrypted protocol",
                port, dangerousPorts[port])
        }

        result.Findings = append(result.Findings, scanner.Finding{
            Severity:    severity,
            Title:       fmt.Sprintf("Open Port: %d", port),
            Description: description,
            Target:      fmt.Sprintf("%s:%d", req.Target, port),
            Remediation: "Verify this port should be accessible. Apply firewall rules if not required.",
            Evidence: map[string]string{
                "port":  fmt.Sprintf("%d", port),
                "state": "open",
            },
        })
    }

    result.Duration = time.Since(start).Milliseconds()
    return result, nil
}

func (p *PortScanner) scanPorts(
    ctx context.Context,
    host string,
    start, end, concurrency int,
) []int {
    type result struct {
        port int
        open bool
    }

    ports := make(chan int, concurrency)
    results := make(chan result, end-start+1)
    var wg sync.WaitGroup

    for i := 0; i < concurrency; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for port := range ports {
                addr := fmt.Sprintf("%s:%d", host, port)
                conn, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
                if err == nil {
                    conn.Close()
                    results <- result{port: port, open: true}
                } else {
                    results <- result{port: port, open: false}
                }
            }
        }()
    }

    go func() {
        for port := start; port <= end; port++ {
            select {
            case <-ctx.Done():
                close(ports)
                return
            default:
                ports <- port
            }
        }
        close(ports)
        wg.Wait()
        close(results)
    }()

    var openPorts []int
    for r := range results {
        if r.open {
            openPorts = append(openPorts, r.port)
        }
    }

    return openPorts
}

func main() {
    hcplugin.Serve(&hcplugin.ServeConfig{
        HandshakeConfig: scanner.Handshake,
        Plugins: map[string]hcplugin.Plugin{
            "scanner": &scanner.GRPCPlugin{Impl: &PortScanner{}},
        },
        GRPCServer: hcplugin.DefaultGRPCServer,
    })
}
```

### Step 4: The Host Application

```go
// cmd/host/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "os"
    "os/exec"
    "path/filepath"
    "strings"
    "time"

    hcplugin "github.com/hashicorp/go-plugin"
    "go.uber.org/zap"

    "github.com/example/security-scanner/pkg/scanner"
)

type loadedPlugin struct {
    client  *hcplugin.Client
    scanner scanner.Scanner
    info    *scanner.PluginInfo
}

type PluginRegistry struct {
    logger  *zap.Logger
    plugins map[string]*loadedPlugin
}

func NewPluginRegistry(logger *zap.Logger) *PluginRegistry {
    return &PluginRegistry{
        logger:  logger,
        plugins: make(map[string]*loadedPlugin),
    }
}

func (r *PluginRegistry) LoadPlugin(pluginPath string) error {
    r.logger.Info("loading plugin", zap.String("path", pluginPath))

    client := hcplugin.NewClient(&hcplugin.ClientConfig{
        HandshakeConfig: scanner.Handshake,
        Plugins:         scanner.PluginMap,
        Cmd:             exec.Command(pluginPath), // #nosec G204 - path validated before call
        AllowedProtocols: []hcplugin.Protocol{
            hcplugin.ProtocolGRPC,
        },
        AutoMTLS: true,
    })

    rpcClient, err := client.Client()
    if err != nil {
        client.Kill()
        return fmt.Errorf("start plugin: %w", err)
    }

    raw, err := rpcClient.Dispense("scanner")
    if err != nil {
        client.Kill()
        return fmt.Errorf("dispense plugin: %w", err)
    }

    scannerPlugin, ok := raw.(scanner.Scanner)
    if !ok {
        client.Kill()
        return fmt.Errorf("plugin does not implement Scanner interface")
    }

    pluginInfo, err := scannerPlugin.Info()
    if err != nil {
        client.Kill()
        return fmt.Errorf("get plugin info: %w", err)
    }

    r.plugins[pluginInfo.Name] = &loadedPlugin{
        client:  client,
        scanner: scannerPlugin,
        info:    pluginInfo,
    }

    r.logger.Info("plugin loaded",
        zap.String("name", pluginInfo.Name),
        zap.String("version", pluginInfo.Version),
    )

    return nil
}

func (r *PluginRegistry) LoadPluginDir(dir string) error {
    entries, err := os.ReadDir(dir)
    if err != nil {
        return fmt.Errorf("read plugin dir: %w", err)
    }

    for _, entry := range entries {
        if entry.IsDir() {
            continue
        }
        if !strings.HasPrefix(entry.Name(), "scanner-") {
            continue
        }
        pluginPath := filepath.Join(dir, entry.Name())
        if err := r.LoadPlugin(pluginPath); err != nil {
            r.logger.Warn("failed to load plugin",
                zap.String("path", pluginPath),
                zap.Error(err),
            )
        }
    }

    return nil
}

func (r *PluginRegistry) RunScan(
    ctx context.Context,
    target string,
    options map[string]string,
) ([]*scanner.ScanResult, error) {
    var results []*scanner.ScanResult

    for name, p := range r.plugins {
        r.logger.Info("running scanner",
            zap.String("plugin", name),
            zap.String("target", target),
        )

        scanCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
        result, err := p.scanner.Scan(scanCtx, &scanner.ScanRequest{
            Target:  target,
            Options: options,
            Timeout: 300,
        })
        cancel()

        if err != nil {
            r.logger.Error("scanner failed",
                zap.String("plugin", name),
                zap.Error(err),
            )
            results = append(results, &scanner.ScanResult{
                PluginName: name,
                Error:      err.Error(),
            })
            continue
        }

        results = append(results, result)
    }

    return results, nil
}

func (r *PluginRegistry) Close() {
    for name, p := range r.plugins {
        r.logger.Info("killing plugin", zap.String("name", name))
        p.client.Kill()
    }
}

func main() {
    logger, _ := zap.NewProduction()
    defer logger.Sync()

    if len(os.Args) < 2 {
        fmt.Fprintf(os.Stderr, "Usage: %s <target> [plugin-dir]\n", os.Args[0])
        os.Exit(1)
    }

    target := os.Args[1]
    pluginDir := "./plugins"
    if len(os.Args) > 2 {
        pluginDir = os.Args[2]
    }

    registry := NewPluginRegistry(logger)
    defer registry.Close()

    if err := registry.LoadPluginDir(pluginDir); err != nil {
        logger.Fatal("load plugins", zap.Error(err))
    }

    ctx := context.Background()
    results, err := registry.RunScan(ctx, target, map[string]string{
        "start_port": "1",
        "end_port":   "10000",
    })
    if err != nil {
        logger.Fatal("run scan", zap.Error(err))
    }

    output := map[string]interface{}{
        "target":  target,
        "results": results,
    }

    enc := json.NewEncoder(os.Stdout)
    enc.SetIndent("", "  ")
    enc.Encode(output)
}
```

## Section 5: Plugin Versioning Strategy

```go
// pkg/scanner/version.go
package scanner

import (
    "fmt"
    "strconv"
    "strings"
)

type Version struct {
    Major int
    Minor int
    Patch int
}

func ParseVersion(s string) (Version, error) {
    parts := strings.Split(s, ".")
    if len(parts) != 3 {
        return Version{}, fmt.Errorf("invalid version: %s", s)
    }

    var v Version
    var err error
    if v.Major, err = strconv.Atoi(parts[0]); err != nil {
        return Version{}, fmt.Errorf("invalid major version: %s", parts[0])
    }
    if v.Minor, err = strconv.Atoi(parts[1]); err != nil {
        return Version{}, fmt.Errorf("invalid minor version: %s", parts[1])
    }
    if v.Patch, err = strconv.Atoi(parts[2]); err != nil {
        return Version{}, fmt.Errorf("invalid patch version: %s", parts[2])
    }

    return v, nil
}

// IsCompatible returns true if the plugin version is compatible with the host.
// Rule: same major version, plugin minor <= host minor.
func (host Version) IsCompatible(pluginVer Version) bool {
    if host.Major != pluginVer.Major {
        return false
    }
    return pluginVer.Minor <= host.Minor
}
```

### Backward-Compatible Interface Evolution

```go
// pkg/scanner/v2/interface.go
// v2 adds streaming; v1 plugins remain loadable without recompilation

package scannerv2

import (
    "context"

    v1 "github.com/example/security-scanner/pkg/scanner"
)

// ScannerV2 extends v1 with streaming capabilities
type ScannerV2 interface {
    v1.Scanner
    ScanStream(ctx context.Context, req *v1.ScanRequest, out chan<- *v1.Finding) error
}

// WrapAsV1 makes a ScannerV2 usable where only v1 is expected
func WrapAsV1(s ScannerV2) v1.Scanner {
    return &v2AsV1{inner: s}
}

type v2AsV1 struct{ inner ScannerV2 }

func (a *v2AsV1) Info() (*v1.PluginInfo, error) { return a.inner.Info() }
func (a *v2AsV1) Scan(ctx context.Context, req *v1.ScanRequest) (*v1.ScanResult, error) {
    return a.inner.Scan(ctx, req)
}
```

## Section 6: Plugin Security Hardening

```go
// pkg/scanner/security.go
package scanner

import (
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "io"
    "os"
)

// VerifyChecksum computes the SHA-256 of a file and compares to expected.
// Use this before loading any plugin binary to detect tampering.
func VerifyChecksum(path, expectedHex string) error {
    f, err := os.Open(path)
    if err != nil {
        return fmt.Errorf("open plugin binary: %w", err)
    }
    defer f.Close()

    h := sha256.New()
    if _, err := io.Copy(h, f); err != nil {
        return fmt.Errorf("hash plugin binary: %w", err)
    }

    actual := hex.EncodeToString(h.Sum(nil))
    if actual != expectedHex {
        return fmt.Errorf("checksum mismatch: expected %s got %s", expectedHex, actual)
    }

    return nil
}
```

```go
// Plugin manifest for secure distribution
type PluginManifestEntry struct {
    Name        string `json:"name"`
    Version     string `json:"version"`
    SHA256      string `json:"sha256"`
    DownloadURL string `json:"download_url"`
}

// Before loading, verify integrity:
func (r *PluginRegistry) LoadVerifiedPlugin(
    entry PluginManifestEntry,
    pluginPath string,
) error {
    if err := VerifyChecksum(pluginPath, entry.SHA256); err != nil {
        return fmt.Errorf("plugin integrity check failed: %w", err)
    }
    return r.LoadPlugin(pluginPath)
}
```

## Section 7: Testing Plugin Implementations

```go
// pkg/scanner/testkit/suite.go
package testkit

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"

    "github.com/example/security-scanner/pkg/scanner"
)

// ScannerTestSuite provides a standard compliance test for Scanner implementations
type ScannerTestSuite struct {
    Scanner scanner.Scanner
    Target  string // e.g., "127.0.0.1" for local tests
}

func (s *ScannerTestSuite) Run(t *testing.T) {
    t.Helper()

    t.Run("Info returns valid metadata", func(t *testing.T) {
        info, err := s.Scanner.Info()
        require.NoError(t, err)
        require.NotNil(t, info)
        assert.NotEmpty(t, info.Name, "Name must not be empty")
        assert.NotEmpty(t, info.Version, "Version must not be empty")
        assert.NotEmpty(t, info.Description, "Description must not be empty")
        assert.NotEmpty(t, info.Capabilities, "Capabilities must not be empty")
    })

    t.Run("Scan returns result with plugin metadata", func(t *testing.T) {
        ctx := context.Background()
        result, err := s.Scanner.Scan(ctx, &scanner.ScanRequest{
            Target:  s.Target,
            Options: map[string]string{},
            Timeout: 30,
        })
        require.NoError(t, err)
        require.NotNil(t, result)
        assert.NotEmpty(t, result.PluginName)
        assert.GreaterOrEqual(t, result.Duration, int64(0))
    })

    t.Run("Each finding has required fields", func(t *testing.T) {
        ctx := context.Background()
        result, err := s.Scanner.Scan(ctx, &scanner.ScanRequest{
            Target:  s.Target,
            Options: map[string]string{},
            Timeout: 30,
        })
        require.NoError(t, err)

        for i, f := range result.Findings {
            assert.NotEmpty(t, f.Severity, "Finding %d: Severity must not be empty", i)
            assert.NotEmpty(t, f.Title, "Finding %d: Title must not be empty", i)
            assert.Contains(t,
                []string{"critical", "high", "medium", "low", "info"},
                f.Severity,
                "Finding %d: Severity must be one of critical/high/medium/low/info", i,
            )
        }
    })
}
```

## Section 8: Build and Distribution

```makefile
# Makefile
.PHONY: build-host build-plugins install-plugins

PLUGIN_NAMES := port-scanner ssl-checker
PLUGIN_DIR   := ./dist/plugins
BINARY_DIR   := ./dist

build-host:
	go build -o $(BINARY_DIR)/security-scanner ./cmd/host/

build-plugins: $(PLUGIN_NAMES:%=build-plugin-%)

build-plugin-%:
	go build \
	    -ldflags="-s -w" \
	    -o $(PLUGIN_DIR)/scanner-$* \
	    ./cmd/plugins/$*/

install-plugins: build-plugins
	install -d ~/.security-scanner/plugins
	install -m 755 $(PLUGIN_DIR)/scanner-* ~/.security-scanner/plugins/

generate-checksums:
	@for f in $(PLUGIN_DIR)/scanner-*; do \
	    sha256sum "$$f" >> $(PLUGIN_DIR)/checksums.sha256; \
	done

release: build-host build-plugins generate-checksums
	tar -czf security-scanner-$(VERSION)-linux-amd64.tar.gz \
	    -C dist . \
	    --transform 's|^|security-scanner-$(VERSION)/|'
```

## Conclusion

The `hashicorp/go-plugin` library provides the right foundation for production plugin systems in Go. Its process-isolation model eliminates the build-time constraints of native plugins, enables independent versioning and deployment of plugins, and provides strong reliability guarantees — a crashing plugin process does not crash the host.

Key design decisions for production plugin systems:
- Use gRPC as the transport (not the older net/rpc); it provides better error handling, context propagation, and proto-based evolution
- Enable `AutoMTLS` to encrypt communication between host and plugin processes
- Implement checksum verification before loading any plugin binary to prevent supply chain attacks
- Version your plugin protocol separately from plugin binaries using `HandshakeConfig.ProtocolVersion`
- Design interfaces for backward compatibility from the start — evolve via embedding rather than modification
- Test plugin implementations with a compliance test suite to ensure all implementations behave consistently
- Use a plugin manifest with checksums for secure, auditable plugin distribution
