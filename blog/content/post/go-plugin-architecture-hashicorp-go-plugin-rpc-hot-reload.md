---
title: "Go Plugin Architecture: Building Extensible Systems with Hashicorp go-plugin, RPC Plugins, and Hot Reload"
date: 2031-10-27T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Plugins", "go-plugin", "Hashicorp", "RPC", "Architecture", "Hot Reload"]
categories:
- Go
- Architecture
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to building extensible Go applications using native Go plugins and Hashicorp go-plugin: implementing RPC-based plugin systems, version negotiation, hot reload, and production-grade plugin lifecycle management."
more_link: "yes"
url: "/go-plugin-architecture-hashicorp-go-plugin-rpc-hot-reload/"
---

Building extensible enterprise applications in Go requires careful consideration of the plugin model. Native Go plugins offer in-process execution speed, while Hashicorp's go-plugin library provides process isolation and language-agnostic interfaces via gRPC. This guide covers both approaches in depth, with practical examples for implementing hot reload, version negotiation, and robust plugin lifecycle management suitable for production systems.

<!--more-->

# Go Plugin Architecture: RPC Plugins, Hot Reload, and Versioning

## Why Plugin Architecture Matters

Enterprise applications frequently need to extend functionality without recompiling the core binary. Common use cases include:

- **Authentication providers**: LDAP, SAML, custom SSO implementations
- **Storage backends**: Different databases or object stores behind a common interface
- **Notification handlers**: Slack, PagerDuty, email, custom webhooks
- **Data transformers**: Proprietary format converters, encryption modules
- **Policy engines**: Custom authorization logic per tenant

Two primary approaches exist in Go: native `plugin` package and Hashicorp's `go-plugin`.

## Native Go Plugin Package

### Limitations to Understand First

Native Go plugins have significant constraints that make them unsuitable for many production use cases:

- Plugins must be compiled with the **exact same Go toolchain version** as the host
- All dependencies must match at the module level (same import paths, same versions)
- Plugins cannot be unloaded once loaded (memory leak potential)
- Only supported on Linux, FreeBSD, and macOS with CGO enabled
- Shared global state between host and plugins

Despite these limitations, they excel when you control the entire build pipeline.

### Basic Native Plugin Structure

```go
// plugins/greeter/greeter.go
package main

import (
    "fmt"
    "strings"
)

// Exported symbol - must be capitalized
var Plugin greeterPlugin

type greeterPlugin struct{}

// GreetFunc defines the function signature plugins must implement
type GreetFunc func(name string) string

func (g greeterPlugin) Greet(name string) string {
    return fmt.Sprintf("Hello, %s! (from native plugin)", strings.Title(name))
}

// Version for compatibility checking
var PluginVersion = "1.0.0"
var PluginAPIVersion = 1
```

Build the plugin:

```bash
go build -buildmode=plugin -o plugins/greeter.so ./plugins/greeter/
```

### Native Plugin Loader with Version Checking

```go
// internal/pluginmgr/loader.go
package pluginmgr

import (
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "io"
    "os"
    "plugin"
    "sync"
    "sync/atomic"
    "time"
)

const RequiredAPIVersion = 1

type LoadedPlugin struct {
    Path       string
    Checksum   string
    LoadedAt   time.Time
    APIVersion int
    handle     *plugin.Plugin
}

type PluginManager struct {
    mu      sync.RWMutex
    plugins map[string]*LoadedPlugin
}

func NewPluginManager() *PluginManager {
    return &PluginManager{
        plugins: make(map[string]*LoadedPlugin),
    }
}

func (pm *PluginManager) Load(name, path string) error {
    checksum, err := fileChecksum(path)
    if err != nil {
        return fmt.Errorf("checksum failed for %s: %w", path, err)
    }

    pm.mu.Lock()
    defer pm.mu.Unlock()

    // Skip reload if checksum unchanged
    if existing, ok := pm.plugins[name]; ok {
        if existing.Checksum == checksum {
            return nil
        }
    }

    p, err := plugin.Open(path)
    if err != nil {
        return fmt.Errorf("failed to open plugin %s: %w", path, err)
    }

    // Verify API version compatibility
    apiVerSym, err := p.Lookup("PluginAPIVersion")
    if err != nil {
        return fmt.Errorf("plugin %s missing PluginAPIVersion symbol", name)
    }
    apiVer, ok := apiVerSym.(*int)
    if !ok {
        return fmt.Errorf("plugin %s PluginAPIVersion has wrong type", name)
    }
    if *apiVer != RequiredAPIVersion {
        return fmt.Errorf("plugin %s API version %d incompatible with required %d",
            name, *apiVer, RequiredAPIVersion)
    }

    pm.plugins[name] = &LoadedPlugin{
        Path:       path,
        Checksum:   checksum,
        LoadedAt:   time.Now(),
        APIVersion: *apiVer,
        handle:     p,
    }

    return nil
}

func (pm *PluginManager) Lookup(name, symbol string) (plugin.Symbol, error) {
    pm.mu.RLock()
    p, ok := pm.plugins[name]
    pm.mu.RUnlock()

    if !ok {
        return nil, fmt.Errorf("plugin %s not loaded", name)
    }

    return p.handle.Lookup(symbol)
}

func fileChecksum(path string) (string, error) {
    f, err := os.Open(path)
    if err != nil {
        return "", err
    }
    defer f.Close()

    h := sha256.New()
    if _, err := io.Copy(h, f); err != nil {
        return "", err
    }
    return hex.EncodeToString(h.Sum(nil)), nil
}

// WatchAndReload watches plugin files and triggers reload callbacks
// Note: native plugins cannot be unloaded, so this is for initial load
// and informational purposes only
func (pm *PluginManager) WatchAndReload(paths map[string]string, onChange func(name string)) {
    ticker := time.NewTicker(30 * time.Second)
    checksums := make(map[string]string)

    go func() {
        for range ticker.C {
            for name, path := range paths {
                cs, err := fileChecksum(path)
                if err != nil {
                    continue
                }
                if prev, ok := checksums[name]; ok && prev != cs {
                    onChange(name)
                }
                checksums[name] = cs
            }
        }
    }()
}
```

## Hashicorp go-plugin: Process-Isolated Plugins

Hashicorp's go-plugin library is used by Terraform, Vault, Packer, and other major tools. It solves the native plugin limitations by running plugins as separate processes communicating via gRPC or net/rpc.

### Why go-plugin for Enterprise Use

- **Process isolation**: Plugin crashes do not affect the host
- **Language agnostic**: Plugins can be written in any language with gRPC support
- **Hot reload**: Restart individual plugin processes without restarting the host
- **Version negotiation**: Protocol versioning between host and plugin
- **Security**: Plugin processes can run with reduced privileges
- **Debugging**: Plugins are separate processes and can be debugged independently

### Project Structure

```
myapp/
├── cmd/
│   ├── myapp/
│   │   └── main.go
│   └── plugins/
│       ├── auth-ldap/
│       │   └── main.go
│       └── auth-saml/
│           └── main.go
├── internal/
│   └── plugin/
│       ├── interface.go
│       ├── grpc.go
│       └── manager.go
├── proto/
│   └── auth.proto
└── go.mod
```

### Define the Plugin Interface

```go
// internal/plugin/interface.go
package plugin

import "context"

// AuthPlugin is the interface that all authentication plugins must implement
type AuthPlugin interface {
    // Authenticate validates credentials and returns a user identity
    Authenticate(ctx context.Context, req *AuthRequest) (*AuthResponse, error)
    // Health returns the plugin's operational status
    Health(ctx context.Context) error
    // Capabilities returns what features the plugin supports
    Capabilities() []string
}

type AuthRequest struct {
    Username   string            `json:"username"`
    Password   string            `json:"password"`
    Metadata   map[string]string `json:"metadata,omitempty"`
    RemoteAddr string            `json:"remote_addr"`
}

type AuthResponse struct {
    UserID   string            `json:"user_id"`
    Email    string            `json:"email"`
    Groups   []string          `json:"groups"`
    Claims   map[string]string `json:"claims,omitempty"`
}

// PluginMetadata describes a plugin's identity and version
type PluginMetadata struct {
    Name        string `json:"name"`
    Version     string `json:"version"`
    Description string `json:"description"`
    Author      string `json:"author"`
}
```

### Protocol Buffer Definition

```protobuf
// proto/auth.proto
syntax = "proto3";
package auth;
option go_package = "github.com/example/myapp/proto/auth";

service AuthPlugin {
    rpc Authenticate(AuthRequest) returns (AuthResponse);
    rpc Health(HealthRequest) returns (HealthResponse);
    rpc Capabilities(CapabilitiesRequest) returns (CapabilitiesResponse);
}

message AuthRequest {
    string username = 1;
    string password = 2;
    map<string, string> metadata = 3;
    string remote_addr = 4;
}

message AuthResponse {
    string user_id = 1;
    string email = 2;
    repeated string groups = 3;
    map<string, string> claims = 4;
}

message HealthRequest {}
message HealthResponse {
    bool healthy = 1;
    string message = 2;
}

message CapabilitiesRequest {}
message CapabilitiesResponse {
    repeated string capabilities = 1;
}
```

Generate Go code:

```bash
protoc --go_out=. --go-grpc_out=. proto/auth.proto
```

### gRPC Plugin Implementation

```go
// internal/plugin/grpc.go
package plugin

import (
    "context"
    "fmt"

    "github.com/hashicorp/go-plugin"
    "google.golang.org/grpc"

    authpb "github.com/example/myapp/proto/auth"
)

// Handshake is the HandshakeConfig used to verify plugin compatibility.
// Both the host and plugin must use the same magic cookie.
var Handshake = plugin.HandshakeConfig{
    ProtocolVersion:  2,
    MagicCookieKey:   "MYAPP_AUTH_PLUGIN",
    MagicCookieValue: "d1a9f2c4b8e3a7f1",
}

// PluginMap is the map of plugins supported by this binary
var PluginMap = map[string]plugin.Plugin{
    "auth": &AuthGRPCPlugin{},
}

// AuthGRPCPlugin implements plugin.GRPCPlugin interface
type AuthGRPCPlugin struct {
    plugin.Plugin
    Impl AuthPlugin
}

func (p *AuthGRPCPlugin) GRPCServer(broker *plugin.GRPCBroker, s *grpc.Server) error {
    authpb.RegisterAuthPluginServer(s, &GRPCServer{Impl: p.Impl})
    return nil
}

func (p *AuthGRPCPlugin) GRPCClient(ctx context.Context, broker *plugin.GRPCBroker, c *grpc.ClientConn) (interface{}, error) {
    return &GRPCClient{client: authpb.NewAuthPluginClient(c)}, nil
}

// GRPCServer wraps the Go interface implementation for gRPC
type GRPCServer struct {
    authpb.UnimplementedAuthPluginServer
    Impl AuthPlugin
}

func (s *GRPCServer) Authenticate(ctx context.Context, req *authpb.AuthRequest) (*authpb.AuthResponse, error) {
    goReq := &AuthRequest{
        Username:   req.Username,
        Password:   req.Password,
        Metadata:   req.Metadata,
        RemoteAddr: req.RemoteAddr,
    }

    resp, err := s.Impl.Authenticate(ctx, goReq)
    if err != nil {
        return nil, err
    }

    return &authpb.AuthResponse{
        UserId: resp.UserID,
        Email:  resp.Email,
        Groups: resp.Groups,
        Claims: resp.Claims,
    }, nil
}

func (s *GRPCServer) Health(ctx context.Context, req *authpb.HealthRequest) (*authpb.HealthResponse, error) {
    err := s.Impl.Health(ctx)
    if err != nil {
        return &authpb.HealthResponse{Healthy: false, Message: err.Error()}, nil
    }
    return &authpb.HealthResponse{Healthy: true, Message: "OK"}, nil
}

func (s *GRPCServer) Capabilities(ctx context.Context, req *authpb.CapabilitiesRequest) (*authpb.CapabilitiesResponse, error) {
    caps := s.Impl.Capabilities()
    return &authpb.CapabilitiesResponse{Capabilities: caps}, nil
}

// GRPCClient is used by the host application to call the plugin
type GRPCClient struct {
    client authpb.AuthPluginClient
}

func (c *GRPCClient) Authenticate(ctx context.Context, req *AuthRequest) (*AuthResponse, error) {
    pbReq := &authpb.AuthRequest{
        Username:   req.Username,
        Password:   req.Password,
        Metadata:   req.Metadata,
        RemoteAddr: req.RemoteAddr,
    }

    resp, err := c.client.Authenticate(ctx, pbReq)
    if err != nil {
        return nil, fmt.Errorf("plugin authenticate failed: %w", err)
    }

    return &AuthResponse{
        UserID: resp.UserId,
        Email:  resp.Email,
        Groups: resp.Groups,
        Claims: resp.Claims,
    }, nil
}

func (c *GRPCClient) Health(ctx context.Context) error {
    resp, err := c.client.Health(ctx, &authpb.HealthRequest{})
    if err != nil {
        return err
    }
    if !resp.Healthy {
        return fmt.Errorf("plugin unhealthy: %s", resp.Message)
    }
    return nil
}

func (c *GRPCClient) Capabilities() []string {
    resp, err := c.client.Capabilities(context.Background(), &authpb.CapabilitiesRequest{})
    if err != nil {
        return nil
    }
    return resp.Capabilities
}
```

### Plugin Manager with Hot Reload

```go
// internal/plugin/manager.go
package plugin

import (
    "context"
    "fmt"
    "log/slog"
    "os"
    "os/exec"
    "path/filepath"
    "sync"
    "time"

    "github.com/hashicorp/go-plugin"
)

type PluginConfig struct {
    Name       string
    BinaryPath string
    Env        []string
    SecureConfig *plugin.SecureConfig
}

type ManagedPlugin struct {
    Config    PluginConfig
    client    *plugin.Client
    impl      AuthPlugin
    startedAt time.Time
    mu        sync.RWMutex
}

type Manager struct {
    plugins   map[string]*ManagedPlugin
    mu        sync.RWMutex
    logger    *slog.Logger
    reloadCh  chan string
}

func NewManager(logger *slog.Logger) *Manager {
    m := &Manager{
        plugins:  make(map[string]*ManagedPlugin),
        logger:   logger,
        reloadCh: make(chan string, 10),
    }
    go m.reloadWorker()
    return m
}

// Load initializes and starts a plugin process
func (m *Manager) Load(ctx context.Context, cfg PluginConfig) error {
    m.logger.Info("loading plugin", "name", cfg.Name, "binary", cfg.BinaryPath)

    if _, err := os.Stat(cfg.BinaryPath); err != nil {
        return fmt.Errorf("plugin binary not found: %w", err)
    }

    managed, err := m.startPlugin(cfg)
    if err != nil {
        return fmt.Errorf("failed to start plugin %s: %w", cfg.Name, err)
    }

    // Validate plugin health before accepting it
    healthCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    if err := managed.impl.Health(healthCtx); err != nil {
        managed.client.Kill()
        return fmt.Errorf("plugin %s failed health check: %w", cfg.Name, err)
    }

    m.mu.Lock()
    if existing, ok := m.plugins[cfg.Name]; ok {
        m.logger.Info("replacing existing plugin instance", "name", cfg.Name)
        existing.client.Kill()
    }
    m.plugins[cfg.Name] = managed
    m.mu.Unlock()

    m.logger.Info("plugin loaded successfully",
        "name", cfg.Name,
        "capabilities", managed.impl.Capabilities())
    return nil
}

func (m *Manager) startPlugin(cfg PluginConfig) (*ManagedPlugin, error) {
    clientConfig := &plugin.ClientConfig{
        HandshakeConfig: Handshake,
        Plugins:         PluginMap,
        Cmd:             exec.Command(cfg.BinaryPath),
        Env:             cfg.Env,
        AllowedProtocols: []plugin.Protocol{
            plugin.ProtocolGRPC,
        },
        GRPCDialOptions: []grpc.DialOption{
            grpc.WithBlock(),
        },
        StartTimeout: 30 * time.Second,
        Logger: hclog.New(&hclog.LoggerOptions{
            Name:  cfg.Name,
            Level: hclog.Info,
        }),
    }

    // Apply secure config if provided (checksum verification)
    if cfg.SecureConfig != nil {
        clientConfig.SecureConfig = cfg.SecureConfig
    }

    client := plugin.NewClient(clientConfig)

    rpcClient, err := client.Client()
    if err != nil {
        client.Kill()
        return nil, fmt.Errorf("failed to connect to plugin: %w", err)
    }

    raw, err := rpcClient.Dispense("auth")
    if err != nil {
        client.Kill()
        return nil, fmt.Errorf("failed to dispense plugin: %w", err)
    }

    impl, ok := raw.(AuthPlugin)
    if !ok {
        client.Kill()
        return nil, fmt.Errorf("plugin does not implement AuthPlugin interface")
    }

    return &ManagedPlugin{
        Config:    cfg,
        client:    client,
        impl:      impl,
        startedAt: time.Now(),
    }, nil
}

// Get returns the plugin implementation for use
func (m *Manager) Get(name string) (AuthPlugin, error) {
    m.mu.RLock()
    managed, ok := m.plugins[name]
    m.mu.RUnlock()

    if !ok {
        return nil, fmt.Errorf("plugin %s not loaded", name)
    }

    managed.mu.RLock()
    impl := managed.impl
    managed.mu.RUnlock()

    return impl, nil
}

// Reload triggers a hot reload of a specific plugin
func (m *Manager) Reload(ctx context.Context, name string) error {
    m.mu.RLock()
    managed, ok := m.plugins[name]
    m.mu.RUnlock()

    if !ok {
        return fmt.Errorf("plugin %s not loaded", name)
    }

    m.logger.Info("reloading plugin", "name", name)

    // Start new instance first
    newManaged, err := m.startPlugin(managed.Config)
    if err != nil {
        return fmt.Errorf("failed to start new instance of %s: %w", name, err)
    }

    // Validate new instance
    healthCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    if err := newManaged.impl.Health(healthCtx); err != nil {
        newManaged.client.Kill()
        return fmt.Errorf("new plugin instance failed health check: %w", err)
    }

    // Atomic swap
    m.mu.Lock()
    oldManaged := m.plugins[name]
    m.plugins[name] = newManaged
    m.mu.Unlock()

    // Graceful shutdown of old instance with delay for in-flight requests
    go func() {
        time.Sleep(5 * time.Second)
        oldManaged.client.Kill()
        m.logger.Info("old plugin instance terminated", "name", name)
    }()

    m.logger.Info("plugin reloaded successfully", "name", name)
    return nil
}

func (m *Manager) reloadWorker() {
    for name := range m.reloadCh {
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        if err := m.Reload(ctx, name); err != nil {
            m.logger.Error("plugin reload failed", "name", name, "error", err)
        }
        cancel()
    }
}

// Shutdown terminates all plugin processes
func (m *Manager) Shutdown() {
    m.mu.Lock()
    defer m.mu.Unlock()

    for name, managed := range m.plugins {
        m.logger.Info("terminating plugin", "name", name)
        managed.client.Kill()
    }
}

// HealthCheck returns health status of all plugins
func (m *Manager) HealthCheck(ctx context.Context) map[string]error {
    m.mu.RLock()
    names := make([]string, 0, len(m.plugins))
    for name := range m.plugins {
        names = append(names, name)
    }
    m.mu.RUnlock()

    results := make(map[string]error, len(names))
    for _, name := range names {
        impl, err := m.Get(name)
        if err != nil {
            results[name] = err
            continue
        }
        healthCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
        results[name] = impl.Health(healthCtx)
        cancel()
    }
    return results
}
```

### Implementing an LDAP Auth Plugin

```go
// cmd/plugins/auth-ldap/main.go
package main

import (
    "context"
    "crypto/tls"
    "fmt"
    "log/slog"
    "os"

    "github.com/go-ldap/ldap/v3"
    "github.com/hashicorp/go-hclog"
    "github.com/hashicorp/go-plugin"

    pluginpkg "github.com/example/myapp/internal/plugin"
)

type LDAPAuthPlugin struct {
    host     string
    port     int
    baseDN   string
    bindDN   string
    bindPass string
    tlsConfig *tls.Config
}

func (l *LDAPAuthPlugin) Authenticate(ctx context.Context, req *pluginpkg.AuthRequest) (*pluginpkg.AuthResponse, error) {
    conn, err := ldap.DialTLS("tcp",
        fmt.Sprintf("%s:%d", l.host, l.port),
        l.tlsConfig)
    if err != nil {
        return nil, fmt.Errorf("LDAP connection failed: %w", err)
    }
    defer conn.Close()

    // Bind with service account
    if err := conn.Bind(l.bindDN, l.bindPass); err != nil {
        return nil, fmt.Errorf("LDAP service bind failed: %w", err)
    }

    // Search for the user
    searchReq := ldap.NewSearchRequest(
        l.baseDN,
        ldap.ScopeWholeSubtree,
        ldap.NeverDerefAliases,
        0, 0, false,
        fmt.Sprintf("(&(objectClass=user)(sAMAccountName=%s))", ldap.EscapeFilter(req.Username)),
        []string{"dn", "mail", "memberOf", "displayName"},
        nil,
    )

    result, err := conn.Search(searchReq)
    if err != nil {
        return nil, fmt.Errorf("LDAP search failed: %w", err)
    }

    if len(result.Entries) != 1 {
        return nil, fmt.Errorf("user %s not found", req.Username)
    }

    userDN := result.Entries[0].DN
    email := result.Entries[0].GetAttributeValue("mail")
    memberOf := result.Entries[0].GetAttributeValues("memberOf")

    // Verify password by binding as the user
    if err := conn.Bind(userDN, req.Password); err != nil {
        return nil, fmt.Errorf("invalid credentials")
    }

    // Extract group names from memberOf DNs
    groups := make([]string, 0, len(memberOf))
    for _, dn := range memberOf {
        parsedDN, err := ldap.ParseDN(dn)
        if err != nil {
            continue
        }
        for _, rdn := range parsedDN.RDNs {
            for _, attr := range rdn.Attributes {
                if attr.Type == "CN" {
                    groups = append(groups, attr.Value)
                }
            }
        }
    }

    return &pluginpkg.AuthResponse{
        UserID: userDN,
        Email:  email,
        Groups: groups,
        Claims: map[string]string{
            "auth_method": "ldap",
            "domain":      l.host,
        },
    }, nil
}

func (l *LDAPAuthPlugin) Health(ctx context.Context) error {
    conn, err := ldap.DialTLS("tcp",
        fmt.Sprintf("%s:%d", l.host, l.port),
        l.tlsConfig)
    if err != nil {
        return fmt.Errorf("LDAP health check failed: %w", err)
    }
    conn.Close()
    return nil
}

func (l *LDAPAuthPlugin) Capabilities() []string {
    return []string{"authentication", "groups", "ldap"}
}

func main() {
    logger := hclog.New(&hclog.LoggerOptions{
        Name:   "auth-ldap",
        Level:  hclog.Info,
        Output: os.Stderr,
    })

    impl := &LDAPAuthPlugin{
        host:     os.Getenv("LDAP_HOST"),
        port:     636,
        baseDN:   os.Getenv("LDAP_BASE_DN"),
        bindDN:   os.Getenv("LDAP_BIND_DN"),
        bindPass: os.Getenv("LDAP_BIND_PASSWORD"),
        tlsConfig: &tls.Config{
            MinVersion: tls.VersionTLS12,
        },
    }

    plugin.Serve(&plugin.ServeConfig{
        HandshakeConfig: pluginpkg.Handshake,
        Plugins: map[string]plugin.Plugin{
            "auth": &pluginpkg.AuthGRPCPlugin{Impl: impl},
        },
        GRPCServer: plugin.DefaultGRPCServer,
        Logger:     logger,
    })
}
```

### Host Application Integration

```go
// cmd/myapp/main.go
package main

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "io"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/hashicorp/go-plugin"

    pluginpkg "github.com/example/myapp/internal/plugin"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    manager := pluginpkg.NewManager(logger)
    defer manager.Shutdown()

    // Generate secure config for plugin binary verification
    ldapBinaryPath := "/opt/myapp/plugins/auth-ldap"
    checksum, err := computeChecksum(ldapBinaryPath)
    if err != nil {
        logger.Error("failed to compute plugin checksum", "error", err)
        os.Exit(1)
    }

    secureConfig := &plugin.SecureConfig{
        Checksum: checksum,
        Hash:     sha256.New,
    }

    ctx := context.Background()

    // Load the LDAP auth plugin
    if err := manager.Load(ctx, pluginpkg.PluginConfig{
        Name:       "ldap",
        BinaryPath: ldapBinaryPath,
        Env: []string{
            "LDAP_HOST=ldap.example.corp",
            "LDAP_BASE_DN=DC=example,DC=corp",
            "LDAP_BIND_DN=CN=svc-myapp,OU=Service Accounts,DC=example,DC=corp",
            "LDAP_BIND_PASSWORD=PLUGIN_SECRET_REPLACE_ME",
        },
        SecureConfig: secureConfig,
    }); err != nil {
        logger.Error("failed to load LDAP plugin", "error", err)
        os.Exit(1)
    }

    // Start HTTP server
    mux := http.NewServeMux()
    mux.HandleFunc("/auth", func(w http.ResponseWriter, r *http.Request) {
        authPlugin, err := manager.Get("ldap")
        if err != nil {
            http.Error(w, "auth service unavailable", http.StatusServiceUnavailable)
            return
        }

        ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
        defer cancel()

        resp, err := authPlugin.Authenticate(ctx, &pluginpkg.AuthRequest{
            Username:   r.FormValue("username"),
            Password:   r.FormValue("password"),
            RemoteAddr: r.RemoteAddr,
        })
        if err != nil {
            http.Error(w, "authentication failed", http.StatusUnauthorized)
            return
        }

        w.Header().Set("X-User-ID", resp.UserID)
        w.Header().Set("X-User-Email", resp.Email)
        w.WriteHeader(http.StatusOK)
    })

    // Plugin reload endpoint (protected in production)
    mux.HandleFunc("/admin/plugins/reload", func(w http.ResponseWriter, r *http.Request) {
        name := r.URL.Query().Get("name")
        if name == "" {
            http.Error(w, "name required", http.StatusBadRequest)
            return
        }

        ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
        defer cancel()

        if err := manager.Reload(ctx, name); err != nil {
            logger.Error("plugin reload failed", "name", name, "error", err)
            http.Error(w, err.Error(), http.StatusInternalServerError)
            return
        }
        w.WriteHeader(http.StatusOK)
    })

    // Health endpoint
    mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
        defer cancel()

        checks := manager.HealthCheck(ctx)
        allHealthy := true
        for name, err := range checks {
            if err != nil {
                allHealthy = false
                logger.Warn("plugin unhealthy", "name", name, "error", err)
            }
        }

        if !allHealthy {
            w.WriteHeader(http.StatusServiceUnavailable)
            return
        }
        w.WriteHeader(http.StatusOK)
    })

    srv := &http.Server{
        Addr:         ":8080",
        Handler:      mux,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
    }

    // Graceful shutdown
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

    go func() {
        logger.Info("starting server", "addr", srv.Addr)
        if err := srv.ListenAndServe(); err != http.ErrServerClosed {
            logger.Error("server error", "error", err)
            os.Exit(1)
        }
    }()

    <-sigCh
    logger.Info("shutting down")

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    srv.Shutdown(ctx)
}

func computeChecksum(path string) ([]byte, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    h := sha256.New()
    if _, err := io.Copy(h, f); err != nil {
        return nil, err
    }
    sum := hex.EncodeToString(h.Sum(nil))
    _ = sum
    return h.Sum(nil), nil
}
```

## Plugin Version Negotiation

go-plugin supports multi-version plugins through the `VersionedPlugins` map:

```go
// internal/plugin/versioned.go
package plugin

import "github.com/hashicorp/go-plugin"

// VersionedPluginMap maps API versions to plugin implementations
// Allows the host to support multiple plugin API versions simultaneously
var VersionedPluginMap = map[int]plugin.PluginSet{
    1: {
        "auth": &AuthGRPCPluginV1{},
    },
    2: {
        "auth": &AuthGRPCPlugin{}, // current version
    },
}

// HandshakeWithVersioning uses protocol version negotiation
var HandshakeWithVersioning = plugin.HandshakeConfig{
    ProtocolVersion:  2,
    MagicCookieKey:   "MYAPP_AUTH_PLUGIN",
    MagicCookieValue: "d1a9f2c4b8e3a7f1",
}

func NewVersionedClient(binaryPath string) *plugin.Client {
    return plugin.NewClient(&plugin.ClientConfig{
        HandshakeConfig:  HandshakeWithVersioning,
        VersionedPlugins: VersionedPluginMap,
        Cmd:              exec.Command(binaryPath),
        AllowedProtocols: []plugin.Protocol{plugin.ProtocolGRPC},
    })
}
```

### Plugin that Supports Multiple Versions

```go
// cmd/plugins/auth-ldap/main.go - versioned serve
func main() {
    plugin.Serve(&plugin.ServeConfig{
        HandshakeConfig: pluginpkg.HandshakeWithVersioning,
        VersionedPlugins: map[int]plugin.PluginSet{
            1: {
                "auth": &pluginpkg.AuthGRPCPluginV1{Impl: impl},
            },
            2: {
                "auth": &pluginpkg.AuthGRPCPlugin{Impl: impl},
            },
        },
        GRPCServer: plugin.DefaultGRPCServer,
    })
}
```

## Testing Plugin Systems

### Unit Testing with Mock Plugins

```go
// internal/plugin/mock_test.go
package plugin_test

import (
    "context"
    "testing"

    pluginpkg "github.com/example/myapp/internal/plugin"
)

type MockAuthPlugin struct {
    AuthenticateFunc func(ctx context.Context, req *pluginpkg.AuthRequest) (*pluginpkg.AuthResponse, error)
    HealthFunc       func(ctx context.Context) error
    CapabilitiesFunc func() []string
}

func (m *MockAuthPlugin) Authenticate(ctx context.Context, req *pluginpkg.AuthRequest) (*pluginpkg.AuthResponse, error) {
    if m.AuthenticateFunc != nil {
        return m.AuthenticateFunc(ctx, req)
    }
    return &pluginpkg.AuthResponse{
        UserID: "test-user-id",
        Email:  "test@example.com",
        Groups: []string{"developers"},
    }, nil
}

func (m *MockAuthPlugin) Health(ctx context.Context) error {
    if m.HealthFunc != nil {
        return m.HealthFunc(ctx)
    }
    return nil
}

func (m *MockAuthPlugin) Capabilities() []string {
    if m.CapabilitiesFunc != nil {
        return m.CapabilitiesFunc()
    }
    return []string{"authentication"}
}

func TestManagerLoad(t *testing.T) {
    // Test that manager correctly manages plugin lifecycle
    mock := &MockAuthPlugin{}

    // Verify interface compliance
    var _ pluginpkg.AuthPlugin = mock

    ctx := context.Background()
    resp, err := mock.Authenticate(ctx, &pluginpkg.AuthRequest{
        Username: "alice",
        Password: "hunter2",
    })

    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if resp.UserID != "test-user-id" {
        t.Errorf("expected test-user-id, got %s", resp.UserID)
    }
}
```

### Integration Test with Real Plugin Process

```go
// internal/plugin/integration_test.go
//go:build integration

package plugin_test

import (
    "context"
    "os"
    "os/exec"
    "testing"
    "time"

    "log/slog"

    pluginpkg "github.com/example/myapp/internal/plugin"
)

func TestRealPluginLifecycle(t *testing.T) {
    if testing.Short() {
        t.Skip("skipping integration test")
    }

    // Build the test plugin binary
    pluginBin := "/tmp/test-auth-plugin"
    cmd := exec.Command("go", "build", "-o", pluginBin, "./cmd/plugins/auth-ldap/")
    cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
    if out, err := cmd.CombinedOutput(); err != nil {
        t.Fatalf("failed to build plugin: %v\n%s", err, out)
    }
    defer os.Remove(pluginBin)

    logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
    manager := pluginpkg.NewManager(logger)
    defer manager.Shutdown()

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    err := manager.Load(ctx, pluginpkg.PluginConfig{
        Name:       "test-auth",
        BinaryPath: pluginBin,
        Env: []string{
            "LDAP_HOST=ldap-test.example.corp",
            "LDAP_BASE_DN=DC=example,DC=corp",
            "LDAP_BIND_DN=CN=test-svc,DC=example,DC=corp",
            "LDAP_BIND_PASSWORD=test-password-replace-me",
        },
    })
    if err != nil {
        t.Fatalf("failed to load plugin: %v", err)
    }

    // Test health check
    checks := manager.HealthCheck(ctx)
    for name, err := range checks {
        if err != nil {
            t.Errorf("plugin %s unhealthy: %v", name, err)
        }
    }

    // Test reload
    if err := manager.Reload(ctx, "test-auth"); err != nil {
        t.Fatalf("failed to reload plugin: %v", err)
    }
}
```

## Operational Considerations

### Plugin Binary Distribution

```makefile
# Makefile
PLUGIN_VERSION ?= $(shell git describe --tags --always --dirty)
PLUGINS := auth-ldap auth-saml auth-oidc

.PHONY: plugins
plugins: $(PLUGINS)

$(PLUGINS):
	@echo "Building plugin: $@"
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
		go build -ldflags="-X main.Version=$(PLUGIN_VERSION)" \
		-o dist/plugins/$@ \
		./cmd/plugins/$@/
	sha256sum dist/plugins/$@ > dist/plugins/$@.sha256

.PHONY: sign-plugins
sign-plugins:
	for plugin in $(PLUGINS); do \
		cosign sign-blob \
			--key cosign.key \
			--output-signature dist/plugins/$$plugin.sig \
			dist/plugins/$$plugin; \
	done
```

### Plugin Manifest

```yaml
# plugins/manifest.yaml
version: "1.0"
plugins:
  - name: auth-ldap
    binary: plugins/auth-ldap
    version: "2.1.0"
    api_version: 2
    checksum_sha256: "a3f1b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2"
    config:
      required_env:
        - LDAP_HOST
        - LDAP_BASE_DN
        - LDAP_BIND_DN
        - LDAP_BIND_PASSWORD
    health_check:
      interval: 30s
      timeout: 5s
      retries: 3
  - name: auth-saml
    binary: plugins/auth-saml
    version: "1.4.2"
    api_version: 2
    checksum_sha256: "b4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5"
    config:
      required_env:
        - SAML_IDP_METADATA_URL
        - SAML_SP_ENTITY_ID
        - SAML_SP_CERTIFICATE
```

### Kubernetes Deployment with Plugin Sidecar Pattern

```yaml
# plugin-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      initContainers:
        # Fetch plugins from artifact registry
        - name: plugin-fetcher
          image: registry.example.corp/tools/plugin-fetcher:1.0.0
          command:
            - /bin/sh
            - -c
            - |
              set -e
              # Download plugins from registry
              for plugin in auth-ldap auth-saml; do
                curl -fsSL "https://artifacts.example.corp/plugins/${plugin}" \
                  -o "/plugins/${plugin}"
                chmod +x "/plugins/${plugin}"

                # Verify checksum
                expected=$(curl -fsSL "https://artifacts.example.corp/plugins/${plugin}.sha256")
                actual=$(sha256sum "/plugins/${plugin}" | cut -d' ' -f1)
                if [ "${expected}" != "${actual}" ]; then
                  echo "Checksum mismatch for ${plugin}"
                  exit 1
                fi
              done
          volumeMounts:
            - name: plugins
              mountPath: /plugins
      containers:
        - name: myapp
          image: registry.example.corp/myapp:latest
          env:
            - name: PLUGIN_DIR
              value: /opt/plugins
            - name: LDAP_HOST
              valueFrom:
                secretKeyRef:
                  name: ldap-config
                  key: host
            - name: LDAP_BIND_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: ldap-credentials
                  key: password
          volumeMounts:
            - name: plugins
              mountPath: /opt/plugins
              readOnly: true
      volumes:
        - name: plugins
          emptyDir: {}
```

## Conclusion

Go plugin architecture requires choosing the right tool for the job. Native Go plugins excel in controlled environments with matching build toolchains, while Hashicorp go-plugin provides the process isolation and language flexibility that enterprise systems require. The key patterns covered here — interface-driven design, gRPC transport, version negotiation, binary verification, and hot reload — form the foundation of a production-ready extensible system. By building these capabilities into your application from the start, you enable third-party extension without sacrificing stability or security.
