---
title: "Go Monorepo Patterns: Module Management and Build Optimization"
date: 2029-10-29T00:00:00-05:00
draft: false
tags: ["Go", "Monorepo", "Build Optimization", "Module Management", "go.mod", "Build Cache"]
categories: ["Go", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go monorepo architecture: comparing single vs. multiple go.mod layouts, managing internal packages, shared library versioning, Go-native monorepo tooling, and optimizing build cache sharing in CI."
more_link: "yes"
url: "/go-monorepo-patterns-module-management-build-optimization/"
---

Go monorepos present a distinct set of challenges compared to JavaScript or Java monorepos. The Go module system was designed around individual repositories, which creates friction when dozens of services share common libraries in a single repository. This guide explores the tradeoffs between single-module and multi-module layouts, patterns for internal package management, how to implement versioning without the overhead of per-library release cycles, and how to dramatically speed up CI builds through cache sharing.

<!--more-->

# Go Monorepo Patterns: Module Management and Build Optimization

## Section 1: Single Module vs. Multi-Module Layouts

The fundamental decision in a Go monorepo is whether to use one `go.mod` at the root or separate `go.mod` files per service or library.

### Single go.mod (Workspace Style)

```
monorepo/
├── go.mod          -- single module: github.com/example/monorepo
├── go.sum
├── cmd/
│   ├── api-gateway/
│   │   └── main.go
│   ├── user-service/
│   │   └── main.go
│   └── billing-service/
│       └── main.go
├── internal/
│   ├── auth/
│   ├── database/
│   ├── config/
│   └── telemetry/
├── pkg/
│   ├── httpclient/
│   ├── ratelimit/
│   └── pagination/
└── services/
    ├── api-gateway/
    ├── user-service/
    └── billing-service/
```

**Advantages:**
- Single `go get` to update all dependencies
- No cross-module replace directives
- Atomic changes: update a shared library and its consumers in one commit
- Simpler CI dependency

**Disadvantages:**
- Any import in any service bloats all service binaries (mitigated by proper build commands)
- `go test ./...` runs all tests in the repo — slow for large repos
- Dependency conflicts across services are harder to manage

### Multiple go.mod (Multi-Module)

```
monorepo/
├── go.work          -- Go workspace file
├── libs/
│   ├── auth/
│   │   ├── go.mod   -- module: github.com/example/monorepo/libs/auth
│   │   └── go.sum
│   ├── database/
│   │   ├── go.mod   -- module: github.com/example/monorepo/libs/database
│   │   └── go.sum
│   └── telemetry/
│       ├── go.mod   -- module: github.com/example/monorepo/libs/telemetry
│       └── go.sum
└── services/
    ├── api-gateway/
    │   ├── go.mod   -- module: github.com/example/monorepo/services/api-gateway
    │   └── go.sum
    └── user-service/
        ├── go.mod   -- module: github.com/example/monorepo/services/user-service
        └── go.sum
```

**Advantages:**
- Services can have different versions of the same dependency
- Smaller, more focused `go.sum` files
- Independent versioning of libraries (publish `libs/auth` as `v1.2.0`)

**Disadvantages:**
- Cross-module changes require updating `go.mod` in every consumer
- Without `go.work`, local development requires `replace` directives
- More complex CI: must determine which modules changed

## Section 2: Go Workspaces

Go 1.18 introduced workspaces (`go.work`) to solve the local development pain of multi-module repos. A workspace overrides module resolution for all listed modules.

```go
// go.work (at repo root)
go 1.22

use (
    ./libs/auth
    ./libs/database
    ./libs/telemetry
    ./libs/httpclient
    ./services/api-gateway
    ./services/user-service
    ./services/billing-service
)

// Optional: replace directives apply workspace-wide
replace github.com/some/old-package => github.com/some/new-package v1.0.0
```

With `go.work`, running `go build ./services/api-gateway/...` from the root automatically resolves `github.com/example/monorepo/libs/auth` from `./libs/auth` without any `replace` directives in individual `go.mod` files.

### Workspace Commands

```bash
# Initialize workspace
go work init

# Add a module to the workspace
go work use ./libs/auth
go work use ./services/api-gateway

# Add all modules automatically
find . -name go.mod -exec dirname {} \; | xargs go work use

# Sync workspace (download dependencies)
go work sync

# Build a specific service
go build ./services/api-gateway/cmd/server/...

# Test all modules
go test ./...

# Test a specific module
cd services/api-gateway && go test ./...

# Disable workspace (use published versions instead of local)
GOWORK=off go build ./services/api-gateway/cmd/server/...
```

### Workspace in CI

The workspace should only be used locally. In CI, build each module independently against published library versions:

```yaml
# .github/workflows/build.yml
jobs:
  build-api-gateway:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - name: Build
        working-directory: services/api-gateway
        run: |
          # GOWORK=off ensures we use go.mod, not go.work
          GOWORK=off go build ./...
          GOWORK=off go test ./...
```

## Section 3: Internal Package Architecture

The `internal` package convention is powerful for enforcing boundaries in a monorepo.

### Layer Architecture

```
monorepo/
├── internal/           -- only importable by code in monorepo root
│   ├── platform/       -- platform-level concerns (not service-specific)
│   │   ├── config/     -- configuration loading
│   │   ├── health/     -- health check framework
│   │   ├── metrics/    -- Prometheus setup
│   │   └── tracing/    -- OpenTelemetry setup
│   └── testutil/       -- shared test utilities
│
├── services/
│   └── api-gateway/
│       ├── internal/   -- only importable by api-gateway
│       │   ├── handler/
│       │   ├── middleware/
│       │   └── cache/
│       └── cmd/
│           └── server/
│               └── main.go
│
└── pkg/                -- public packages (importable externally)
    ├── pagination/
    └── errors/
```

With this layout:
- `services/api-gateway` can import `github.com/example/monorepo/internal/platform/config`
- `services/user-service` CANNOT import `github.com/example/monorepo/services/api-gateway/internal/handler`
- External projects can import `github.com/example/monorepo/pkg/pagination`

### Shared Configuration Pattern

```go
// internal/platform/config/config.go
package config

import (
    "fmt"
    "os"
    "strings"
    "time"

    "github.com/spf13/viper"
)

// BaseConfig contains fields common to all services
type BaseConfig struct {
    ServiceName    string        `mapstructure:"service_name"`
    Environment    string        `mapstructure:"environment"`
    LogLevel       string        `mapstructure:"log_level"`
    MetricsPort    int           `mapstructure:"metrics_port"`
    ShutdownTimeout time.Duration `mapstructure:"shutdown_timeout"`

    Database DatabaseConfig `mapstructure:"database"`
    Redis    RedisConfig    `mapstructure:"redis"`
    Tracing  TracingConfig  `mapstructure:"tracing"`
}

type DatabaseConfig struct {
    Host            string        `mapstructure:"host"`
    Port            int           `mapstructure:"port"`
    Name            string        `mapstructure:"name"`
    User            string        `mapstructure:"user"`
    Password        string        `mapstructure:"password"`
    MaxOpenConns    int           `mapstructure:"max_open_conns"`
    MaxIdleConns    int           `mapstructure:"max_idle_conns"`
    ConnMaxLifetime time.Duration `mapstructure:"conn_max_lifetime"`
    SSLMode         string        `mapstructure:"ssl_mode"`
}

// Load loads configuration for a service, embedding the base config
// Usage: config.Load[MyServiceConfig]("api-gateway")
func Load[T any](serviceName string) (*T, error) {
    v := viper.New()
    v.SetConfigName(serviceName)
    v.SetConfigType("yaml")
    v.AddConfigPath("./config")
    v.AddConfigPath("/etc/" + serviceName)
    v.AddConfigPath("$HOME/." + serviceName)

    // Environment variable override
    v.SetEnvPrefix(strings.ToUpper(strings.ReplaceAll(serviceName, "-", "_")))
    v.SetEnvKeyReplacer(strings.NewReplacer(".", "_", "-", "_"))
    v.AutomaticEnv()

    // Defaults
    v.SetDefault("log_level", "info")
    v.SetDefault("metrics_port", 9090)
    v.SetDefault("shutdown_timeout", "30s")
    v.SetDefault("database.max_open_conns", 25)
    v.SetDefault("database.max_idle_conns", 10)
    v.SetDefault("database.conn_max_lifetime", "5m")
    v.SetDefault("database.ssl_mode", "require")

    if err := v.ReadInConfig(); err != nil {
        if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
            return nil, fmt.Errorf("reading config: %w", err)
        }
    }

    var cfg T
    if err := v.Unmarshal(&cfg); err != nil {
        return nil, fmt.Errorf("parsing config: %w", err)
    }

    return &cfg, nil
}
```

Service-specific config embeds base:

```go
// services/api-gateway/internal/config/config.go
package config

import (
    "github.com/example/monorepo/internal/platform/config"
)

type Config struct {
    config.BaseConfig `mapstructure:",squash"`

    // API Gateway-specific config
    HTTP struct {
        Port            int    `mapstructure:"port"`
        ReadTimeout     string `mapstructure:"read_timeout"`
        WriteTimeout    string `mapstructure:"write_timeout"`
        RateLimit       int    `mapstructure:"rate_limit"`
        CORSOrigins     []string `mapstructure:"cors_origins"`
    } `mapstructure:"http"`

    Auth struct {
        JWTSecret      string `mapstructure:"jwt_secret"`
        TokenExpiry    string `mapstructure:"token_expiry"`
        RefreshExpiry  string `mapstructure:"refresh_expiry"`
    } `mapstructure:"auth"`
}

func Load() (*Config, error) {
    return config.Load[Config]("api-gateway")
}
```

## Section 4: Shared Library Versioning

In a multi-module monorepo, libraries need versioning. The challenge is maintaining version coherence across many services.

### Semantic Import Versioning for Breaking Changes

When a shared library introduces a breaking change, Go requires a new major version path:

```go
// libs/auth/go.mod (before breaking change)
module github.com/example/monorepo/libs/auth
go 1.22

// libs/auth/go.mod (after breaking change)
module github.com/example/monorepo/libs/auth/v2
go 1.22
```

Consumers update their imports:

```go
// Before
import "github.com/example/monorepo/libs/auth"

// After
import authv2 "github.com/example/monorepo/libs/auth/v2"
```

### Pseudo-Versioning with Monotonic Tags

For internal libraries that never need to be published externally, use simple monotonic versioning:

```bash
# Tag a library release
git tag libs/auth/v1.2.3
git push origin libs/auth/v1.2.3
```

`go get` resolves module-path prefixed tags automatically:

```bash
cd services/api-gateway
go get github.com/example/monorepo/libs/auth@libs/auth/v1.2.3
```

### Version Pinning Script

A script to ensure all services use the same version of a library:

```bash
#!/bin/bash
# scripts/pin-library-version.sh
# Usage: ./scripts/pin-library-version.sh libs/auth v1.2.3

set -euo pipefail

LIBRARY="$1"
VERSION="$2"
MODULE_PATH="github.com/example/monorepo/${LIBRARY}"

echo "Pinning ${MODULE_PATH} to ${VERSION} in all services..."

find services/ -name go.mod | while read -r modfile; do
    dir=$(dirname "$modfile")

    # Skip if this module doesn't import the library
    if ! GOWORK=off grep -q "$MODULE_PATH" "$modfile"; then
        continue
    fi

    echo "Updating $dir..."
    (cd "$dir" && GOWORK=off go get "${MODULE_PATH}@${VERSION}")
done

echo "Done. Run 'go work sync' to update go.work.sum"
go work sync
```

## Section 5: Build Optimization and Change Detection

The key optimization in a monorepo CI system is building only what changed.

### Go Build Cache

Go's build cache (`GOCACHE`) dramatically speeds up repeated builds. The cache stores compiled packages keyed by their content hash.

```bash
# Show cache info
go env GOCACHE
# /home/user/.cache/go/build

# Cache size
du -sh $(go env GOCACHE)

# Clean cache (rarely needed)
go clean -cache
```

In CI, persist the build cache between runs:

```yaml
# GitHub Actions
- uses: actions/cache@v4
  with:
    path: |
      ~/.cache/go/build
      ~/go/pkg/mod
    key: ${{ runner.os }}-go-${{ hashFiles('**/go.sum') }}
    restore-keys: |
      ${{ runner.os }}-go-
```

### Affected Module Detection

Build only services affected by a change:

```bash
#!/bin/bash
# scripts/affected-modules.sh
# Outputs a list of modules affected by changes in a PR

set -euo pipefail

BASE_BRANCH="${BASE_BRANCH:-main}"
CURRENT_SHA=$(git rev-parse HEAD)
BASE_SHA=$(git merge-base HEAD "origin/$BASE_BRANCH")

echo "Detecting changes between $BASE_SHA and $CURRENT_SHA"

# Get changed files
CHANGED_FILES=$(git diff --name-only "$BASE_SHA" "$CURRENT_SHA")

# Find all modules
declare -A MODULE_PATHS
while IFS= read -r modfile; do
    dir=$(dirname "$modfile")
    module=$(grep '^module ' "$modfile" | awk '{print $2}')
    MODULE_PATHS[$dir]="$module"
done < <(find . -name go.mod -not -path '*/vendor/*')

# Determine which modules are affected
declare -A AFFECTED

for file in $CHANGED_FILES; do
    for dir in "${!MODULE_PATHS[@]}"; do
        # Normalize dir path
        normalized_dir="${dir#./}"
        if [[ "$file" == "$normalized_dir"* ]]; then
            AFFECTED[$dir]=1
        fi
    done
done

# Also check: if a library changed, all consumers are affected
for dir in "${!AFFECTED[@]}"; do
    module="${MODULE_PATHS[$dir]}"
    # Check which other modules import this module
    for other_dir in "${!MODULE_PATHS[@]}"; do
        if [ "$other_dir" = "$dir" ]; then
            continue
        fi
        if GOWORK=off grep -q "$module" "$other_dir/go.mod" 2>/dev/null; then
            AFFECTED[$other_dir]=1
        fi
    done
done

# Output affected modules
for dir in "${!AFFECTED[@]}"; do
    echo "$dir"
done
```

Use this in CI:

```yaml
jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      affected: ${{ steps.detect.outputs.affected }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history needed for diff
      - id: detect
        run: |
          AFFECTED=$(./scripts/affected-modules.sh | jq -R -s -c 'split("\n")[:-1]')
          echo "affected=$AFFECTED" >> "$GITHUB_OUTPUT"

  build:
    needs: detect-changes
    runs-on: ubuntu-latest
    strategy:
      matrix:
        module: ${{ fromJSON(needs.detect-changes.outputs.affected) }}
    steps:
      - uses: actions/checkout@v4
      - name: Build and test
        working-directory: ${{ matrix.module }}
        run: |
          GOWORK=off go build ./...
          GOWORK=off go test -race ./...
```

### Hermetic Builds with Module Proxy

For fully reproducible builds, use a private module proxy that caches all dependencies:

```bash
# In CI environment
export GONOSUMCHECK="github.com/example/*"
export GOFLAGS="-mod=readonly"
export GOPROXY="https://proxy.example.com,https://proxy.golang.org,direct"
export GONOSUMDB="github.com/example/*"

# Vendor mode (alternative: check in vendor directory)
go mod vendor
go build -mod=vendor ./...
```

### Multi-Stage Docker Builds with Cache

```dockerfile
# Dockerfile.api-gateway
# syntax=docker/dockerfile:1.7

FROM golang:1.22-alpine AS builder

WORKDIR /workspace

# Copy workspace configuration
COPY go.work go.work.sum ./

# Copy all go.mod files first (for better layer caching)
COPY libs/auth/go.mod libs/auth/go.sum ./libs/auth/
COPY libs/database/go.mod libs/database/go.sum ./libs/database/
COPY libs/telemetry/go.mod libs/telemetry/go.sum ./libs/telemetry/
COPY services/api-gateway/go.mod services/api-gateway/go.sum ./services/api-gateway/

# Download dependencies (cached unless go.mod changes)
RUN --mount=type=cache,target=/root/go/pkg/mod \
    go work sync

# Copy source
COPY libs/ ./libs/
COPY services/api-gateway/ ./services/api-gateway/
COPY internal/ ./internal/

# Build with build cache mount
RUN --mount=type=cache,target=/root/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go/build \
    cd services/api-gateway && \
    CGO_ENABLED=0 GOOS=linux go build \
      -ldflags="-w -s -X main.version=${VERSION}" \
      -o /api-gateway \
      ./cmd/server/...

FROM gcr.io/distroless/static-debian12
COPY --from=builder /api-gateway /api-gateway
USER nonroot:nonroot
ENTRYPOINT ["/api-gateway"]
```

Build with:

```bash
# Leverage BuildKit cache
DOCKER_BUILDKIT=1 docker build \
  --build-arg VERSION=$(git rev-parse --short HEAD) \
  --cache-from type=registry,ref=registry.example.com/api-gateway:buildcache \
  --cache-to type=registry,ref=registry.example.com/api-gateway:buildcache,mode=max \
  -f Dockerfile.api-gateway \
  -t registry.example.com/api-gateway:$(git rev-parse --short HEAD) \
  .
```

## Section 6: Monorepo Tooling for Go

### gonew for Service Scaffolding

Use `gonew` (Go 1.21+) to bootstrap new services from templates:

```bash
go install golang.org/x/tools/cmd/gonew@latest

# Create a new service from template
gonew github.com/example/monorepo/templates/http-service \
      github.com/example/monorepo/services/new-service \
      ./services/new-service
```

The template directory structure:

```
templates/http-service/
├── go.mod
├── cmd/
│   └── server/
│       └── main.go    -- templated service entry point
├── internal/
│   ├── config/
│   │   └── config.go
│   ├── handler/
│   │   └── health.go
│   └── server/
│       └── server.go
└── Dockerfile
```

### Workspace Management Script

```bash
#!/bin/bash
# scripts/workspace-sync.sh
# Regenerates go.work from all go.mod files

set -euo pipefail

echo "go 1.22" > go.work
echo "" >> go.work
echo "use (" >> go.work

find . -name go.mod \
  -not -path '*/vendor/*' \
  -not -path '*/.git/*' | \
  sort | \
  xargs -I{} dirname {} | \
  sed 's|^\./||' | \
  sed 's|^|    ./|' >> go.work

echo ")" >> go.work

echo "Running go work sync..."
go work sync

echo "go.work updated successfully"
```

### Dependency Audit Script

Check for inconsistent dependency versions across modules:

```bash
#!/bin/bash
# scripts/dependency-audit.sh
# Reports modules using different versions of the same dependency

declare -A DEP_VERSIONS

find . -name go.mod \
  -not -path '*/vendor/*' | \
  while read -r modfile; do
    module_dir=$(dirname "$modfile")

    # Parse direct dependencies
    while IFS= read -r dep; do
        pkg=$(echo "$dep" | awk '{print $1}')
        ver=$(echo "$dep" | awk '{print $2}')
        key="$pkg"

        if [ -n "${DEP_VERSIONS[$key]:-}" ] && [ "${DEP_VERSIONS[$key]}" != "$ver" ]; then
            echo "VERSION MISMATCH: $pkg"
            echo "  Seen: ${DEP_VERSIONS[$key]}"
            echo "  In $module_dir: $ver"
        else
            DEP_VERSIONS[$key]="$ver"
        fi
    done < <(grep '^\t' "$modfile" | grep -v '^// ' | grep -v 'indirect')
done
```

## Section 7: Testing Strategy

### Parallel Test Execution

In a monorepo, running all tests serially is slow. Parallelize by module:

```makefile
# Makefile
MODULES := $(shell find . -name go.mod -not -path '*/vendor/*' -exec dirname {} \;)

.PHONY: test
test:
	@echo "Running tests in parallel across $(words $(MODULES)) modules..."
	@echo $(MODULES) | tr ' ' '\n' | \
	  xargs -P4 -I{} sh -c \
	    'echo "Testing {}..." && cd {} && GOWORK=off go test -race -timeout=300s ./... 2>&1 | sed "s/^/[{}] /"'

.PHONY: test-module
test-module:
	@test -n "$(MODULE)" || (echo "Usage: make test-module MODULE=services/api-gateway" && exit 1)
	cd $(MODULE) && GOWORK=off go test -race -count=1 -v ./...
```

### Shared Test Infrastructure

```go
// internal/testutil/postgres.go
package testutil

import (
    "context"
    "database/sql"
    "fmt"
    "testing"
    "time"

    _ "github.com/lib/pq"
    "github.com/ory/dockertest/v3"
    "github.com/ory/dockertest/v3/docker"
)

// NewPostgresDB starts a PostgreSQL container for testing
// and returns a connection. Cleanup is registered via t.Cleanup.
func NewPostgresDB(t *testing.T) *sql.DB {
    t.Helper()

    pool, err := dockertest.NewPool("")
    if err != nil {
        t.Fatalf("connecting to docker: %v", err)
    }

    resource, err := pool.RunWithOptions(&dockertest.RunOptions{
        Repository: "postgres",
        Tag:        "16-alpine",
        Env: []string{
            "POSTGRES_USER=test",
            "POSTGRES_PASSWORD=test",
            "POSTGRES_DB=testdb",
        },
    }, func(config *docker.HostConfig) {
        config.AutoRemove = true
        config.RestartPolicy = docker.RestartPolicy{Name: "no"}
    })
    if err != nil {
        t.Fatalf("starting postgres container: %v", err)
    }

    t.Cleanup(func() {
        if err := pool.Purge(resource); err != nil {
            t.Logf("purging postgres container: %v", err)
        }
    })

    resource.Expire(120)

    var db *sql.DB
    dsn := fmt.Sprintf(
        "postgres://test:test@localhost:%s/testdb?sslmode=disable",
        resource.GetPort("5432/tcp"),
    )

    if err := pool.Retry(func() error {
        var err error
        db, err = sql.Open("postgres", dsn)
        if err != nil {
            return err
        }
        return db.PingContext(context.Background())
    }); err != nil {
        t.Fatalf("connecting to postgres: %v", err)
    }

    return db
}
```

## Section 8: Linting and Code Quality

### Shared golangci-lint Configuration

Place a shared `.golangci.yml` at the root:

```yaml
# .golangci.yml
run:
  timeout: 10m
  modules-download-mode: readonly

linters:
  enable:
    - errcheck
    - gosimple
    - govet
    - ineffassign
    - staticcheck
    - typecheck
    - unused
    - goimports
    - revive
    - noctx
    - bodyclose
    - exhaustive
    - gocritic
    - prealloc
    - unconvert
    - unparam

linters-settings:
  goimports:
    local-prefixes: github.com/example/monorepo
  revive:
    rules:
      - name: exported
        severity: warning
      - name: unused-parameter
        severity: warning
  exhaustive:
    default-signifies-exhaustive: true

issues:
  exclude-rules:
    # Test files get more relaxed rules
    - path: "_test\\.go"
      linters:
        - unparam
        - errcheck
```

Run linting across all modules:

```bash
#!/bin/bash
# scripts/lint-all.sh
FAILED=0
find . -name go.mod \
  -not -path '*/vendor/*' \
  -exec dirname {} \; | \
  while read -r dir; do
    echo "Linting $dir..."
    if ! (cd "$dir" && GOWORK=off golangci-lint run --config ../../.golangci.yml ./...); then
        FAILED=1
    fi
done
exit $FAILED
```

## Conclusion

Go monorepos work well when the tooling is configured correctly. The Go workspace feature eliminates the biggest pain point of multi-module development, while proper `internal` package boundaries enforce service isolation. Affected-module detection in CI ensures builds remain fast even as the repository grows.

The right layout depends on team size and deployment frequency:
- Small teams with tightly coupled services: single `go.mod` with workspace
- Large teams with independently deployed services: multi-module with workspaces
- Mixed teams: services as separate modules, shared libs as single module

Key takeaways:
- Use `go.work` for local development in multi-module repos; disable with `GOWORK=off` in CI
- Invest in affected-module detection early — it prevents CI times from growing linearly
- Mount build caches in Docker builds for significant speed improvements
- Standardize on a shared `internal/platform` package to avoid re-implementing config, logging, and tracing in every service
