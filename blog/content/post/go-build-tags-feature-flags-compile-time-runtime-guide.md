---
title: "Go Build Tags and Feature Flags: Compile-Time vs Runtime Configuration"
date: 2031-05-30T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Build Tags", "Feature Flags", "CI/CD", "flipt", "unleash"]
categories:
- Go
- DevOps
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Go build constraints, integration test build tags, feature flag libraries including flipt and unleash-client-go, and the trade-offs between compile-time and runtime configuration."
more_link: "yes"
url: "/go-build-tags-feature-flags-compile-time-runtime-guide/"
---

Go's build system provides two complementary mechanisms for varying program behavior: build tags that make decisions at compile time, and feature flags that make decisions at runtime. Both are essential tools in a mature engineering organization. This guide covers the complete picture: build constraint syntax for OS, architecture, and custom tags; the standard pattern for integration test separation; and runtime feature flag systems including flipt and the Unleash Go client, with a clear framework for choosing between compile-time and runtime approaches.

<!--more-->

# Go Build Tags and Feature Flags: Compile-Time vs Runtime Configuration

## Section 1: Build Constraint Fundamentals

Build constraints (also called build tags) are annotations that tell the Go toolchain whether to include a file in a build. They appear as a comment at the top of a Go source file before the package declaration.

### Modern Build Constraint Syntax (Go 1.17+)

Go 1.17 introduced the `//go:build` directive as the canonical form. The older `// +build` form is still supported but deprecated:

```go
//go:build linux && amd64

package main
```

The `//go:build` form uses standard Go boolean expression syntax:
- `&&` for AND
- `||` for OR
- `!` for NOT
- Parentheses for grouping

```go
//go:build (linux || darwin) && !386

package platform
```

### Automatic Platform Tags

The Go toolchain automatically defines tags based on the build environment:

```go
//go:build linux       // GOOS=linux
//go:build darwin      // GOOS=darwin
//go:build windows     // GOOS=windows

//go:build amd64       // GOARCH=amd64
//go:build arm64       // GOARCH=arm64
//go:build arm         // GOARCH=arm

//go:build go1.21      // Go version >= 1.21
//go:build go1.22      // Go version >= 1.22
```

### Listing All Available Tags

```bash
# See all implicit build constraints
go env GOARCH GOOS

# See all tags that would be set for a build
go list -f '{{.GoFiles}}' .

# Check which files would be compiled
go list -f '{{.GoFiles}}{{.CgoFiles}}' ./...

# Use go build -v to see what is compiled
go build -v ./...
```

## Section 2: Platform-Specific Code

Build tags enable clean platform abstraction. The standard pattern is a common interface with platform-specific implementations:

### File Layout

```
syscalls/
├── syscalls.go         # //go:build !linux && !darwin
├── syscalls_linux.go   # //go:build linux
├── syscalls_darwin.go  # //go:build darwin
└── syscalls_test.go    # tests for common interface
```

### Common Interface

```go
// syscalls/syscalls.go
//go:build !linux && !darwin

package syscalls

import "errors"

// GetMemoryInfo returns memory usage statistics.
func GetMemoryInfo() (MemoryInfo, error) {
    return MemoryInfo{}, errors.New("not supported on this platform")
}

type MemoryInfo struct {
    TotalBytes     uint64
    AvailableBytes uint64
    UsedBytes      uint64
}
```

### Linux Implementation

```go
// syscalls/syscalls_linux.go
//go:build linux

package syscalls

import "syscall"

func GetMemoryInfo() (MemoryInfo, error) {
    var info syscall.Sysinfo_t
    if err := syscall.Sysinfo(&info); err != nil {
        return MemoryInfo{}, err
    }
    total := info.Totalram * uint64(info.Unit)
    free := info.Freeram * uint64(info.Unit)
    return MemoryInfo{
        TotalBytes:     total,
        AvailableBytes: free,
        UsedBytes:      total - free,
    }, nil
}
```

### macOS Implementation

```go
// syscalls/syscalls_darwin.go
//go:build darwin

package syscalls

import (
    "os/exec"
    "strconv"
    "strings"
)

func GetMemoryInfo() (MemoryInfo, error) {
    out, err := exec.Command("sysctl", "-n", "hw.memsize").Output()
    if err != nil {
        return MemoryInfo{}, err
    }
    total, err := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
    if err != nil {
        return MemoryInfo{}, err
    }
    // Simplified: macOS available memory requires vm_stat parsing
    return MemoryInfo{
        TotalBytes: total,
    }, nil
}
```

## Section 3: Integration Test Build Tags

The most common use of custom build tags in Go projects is separating unit tests from integration tests. Integration tests require external services (databases, message brokers, Kubernetes clusters) and should not run in every `go test ./...` invocation.

### The Standard Pattern

```go
// database/integration_test.go
//go:build integration

package database_test

import (
    "context"
    "os"
    "testing"
    "time"

    "github.com/jmoiron/sqlx"
    _ "github.com/lib/pq"
)

func TestUserRepository_CreateAndFind(t *testing.T) {
    dsn := os.Getenv("TEST_DATABASE_URL")
    if dsn == "" {
        t.Skip("TEST_DATABASE_URL not set")
    }

    db, err := sqlx.Connect("postgres", dsn)
    if err != nil {
        t.Fatalf("failed to connect: %v", err)
    }
    defer db.Close()

    repo := NewUserRepository(db)
    ctx := context.Background()

    user, err := repo.Create(ctx, CreateUserInput{
        Email: "test@example.com",
        Name:  "Test User",
    })
    if err != nil {
        t.Fatalf("Create failed: %v", err)
    }
    if user.ID == "" {
        t.Fatal("expected non-empty user ID")
    }

    found, err := repo.FindByEmail(ctx, "test@example.com")
    if err != nil {
        t.Fatalf("FindByEmail failed: %v", err)
    }
    if found.ID != user.ID {
        t.Errorf("expected ID %s, got %s", user.ID, found.ID)
    }
}
```

### Running Tests by Tag

```bash
# Run only unit tests (default)
go test ./...

# Run integration tests
go test -tags=integration ./...

# Run both
go test -tags=integration,e2e ./...

# Run with race detector
go test -race -tags=integration ./...
```

### Multiple Tag Conventions

Many projects define several test categories:

```go
// slow_test.go - tests that take > 1 second
//go:build slow

// e2e_test.go - tests requiring a live cluster
//go:build e2e

// smoke_test.go - basic connectivity tests
//go:build smoke
```

### Makefile Integration

```makefile
.PHONY: test
test:
	go test -race -count=1 ./...

.PHONY: test-integration
test-integration:
	go test -race -count=1 -tags=integration -timeout=5m ./...

.PHONY: test-e2e
test-e2e:
	go test -count=1 -tags=e2e -timeout=15m ./e2e/...

.PHONY: test-all
test-all: test test-integration test-e2e

.PHONY: test-cover
test-cover:
	go test -race -count=1 -tags=integration \
		-coverprofile=coverage.out \
		-coverpkg=./... \
		./...
	go tool cover -html=coverage.out -o coverage.html
```

## Section 4: Version-Gated Code

The `go1.X` tags allow you to write code that only compiles on specific Go versions:

```go
// atomic_go121.go
//go:build go1.21

package cache

import "sync/atomic"

// AtomicInt64 uses the new sync/atomic.Int64 type from Go 1.19+
type AtomicInt64 struct {
    v atomic.Int64
}

func (a *AtomicInt64) Add(delta int64) int64 { return a.v.Add(delta) }
func (a *AtomicInt64) Load() int64           { return a.v.Load() }
func (a *AtomicInt64) Store(v int64)         { a.v.Store(v) }
```

```go
// atomic_legacy.go
//go:build !go1.21

package cache

import "sync/atomic"

// AtomicInt64 uses the older sync/atomic API for Go < 1.19
type AtomicInt64 struct {
    v int64
}

func (a *AtomicInt64) Add(delta int64) int64 { return atomic.AddInt64(&a.v, delta) }
func (a *AtomicInt64) Load() int64           { return atomic.LoadInt64(&a.v) }
func (a *AtomicInt64) Store(v int64)         { atomic.StoreInt64(&a.v, v) }
```

## Section 5: Custom Build Tags for Feature Variants

Custom tags can enable or disable entire features at compile time. This is useful for building stripped-down binaries or enabling experimental features:

```go
// tracing/tracing.go
//go:build !notrace

package tracing

import (
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/trace"
)

var tracer trace.Tracer

func Init(serviceName string) error {
    // ... real OpenTelemetry initialization
    tracer = otel.Tracer(serviceName)
    return nil
}

func StartSpan(ctx context.Context, name string) (context.Context, trace.Span) {
    return tracer.Start(ctx, name)
}
```

```go
// tracing/tracing_noop.go
//go:build notrace

package tracing

import "go.opentelemetry.io/otel/trace"

func Init(serviceName string) error { return nil }

func StartSpan(ctx context.Context, name string) (context.Context, trace.Span) {
    return ctx, trace.SpanFromContext(ctx)
}
```

Build with tracing disabled:
```bash
go build -tags=notrace -o app-minimal ./cmd/server
```

## Section 6: Runtime Feature Flags with flipt

flipt is an open-source feature flag server that supports Go, with a clean gRPC/HTTP API. It enables A/B testing, gradual rollouts, and kill switches without redeployment.

### Installing and Running flipt

```bash
# Docker deployment
docker run --rm -p 8080:8080 -p 9000:9000 \
  -v $(pwd)/config:/etc/flipt \
  flipt/flipt:latest

# Or with docker-compose
cat > docker-compose.yaml << 'EOF'
version: '3'
services:
  flipt:
    image: flipt/flipt:latest
    ports:
      - "8080:8080"  # HTTP/UI
      - "9000:9000"  # gRPC
    volumes:
      - flipt-data:/var/opt/flipt
volumes:
  flipt-data:
EOF
docker compose up -d
```

### Go Client Integration

```go
// features/flipt.go
package features

import (
    "context"
    "fmt"
    "log/slog"

    flipt "go.flipt.io/flipt/sdk/go"
    grpctransport "go.flipt.io/flipt/sdk/go/grpc"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

type FliptClient struct {
    client flipt.SDK
    ns     string
}

func NewFliptClient(addr, namespace string) (*FliptClient, error) {
    conn, err := grpc.NewClient(addr,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil {
        return nil, fmt.Errorf("failed to connect to flipt: %w", err)
    }
    transport := grpctransport.NewTransport(conn)
    sdk := flipt.New(transport)
    return &FliptClient{client: sdk, ns: namespace}, nil
}

// IsEnabled checks a boolean flag.
func (f *FliptClient) IsEnabled(ctx context.Context, flagKey, entityID string) bool {
    result, err := f.client.Evaluation().Boolean(ctx, &flipt.EvaluationRequest{
        NamespaceKey: f.ns,
        FlagKey:      flagKey,
        EntityId:     entityID,
    })
    if err != nil {
        slog.Error("flipt evaluation failed", "flag", flagKey, "error", err)
        return false // fail closed
    }
    return result.Enabled
}

// GetVariant returns the variant for a multivariate flag.
func (f *FliptClient) GetVariant(ctx context.Context, flagKey, entityID string, attrs map[string]string) string {
    result, err := f.client.Evaluation().Variant(ctx, &flipt.EvaluationRequest{
        NamespaceKey: f.ns,
        FlagKey:      flagKey,
        EntityId:     entityID,
        Context:      attrs,
    })
    if err != nil {
        slog.Error("flipt variant evaluation failed", "flag", flagKey, "error", err)
        return "default"
    }
    if result.Match {
        return result.VariantKey
    }
    return "default"
}
```

### Using flipt in Application Code

```go
// handlers/checkout.go
package handlers

import (
    "net/http"

    "myapp/features"
)

type CheckoutHandler struct {
    flags *features.FliptClient
}

func (h *CheckoutHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    userID := r.Header.Get("X-User-ID")
    ctx := r.Context()

    // Check if new checkout flow is enabled for this user
    if h.flags.IsEnabled(ctx, "new-checkout-flow", userID) {
        h.handleNewCheckout(w, r)
        return
    }
    h.handleLegacyCheckout(w, r)
}

func (h *CheckoutHandler) handleNewCheckout(w http.ResponseWriter, r *http.Request) {
    // New implementation
    w.Header().Set("X-Checkout-Version", "v2")
    // ...
}

func (h *CheckoutHandler) handleLegacyCheckout(w http.ResponseWriter, r *http.Request) {
    // Legacy implementation
    w.Header().Set("X-Checkout-Version", "v1")
    // ...
}
```

## Section 7: Runtime Feature Flags with Unleash

Unleash is a widely-used enterprise feature management platform with a mature Go SDK:

```bash
go get github.com/Unleash/unleash-client-go/v4
```

### Unleash Client Setup

```go
// features/unleash.go
package features

import (
    "context"
    "fmt"
    "os"
    "time"

    "github.com/Unleash/unleash-client-go/v4"
    "github.com/Unleash/unleash-client-go/v4/context"
)

type UnleashClient struct {
    initialized bool
}

func NewUnleashClient(serverURL, appName, token string) (*UnleashClient, error) {
    err := unleash.Initialize(
        unleash.WithUrl(serverURL),
        unleash.WithAppName(appName),
        unleash.WithCustomHeaders(http.Header{
            "Authorization": []string{token},
        }),
        unleash.WithRefreshInterval(15*time.Second),
        unleash.WithMetricsInterval(60*time.Second),
        unleash.WithListener(&unleash.DebugListener{}),
    )
    if err != nil {
        return nil, fmt.Errorf("failed to initialize unleash: %w", err)
    }
    return &UnleashClient{initialized: true}, nil
}

// IsEnabled checks a feature toggle.
func (u *UnleashClient) IsEnabled(feature string, opts ...unleash.FeatureOption) bool {
    return unleash.IsEnabled(feature, opts...)
}

// IsEnabledForUser checks a feature toggle for a specific user context.
func (u *UnleashClient) IsEnabledForUser(feature, userID string, properties map[string]string) bool {
    ctx := &context.Context{
        UserId:     userID,
        Properties: properties,
    }
    return unleash.IsEnabled(feature, unleash.WithContext(ctx))
}

// IsEnabledForRequest extracts context from an HTTP request.
func (u *UnleashClient) IsEnabledForRequest(feature string, r *http.Request) bool {
    userID := r.Header.Get("X-User-ID")
    sessionID := r.Header.Get("X-Session-ID")
    ctx := &context.Context{
        UserId:    userID,
        SessionId: sessionID,
        RemoteAddress: r.RemoteAddr,
    }
    return unleash.IsEnabled(feature, unleash.WithContext(ctx))
}

// Close shuts down background goroutines.
func (u *UnleashClient) Close() error {
    return unleash.Close()
}
```

### Unleash in Middleware

```go
// middleware/feature_gate.go
package middleware

import (
    "net/http"

    "myapp/features"
)

// FeatureGate returns a middleware that gates a route behind a feature flag.
func FeatureGate(flags *features.UnleashClient, flagName string, fallback http.Handler) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if flags.IsEnabledForRequest(flagName, r) {
                next.ServeHTTP(w, r)
                return
            }
            if fallback != nil {
                fallback.ServeHTTP(w, r)
                return
            }
            http.Error(w, "Feature not available", http.StatusNotFound)
        })
    }
}
```

## Section 8: Environment-Based Flag Evaluation

For simpler use cases, environment variable-based flags avoid the need for external services:

```go
// features/env.go
package features

import (
    "os"
    "strconv"
    "strings"
    "sync"
)

// EnvFlags reads feature flags from environment variables.
// Convention: FEATURE_<FLAG_NAME>=true|false|1|0|enabled|disabled
type EnvFlags struct {
    prefix string
    cache  sync.Map
}

func NewEnvFlags(prefix string) *EnvFlags {
    return &EnvFlags{prefix: prefix}
}

func (e *EnvFlags) IsEnabled(flag string) bool {
    key := e.envKey(flag)

    if v, ok := e.cache.Load(key); ok {
        return v.(bool)
    }

    val := os.Getenv(key)
    enabled := parseFlag(val)
    e.cache.Store(key, enabled)
    return enabled
}

func (e *EnvFlags) envKey(flag string) string {
    upper := strings.ToUpper(strings.ReplaceAll(flag, "-", "_"))
    if e.prefix != "" {
        return e.prefix + "_" + upper
    }
    return upper
}

func parseFlag(val string) bool {
    switch strings.ToLower(strings.TrimSpace(val)) {
    case "true", "1", "yes", "enabled", "on":
        return true
    default:
        return false
    }
}

// Refresh clears the cache, forcing re-read from environment.
// Useful in tests or after runtime configuration changes.
func (e *EnvFlags) Refresh() {
    e.cache.Range(func(key, _ any) bool {
        e.cache.Delete(key)
        return true
    })
}
```

### Usage with Kubernetes ConfigMap

```yaml
# configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: feature-flags
data:
  FEATURE_NEW_PAYMENT_FLOW: "true"
  FEATURE_EXPERIMENTAL_CACHE: "false"
  FEATURE_BETA_UI: "true"
```

```yaml
# deployment.yaml
spec:
  template:
    spec:
      containers:
        - name: app
          envFrom:
            - configMapRef:
                name: feature-flags
```

## Section 9: Compile-Time vs Runtime Flags - Decision Framework

Choosing between compile-time build tags and runtime feature flags requires understanding their respective properties:

### Compile-Time Build Tags

**Use when:**
- Behavior varies by target platform (Linux, macOS, Windows, ARM)
- Removing a feature entirely eliminates security surface area (e.g., debug endpoints)
- Binary size matters and unused code should not be included
- The feature is permanently enabled or disabled per deployment target
- You need dead code elimination (compiler removes unreachable paths)

**Do not use when:**
- You need to change behavior without rebuilding
- Different users should see different behavior from the same binary
- You want gradual rollouts or A/B testing
- You need to roll back a feature without redeployment

### Runtime Feature Flags

**Use when:**
- You want to release features progressively (canary users, % rollouts)
- You need kill switches for risk management
- A/B testing requires routing users to different code paths
- Operations teams need to change behavior without engineering involvement
- You want to test features in production with a subset of traffic

**Do not use when:**
- The feature involves platform-specific syscalls
- Binary size is a hard constraint
- The overhead of a flag check in a hot path is unacceptable
- The feature is always off or always on for all users

### Performance Considerations

```go
// Compile-time: zero runtime cost after compilation
//go:build premium

func processPayment(ctx context.Context, amount decimal.Decimal) error {
    return premiumProcessor.Process(ctx, amount)
}

// Runtime flag in hot path: ~100ns per check from memory cache
func processOrder(ctx context.Context, order Order) error {
    if flags.IsEnabled(ctx, "new-order-flow", order.UserID) {
        return newProcessor.Process(ctx, order)
    }
    return legacyProcessor.Process(ctx, order)
}

// Cached runtime flag: ~10ns (atomic read)
var useNewFlow atomic.Bool // set by background goroutine

func processOrderFast(ctx context.Context, order Order) error {
    if useNewFlow.Load() {
        return newProcessor.Process(ctx, order)
    }
    return legacyProcessor.Process(ctx, order)
}
```

## Section 10: Testing Feature Flags

Feature flags require careful testing to ensure both paths work correctly.

### Testing Compile-Time Tags

```bash
# Test all tag combinations
go test ./... -tags=""         # default build
go test ./... -tags="premium"  # premium features
go test ./... -tags="notrace"  # minimal build

# Use build matrix in CI
for tags in "" premium notrace "premium,notrace"; do
    echo "Testing with tags: $tags"
    go test ./... -tags="$tags"
done
```

### Unit Testing Runtime Flags

```go
// features/flags_test.go
package features_test

import (
    "testing"

    "myapp/features"
)

type mockFlags struct {
    enabled map[string]bool
}

func (m *mockFlags) IsEnabled(flag string) bool {
    return m.enabled[flag]
}

func TestCheckoutHandler_NewFlow(t *testing.T) {
    tests := []struct {
        name        string
        flagEnabled bool
        wantVersion string
    }{
        {
            name:        "new flow when flag enabled",
            flagEnabled: true,
            wantVersion: "v2",
        },
        {
            name:        "legacy flow when flag disabled",
            flagEnabled: false,
            wantVersion: "v1",
        },
    }

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            flags := &mockFlags{
                enabled: map[string]bool{
                    "new-checkout-flow": tc.flagEnabled,
                },
            }
            // Test with mock flags
            handler := &CheckoutHandler{flags: flags}
            // ... assert behavior
        })
    }
}
```

### Testing EnvFlags

```go
func TestEnvFlags_IsEnabled(t *testing.T) {
    tests := []struct {
        envVal  string
        want    bool
    }{
        {"true", true},
        {"TRUE", true},
        {"1", true},
        {"yes", true},
        {"enabled", true},
        {"false", false},
        {"0", false},
        {"", false},
        {"no", false},
    }

    for _, tc := range tests {
        t.Run(fmt.Sprintf("val=%q", tc.envVal), func(t *testing.T) {
            t.Setenv("FEATURE_TEST_FLAG", tc.envVal)
            flags := features.NewEnvFlags("FEATURE")
            got := flags.IsEnabled("test-flag")
            if got != tc.want {
                t.Errorf("IsEnabled(%q) = %v, want %v", tc.envVal, got, tc.want)
            }
        })
    }
}
```

### Integration Testing with a Live flipt Instance

```go
//go:build integration

package features_test

import (
    "context"
    "os"
    "testing"

    "myapp/features"
)

func TestFliptClient_Integration(t *testing.T) {
    addr := os.Getenv("FLIPT_GRPC_ADDR")
    if addr == "" {
        t.Skip("FLIPT_GRPC_ADDR not set")
    }

    client, err := features.NewFliptClient(addr, "test")
    if err != nil {
        t.Fatalf("failed to create client: %v", err)
    }

    ctx := context.Background()

    // Flag must exist in flipt before running this test
    enabled := client.IsEnabled(ctx, "test-flag", "user-123")
    t.Logf("test-flag for user-123: %v", enabled)
    // Don't assert exact value since it depends on server config
    // Instead verify the call didn't panic or error
}
```

## Section 11: Managing Build Tags at Scale

In large codebases, build tags require governance:

### Enforcing Tag Consistency

```go
// internal/lint/buildtags.go
// This is a custom linter that runs as part of go vet or golangci-lint.
// It ensures all integration test files have the correct build tag.

//go:build tools

package lint

// Run the check:
// go run ./internal/lint/buildtags.go ./...
```

### golangci-lint Configuration

```yaml
# .golangci.yml
linters-settings:
  gocritic:
    enabled-checks:
      - buildTagsChecker

issues:
  exclude-rules:
    # Allow init() in feature flag bootstrap
    - path: features/
      linters:
        - gochecknoinits
```

### Documentation Convention

Document each custom build tag in a central file:

```go
// internal/buildtags/doc.go

// Package buildtags documents all custom build tags used in this project.
//
// # Integration Tags
//
// integration - enables database and external service integration tests
// e2e         - enables end-to-end tests requiring a live cluster
// slow        - enables tests that take more than 1 second
//
// # Feature Tags
//
// premium     - enables premium feature code paths
// notrace     - disables OpenTelemetry tracing instrumentation
// noauth      - disables authentication (development only, NEVER in production)
//
// # Platform Tags (automatically set by Go toolchain)
//
// linux, darwin, windows - GOOS
// amd64, arm64, arm      - GOARCH
// go1.21, go1.22         - minimum Go version
package buildtags
```

## Section 12: Combining Build Tags and Runtime Flags

The most sophisticated systems combine both approaches: build tags gate which flag-checking code is compiled in, and runtime flags control behavior within those code paths:

```go
// analytics/analytics.go
//go:build !noanalytics

package analytics

import (
    "context"

    "myapp/features"
)

type Tracker struct {
    flags features.FlagChecker
}

func (t *Tracker) TrackEvent(ctx context.Context, event Event) {
    if !t.flags.IsEnabled("analytics-enabled") {
        return
    }
    if t.flags.IsEnabled("detailed-analytics") {
        t.trackDetailed(ctx, event)
        return
    }
    t.trackBasic(ctx, event)
}
```

```go
// analytics/analytics_noop.go
//go:build noanalytics

package analytics

// Tracker is a no-op implementation when analytics is compiled out.
// Zero overhead: all calls are eliminated by the compiler.
type Tracker struct{}

func (t *Tracker) TrackEvent(_ context.Context, _ Event) {}
```

This pattern gives you:
1. Binary size savings by compiling out analytics entirely for certain targets (`noanalytics` tag)
2. Runtime control over analytics behavior via feature flags when analytics is compiled in
3. A/B testing of different analytics collection strategies without rebuilding

## Conclusion

Build tags and feature flags are complementary tools that serve different purposes. Build tags are for structural variation: platform support, binary variants, and test categorization. Runtime feature flags are for behavioral variation: gradual rollouts, A/B testing, and operational kill switches. The decision framework is clear: if you need to change behavior without rebuilding and redeploying, use runtime flags. If the variation is determined by deployment target or test type, use build tags. In mature systems, both tools work together to give engineering teams precise control over what code runs where and when.
