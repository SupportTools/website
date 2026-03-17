---
title: "Go Workspace Mode: Multi-Module Development, Replace Directives, Cross-Module Testing, and go work sync"
date: 2032-01-31T00:00:00-05:00
draft: false
tags: ["Go", "Modules", "Workspace", "Development", "Monorepo", "go work"]
categories:
- Go
- Development
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go workspace mode (go work) for multi-module development. Covers go.work file structure, replace directives vs workspaces, testing across module boundaries, go work sync, vendoring with workspaces, and CI/CD patterns for monorepo Go projects."
more_link: "yes"
url: "/go-workspace-mode-multi-module-development-go-work-sync/"
---

Go workspace mode, introduced in Go 1.18, solves the multi-module development problem that previously required fragile `replace` directives in `go.mod`. When you maintain several modules that depend on each other — a common pattern in microservice monorepos, SDK development, and shared library work — workspaces let you develop them simultaneously without publishing intermediate versions to a module proxy.

<!--more-->

# Go Workspace Mode: Complete Guide

## The Problem Workspaces Solve

Before workspaces, developing across interdependent modules required this painful workflow:

```
api-service/go.mod: requires github.com/myorg/shared-lib v1.2.3
shared-lib/go.mod: module github.com/myorg/shared-lib

# To test a change in shared-lib from api-service:
# Option 1: Publish a pre-release tag to GitHub, update go.mod
# Option 2: Use replace directive (must not be committed)

# api-service/go.mod with replace:
module github.com/myorg/api-service

require github.com/myorg/shared-lib v1.2.3
replace github.com/myorg/shared-lib => ../shared-lib  # Must remove before commit
```

Replace directives in `go.mod` are dangerous: they affect everyone who clones the repo, break `go mod tidy`, and are easy to accidentally commit.

Workspaces solve this at the workspace level, leaving individual `go.mod` files clean.

## go.work File Structure

```
workspace/
  go.work          # workspace file
  api-service/
    go.mod
    main.go
  shared-lib/
    go.mod
    lib.go
  grpc-proto/
    go.mod
    proto.go
  cli-tool/
    go.mod
    main.go
```

```go
// go.work
go 1.23

use (
    ./api-service
    ./shared-lib
    ./grpc-proto
    ./cli-tool
)

// replace directives can still appear in go.work
// (they override go.mod replace directives)
replace (
    github.com/some/fork => github.com/myorg/fork v0.0.0-20240101000000-abcdef123456
)
```

## Creating a Workspace

```bash
# Initialize a workspace from scratch
mkdir myworkspace && cd myworkspace
go work init

# Add existing modules to workspace
go work use ./api-service ./shared-lib ./grpc-proto

# Or initialize with modules in one command
go work init ./api-service ./shared-lib ./grpc-proto

# Add a single module to existing workspace
go work use ./new-module

# Remove a module from workspace (edit go.work manually or use go work edit)
go work edit -dropuse=./old-module

# View the workspace configuration
go work edit -print
```

## Module Development Workflow

### Scenario: Updating a Shared Library

```
monorepo/
  go.work
  pkg/
    go.mod  (module github.com/myorg/pkg)
    config/
      config.go
    logger/
      logger.go
  services/
    api/
      go.mod  (module github.com/myorg/services/api)
      main.go
    worker/
      go.mod  (module github.com/myorg/services/worker)
      main.go
```

```go
// go.work
go 1.23

use (
    ./pkg
    ./services/api
    ./services/worker
)
```

```go
// pkg/go.mod
module github.com/myorg/pkg

go 1.23

require (
    github.com/rs/zerolog v1.32.0
    github.com/spf13/viper v1.18.2
)
```

```go
// services/api/go.mod
module github.com/myorg/services/api

go 1.23

require (
    github.com/myorg/pkg v1.5.0   // Published version
    github.com/gin-gonic/gin v1.9.1
)
```

Now, when you modify `pkg/config/config.go`, `services/api` immediately uses the local version without any version bumping:

```bash
# In the workspace root:
go build ./services/api/...    # Uses local ./pkg
go test ./services/api/...     # Uses local ./pkg
go vet ./...                   # Checks all modules

# The go.mod files remain clean — no replace directives
cat services/api/go.mod
# module github.com/myorg/services/api
# require github.com/myorg/pkg v1.5.0  (published version, not local)
```

## go work sync

`go work sync` reconciles the workspace's build list with the `go.mod` files of each module in the workspace.

```bash
# After developing with workspace, sync go.mod files to match workspace dependencies
go work sync

# This updates each module's go.mod to require the minimum versions
# that the workspace resolved — preventing version skew when
# modules are deployed independently

# Typical workflow:
# 1. Edit shared-lib
# 2. Verify everything builds: go build ./...
# 3. Run tests: go test ./...
# 4. Run go work sync to update go.mod files
# 5. Bump version in shared-lib (git tag)
# 6. Update require in dependent modules: go get github.com/myorg/shared-lib@v1.6.0
# 7. Commit everything
```

### What go work sync Does

```bash
# Before sync: api-service/go.mod requires shared-lib v1.5.0
# During workspace dev: you added methods that require new dependencies in shared-lib
# shared-lib now requires github.com/foo/bar v1.2.0

# go work sync adds the transitive dependency to api-service/go.mod
cat services/api/go.mod
# After sync:
# require (
#     github.com/myorg/pkg v1.5.0
#     github.com/foo/bar v1.2.0  // indirect, added by go work sync
# )

# This ensures that when api-service is built outside the workspace,
# it has all necessary dependency versions
```

## Cross-Module Testing

```bash
# Run tests for all modules in workspace
go test ./...

# Run tests for specific module
go test github.com/myorg/services/api/...

# Run a test from one module that depends on code from another
# (workspace resolves the dependency automatically)
cd services/api
go test -run TestConfigIntegration ./...

# Run tests with race detector across all modules
go test -race ./...

# Generate coverage for all modules
go test -coverprofile=coverage.out ./...
go tool cover -html=coverage.out

# Benchmark across modules
go test -bench=. -benchmem ./pkg/... ./services/...
```

### Integration Tests Across Modules

```go
// services/api/integration_test.go
package api_test

import (
    "testing"

    // Uses local workspace version during development
    "github.com/myorg/pkg/config"
    "github.com/myorg/pkg/logger"
    "github.com/myorg/services/api"
)

func TestAPIWithConfig(t *testing.T) {
    cfg, err := config.Load("testdata/config.yaml")
    if err != nil {
        t.Fatal(err)
    }

    log := logger.New(cfg.LogLevel)
    server := api.NewServer(cfg, log)

    // Integration test runs against local versions of both modules
    resp := server.HandleRequest(testRequest())
    if resp.StatusCode != 200 {
        t.Errorf("expected 200, got %d", resp.StatusCode)
    }
}
```

## Replace Directives in go.work

The `go.work` file can contain `replace` directives that apply across the entire workspace. These are different from per-module `go.mod` replace directives:

```go
// go.work
go 1.23

use (
    ./api-service
    ./shared-lib
)

// Workspace-level replace: applies to all modules in workspace
replace (
    // Use a fork of a dependency for the entire workspace
    golang.org/x/net => golang.org/x/net v0.21.0

    // Local development of an upstream library
    github.com/grpc-ecosystem/grpc-gateway/v2 => ../grpc-gateway
)
```

```bash
# Edit replace directives from CLI
go work edit -replace github.com/foo/bar=../local-fork
go work edit -dropreplace github.com/foo/bar

# List all effective replace directives
go work edit -print | grep replace
```

## Vendoring with Workspaces

Vendoring in workspace mode works differently from single-module vendoring:

```bash
# go mod vendor still works per-module
cd services/api
go mod vendor

# But workspace build does NOT use vendor/ directories by default
# To use vendor, run from individual module directory:
cd services/api && go build -mod=vendor ./...

# Workspace-level vendoring (Go 1.22+):
# Run from workspace root with -mod=vendor
# Each module's vendor/ must be populated independently
cd pkg && go mod vendor
cd services/api && go mod vendor
cd services/worker && go mod vendor

# Then build with vendor
go build -mod=vendor ./...
```

## go.work and CI/CD

### Development vs CI Separation

```bash
# go.work should be committed for development convenience
# CI should build modules independently (without workspace)

# .gitignore: do NOT ignore go.work for development repos
# CI script that builds without workspace:
GOWORK=off go build ./services/api/...
GOWORK=off go test ./services/api/...

# Or use per-module CI:
for module in pkg services/api services/worker cli-tool; do
    cd "$module"
    GOWORK=off go build ./...
    GOWORK=off go test ./...
    cd -
done
```

### CI Pipeline Pattern

```yaml
# .github/workflows/ci.yaml
name: CI

on: [push, pull_request]

jobs:
  workspace-build:
    name: Workspace Build
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-go@v5
      with:
        go-version: '1.23'
        cache: true

    - name: Workspace build and test
      run: |
        go build ./...
        go test -race ./...
        go vet ./...

  module-build:
    name: Independent Module Build
    runs-on: ubuntu-latest
    strategy:
      matrix:
        module: [pkg, services/api, services/worker, cli-tool]
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-go@v5
      with:
        go-version: '1.23'
        cache: true
        cache-dependency-path: "${{ matrix.module }}/go.sum"

    - name: Build module independently
      working-directory: ${{ matrix.module }}
      run: |
        GOWORK=off go build ./...
        GOWORK=off go test ./...
        GOWORK=off go mod tidy
        git diff --exit-code go.mod go.sum

  # After workspace development, ensure go.mod files are synced
  sync-check:
    name: go work sync check
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-go@v5
      with:
        go-version: '1.23'

    - name: Check go work sync
      run: |
        go work sync
        git diff --exit-code
        # If this fails: run 'go work sync' locally and commit the changes
```

## Multiple Workspaces for Large Monorepos

For monorepos with distinct product areas, multiple workspaces can coexist:

```
monorepo/
  platform/
    go.work          # platform workspace
    core/go.mod
    api-framework/go.mod
    auth/go.mod
  data/
    go.work          # data workspace
    pipeline/go.mod
    storage/go.mod
    analytics/go.mod
  tools/
    go.work          # tooling workspace
    codegen/go.mod
    linter/go.mod
```

```bash
# Operate on specific workspace
cd platform && go test ./...
cd data && go test ./...

# Cross-workspace dependency (still uses published versions)
# data/pipeline/go.mod requires platform/core at a published version
# Use workspace only within the same workspace root
```

## go work Subcommands Reference

```bash
# Initialize a new workspace
go work init [modules...]

# Add modules to workspace
go work use ./module1 ./module2

# Edit the go.work file
go work edit [flags]
  -fmt             # format the go.work file
  -go=1.23         # set Go version
  -use=./module    # add module
  -dropuse=./mod   # remove module
  -replace=...     # add replace
  -dropreplace=... # remove replace
  -print           # print resulting go.work

# Sync go.mod files with workspace build list
go work sync

# Verify workspace module graph
go mod graph

# Show effective module dependencies
go list -m all

# Show which workspace member provides a package
go list -m github.com/myorg/pkg
```

## Debugging Workspace Issues

```bash
# Why is this module version being used?
go list -m -mod=mod github.com/grpc-ecosystem/grpc-gateway/v2
# github.com/grpc-ecosystem/grpc-gateway/v2 v2.19.1 => ../grpc-gateway

# Show all module versions in workspace build list
go list -m all | sort

# Check for version inconsistencies across modules
go list -m -json all | jq -r '.Path + " " + .Version' | sort | \
  awk '{split($0,a," "); count[a[1]]++; ver[a[1]]=ver[a[1]] " " a[2]}
       END {for (k in count) if (count[k]>1) print k, ver[k]}'

# Identify which module introduces a dependency
go mod why github.com/some/dependency

# Check for security vulnerabilities
govulncheck ./...

# Build list for a specific module without workspace
GOWORK=off go list -m all
```

## Workspace-Aware Tools

```bash
# gopls (language server) respects go.work
# VS Code Go extension: works automatically with go.work
# Ensure gopls version >= 0.12 for full workspace support

# staticcheck works with workspace
staticcheck ./...

# golangci-lint with workspace (v1.56+)
golangci-lint run ./...

# go generate across all workspace modules
go generate ./...

# Build all binaries
go build -o ./bin/ ./...

# Install all CLI tools in workspace
go install ./cli-tool/cmd/mytool@v0.0.0
# Equivalent without version (workspace context):
go install ./cli-tool/cmd/mytool
```

## Best Practices

### Repository Layout

```
myproject/
  go.work        # committed; enables local multi-module development
  go.work.sum    # committed; dependency verification
  pkg/           # shared library module
    go.mod
    go.sum
  services/
    api/         # service module
      go.mod
      go.sum
    worker/
      go.mod
      go.sum
  tools/         # tooling module
    go.mod
    go.sum
  .gitignore     # does NOT exclude go.work
```

### go.work.sum

```bash
# go.work.sum is generated automatically
# Commit it alongside go.work for reproducible workspace builds
# It contains checksums for dependencies resolved by the workspace
# that aren't in any individual module's go.sum

git add go.work go.work.sum
```

### Upgrade Dependencies Across Workspace

```bash
# Upgrade a dependency in all workspace modules
for dir in pkg services/api services/worker; do
    pushd "$dir"
    go get github.com/some/dep@v2.0.0
    go mod tidy
    popd
done

# Then sync
go work sync

# Upgrade all direct dependencies (use with care in production)
for dir in pkg services/api services/worker; do
    pushd "$dir"
    go get -u ./...
    go mod tidy
    popd
done
go work sync
```

Go workspaces represent the correct architectural solution for multi-module development. They keep `go.mod` files clean for deployment, enable simultaneous changes across module boundaries, and integrate naturally with the Go toolchain. The combination of workspace-local development with per-module CI validation gives you the best of both monorepo and multi-repo development models.
