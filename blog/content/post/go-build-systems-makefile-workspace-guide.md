---
title: "Go Build Systems: Makefile Patterns, Build Tags, Go Workspace Modules, and Reproducible Builds"
date: 2028-08-08T00:00:00-05:00
draft: false
tags: ["Go", "Build", "Makefile", "Workspace", "Modules", "Reproducible Builds"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go build systems covering production Makefile patterns, build tag strategies for feature flags and platform targets, Go workspace modules for multi-module development, reproducible builds with pinned toolchains, and CI/CD integration patterns."
more_link: "yes"
url: "/go-build-systems-makefile-workspace-guide/"
---

Build systems are the foundation of every software project, yet they are routinely underdesigned. Go projects that start with `go build ./...` in a shell script eventually accumulate test targets, linting, Docker builds, version injection, cross-compilation, code generation, and integration tests — all as ad-hoc additions. The result is a fragile, inconsistent build that works on the author's machine and nowhere else.

This guide covers principled Go build system design: Makefile patterns that are portable and self-documenting, build tags for conditional compilation, Go workspaces for multi-module monorepos, reproducible builds, and CI/CD integration.

<!--more-->

# Go Build Systems: Makefile Patterns, Build Tags, Go Workspace Modules, and Reproducible Builds

## Section 1: Production Makefile Design

A production Makefile for a Go project should be:

1. **Self-documenting** — running `make` or `make help` explains all targets
2. **Portable** — works on Linux, macOS, and in Docker/CI without modification
3. **Incremental** — avoids re-running expensive steps when inputs haven't changed
4. **Variables-first** — all configurable values defined at the top

### Complete Production Makefile

```makefile
# Makefile
# Production Go build system

# =============================================================================
# Variables
# =============================================================================

# Build information
BINARY_NAME    := myapp
MODULE         := github.com/supporttools/myapp
VERSION        := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
GIT_COMMIT     := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_BRANCH     := $(shell git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
BUILD_DATE     := $(shell date -u '+%Y-%m-%dT%H:%M:%SZ')
BUILD_HOST     := $(shell hostname -f 2>/dev/null || echo "unknown")

# Go configuration
GO             := go
GOFLAGS        :=
GOOS           ?= $(shell go env GOOS)
GOARCH         ?= $(shell go env GOARCH)
CGO_ENABLED    ?= 0

# Linker flags for version injection
LDFLAGS := -w -s \
	-X '$(MODULE)/internal/version.Version=$(VERSION)' \
	-X '$(MODULE)/internal/version.GitCommit=$(GIT_COMMIT)' \
	-X '$(MODULE)/internal/version.GitBranch=$(GIT_BRANCH)' \
	-X '$(MODULE)/internal/version.BuildDate=$(BUILD_DATE)'

# Build directories
BUILD_DIR      := ./build
DIST_DIR       := ./dist
COVERAGE_DIR   := ./coverage

# Docker configuration
REGISTRY       ?= ghcr.io/supporttools
IMAGE_NAME     := $(REGISTRY)/$(BINARY_NAME)
IMAGE_TAG      ?= $(VERSION)
DOCKERFILE     := Dockerfile

# Tools (pinned versions for reproducibility)
GOLANGCI_LINT_VERSION  := v1.59.0
GOVULNCHECK_VERSION    := v1.1.1
GORELEASER_VERSION     := v2.1.0

# Tool paths (installed in bin/ to avoid polluting global)
TOOLS_DIR      := ./tools/bin
GOLANGCI_LINT  := $(TOOLS_DIR)/golangci-lint
GOVULNCHECK    := $(TOOLS_DIR)/govulncheck

# =============================================================================
# Default target: show help
# =============================================================================

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ''
	@echo 'Variables (override with make VAR=value):'
	@echo '  VERSION     $(VERSION)'
	@echo '  GOOS        $(GOOS)'
	@echo '  GOARCH      $(GOARCH)'
	@echo '  IMAGE_TAG   $(IMAGE_TAG)'

# =============================================================================
# Code generation
# =============================================================================

.PHONY: generate
generate: ## Run go generate for all packages
	$(GO) generate ./...

.PHONY: generate-mocks
generate-mocks: ## Generate mock implementations using mockgen
	which mockgen || go install go.uber.org/mock/mockgen@latest
	$(GO) generate -run "mockgen" ./...

# =============================================================================
# Build targets
# =============================================================================

.PHONY: build
build: ## Build binary for current OS/arch
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=$(CGO_ENABLED) GOOS=$(GOOS) GOARCH=$(GOARCH) \
		$(GO) build $(GOFLAGS) \
		-ldflags "$(LDFLAGS)" \
		-o $(BUILD_DIR)/$(BINARY_NAME) \
		./cmd/$(BINARY_NAME)
	@echo "Built: $(BUILD_DIR)/$(BINARY_NAME)"

.PHONY: build-all
build-all: ## Build binaries for all supported platforms
	@mkdir -p $(DIST_DIR)
	@for platform in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64; do \
		GOOS=$$(echo $$platform | cut -d/ -f1); \
		GOARCH=$$(echo $$platform | cut -d/ -f2); \
		OUTPUT="$(DIST_DIR)/$(BINARY_NAME)-$$GOOS-$$GOARCH"; \
		[ "$$GOOS" = "windows" ] && OUTPUT="$$OUTPUT.exe"; \
		echo "Building $$GOOS/$$GOARCH -> $$OUTPUT"; \
		CGO_ENABLED=0 GOOS=$$GOOS GOARCH=$$GOARCH \
			$(GO) build -ldflags "$(LDFLAGS)" \
			-o $$OUTPUT ./cmd/$(BINARY_NAME) || exit 1; \
	done
	@echo "All binaries in $(DIST_DIR)/"
	@ls -lh $(DIST_DIR)/

.PHONY: build-debug
build-debug: ## Build with debug symbols (no stripping)
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=$(CGO_ENABLED) \
		$(GO) build $(GOFLAGS) \
		-ldflags "-X '$(MODULE)/internal/version.Version=$(VERSION)'" \
		-gcflags "all=-N -l" \
		-o $(BUILD_DIR)/$(BINARY_NAME)-debug \
		./cmd/$(BINARY_NAME)

.PHONY: build-race
build-race: ## Build with race detector enabled
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=1 \
		$(GO) build -race \
		-ldflags "$(LDFLAGS)" \
		-o $(BUILD_DIR)/$(BINARY_NAME)-race \
		./cmd/$(BINARY_NAME)

# =============================================================================
# Test targets
# =============================================================================

.PHONY: test
test: ## Run unit tests
	$(GO) test $(GOFLAGS) -count=1 -timeout=60s ./...

.PHONY: test-race
test-race: ## Run unit tests with race detector
	CGO_ENABLED=1 $(GO) test -race -count=1 -timeout=120s ./...

.PHONY: test-coverage
test-coverage: ## Run tests with coverage report
	@mkdir -p $(COVERAGE_DIR)
	$(GO) test -count=1 -timeout=120s \
		-coverprofile=$(COVERAGE_DIR)/coverage.out \
		-covermode=atomic \
		./...
	$(GO) tool cover -html=$(COVERAGE_DIR)/coverage.out \
		-o $(COVERAGE_DIR)/coverage.html
	$(GO) tool cover -func=$(COVERAGE_DIR)/coverage.out | tail -1
	@echo "Coverage report: $(COVERAGE_DIR)/coverage.html"

.PHONY: test-integration
test-integration: ## Run integration tests (requires TEST_ENV=... to be set)
	$(GO) test -count=1 -timeout=300s -tags=integration ./...

.PHONY: test-bench
test-bench: ## Run benchmark tests
	$(GO) test -bench=. -benchmem -count=3 ./... | tee $(BUILD_DIR)/bench.txt
	@if command -v benchstat >/dev/null 2>&1; then \
		benchstat $(BUILD_DIR)/bench.txt; \
	fi

.PHONY: test-short
test-short: ## Run tests in short mode (skip long-running tests)
	$(GO) test -short -count=1 -timeout=30s ./...

# =============================================================================
# Lint and vet
# =============================================================================

.PHONY: lint
lint: $(GOLANGCI_LINT) ## Run golangci-lint
	$(GOLANGCI_LINT) run --timeout=10m ./...

.PHONY: vet
vet: ## Run go vet
	$(GO) vet ./...

.PHONY: vuln
vuln: $(GOVULNCHECK) ## Check for known vulnerabilities
	$(GOVULNCHECK) ./...

.PHONY: tidy
tidy: ## Tidy and verify go.mod/go.sum
	$(GO) mod tidy
	$(GO) mod verify
	git diff --exit-code go.mod go.sum

.PHONY: staticcheck
staticcheck: ## Run staticcheck
	which staticcheck || go install honnef.co/go/tools/cmd/staticcheck@latest
	staticcheck ./...

# =============================================================================
# Docker targets
# =============================================================================

.PHONY: docker-build
docker-build: ## Build Docker image
	docker build \
		--build-arg VERSION=$(VERSION) \
		--build-arg GIT_COMMIT=$(GIT_COMMIT) \
		--build-arg BUILD_DATE=$(BUILD_DATE) \
		--label "org.opencontainers.image.version=$(VERSION)" \
		--label "org.opencontainers.image.revision=$(GIT_COMMIT)" \
		--label "org.opencontainers.image.created=$(BUILD_DATE)" \
		-t $(IMAGE_NAME):$(IMAGE_TAG) \
		-t $(IMAGE_NAME):latest \
		-f $(DOCKERFILE) .
	@echo "Built: $(IMAGE_NAME):$(IMAGE_TAG)"

.PHONY: docker-push
docker-push: docker-build ## Build and push Docker image
	docker push $(IMAGE_NAME):$(IMAGE_TAG)
	docker push $(IMAGE_NAME):latest

.PHONY: docker-run
docker-run: ## Run the Docker image locally
	docker run --rm -it \
		-p 8080:8080 \
		-e LOG_LEVEL=debug \
		$(IMAGE_NAME):$(IMAGE_TAG)

# =============================================================================
# Tool installation
# =============================================================================

$(TOOLS_DIR):
	@mkdir -p $(TOOLS_DIR)

$(GOLANGCI_LINT): $(TOOLS_DIR)
	@echo "Installing golangci-lint $(GOLANGCI_LINT_VERSION)..."
	GOBIN=$(abspath $(TOOLS_DIR)) go install \
		github.com/golangci/golangci-lint/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION)

$(GOVULNCHECK): $(TOOLS_DIR)
	@echo "Installing govulncheck $(GOVULNCHECK_VERSION)..."
	GOBIN=$(abspath $(TOOLS_DIR)) go install \
		golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION)

.PHONY: tools
tools: $(GOLANGCI_LINT) $(GOVULNCHECK) ## Install all development tools

# =============================================================================
# CI targets (run all checks)
# =============================================================================

.PHONY: ci
ci: tidy generate vet lint test-coverage ## Run all CI checks

.PHONY: ci-fast
ci-fast: vet test-short ## Run fast subset of CI checks

.PHONY: release
release: ci build-all docker-push ## Full release pipeline

# =============================================================================
# Development helpers
# =============================================================================

.PHONY: run
run: ## Run the application locally
	$(GO) run ./cmd/$(BINARY_NAME)

.PHONY: watch
watch: ## Watch for changes and rebuild (requires entr)
	find . -name "*.go" | entr -r make run

.PHONY: clean
clean: ## Remove build artifacts
	rm -rf $(BUILD_DIR) $(DIST_DIR) $(COVERAGE_DIR)
	$(GO) clean -cache

.PHONY: version
version: ## Show version information
	@echo "Version:    $(VERSION)"
	@echo "Git commit: $(GIT_COMMIT)"
	@echo "Git branch: $(GIT_BRANCH)"
	@echo "Build date: $(BUILD_DATE)"
	@echo "GOOS:       $(GOOS)"
	@echo "GOARCH:     $(GOARCH)"

# Prevent targets from conflicting with files of the same name
.PHONY: all
all: ci build docker-build
```

## Section 2: Version Injection Pattern

```go
// internal/version/version.go
package version

import (
    "fmt"
    "runtime"
)

// These variables are injected at build time via -ldflags.
// They default to "dev" values for local development.
var (
    Version   = "dev"
    GitCommit = "unknown"
    GitBranch = "unknown"
    BuildDate = "unknown"
)

// Info contains all build-time version information.
type Info struct {
    Version   string `json:"version"`
    GitCommit string `json:"gitCommit"`
    GitBranch string `json:"gitBranch"`
    BuildDate string `json:"buildDate"`
    GoVersion string `json:"goVersion"`
    Platform  string `json:"platform"`
}

// Get returns the current version information.
func Get() Info {
    return Info{
        Version:   Version,
        GitCommit: GitCommit,
        GitBranch: GitBranch,
        BuildDate: BuildDate,
        GoVersion: runtime.Version(),
        Platform:  fmt.Sprintf("%s/%s", runtime.GOOS, runtime.GOARCH),
    }
}

func (i Info) String() string {
    return fmt.Sprintf("%s (commit: %s, branch: %s, built: %s, go: %s, platform: %s)",
        i.Version, i.GitCommit, i.GitBranch, i.BuildDate, i.GoVersion, i.Platform)
}
```

## Section 3: Build Tags

Build tags (also called build constraints) allow conditional compilation based on OS, architecture, Go version, or custom conditions.

### Syntax

```go
//go:build linux && amd64
// OR (old syntax, still supported):
// +build linux,amd64

package mypackage
```

### Platform-Specific Code

```go
// signal_unix.go
//go:build !windows

package signals

import (
    "os"
    "os/signal"
    "syscall"
)

// ListenForShutdown registers SIGTERM and SIGINT handlers.
func ListenForShutdown(cancel func()) {
    ch := make(chan os.Signal, 1)
    signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
    go func() {
        <-ch
        cancel()
    }()
}
```

```go
// signal_windows.go
//go:build windows

package signals

import (
    "os"
    "os/signal"
    "syscall"
)

// ListenForShutdown registers SIGTERM and interrupt handlers on Windows.
func ListenForShutdown(cancel func()) {
    ch := make(chan os.Signal, 1)
    signal.Notify(ch, syscall.SIGTERM, os.Interrupt)
    go func() {
        <-ch
        cancel()
    }()
}
```

### Feature Flags via Build Tags

```go
// features_default.go
//go:build !enterprise

package features

// Free tier capabilities
const (
    MaxConnections = 100
    EnableAuditLog = false
    EnableSSO      = false
)

func IsEnterprise() bool { return false }
```

```go
// features_enterprise.go
//go:build enterprise

package features

// Enterprise tier capabilities
const (
    MaxConnections = 100000
    EnableAuditLog = true
    EnableSSO      = true
)

func IsEnterprise() bool { return true }
```

Building with enterprise features:

```bash
# Standard build
go build ./...

# Enterprise build
go build -tags enterprise ./...

# Multiple tags
go build -tags "enterprise,trace,metrics" ./...
```

### Integration Test Tags

```go
// database_integration_test.go
//go:build integration

package database_test

import (
    "database/sql"
    "testing"
    "os"
)

func TestDatabaseRoundTrip(t *testing.T) {
    dsn := os.Getenv("TEST_DATABASE_DSN")
    if dsn == "" {
        t.Skip("TEST_DATABASE_DSN not set")
    }

    db, err := sql.Open("postgres", dsn)
    if err != nil {
        t.Fatal(err)
    }
    defer db.Close()

    // Full round-trip test against real database
    // ...
}
```

```go
// database_mock_test.go
//go:build !integration

package database_test

import (
    "testing"
)

func TestDatabaseRoundTrip(t *testing.T) {
    // Mock-based test for unit test runs
    // ...
}
```

### Go Version Constraints

```go
// slices_go121.go
//go:build go1.21

package utils

import "slices"

// SortedKeys returns sorted keys using the built-in slices package (go1.21+).
func SortedKeys[K comparable, V any](m map[K]V) []K {
    keys := make([]K, 0, len(m))
    for k := range m {
        keys = append(keys, k)
    }
    slices.Sort(keys)
    return keys
}
```

```go
// slices_pre121.go
//go:build !go1.21

package utils

import "sort"

// SortedKeys returns sorted keys using sort.Slice for pre-1.21 Go.
func SortedKeys[K comparable, V any](m map[K]V) []K {
    keys := make([]K, 0, len(m))
    for k := range m {
        keys = append(keys, k)
    }
    sort.Slice(keys, func(i, j int) bool {
        return fmt.Sprint(keys[i]) < fmt.Sprint(keys[j])
    })
    return keys
}
```

## Section 4: Go Workspace Modules

Go workspaces (introduced in Go 1.18) allow working with multiple modules simultaneously without requiring `replace` directives in go.mod files.

### When to Use Workspaces

Workspaces shine in monorepos where:
- Multiple services share internal libraries
- You're developing a library and its consumer simultaneously
- You want to test cross-module changes before publishing

```
mymonorepo/
├── go.work                    # Workspace definition
├── go.work.sum                # Workspace dependency checksums
├── services/
│   ├── api-server/
│   │   ├── go.mod             # module github.com/org/api-server
│   │   └── main.go
│   ├── worker/
│   │   ├── go.mod             # module github.com/org/worker
│   │   └── main.go
│   └── gateway/
│       ├── go.mod             # module github.com/org/gateway
│       └── main.go
└── libs/
    ├── database/
    │   ├── go.mod             # module github.com/org/database
    │   └── client.go
    ├── auth/
    │   ├── go.mod             # module github.com/org/auth
    │   └── token.go
    └── config/
        ├── go.mod             # module github.com/org/config
        └── loader.go
```

### Creating a Workspace

```bash
# Initialize a workspace from the root
cd mymonorepo
go work init ./services/api-server ./services/worker ./services/gateway \
             ./libs/database ./libs/auth ./libs/config

# Add a module to an existing workspace
go work use ./services/new-service

# Sync workspace dependencies
go work sync
```

### go.work File

```go
// go.work
go 1.22

use (
    ./services/api-server
    ./services/worker
    ./services/gateway
    ./libs/database
    ./libs/auth
    ./libs/config
)

// Optional: replace directives that apply workspace-wide
replace (
    // Use a local fork of a library during development
    github.com/some/library => ../local-fork/library
)
```

### Module go.mod Files

```go
// libs/database/go.mod
module github.com/org/database

go 1.22

require (
    github.com/jackc/pgx/v5 v5.6.0
)
```

```go
// services/api-server/go.mod
module github.com/org/api-server

go 1.22

require (
    // References the workspace-local module
    // In go.mod this is a normal dependency...
    github.com/org/database v0.0.0
    github.com/org/auth v0.0.0
    github.com/org/config v0.0.0
)

// ...but go.work makes the workspace modules override these versions
// with local copies. No replace directives needed!
```

### Workspace-Level Commands

```bash
# Build all modules in the workspace
go build ./...

# Test all modules
go test ./...

# Run vet across all workspace modules
go vet ./...

# Run go generate across all modules
go generate ./...

# Check for workspace-level issues
go work sync
go mod tidy  # Run in each module directory

# Disable workspace (for CI where you want to use published versions)
GOWORK=off go build ./...

# Or set in CI:
# export GOWORK=off
```

### Workspace Makefile

```makefile
# Workspace-aware Makefile
MODULES := $(shell go work edit -json | jq -r '.Use[].DiskPath' 2>/dev/null || \
           find . -name go.mod -not -path "*/vendor/*" -exec dirname {} \;)

.PHONY: tidy-all
tidy-all: ## Tidy all modules in the workspace
	@for mod in $(MODULES); do \
		echo "Tidying $$mod..."; \
		(cd $$mod && go mod tidy) || exit 1; \
	done

.PHONY: test-all
test-all: ## Test all modules in the workspace
	go test ./...

.PHONY: lint-all
lint-all: ## Lint all modules in the workspace
	@for mod in $(MODULES); do \
		echo "Linting $$mod..."; \
		(cd $$mod && golangci-lint run ./...) || exit 1; \
	done

.PHONY: build-services
build-services: ## Build all service binaries
	@for svc in services/*/; do \
		name=$$(basename $$svc); \
		echo "Building $$name..."; \
		(cd $$svc && go build -o ../../build/$$name .) || exit 1; \
	done
```

## Section 5: Reproducible Builds

A reproducible build produces bit-for-bit identical output when given the same inputs. This is critical for supply chain security — you can verify that a distributed binary matches a specific source commit.

### Go's Reproducibility Features

Go supports reproducible builds by default since 1.13. Key requirements:

```bash
# Use -trimpath to remove local file paths from the binary
go build -trimpath ./...

# Use module proxy for pinned dependency resolution
GONOSUMCHECK="" GOFLAGS="-mod=readonly" go build ./...

# Verify all module downloads against go.sum
go mod verify
```

### Pinning the Go Toolchain

```go
// go.mod — pin the Go toolchain version
module github.com/supporttools/myapp

go 1.22.4

toolchain go1.22.4  // Exact Go version requirement
```

```bash
# Install specific Go toolchain
go install golang.org/dl/go1.22.4@latest
go1.22.4 download

# Or use GOTOOLCHAIN env var
export GOTOOLCHAIN=go1.22.4
```

### Reproducible Docker Build

```dockerfile
# Dockerfile
# Stage 1: Build the Go binary with a pinned toolchain
FROM golang:1.22.4-alpine3.20 AS builder

# Install build dependencies (pinned versions)
RUN apk add --no-cache --update \
    git=2.45.2-r0 \
    make=4.4.1-r2 \
    ca-certificates=20240226-r0

WORKDIR /build

# Cache dependencies separately from source code
COPY go.mod go.sum ./
RUN go mod download && go mod verify

# Copy source code
COPY . .

# Build with reproducibility flags
ARG VERSION=dev
ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
    -trimpath \
    -ldflags "-w -s \
        -X 'github.com/supporttools/myapp/internal/version.Version=${VERSION}' \
        -X 'github.com/supporttools/myapp/internal/version.GitCommit=${GIT_COMMIT}' \
        -X 'github.com/supporttools/myapp/internal/version.BuildDate=${BUILD_DATE}'" \
    -o /build/bin/myapp \
    ./cmd/myapp

# Stage 2: Minimal runtime image
FROM gcr.io/distroless/static-debian12:nonroot

# Copy only the binary and CA certs
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /build/bin/myapp /usr/local/bin/myapp

ENTRYPOINT ["/usr/local/bin/myapp"]
```

### SBOM and Binary Verification

```bash
# Generate SBOM for the Go binary using syft
syft scan ./build/myapp -o spdx-json > sbom.spdx.json

# Sign the binary with cosign
cosign sign-blob --key cosign.key \
  --output-signature myapp.sig \
  --output-certificate myapp.cert \
  ./build/myapp

# Verify
cosign verify-blob \
  --key cosign.pub \
  --signature myapp.sig \
  --certificate myapp.cert \
  ./build/myapp

# Check binary for embedded paths (reproducibility indicator)
go tool nm ./build/myapp | grep "\.go:" | head -5
# No output = -trimpath was effective
```

## Section 6: .golangci-lint Configuration

```yaml
# .golangci.yml
run:
  timeout: 10m
  go: "1.22"
  modules-download-mode: readonly
  allow-parallel-runners: true

linters:
  enable:
    - gofmt
    - goimports
    - govet
    - errcheck
    - staticcheck
    - unused
    - gosimple
    - ineffassign
    - typecheck
    - gosec
    - revive
    - misspell
    - prealloc
    - bodyclose         # ensure HTTP response bodies are closed
    - contextcheck      # ensure context is propagated correctly
    - cyclop            # cyclomatic complexity
    - errorlint         # proper error wrapping
    - exhaustive        # exhaustive enum switches
    - forbidigo         # ban specific function calls
    - gochecknoinits    # ban init() functions
    - godot             # comment punctuation
    - noctx             # ban HTTP requests without context
    - nolintlint        # ensure nolint directives are valid
    - sqlclosecheck     # ensure sql.Rows and sql.Stmt are closed
    - unparam           # unused function parameters
    - wrapcheck         # ensure errors from external packages are wrapped

linters-settings:
  errcheck:
    check-type-assertions: true
    check-blank: true

  gosec:
    severity: medium
    confidence: medium

  cyclop:
    max-complexity: 15
    package-average: 10

  forbidigo:
    forbid:
      - p: fmt\.Print(ln|f)?$
        msg: "use structured logging instead"
      - p: log\.(Print|Fatal|Panic)(ln|f)?$
        msg: "use structured logging instead"
      - p: os\.Exit
        msg: "use graceful shutdown instead"

  wrapcheck:
    ignorePackageGlobs:
      - github.com/supporttools/myapp/*  # Internal packages don't need wrapping

issues:
  exclude-rules:
    # Allow fmt.Print in test files
    - path: _test\.go
      linters:
        - forbidigo
        - gochecknoinits

    # Allow init() in main packages
    - path: cmd/
      linters:
        - gochecknoinits

  max-issues-per-linter: 0
  max-same-issues: 0
```

## Section 7: CI/CD Integration

### GitHub Actions Workflow

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: "0 6 * * 1"  # Weekly vulnerability scan

jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version-file: go.mod  # Uses toolchain directive
          cache: true

      - name: Verify dependencies
        run: |
          go mod verify
          go mod tidy
          git diff --exit-code go.mod go.sum

      - name: Run tests
        run: make test-coverage

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          file: ./coverage/coverage.out

  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true

      - name: golangci-lint
        uses: golangci/golangci-lint-action@v6
        with:
          version: v1.59.0
          args: --timeout=10m

  security:
    name: Security Scan
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version-file: go.mod

      - name: govulncheck
        run: |
          go install golang.org/x/vuln/cmd/govulncheck@v1.1.1
          govulncheck ./...

  build:
    name: Build
    runs-on: ubuntu-latest
    needs: [test, lint]
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for git describe

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true

      - name: Build all platforms
        run: make build-all

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: binaries
          path: dist/

  docker:
    name: Docker Build
    runs-on: ubuntu-latest
    needs: [test, lint]
    if: github.ref == 'refs/heads/main'
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up QEMU (for multi-arch)
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/supporttools/myapp

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          build-args: |
            VERSION=${{ github.ref_name }}
            GIT_COMMIT=${{ github.sha }}
            BUILD_DATE=${{ fromJSON(steps.meta.outputs.json).labels['org.opencontainers.image.created'] }}
```

## Section 8: Go Release with GoReleaser

```yaml
# .goreleaser.yml
version: 2

project_name: myapp

before:
  hooks:
    - go mod tidy
    - go generate ./...
    - go test ./...

builds:
  - id: myapp
    main: ./cmd/myapp
    binary: myapp
    goos: [linux, darwin, windows]
    goarch: [amd64, arm64]
    goarm: []
    env:
      - CGO_ENABLED=0
    flags:
      - -trimpath
    ldflags:
      - -w -s
      - -X github.com/supporttools/myapp/internal/version.Version={{.Version}}
      - -X github.com/supporttools/myapp/internal/version.GitCommit={{.Commit}}
      - -X github.com/supporttools/myapp/internal/version.BuildDate={{.Date}}

archives:
  - id: default
    builds: [myapp]
    format: tar.gz
    format_overrides:
      - goos: windows
        format: zip
    name_template: "{{ .ProjectName }}_{{ .Os }}_{{ .Arch }}"
    files:
      - README.md
      - LICENSE

checksum:
  name_template: "checksums.txt"
  algorithm: sha256

sboms:
  - artifacts: archive
    documents:
      - "{{ .ProjectName }}_{{ .Version }}_{{ .Os }}_{{ .Arch }}.sbom"

signs:
  - cmd: cosign
    stdin: "{{ .Env.COSIGN_PASSWORD }}"
    args:
      - sign-blob
      - --key=cosign.key
      - --output-signature=${signature}
      - --output-certificate=${certificate}
      - ${artifact}
    artifacts: checksum

docker_manifests:
  - name_template: ghcr.io/supporttools/myapp:{{ .Version }}
    image_templates:
      - ghcr.io/supporttools/myapp:{{ .Version }}-amd64
      - ghcr.io/supporttools/myapp:{{ .Version }}-arm64

changelog:
  sort: asc
  filters:
    exclude:
      - "^docs:"
      - "^test:"
      - "^chore:"
      - Merge pull request
      - Merge branch

release:
  github:
    owner: supporttools
    name: myapp
  draft: false
  prerelease: auto
```

## Section 9: Module Proxy and Private Modules

```bash
# Configure GONOSUMCHECK for private modules
GONOSUMCHECK=github.com/mycompany/* go build ./...

# Set GONOSUMDB for modules not in the sum database
GONOSUMDB=github.com/mycompany/* go build ./...

# Use a private module proxy (e.g., Athens)
GOPROXY=https://goproxy.mycompany.com,direct go build ./...

# GOFLAGS in environment for persistent configuration
export GOFLAGS="-mod=readonly"
export GONOSUMDB="github.com/mycompany/*"
export GOPROXY="https://goproxy.mycompany.com,https://proxy.golang.org,direct"
export GONOSUMCHECK="github.com/mycompany/*"

# Vendor mode (copies all dependencies into vendor/)
go mod vendor
go build -mod=vendor ./...

# In CI: verify vendor directory is up to date
go mod vendor
git diff --exit-code vendor/
```

## Conclusion

A well-designed Go build system makes the difference between a codebase that is a pleasure to develop and one that accumulates technical debt in the build process. Key patterns from this guide:

- **Self-documenting Makefile**: Every target has a `## comment`, `make help` works, and variables are defined at the top. New contributors can understand the build without reading documentation.
- **Version injection**: Version, commit, and build date are injected at link time via `-ldflags`, not baked into source code.
- **Build tags**: Platform-specific code, feature flags, and test categories are managed with `//go:build` constraints, not conditional compilation in a single file.
- **Go workspaces**: Multi-module monorepos use `go work` instead of `replace` directives, enabling seamless cross-module development without publishing intermediate versions.
- **Reproducible builds**: `-trimpath`, pinned toolchain via `go.mod toolchain`, and module verification with `go mod verify` ensure binary reproducibility for supply chain security.
- **CI integration**: The same Makefile targets that work locally run in CI. The CI workflow pins tool versions, verifies go.mod consistency, and produces multi-arch container images.
