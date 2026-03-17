---
title: "Go Plugin Architecture: gRPC Plugins, Hashicorp go-plugin, and Dynamic Loading"
date: 2028-02-12T00:00:00-05:00
draft: false
tags: ["Go", "Plugins", "gRPC", "Hashicorp go-plugin", "Architecture", "Extensibility", "RPC"]
categories:
- Go
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building extensible Go systems using the Hashicorp go-plugin framework, gRPC-based plugin protocols, versioned handshakes, plugin health checking, and a worked example of a pluggable authentication provider."
more_link: "yes"
url: "/go-plugin-architecture-grpc-hashicorp-go-plugin-dynamic-loading/"
---

Go's native plugin package is too limited for production use: plugins must be compiled with the exact same Go version and package dependencies as the host, cannot be unloaded, and are not supported on all platforms. Hashicorp's go-plugin library solves these problems by running plugins as separate processes communicating over gRPC (or net/rpc). Every major Hashicorp tool — Terraform providers, Vault plugins, Packer builders — uses this approach. This guide covers the complete go-plugin pattern with a worked example of a pluggable authentication provider.

<!--more-->

# Go Plugin Architecture: gRPC Plugins, Hashicorp go-plugin, and Dynamic Loading

## Why Not the Go Plugin Package

The `plugin` package in the Go standard library (`plugin.Open`, `plugin.Lookup`) has significant constraints:

- **Compilation coupling**: Plugins must be compiled with `CGO_ENABLED=1` and the exact same Go version as the host binary. Version drift between host and plugin causes runtime panics.
- **No unloading**: Loaded plugins cannot be unloaded. Memory is never freed for the plugin's code and data.
- **Platform restrictions**: Only supported on Linux, macOS, and FreeBSD. Not available on Windows.
- **Shared state bugs**: Plugins share the same process, same heap, same goroutine scheduler. A panic in a plugin crashes the host. A memory leak in a plugin affects the host.
- **Single import**: The same package cannot be imported in both the host and the plugin — they must share a single compiled copy, requiring careful dependency management.

For production extensibility, the out-of-process model is more robust.

## Hashicorp go-plugin Architecture

`github.com/hashicorp/go-plugin` implements a plugin system where:

1. The **host** (the main application) defines the plugin interface as a Go interface
2. The **plugin** (separate binary) implements that interface
3. The host launches the plugin as a subprocess
4. Communication occurs over gRPC or net/rpc on a local Unix socket or TCP loopback
5. The host accesses the plugin via a generated gRPC client that satisfies the Go interface

From the host's perspective, the plugin looks like a local Go object. From the plugin binary's perspective, it is a standalone Go program that registers its implementation and serves gRPC requests.

```
┌──────────────────────────────────────────────────────┐
│  Host Process                                        │
│                                                      │
│  ┌─────────────────────┐                             │
│  │  plugin.Client       │     gRPC over Unix socket  │
│  │  ├── HandshakeConfig │ ──────────────────────────►│
│  │  └── AuthProvider   │◄──────────────────────────  │
│  │      (gRPC client)  │                             │
│  └─────────────────────┘                             │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│  Plugin Process (subprocess)                         │
│                                                      │
│  ┌─────────────────────┐                             │
│  │  plugin.Serve()     │                             │
│  │  AuthProviderImpl   │  gRPC server                │
│  │  (gRPC server)      │                             │
│  └─────────────────────┘                             │
└──────────────────────────────────────────────────────┘
```

## Defining the Plugin Interface

The plugin interface and its gRPC protocol definition are the contract between host and plugin. Changing the interface version requires a new protocol version.

### Protocol Buffer Definition

```protobuf
// proto/auth/v1/auth.proto
syntax = "proto3";

package auth.v1;

option go_package = "github.com/example/auth-system/proto/auth/v1;authv1";

// AuthProvider defines the interface that all authentication plugins must implement.
service AuthProvider {
  // Authenticate validates credentials and returns an identity.
  rpc Authenticate(AuthRequest) returns (AuthResponse);

  // ValidateToken checks whether an existing token is still valid.
  rpc ValidateToken(ValidateTokenRequest) returns (ValidateTokenResponse);

  // GetCapabilities returns the set of authentication methods supported by this plugin.
  rpc GetCapabilities(CapabilitiesRequest) returns (CapabilitiesResponse);
}

message AuthRequest {
  // auth_method: "password", "ldap", "saml", "oidc"
  string auth_method = 1;
  // credentials: method-specific credential data (JSON-encoded)
  bytes credentials = 2;
  // request_metadata: IP address, user agent, timestamp, etc.
  map<string, string> request_metadata = 3;
}

message AuthResponse {
  bool success = 1;
  // identity returned on success
  Identity identity = 4;
  // error_code on failure: "invalid_credentials", "account_locked", "mfa_required"
  string error_code = 5;
  string error_message = 6;
}

message Identity {
  string user_id = 1;
  string username = 2;
  string email = 3;
  repeated string groups = 4;
  // token issued by the auth provider for subsequent requests
  string token = 5;
  // token_expiry: Unix timestamp
  int64 token_expiry = 6;
  // claims: additional identity attributes
  map<string, string> claims = 7;
}

message ValidateTokenRequest {
  string token = 1;
}

message ValidateTokenResponse {
  bool valid = 1;
  Identity identity = 2;  // populated if valid
  string error_code = 3;
}

message CapabilitiesRequest {}

message CapabilitiesResponse {
  repeated string supported_methods = 1;
  string plugin_version = 2;
  string protocol_version = 3;
}
```

```bash
# Generate Go code from proto definition
protoc \
  --go_out=. \
  --go_opt=paths=source_relative \
  --go-grpc_out=. \
  --go-grpc_opt=paths=source_relative \
  proto/auth/v1/auth.proto
```

### Go Interface Definition

```go
// pkg/plugin/auth/interface.go
package auth

// AuthProvider is the Go interface that all auth plugins must implement.
// This interface is implemented by the gRPC client stub on the host side
// and by the plugin binary on the plugin side.
type AuthProvider interface {
    // Authenticate validates credentials and returns an identity.
    Authenticate(req AuthRequest) (AuthResponse, error)

    // ValidateToken checks whether an existing token is still valid.
    ValidateToken(token string) (AuthResponse, error)

    // GetCapabilities returns the authentication methods supported by this plugin.
    GetCapabilities() ([]string, error)
}

// AuthRequest holds the authentication request data
type AuthRequest struct {
    AuthMethod      string            `json:"auth_method"`
    Credentials     []byte            `json:"credentials"`
    RequestMetadata map[string]string `json:"request_metadata"`
}

// AuthResponse holds the authentication result
type AuthResponse struct {
    Success      bool              `json:"success"`
    Identity     *Identity         `json:"identity,omitempty"`
    ErrorCode    string            `json:"error_code,omitempty"`
    ErrorMessage string            `json:"error_message,omitempty"`
}

// Identity represents an authenticated user
type Identity struct {
    UserID      string            `json:"user_id"`
    Username    string            `json:"username"`
    Email       string            `json:"email"`
    Groups      []string          `json:"groups"`
    Token       string            `json:"token"`
    TokenExpiry int64             `json:"token_expiry"`
    Claims      map[string]string `json:"claims"`
}
```

### gRPC Plugin Wrapper (Host Side)

```go
// pkg/plugin/auth/grpc.go
package auth

import (
    "context"
    "time"

    "github.com/hashicorp/go-plugin"
    "google.golang.org/grpc"

    authv1 "github.com/example/auth-system/proto/auth/v1"
)

// HandshakeConfig is shared between host and plugin.
// MagicCookieKey/Value prevents accidental execution of a plugin binary.
// ProtocolVersion must match between host and plugin; a mismatch causes a clean error.
var HandshakeConfig = plugin.HandshakeConfig{
    ProtocolVersion:  1,
    MagicCookieKey:   "AUTH_PLUGIN_MAGIC_COOKIE",
    MagicCookieValue: "auth-plugin-v1-secure-cookie-value-2028",
}

// PluginMap maps plugin names to their implementations.
// The host uses this map to discover available plugin types.
var PluginMap = map[string]plugin.Plugin{
    "auth_provider": &AuthProviderPlugin{},
}

// AuthProviderPlugin implements plugin.GRPCPlugin and bridges
// the go-plugin framework with the gRPC AuthProvider interface.
type AuthProviderPlugin struct {
    // Impl is set by the plugin binary when serving
    Impl AuthProvider
}

// GRPCServer registers the plugin's gRPC server (called by the plugin binary)
func (p *AuthProviderPlugin) GRPCServer(broker *plugin.GRPCBroker, s *grpc.Server) error {
    authv1.RegisterAuthProviderServer(s, &GRPCServer{Impl: p.Impl})
    return nil
}

// GRPCClient returns a client that wraps the gRPC connection (called by the host)
func (p *AuthProviderPlugin) GRPCClient(
    ctx context.Context,
    broker *plugin.GRPCBroker,
    c *grpc.ClientConn,
) (interface{}, error) {
    return &GRPCClient{client: authv1.NewAuthProviderClient(c)}, nil
}

// GRPCClient is the host-side implementation of AuthProvider backed by gRPC
type GRPCClient struct {
    client authv1.AuthProviderClient
}

func (c *GRPCClient) Authenticate(req AuthRequest) (AuthResponse, error) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    resp, err := c.client.Authenticate(ctx, &authv1.AuthRequest{
        AuthMethod:      req.AuthMethod,
        Credentials:     req.Credentials,
        RequestMetadata: req.RequestMetadata,
    })
    if err != nil {
        return AuthResponse{}, err
    }

    result := AuthResponse{
        Success:      resp.Success,
        ErrorCode:    resp.ErrorCode,
        ErrorMessage: resp.ErrorMessage,
    }
    if resp.Identity != nil {
        result.Identity = &Identity{
            UserID:      resp.Identity.UserId,
            Username:    resp.Identity.Username,
            Email:       resp.Identity.Email,
            Groups:      resp.Identity.Groups,
            Token:       resp.Identity.Token,
            TokenExpiry: resp.Identity.TokenExpiry,
            Claims:      resp.Identity.Claims,
        }
    }
    return result, nil
}

func (c *GRPCClient) ValidateToken(token string) (AuthResponse, error) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    resp, err := c.client.ValidateToken(ctx, &authv1.ValidateTokenRequest{Token: token})
    if err != nil {
        return AuthResponse{}, err
    }
    return AuthResponse{
        Success:   resp.Valid,
        ErrorCode: resp.ErrorCode,
    }, nil
}

func (c *GRPCClient) GetCapabilities() ([]string, error) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    resp, err := c.client.GetCapabilities(ctx, &authv1.CapabilitiesRequest{})
    if err != nil {
        return nil, err
    }
    return resp.SupportedMethods, nil
}

// GRPCServer is the plugin-side implementation that wraps the actual AuthProvider impl
type GRPCServer struct {
    authv1.UnimplementedAuthProviderServer
    Impl AuthProvider
}

func (s *GRPCServer) Authenticate(
    ctx context.Context,
    req *authv1.AuthRequest,
) (*authv1.AuthResponse, error) {
    result, err := s.Impl.Authenticate(AuthRequest{
        AuthMethod:      req.AuthMethod,
        Credentials:     req.Credentials,
        RequestMetadata: req.RequestMetadata,
    })
    if err != nil {
        return nil, err
    }

    resp := &authv1.AuthResponse{
        Success:      result.Success,
        ErrorCode:    result.ErrorCode,
        ErrorMessage: result.ErrorMessage,
    }
    if result.Identity != nil {
        resp.Identity = &authv1.Identity{
            UserId:      result.Identity.UserID,
            Username:    result.Identity.Username,
            Email:       result.Identity.Email,
            Groups:      result.Identity.Groups,
            Token:       result.Identity.Token,
            TokenExpiry: result.Identity.TokenExpiry,
            Claims:      result.Identity.Claims,
        }
    }
    return resp, nil
}
```

## Plugin Binary Implementation (LDAP Auth Provider)

```go
// plugins/ldap-auth/main.go
// This is the plugin binary. It implements AuthProvider using LDAP.
package main

import (
    "crypto/tls"
    "fmt"
    "os"
    "time"

    "github.com/go-ldap/ldap/v3"
    "github.com/hashicorp/go-plugin"

    auth "github.com/example/auth-system/pkg/plugin/auth"
)

// LDAPAuthProvider implements the AuthProvider interface using LDAP
type LDAPAuthProvider struct {
    serverURL string
    baseDN    string
    bindDN    string
    bindPass  string
    tlsConfig *tls.Config
}

func (p *LDAPAuthProvider) Authenticate(req auth.AuthRequest) (auth.AuthResponse, error) {
    if req.AuthMethod != "ldap" && req.AuthMethod != "password" {
        return auth.AuthResponse{
            Success:      false,
            ErrorCode:    "unsupported_method",
            ErrorMessage: fmt.Sprintf("LDAP plugin does not support method: %s", req.AuthMethod),
        }, nil
    }

    // Decode credentials from JSON
    var creds struct {
        Username string `json:"username"`
        Password string `json:"password"`
    }
    if err := jsonUnmarshal(req.Credentials, &creds); err != nil {
        return auth.AuthResponse{
            Success:   false,
            ErrorCode: "invalid_credentials_format",
        }, nil
    }

    // Connect to LDAP server
    conn, err := ldap.DialURL(p.serverURL, ldap.DialWithTLSConfig(p.tlsConfig))
    if err != nil {
        return auth.AuthResponse{}, fmt.Errorf("LDAP connection failed: %w", err)
    }
    defer conn.Close()

    // Bind with service account for search
    if err := conn.Bind(p.bindDN, p.bindPass); err != nil {
        return auth.AuthResponse{}, fmt.Errorf("service account bind failed: %w", err)
    }

    // Search for the user DN
    searchRequest := ldap.NewSearchRequest(
        p.baseDN,
        ldap.ScopeWholeSubtree,
        ldap.NeverDerefAliases,
        0, 10, false,
        fmt.Sprintf("(&(objectClass=person)(uid=%s))", ldap.EscapeFilter(creds.Username)),
        []string{"dn", "mail", "memberOf", "displayName"},
        nil,
    )

    result, err := conn.Search(searchRequest)
    if err != nil || len(result.Entries) != 1 {
        return auth.AuthResponse{
            Success:      false,
            ErrorCode:    "invalid_credentials",
            ErrorMessage: "user not found or multiple matches",
        }, nil
    }

    userDN := result.Entries[0].DN
    email := result.Entries[0].GetAttributeValue("mail")
    groups := result.Entries[0].GetAttributeValues("memberOf")

    // Attempt user bind (credential validation)
    if err := conn.Bind(userDN, creds.Password); err != nil {
        return auth.AuthResponse{
            Success:      false,
            ErrorCode:    "invalid_credentials",
            ErrorMessage: "authentication failed",
        }, nil
    }

    // Generate a token (in production, use JWT with proper signing)
    token := generateToken(creds.Username)
    expiry := time.Now().Add(8 * time.Hour).Unix()

    return auth.AuthResponse{
        Success: true,
        Identity: &auth.Identity{
            UserID:      creds.Username,
            Username:    creds.Username,
            Email:       email,
            Groups:      groups,
            Token:       token,
            TokenExpiry: expiry,
            Claims:      map[string]string{"source": "ldap"},
        },
    }, nil
}

func (p *LDAPAuthProvider) ValidateToken(token string) (auth.AuthResponse, error) {
    // Validate the JWT token
    claims, err := parseToken(token)
    if err != nil {
        return auth.AuthResponse{
            Success:   false,
            ErrorCode: "invalid_token",
        }, nil
    }

    return auth.AuthResponse{
        Success: true,
        Identity: &auth.Identity{
            UserID:   claims["sub"].(string),
            Username: claims["sub"].(string),
        },
    }, nil
}

func (p *LDAPAuthProvider) GetCapabilities() ([]string, error) {
    return []string{"password", "ldap"}, nil
}

func main() {
    // Read configuration from environment variables (injected by the host)
    provider := &LDAPAuthProvider{
        serverURL: os.Getenv("LDAP_URL"),
        baseDN:    os.Getenv("LDAP_BASE_DN"),
        bindDN:    os.Getenv("LDAP_BIND_DN"),
        bindPass:  os.Getenv("LDAP_BIND_PASSWORD"),
        tlsConfig: &tls.Config{MinVersion: tls.VersionTLS12},
    }

    // Serve the plugin: this blocks until the host closes the connection
    plugin.Serve(&plugin.ServeConfig{
        HandshakeConfig: auth.HandshakeConfig,
        Plugins: map[string]plugin.Plugin{
            "auth_provider": &auth.AuthProviderPlugin{Impl: provider},
        },
        // Use gRPC transport (preferred over net/rpc for new plugins)
        GRPCServer: plugin.DefaultGRPCServer,
    })
}

// Placeholder helpers (implement with crypto/jwt in production)
func jsonUnmarshal(data []byte, v interface{}) error { return nil }
func generateToken(username string) string            { return "token-" + username }
func parseToken(token string) (map[string]interface{}, error) {
    return map[string]interface{}{"sub": "user"}, nil
}
```

## Host: Plugin Manager with Discovery and Health Checking

```go
// internal/pluginmanager/manager.go
package pluginmanager

import (
    "fmt"
    "os"
    "os/exec"
    "path/filepath"
    "sync"
    "time"

    "github.com/hashicorp/go-hclog"
    "github.com/hashicorp/go-plugin"

    auth "github.com/example/auth-system/pkg/plugin/auth"
)

// PluginManager manages the lifecycle of auth provider plugins
type PluginManager struct {
    pluginDir string
    plugins   map[string]*pluginEntry
    mu        sync.RWMutex
    logger    hclog.Logger
}

type pluginEntry struct {
    name     string
    client   *plugin.Client
    provider auth.AuthProvider
    binPath  string
    lastSeen time.Time
}

// NewPluginManager creates a PluginManager that loads plugins from pluginDir
func NewPluginManager(pluginDir string, logger hclog.Logger) *PluginManager {
    return &PluginManager{
        pluginDir: pluginDir,
        plugins:   make(map[string]*pluginEntry),
        logger:    logger,
    }
}

// LoadPlugin discovers and loads an auth provider plugin binary
func (m *PluginManager) LoadPlugin(name string) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    // Find the plugin binary
    binPath := filepath.Join(m.pluginDir, name)
    if _, err := os.Stat(binPath); os.IsNotExist(err) {
        return fmt.Errorf("plugin binary not found: %s", binPath)
    }

    m.logger.Info("Loading plugin", "name", name, "path", binPath)

    // Create a go-plugin client
    client := plugin.NewClient(&plugin.ClientConfig{
        HandshakeConfig: auth.HandshakeConfig,
        Plugins:         auth.PluginMap,

        // The command to launch the plugin subprocess
        Cmd: exec.Command(binPath),

        // Use gRPC transport
        AllowedProtocols: []plugin.Protocol{plugin.ProtocolGRPC},

        // Logger: use the hclog logger for plugin subprocess stdout/stderr
        Logger: m.logger.Named(name),

        // Security: plugin process runs with no elevated privileges
        // Set resource limits via OS-level mechanisms before process start
        SyncStdout: os.Stdout,
        SyncStderr: os.Stderr,

        // AutoMTLS: automatically generate TLS certificates for the gRPC channel
        // between host and plugin (local socket is still encrypted)
        AutoMTLS: true,

        // StartTimeout: fail if plugin doesn't start within this duration
        StartTimeout: 15 * time.Second,
    })

    // Acquire the gRPC client connection
    rpcClient, err := client.Client()
    if err != nil {
        client.Kill()
        return fmt.Errorf("failed to create RPC client for plugin %s: %w", name, err)
    }

    // Dispense the specific plugin type
    raw, err := rpcClient.Dispense("auth_provider")
    if err != nil {
        client.Kill()
        return fmt.Errorf("failed to dispense auth_provider plugin %s: %w", name, err)
    }

    provider, ok := raw.(auth.AuthProvider)
    if !ok {
        client.Kill()
        return fmt.Errorf("plugin %s does not implement AuthProvider interface", name)
    }

    // Verify the plugin works by calling GetCapabilities
    caps, err := provider.GetCapabilities()
    if err != nil {
        client.Kill()
        return fmt.Errorf("plugin %s health check failed: %w", name, err)
    }
    m.logger.Info("Plugin loaded successfully", "name", name, "capabilities", caps)

    m.plugins[name] = &pluginEntry{
        name:     name,
        client:   client,
        provider: provider,
        binPath:  binPath,
        lastSeen: time.Now(),
    }

    return nil
}

// GetProvider returns the named auth provider plugin
func (m *PluginManager) GetProvider(name string) (auth.AuthProvider, error) {
    m.mu.RLock()
    defer m.mu.RUnlock()

    entry, ok := m.plugins[name]
    if !ok {
        return nil, fmt.Errorf("plugin not loaded: %s", name)
    }

    // Check if the plugin process is still alive
    if entry.client.Exited() {
        return nil, fmt.Errorf("plugin %s has exited unexpectedly", name)
    }

    return entry.provider, nil
}

// ReloadPlugin kills and reloads a plugin (for hot-reload after binary update)
func (m *PluginManager) ReloadPlugin(name string) error {
    m.mu.Lock()
    if entry, ok := m.plugins[name]; ok {
        m.logger.Info("Killing plugin for reload", "name", name)
        entry.client.Kill()
        delete(m.plugins, name)
    }
    m.mu.Unlock()

    return m.LoadPlugin(name)
}

// HealthCheck verifies all loaded plugins are responsive
func (m *PluginManager) HealthCheck() map[string]error {
    m.mu.RLock()
    defer m.mu.RUnlock()

    results := make(map[string]error)
    for name, entry := range m.plugins {
        if entry.client.Exited() {
            results[name] = fmt.Errorf("plugin process has exited")
            continue
        }
        _, err := entry.provider.GetCapabilities()
        results[name] = err
    }
    return results
}

// Shutdown gracefully terminates all plugin processes
func (m *PluginManager) Shutdown() {
    m.mu.Lock()
    defer m.mu.Unlock()

    for name, entry := range m.plugins {
        m.logger.Info("Shutting down plugin", "name", name)
        entry.client.Kill()
    }
    m.plugins = make(map[string]*pluginEntry)
}
```

## Versioned Protocol Handshakes

When the plugin interface evolves, the protocol version prevents mismatched host and plugin versions from silently producing wrong results:

```go
// pkg/plugin/auth/versions.go
package auth

import "github.com/hashicorp/go-plugin"

const (
    // CurrentProtocolVersion must be incremented when the interface changes
    // in a backward-incompatible way.
    CurrentProtocolVersion = 2

    // MinSupportedProtocolVersion: plugins at or above this version are compatible.
    // Set this to CurrentProtocolVersion to require exact match,
    // or to an older version to support both old and new plugins.
    MinSupportedProtocolVersion = 1
)

// VersionedHandshakeConfig includes version negotiation
var VersionedHandshakeConfig = plugin.HandshakeConfig{
    ProtocolVersion:  CurrentProtocolVersion,
    MagicCookieKey:   "AUTH_PLUGIN_MAGIC_COOKIE",
    MagicCookieValue: "auth-plugin-v2-secure-cookie-value-2028",
}

// The host checks whether the plugin's reported version falls within
// the supported range before using it:
// if pluginVersion < MinSupportedProtocolVersion || pluginVersion > CurrentProtocolVersion {
//     return fmt.Errorf("plugin version %d not supported (requires %d-%d)",
//         pluginVersion, MinSupportedProtocolVersion, CurrentProtocolVersion)
// }
```

## Plugin Discovery

```go
// internal/pluginmanager/discovery.go
package pluginmanager

import (
    "os"
    "path/filepath"
    "strings"
)

// DiscoverPlugins scans pluginDir for executable files matching the naming convention.
// Convention: plugin binaries are named "auth-provider-{name}" (e.g., auth-provider-ldap)
func DiscoverPlugins(pluginDir string) ([]string, error) {
    entries, err := os.ReadDir(pluginDir)
    if err != nil {
        return nil, err
    }

    var plugins []string
    for _, entry := range entries {
        if entry.IsDir() {
            continue
        }

        name := entry.Name()
        if !strings.HasPrefix(name, "auth-provider-") {
            continue
        }

        // Verify the file is executable
        info, err := entry.Info()
        if err != nil {
            continue
        }
        if info.Mode()&0111 == 0 {
            // File is not executable — skip
            continue
        }

        plugins = append(plugins, strings.TrimPrefix(name, "auth-provider-"))
    }

    return plugins, nil
}

// AutoLoad discovers and loads all plugins in the plugin directory
func (m *PluginManager) AutoLoad() error {
    names, err := DiscoverPlugins(m.pluginDir)
    if err != nil {
        return err
    }

    for _, name := range names {
        if err := m.LoadPlugin("auth-provider-" + name); err != nil {
            m.logger.Warn("Failed to load plugin", "name", name, "error", err)
            // Continue loading other plugins even if one fails
        }
    }
    return nil
}
```

## Complete Usage Example

```go
// cmd/auth-server/main.go
package main

import (
    "encoding/json"
    "fmt"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/hashicorp/go-hclog"

    "github.com/example/auth-system/internal/pluginmanager"
)

func main() {
    logger := hclog.New(&hclog.LoggerOptions{
        Name:   "auth-server",
        Level:  hclog.Info,
        Output: os.Stdout,
    })

    pluginDir := os.Getenv("PLUGIN_DIR")
    if pluginDir == "" {
        pluginDir = "/etc/auth-server/plugins"
    }

    // Initialize and load plugins
    pm := pluginmanager.NewPluginManager(pluginDir, logger)
    defer pm.Shutdown()

    if err := pm.AutoLoad(); err != nil {
        logger.Error("Plugin discovery failed", "error", err)
    }

    // HTTP handler for authentication
    http.HandleFunc("/authenticate", func(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodPost {
            http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
            return
        }

        var req struct {
            PluginName string          `json:"plugin"`
            AuthMethod string          `json:"auth_method"`
            Credentials json.RawMessage `json:"credentials"`
        }
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
            http.Error(w, "invalid request", http.StatusBadRequest)
            return
        }

        provider, err := pm.GetProvider(req.PluginName)
        if err != nil {
            http.Error(w, fmt.Sprintf("plugin not available: %v", err), http.StatusServiceUnavailable)
            return
        }

        // Delegate to the plugin
        result, err := provider.Authenticate(auth.AuthRequest{
            AuthMethod:      req.AuthMethod,
            Credentials:     req.Credentials,
            RequestMetadata: map[string]string{"remote_addr": r.RemoteAddr},
        })
        if err != nil {
            http.Error(w, "authentication error", http.StatusInternalServerError)
            return
        }

        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(result)
    })

    // Health check endpoint
    http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        results := pm.HealthCheck()
        healthy := true
        for _, err := range results {
            if err != nil {
                healthy = false
                break
            }
        }
        if !healthy {
            w.WriteHeader(http.StatusServiceUnavailable)
        }
        json.NewEncoder(w).Encode(map[string]interface{}{
            "healthy": healthy,
            "plugins": results,
        })
    })

    // Graceful shutdown
    srv := &http.Server{Addr: ":8080", Handler: nil}
    go func() {
        logger.Info("Auth server listening", "addr", ":8080")
        if err := srv.ListenAndServe(); err != http.ErrServerClosed {
            logger.Error("Server error", "error", err)
        }
    }()

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    logger.Info("Shutting down...")
    pm.Shutdown()
}
```

The Hashicorp go-plugin pattern provides production-grade plugin architecture for Go systems: process isolation prevents plugin crashes from affecting the host, gRPC provides a typed and versioned protocol, AutoMTLS secures the local communication channel, and the plugin client interface makes plugins look like regular Go objects to the host. This is the same architecture powering Terraform providers, Vault authentication backends, and Packer builders — a proven pattern for extensible enterprise Go systems.
