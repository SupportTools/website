---
title: "Go Plugin Architecture: Building Extensible Production Systems"
date: 2027-10-17T00:00:00-05:00
draft: false
tags: ["Go", "Architecture", "Plugins", "Production", "Design Patterns"]
categories:
- Go
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into plugin architecture patterns in Go, covering the native plugin package, interface-based systems, hashicorp/go-plugin for RPC-based plugins, and real-world examples from Kubernetes CSI and CNI drivers."
more_link: "yes"
url: "/go-plugin-architecture-patterns-guide/"
---

Plugin architectures allow systems to be extended without modifying core code, and Go provides several distinct approaches ranging from compiled shared objects to full RPC-based subprocess isolation. Choosing the wrong strategy leads to brittle systems, deployment nightmares, or security exposure — this guide covers every viable pattern with production-tested examples drawn from Kubernetes, Terraform, and Vault.

<!--more-->

# Go Plugin Architecture: Building Extensible Production Systems

## Section 1: The Go Plugin Package — Limitations and Real Use Cases

The standard library `plugin` package provides runtime loading of `.so` shared objects on Linux, macOS, and FreeBSD. Despite its appeal, most production systems avoid it for good reasons.

### How the Native Plugin Package Works

```go
// plugin_host/main.go
package main

import (
	"fmt"
	"log"
	"plugin"
)

// Greeter is the interface every plugin must satisfy.
type Greeter interface {
	Greet(name string) string
}

func main() {
	p, err := plugin.Open("./plugins/hello.so")
	if err != nil {
		log.Fatalf("open plugin: %v", err)
	}

	sym, err := p.Lookup("NewGreeter")
	if err != nil {
		log.Fatalf("lookup symbol: %v", err)
	}

	// The symbol must be a func that returns the interface.
	newGreeter, ok := sym.(func() Greeter)
	if !ok {
		log.Fatal("symbol has wrong type")
	}

	g := newGreeter()
	fmt.Println(g.Greet("world"))
}
```

```go
// plugins/hello/main.go  — built with: go build -buildmode=plugin -o hello.so .
package main

import "fmt"

type helloGreeter struct{}

func (h *helloGreeter) Greet(name string) string {
	return fmt.Sprintf("Hello, %s!", name)
}

// NewGreeter is the exported symbol the host looks up.
func NewGreeter() interface{ Greet(string) string } {
	return &helloGreeter{}
}
```

Build and run:

```bash
mkdir -p plugins
go build -buildmode=plugin -o plugins/hello.so ./plugins/hello/
go run ./plugin_host/
# Hello, world!
```

### Why Native Plugins Fail in Production

The `plugin` package has constraints that make it unsuitable for most platforms:

- **Windows is not supported.** Cross-platform tooling is impossible.
- **Both host and plugin must be compiled with the same Go version.** A patch release mismatch causes a panic at `plugin.Open`.
- **CGO must be enabled.** Containers that disable CGO cannot use this mechanism.
- **All imported packages must match exactly.** If the host imports `github.com/foo/bar v1.2.3` and the plugin imports `v1.2.4`, the load fails.
- **Plugins cannot be unloaded.** Memory held by a plugin is never freed.

Despite these limitations, native plugins are appropriate when:

1. The host and plugins are developed and deployed as a monorepo.
2. The target platform is Linux only (e.g., a kernel-adjacent tool).
3. Hot-reload is genuinely required and a restart is not acceptable.

---

## Section 2: Interface-Based Plugin Systems

The most idiomatic Go pattern is to define a stable interface and let callers register implementations. This is how the standard library itself works (`io.Reader`, `http.Handler`, `database/sql` drivers).

### Plugin Registry with Functional Options

```go
// registry/registry.go
package registry

import (
	"fmt"
	"sort"
	"sync"
)

// Transformer is the capability every plugin must provide.
type Transformer interface {
	Name() string
	Transform(input []byte) ([]byte, error)
}

// Factory creates a new Transformer from configuration.
type Factory func(config map[string]string) (Transformer, error)

// Registry holds all registered plugin factories.
type Registry struct {
	mu       sync.RWMutex
	factories map[string]Factory
}

// New returns an empty Registry.
func New() *Registry {
	return &Registry{factories: make(map[string]Factory)}
}

// Register associates a factory with a name. It panics on duplicate
// registration so that init() errors surface at startup, not runtime.
func (r *Registry) Register(name string, f Factory) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.factories[name]; exists {
		panic(fmt.Sprintf("registry: plugin %q registered twice", name))
	}
	r.factories[name] = f
}

// Create instantiates the named plugin with the provided config.
func (r *Registry) Create(name string, config map[string]string) (Transformer, error) {
	r.mu.RLock()
	f, ok := r.factories[name]
	r.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("registry: unknown plugin %q", name)
	}
	return f(config)
}

// List returns plugin names in alphabetical order.
func (r *Registry) List() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	names := make([]string, 0, len(r.factories))
	for n := range r.factories {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}
```

### Plugin Implementation Using init()

```go
// plugins/base64/plugin.go
package base64plugin

import (
	"encoding/base64"
	"myapp/registry"
)

func init() {
	registry.Default.Register("base64", func(config map[string]string) (registry.Transformer, error) {
		enc := base64.StdEncoding
		if config["url_safe"] == "true" {
			enc = base64.URLEncoding
		}
		return &b64Transformer{enc: enc}, nil
	})
}

type b64Transformer struct {
	enc *base64.Encoding
}

func (t *b64Transformer) Name() string { return "base64" }

func (t *b64Transformer) Transform(input []byte) ([]byte, error) {
	out := make([]byte, t.enc.EncodedLen(len(input)))
	t.enc.Encode(out, input)
	return out, nil
}
```

```go
// main.go — blank imports trigger init() registration
package main

import (
	"fmt"
	"log"
	"myapp/registry"

	_ "myapp/plugins/base64"
	_ "myapp/plugins/gzip"
)

func main() {
	t, err := registry.Default.Create("base64", map[string]string{"url_safe": "false"})
	if err != nil {
		log.Fatal(err)
	}
	out, err := t.Transform([]byte("hello plugin"))
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(string(out)) // aGVsbG8gcGx1Z2lu
}
```

### Versioning Plugin Interfaces

Interface versioning prevents breaking changes from cascading:

```go
// Stable contract — never change after v1 release.
type TransformerV1 interface {
	Name() string
	Transform(input []byte) ([]byte, error)
}

// Extended contract added in v2 — backward compatible.
type TransformerV2 interface {
	TransformerV1
	TransformWithContext(ctx context.Context, input []byte) ([]byte, error)
}

// Capability check at runtime.
func transformWithFallback(ctx context.Context, t TransformerV1, input []byte) ([]byte, error) {
	if v2, ok := t.(TransformerV2); ok {
		return v2.TransformWithContext(ctx, input)
	}
	return t.Transform(input)
}
```

---

## Section 3: hashicorp/go-plugin for RPC-Based Plugins

HashiCorp's `go-plugin` library powers Terraform, Vault, and Packer. It runs each plugin as a **child process** and communicates via gRPC (or net/rpc), providing:

- Full process isolation — a crashed plugin does not crash the host.
- Independent Go version per plugin.
- Cross-language plugins (any language that speaks gRPC).
- Automatic stdin/stdout handshake for trust establishment.

### Defining the Plugin Protocol

```protobuf
// proto/transformer.proto
syntax = "proto3";
package transformer;
option go_package = "myapp/proto/transformer";

service TransformerService {
  rpc Transform(TransformRequest) returns (TransformResponse);
}

message TransformRequest {
  bytes input = 1;
  map<string, string> config = 2;
}

message TransformResponse {
  bytes output = 1;
  string error  = 2;
}
```

Generate Go code:

```bash
buf generate
```

### Plugin Interface and gRPC Bridge

```go
// shared/interface.go
package shared

import (
	"context"

	"github.com/hashicorp/go-plugin"
	"google.golang.org/grpc"
	pb "myapp/proto/transformer"
)

// Handshake is shared between host and plugin binaries.
var Handshake = plugin.HandshakeConfig{
	ProtocolVersion:  1,
	MagicCookieKey:   "TRANSFORMER_PLUGIN",
	MagicCookieValue: "v1",
}

// PluginMap lists all plugin types by name.
var PluginMap = map[string]plugin.Plugin{
	"transformer": &TransformerGRPCPlugin{},
}

// Transformer is the interface plugins implement.
type Transformer interface {
	Transform(ctx context.Context, input []byte, config map[string]string) ([]byte, error)
}

// TransformerGRPCPlugin implements plugin.GRPCPlugin.
type TransformerGRPCPlugin struct {
	plugin.Plugin
	Impl Transformer
}

func (p *TransformerGRPCPlugin) GRPCServer(broker *plugin.GRPCBroker, s *grpc.Server) error {
	pb.RegisterTransformerServiceServer(s, &grpcServer{impl: p.Impl})
	return nil
}

func (p *TransformerGRPCPlugin) GRPCClient(
	ctx context.Context,
	broker *plugin.GRPCBroker,
	c *grpc.ClientConn,
) (interface{}, error) {
	return &grpcClient{client: pb.NewTransformerServiceClient(c)}, nil
}

// grpcServer adapts the Transformer interface to the gRPC service.
type grpcServer struct {
	pb.UnimplementedTransformerServiceServer
	impl Transformer
}

func (s *grpcServer) Transform(
	ctx context.Context,
	req *pb.TransformRequest,
) (*pb.TransformResponse, error) {
	out, err := s.impl.Transform(ctx, req.Input, req.Config)
	if err != nil {
		return &pb.TransformResponse{Error: err.Error()}, nil
	}
	return &pb.TransformResponse{Output: out}, nil
}

// grpcClient adapts the gRPC stub to the Transformer interface.
type grpcClient struct {
	client pb.TransformerServiceClient
}

func (c *grpcClient) Transform(
	ctx context.Context,
	input []byte,
	config map[string]string,
) ([]byte, error) {
	resp, err := c.client.Transform(ctx, &pb.TransformRequest{
		Input:  input,
		Config: config,
	})
	if err != nil {
		return nil, err
	}
	if resp.Error != "" {
		return nil, fmt.Errorf("plugin error: %s", resp.Error)
	}
	return resp.Output, nil
}
```

### Host-Side Plugin Loading

```go
// host/main.go
package main

import (
	"context"
	"fmt"
	"log"
	"os/exec"

	"github.com/hashicorp/go-plugin"
	"myapp/shared"
)

func main() {
	client := plugin.NewClient(&plugin.ClientConfig{
		HandshakeConfig: shared.Handshake,
		Plugins:         shared.PluginMap,
		Cmd:             exec.Command("./plugins/rot13-plugin"),
		AllowedProtocols: []plugin.Protocol{
			plugin.ProtocolGRPC,
		},
	})
	defer client.Kill()

	rpcClient, err := client.Client()
	if err != nil {
		log.Fatalf("client connect: %v", err)
	}

	raw, err := rpcClient.Dispense("transformer")
	if err != nil {
		log.Fatalf("dispense: %v", err)
	}

	t := raw.(shared.Transformer)
	out, err := t.Transform(context.Background(), []byte("Hello, Plugin!"), nil)
	if err != nil {
		log.Fatalf("transform: %v", err)
	}
	fmt.Printf("Result: %s\n", out)
}
```

### Plugin-Side Implementation

```go
// plugins/rot13/main.go
package main

import (
	"context"
	"log"
	"unicode"

	"github.com/hashicorp/go-plugin"
	"myapp/shared"
)

type rot13Transformer struct{}

func (r *rot13Transformer) Transform(
	_ context.Context,
	input []byte,
	_ map[string]string,
) ([]byte, error) {
	out := make([]byte, len(input))
	for i, b := range input {
		r := rune(b)
		switch {
		case r >= 'a' && r <= 'z':
			out[i] = byte('a' + (r-'a'+13)%26)
		case r >= 'A' && r <= 'Z':
			out[i] = byte('A' + (r-'A'+13)%26)
		default:
			if unicode.IsSpace(r) || !unicode.IsLetter(r) {
				out[i] = b
			} else {
				out[i] = b
			}
		}
	}
	return out, nil
}

func main() {
	plugin.Serve(&plugin.ServeConfig{
		HandshakeConfig: shared.Handshake,
		Plugins: map[string]plugin.Plugin{
			"transformer": &shared.TransformerGRPCPlugin{
				Impl: &rot13Transformer{},
			},
		},
		GRPCServer: plugin.DefaultGRPCServer,
	})
}
```

---

## Section 4: Plugin Discovery and Registration Patterns

Production systems need a way to find available plugins without hard-coding imports.

### Directory-Based Discovery

```go
// discovery/scanner.go
package discovery

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/hashicorp/go-plugin"
	"myapp/shared"
)

// Scanner discovers plugin binaries in a directory.
type Scanner struct {
	dir    string
	prefix string
}

func NewScanner(dir, prefix string) *Scanner {
	return &Scanner{dir: dir, prefix: prefix}
}

// Discover finds all binaries matching the prefix pattern.
func (s *Scanner) Discover() ([]string, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, fmt.Errorf("read plugin dir %s: %w", s.dir, err)
	}

	var found []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if strings.HasPrefix(e.Name(), s.prefix) {
			found = append(found, filepath.Join(s.dir, e.Name()))
		}
	}
	return found, nil
}

// Probe executes the plugin binary with --version to verify it responds.
func Probe(ctx context.Context, path string) error {
	cmd := exec.CommandContext(ctx, path, "--version")
	cmd.Stdout = os.Stderr // version output is informational
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
```

### Self-Describing Plugins

Plugins that expose metadata through a dedicated RPC method simplify the discovery process:

```go
// In the proto definition, add:
// rpc Describe(DescribeRequest) returns (DescribeResponse);

type PluginMetadata struct {
	Name        string
	Version     string
	APIVersion  int32
	Capabilities []string
}

// The host calls Describe() immediately after Dispense() to validate
// API compatibility before registering the plugin.
func validatePlugin(t shared.Transformer) error {
	type Describer interface {
		Describe(ctx context.Context) (*PluginMetadata, error)
	}
	d, ok := t.(Describer)
	if !ok {
		return fmt.Errorf("plugin does not implement Describe")
	}
	meta, err := d.Describe(context.Background())
	if err != nil {
		return err
	}
	if meta.APIVersion != 1 {
		return fmt.Errorf("plugin API version %d not supported (want 1)", meta.APIVersion)
	}
	return nil
}
```

---

## Section 5: Kubernetes Plugin Architecture Examples

Kubernetes demonstrates three production plugin patterns at scale.

### Admission Webhooks — Interface-Based Plugins

Admission webhooks are the canonical Go interface-based plugin pattern at the HTTP level.

```go
// webhook/server.go
package webhook

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	admissionv1 "k8s.io/api/admission/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Validator is implemented by each admission plugin.
type Validator interface {
	Validate(ctx context.Context, req *admissionv1.AdmissionRequest) ([]string, error)
}

// Mutator is implemented by mutation plugins.
type Mutator interface {
	Mutate(ctx context.Context, req *admissionv1.AdmissionRequest) ([]jsonPatch, error)
}

type jsonPatch struct {
	Op    string      `json:"op"`
	Path  string      `json:"path"`
	Value interface{} `json:"value,omitempty"`
}

// Server routes admission requests to registered plugins.
type Server struct {
	validators []Validator
	mutators   []Mutator
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var admReview admissionv1.AdmissionReview
	if err := json.NewDecoder(r.Body).Decode(&admReview); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var allWarnings []string
	for _, v := range s.validators {
		warnings, err := v.Validate(r.Context(), admReview.Request)
		if err != nil {
			s.deny(w, admReview, err.Error())
			return
		}
		allWarnings = append(allWarnings, warnings...)
	}

	var allPatches []jsonPatch
	for _, m := range s.mutators {
		patches, err := m.Mutate(r.Context(), admReview.Request)
		if err != nil {
			s.deny(w, admReview, err.Error())
			return
		}
		allPatches = append(allPatches, patches...)
	}

	s.allow(w, admReview, allWarnings, allPatches)
}

func (s *Server) deny(w http.ResponseWriter, r admissionv1.AdmissionReview, msg string) {
	r.Response = &admissionv1.AdmissionResponse{
		UID:     r.Request.UID,
		Allowed: false,
		Result:  &metav1.Status{Message: msg},
	}
	json.NewEncoder(w).Encode(r)
}

func (s *Server) allow(
	w http.ResponseWriter,
	r admissionv1.AdmissionReview,
	warnings []string,
	patches []jsonPatch,
) {
	resp := &admissionv1.AdmissionResponse{
		UID:      r.Request.UID,
		Allowed:  true,
		Warnings: warnings,
	}
	if len(patches) > 0 {
		patchBytes, _ := json.Marshal(patches)
		pt := admissionv1.PatchTypeJSONPatch
		resp.Patch = patchBytes
		resp.PatchType = &pt
	}
	r.Response = resp
	json.NewEncoder(w).Encode(r)
}
```

### CNI Plugins — Binary Execution Pattern

Container Network Interface plugins are standalone binaries called by the container runtime. The host (kubelet/containerd) discovers plugins by scanning a directory:

```bash
# CNI plugin discovery path
ls /opt/cni/bin/
# bandwidth  bridge  dhcp  firewall  flannel  host-device
# host-local  ipvlan  loopback  macvlan  portmap  ptp  sbr  static  tuning  vlan  vrf
```

```go
// A minimal CNI plugin binary skeleton
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/containernetworking/cni/pkg/skel"
	"github.com/containernetworking/cni/pkg/types"
	current "github.com/containernetworking/cni/pkg/types/100"
	"github.com/containernetworking/cni/pkg/version"
)

type NetConf struct {
	types.NetConf
	IPAM   types.IPAM `json:"ipam,omitempty"`
	MTU    int        `json:"mtu,omitempty"`
}

func cmdAdd(args *skel.CmdArgs) error {
	conf := &NetConf{}
	if err := json.Unmarshal(args.StdinData, conf); err != nil {
		return fmt.Errorf("parse config: %w", err)
	}

	result := &current.Result{
		CNIVersion: current.ImplementedSpecVersion,
	}
	return types.PrintResult(result, conf.CNIVersion)
}

func cmdDel(args *skel.CmdArgs) error { return nil }
func cmdCheck(args *skel.CmdArgs) error { return nil }

func main() {
	skel.PluginMain(cmdAdd, cmdCheck, cmdDel,
		version.All,
		"minimal CNI plugin v0.1.0",
	)
}
```

### CSI Drivers — gRPC Plugin Pattern

Container Storage Interface drivers implement three gRPC services: Identity, Controller, and Node. This mirrors the hashicorp/go-plugin pattern but uses a Unix socket instead of a child process:

```go
// csi/identity.go
package csi

import (
	"context"

	csi "github.com/container-storage-interface/spec/lib/go/csi"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type IdentityServer struct {
	csi.UnimplementedIdentityServer
	name    string
	version string
}

func (s *IdentityServer) GetPluginInfo(
	_ context.Context,
	_ *csi.GetPluginInfoRequest,
) (*csi.GetPluginInfoResponse, error) {
	if s.name == "" {
		return nil, status.Error(codes.Unavailable, "driver name not configured")
	}
	return &csi.GetPluginInfoResponse{
		Name:          s.name,
		VendorVersion: s.version,
	}, nil
}

func (s *IdentityServer) GetPluginCapabilities(
	_ context.Context,
	_ *csi.GetPluginCapabilitiesRequest,
) (*csi.GetPluginCapabilitiesResponse, error) {
	return &csi.GetPluginCapabilitiesResponse{
		Capabilities: []*csi.PluginCapability{
			{
				Type: &csi.PluginCapability_Service_{
					Service: &csi.PluginCapability_Service{
						Type: csi.PluginCapability_Service_CONTROLLER_SERVICE,
					},
				},
			},
		},
	}, nil
}
```

---

## Section 6: Testing Plugin Systems

Plugin systems require testing at three levels: the contract, the individual plugin, and the integration.

### Contract Testing with Mock Plugins

```go
// testing/fake_transformer.go
package plugintest

import (
	"context"
	"fmt"
)

// FakeTransformer is a test double for the Transformer interface.
type FakeTransformer struct {
	name      string
	responses map[string][]byte
	errors    map[string]error
	calls     []TransformCall
}

type TransformCall struct {
	Input  []byte
	Config map[string]string
}

func NewFake(name string) *FakeTransformer {
	return &FakeTransformer{
		name:      name,
		responses: make(map[string][]byte),
		errors:    make(map[string]error),
	}
}

func (f *FakeTransformer) RespondWith(input string, output []byte) {
	f.responses[input] = output
}

func (f *FakeTransformer) FailWith(input string, err error) {
	f.errors[input] = err
}

func (f *FakeTransformer) Name() string { return f.name }

func (f *FakeTransformer) Transform(
	_ context.Context,
	input []byte,
	config map[string]string,
) ([]byte, error) {
	f.calls = append(f.calls, TransformCall{Input: input, Config: config})
	key := string(input)
	if err, ok := f.errors[key]; ok {
		return nil, err
	}
	if out, ok := f.responses[key]; ok {
		return out, nil
	}
	return nil, fmt.Errorf("no stub for input %q", key)
}

func (f *FakeTransformer) CallCount() int { return len(f.calls) }
func (f *FakeTransformer) Call(i int) TransformCall { return f.calls[i] }
```

### Integration Tests with the Real Plugin Binary

```go
// integration/plugin_test.go
package integration_test

import (
	"context"
	"os"
	"os/exec"
	"testing"

	"github.com/hashicorp/go-plugin"
	"myapp/shared"
)

func TestRot13Plugin(t *testing.T) {
	// Build the plugin binary as part of the test.
	build := exec.Command("go", "build", "-o", "testdata/rot13-plugin", "./plugins/rot13")
	build.Stdout = os.Stderr
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		t.Fatalf("build plugin: %v", err)
	}

	client := plugin.NewClient(&plugin.ClientConfig{
		HandshakeConfig:  shared.Handshake,
		Plugins:          shared.PluginMap,
		Cmd:              exec.Command("./testdata/rot13-plugin"),
		AllowedProtocols: []plugin.Protocol{plugin.ProtocolGRPC},
	})
	t.Cleanup(client.Kill)

	rpcClient, err := client.Client()
	if err != nil {
		t.Fatalf("connect: %v", err)
	}

	raw, err := rpcClient.Dispense("transformer")
	if err != nil {
		t.Fatalf("dispense: %v", err)
	}

	tr := raw.(shared.Transformer)

	tests := []struct {
		input string
		want  string
	}{
		{"Hello", "Uryyb"},
		{"world", "jbeyq"},
		{"ROT13", "EBG13"},
	}
	for _, tc := range tests {
		got, err := tr.Transform(context.Background(), []byte(tc.input), nil)
		if err != nil {
			t.Errorf("Transform(%q): %v", tc.input, err)
			continue
		}
		if string(got) != tc.want {
			t.Errorf("Transform(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}
```

---

## Section 7: Plugin API Versioning Strategies

Long-lived plugin APIs require a disciplined versioning strategy to avoid breaking existing plugins when the host evolves.

### Semantic Import Versioning for Plugin Contracts

```
myapp/
  shared/
    v1/   ← stable, never changed
    v2/   ← additive changes only
```

```go
// shared/v2/interface.go — v2 adds middleware support
package sharedv2

import (
	"context"
	sharedv1 "myapp/shared/v1"
)

// Transformer extends v1 with middleware hooks.
type Transformer interface {
	sharedv1.Transformer
	// Before is called before Transform and can modify input.
	Before(ctx context.Context, input []byte) ([]byte, error)
	// After is called after Transform and can modify output.
	After(ctx context.Context, output []byte) ([]byte, error)
}

// UpgradeV1 wraps a v1 plugin to satisfy the v2 interface.
func UpgradeV1(t sharedv1.Transformer) Transformer {
	return &v1Adapter{Transformer: t}
}

type v1Adapter struct {
	sharedv1.Transformer
}

func (a *v1Adapter) Before(_ context.Context, input []byte) ([]byte, error) {
	return input, nil // no-op
}

func (a *v1Adapter) After(_ context.Context, output []byte) ([]byte, error) {
	return output, nil // no-op
}
```

### Version Negotiation at Startup

```go
// host/negotiate.go
package host

import (
	"context"
	"fmt"
	"log/slog"

	sharedv1 "myapp/shared/v1"
	sharedv2 "myapp/shared/v2"
)

func negotiateTransformer(raw interface{}) (sharedv2.Transformer, error) {
	switch t := raw.(type) {
	case sharedv2.Transformer:
		slog.Info("plugin supports v2 interface")
		return t, nil
	case sharedv1.Transformer:
		slog.Info("plugin supports v1 interface, wrapping with adapter")
		return sharedv2.UpgradeV1(t), nil
	default:
		return nil, fmt.Errorf("plugin does not implement any known Transformer interface")
	}
}
```

---

## Section 8: Production Deployment Considerations

### Plugin Binary Distribution

When using subprocess-based plugins, ship plugins as versioned artifacts:

```yaml
# .plugin-manifest.yaml
apiVersion: plugins/v1
plugins:
  - name: rot13
    version: "1.2.3"
    sha256: "a9f3e2b1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1"
    url: "https://artifacts.example.com/plugins/rot13/v1.2.3/rot13-linux-amd64"
  - name: gzip
    version: "2.0.1"
    sha256: "b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1"
    url: "https://artifacts.example.com/plugins/gzip/v2.0.1/gzip-linux-amd64"
```

```go
// installer/install.go
package installer

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

func InstallPlugin(destDir, url, expectedHash string) error {
	resp, err := http.Get(url)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()

	h := sha256.New()
	data, err := io.ReadAll(io.TeeReader(resp.Body, h))
	if err != nil {
		return fmt.Errorf("read: %w", err)
	}

	got := hex.EncodeToString(h.Sum(nil))
	if got != expectedHash {
		return fmt.Errorf("sha256 mismatch: got %s, want %s", got, expectedHash)
	}

	dest := filepath.Join(destDir, filepath.Base(url))
	if err := os.WriteFile(dest, data, 0o755); err != nil {
		return fmt.Errorf("write %s: %w", dest, err)
	}
	return nil
}
```

### Plugin Sandboxing with Seccomp

When plugins handle untrusted data, restrict syscalls:

```yaml
# k8s manifest for a plugin runner pod
apiVersion: v1
kind: Pod
metadata:
  name: plugin-runner
spec:
  securityContext:
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: runner
      image: myapp/plugin-runner:1.0.0
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 65534
        capabilities:
          drop: ["ALL"]
```

---

## Section 9: Choosing the Right Pattern

| Pattern | Isolation | Cross-language | Hot Reload | Complexity | Best For |
|---|---|---|---|---|---|
| Native `plugin` pkg | None | No | Yes | Low | Single-team monorepos on Linux |
| Interface + `init()` | None | No | No | Low | Standard library-style extensibility |
| hashicorp/go-plugin | Full process | Yes (gRPC) | No | Medium | Terraform-style CLIs, trusted plugins |
| HTTP webhook | Full network | Yes | Yes | Medium | Kubernetes admission controllers |
| Subprocess binary | Full process | Yes | No | Low | CNI/CSI-style OS-level plugins |

For most production services, the **interface + init() registry** pattern provides the best balance of simplicity and safety, since all code runs in the same process with the same memory model. Reserve hashicorp/go-plugin for scenarios where plugin authors are third parties, plugin crashes must not affect the host, or Go version independence is required.
