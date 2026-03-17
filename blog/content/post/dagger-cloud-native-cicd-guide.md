---
title: "Dagger: Portable CI/CD Pipelines as Code in Go"
date: 2027-12-15T00:00:00-05:00
draft: false
tags: ["Dagger", "CI/CD", "Go", "DevOps", "Containers", "GitHub Actions", "Pipeline", "Build Automation"]
categories:
- DevOps
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Dagger for portable CI/CD pipeline development in Go: Container API, pipeline composition, secrets management, caching strategies, GitHub Actions integration, local testing, and multi-platform builds."
more_link: "yes"
url: "/dagger-cloud-native-cicd-guide/"
---

Dagger redefines how CI/CD pipelines are written by providing a programmable API for container-based execution. Instead of YAML DSL files that only run in a specific CI platform, Dagger pipelines are written in Go (or Python, TypeScript, etc.) using a type-safe SDK. The same pipeline code runs identically on a developer's laptop, in GitHub Actions, in GitLab CI, or in any CI environment. This guide covers the complete Dagger SDK for Go from initial setup through advanced patterns including multi-platform builds, secret management, and pipeline composition.

<!--more-->

# Dagger: Portable CI/CD Pipelines as Code in Go

## Why Dagger

Traditional CI/CD systems have a fundamental problem: pipeline definition is platform-specific YAML. A pipeline written for GitHub Actions cannot run in GitLab CI without a full rewrite. Testing pipeline changes requires pushing commits and waiting for CI to run—there is no local execution model.

Dagger solves both problems:

1. **Portability**: The Dagger engine runs in a Docker container. The same pipeline code runs on any host that has Docker. GitHub Actions, Jenkins, and a developer's MacBook all produce identical results.

2. **Local testing**: `dagger run go run ./ci` executes the full pipeline locally in seconds. No commit, no push, no wait.

3. **Type safety**: Dagger pipelines are real Go code. Types, interfaces, and compiler checks apply. YAML typos are compile errors.

4. **Caching**: Dagger's layer cache is shared between local runs and CI runs (with remote cache configuration), dramatically reducing CI execution time.

## Installation

```bash
# Install Dagger CLI
curl -fsSL https://dl.dagger.io/dagger/install.sh | sh

# Verify
dagger version
# dagger v0.14.0 (registry.dagger.io/engine) linux/amd64
```

## Project Setup

Initialize a Dagger module in an existing Go project:

```bash
# Navigate to your project root
cd /path/to/project

# Initialize a Dagger module
dagger init --sdk=go --source=./ci
```

This creates:
```
ci/
├── main.go          # Dagger module definition
├── dagger.gen.go    # Generated SDK bindings
└── go.mod           # Module dependencies
```

## Basic Pipeline Structure

### Module Definition

```go
// ci/main.go
package main

import (
    "context"
    "fmt"
)

// Pipeline is the main Dagger module struct.
// All pipeline functions are methods on this struct.
type Pipeline struct{}

// Build compiles the Go binary and returns the compiled container.
func (p *Pipeline) Build(
    ctx context.Context,
    // source is the source code directory
    source *Directory,
) (*Container, error) {
    return dag.Container().
        From("golang:1.22-alpine").
        WithDirectory("/src", source).
        WithWorkdir("/src").
        WithExec([]string{"go", "build", "-o", "/bin/app", "./..."}).
        Sync(ctx)
}

// Test runs the full test suite with race detection.
func (p *Pipeline) Test(
    ctx context.Context,
    source *Directory,
) (string, error) {
    return dag.Container().
        From("golang:1.22-alpine").
        WithDirectory("/src", source).
        WithWorkdir("/src").
        WithExec([]string{
            "go", "test",
            "-race",
            "-cover",
            "-coverprofile=/tmp/coverage.out",
            "./...",
        }).
        WithExec([]string{
            "go", "tool", "cover",
            "-func=/tmp/coverage.out",
        }).
        Stdout(ctx)
}
```

### Running the Pipeline

```bash
# Run the Test function
dagger call test --source=.

# Run the Build function
dagger call build --source=.

# Use Go directly (for complex pipelines)
cd ci && go run . test --source=..
```

## Container API Deep Dive

### Building a Production Docker Image

```go
// ci/main.go

// BuildImage builds a multi-stage Docker image and returns the final container.
func (p *Pipeline) BuildImage(
    ctx context.Context,
    source *Directory,
    // tag is the image tag to apply
    tag string,
) (*Container, error) {
    // Stage 1: Build binary
    builder := dag.Container().
        From("golang:1.22-alpine").
        WithMountedCache("/root/pkg", dag.CacheVolume("go-pkg")).
        WithMountedCache("/root/.cache/go-build", dag.CacheVolume("go-build")).
        WithDirectory("/src", source).
        WithWorkdir("/src").
        WithEnvVariable("CGO_ENABLED", "0").
        WithEnvVariable("GOOS", "linux").
        WithEnvVariable("GOARCH", "amd64").
        WithExec([]string{
            "go", "build",
            "-trimpath",
            "-ldflags=-s -w",
            "-o", "/bin/app",
            "./cmd/server",
        })

    // Extract binary from builder
    binary := builder.File("/bin/app")

    // Stage 2: Minimal runtime image
    runtime := dag.Container().
        From("gcr.io/distroless/static-debian12:nonroot").
        WithFile("/app", binary).
        WithEntrypoint([]string{"/app"}).
        WithExposedPort(8080).
        WithLabel("org.opencontainers.image.source", "https://github.com/company/app").
        WithLabel("org.opencontainers.image.version", tag)

    return runtime.Sync(ctx)
}

// PublishImage builds and publishes the image to a registry.
func (p *Pipeline) PublishImage(
    ctx context.Context,
    source *Directory,
    tag string,
    registryUsername string,
    registryPassword *Secret,
    registry string,
) (string, error) {
    image, err := p.BuildImage(ctx, source, tag)
    if err != nil {
        return "", fmt.Errorf("building image: %w", err)
    }

    imageRef := fmt.Sprintf("%s/company/app:%s", registry, tag)

    return image.
        WithRegistryAuth(registry, registryUsername, registryPassword).
        Publish(ctx, imageRef)
}
```

## Secrets Management

Dagger provides a `Secret` type that prevents secret values from appearing in logs, build cache, or command output.

### Secrets from Environment Variables

```go
// SecretFromEnv demonstrates passing secrets without exposing values in logs.
func (p *Pipeline) Deploy(
    ctx context.Context,
    source *Directory,
    // kubeconfig is the path to the kubeconfig secret
    kubeconfig *Secret,
    // imageTag is the tag to deploy
    imageTag string,
) (string, error) {
    return dag.Container().
        From("bitnami/kubectl:1.29").
        WithMountedSecret("/root/.kube/config", kubeconfig).
        WithDirectory("/deploy", source.Directory("k8s")).
        WithWorkdir("/deploy").
        WithExec([]string{
            "kubectl", "set", "image",
            "deployment/app",
            fmt.Sprintf("app=company/app:%s", imageTag),
            "-n", "production",
        }).
        Stdout(ctx)
}
```

Calling this from the CLI:

```bash
# Pass secret from environment variable - value never appears in logs
dagger call deploy \
  --source=. \
  --kubeconfig=env:KUBECONFIG \
  --image-tag=v1.2.3
```

### Secrets from Files and Vault

```go
// VaultSecret fetches a secret from HashiCorp Vault.
func (p *Pipeline) VaultSecret(
    ctx context.Context,
    vaultToken *Secret,
    vaultAddr string,
    secretPath string,
) (*Secret, error) {
    output, err := dag.Container().
        From("hashicorp/vault:1.16").
        WithSecretVariable("VAULT_TOKEN", vaultToken).
        WithEnvVariable("VAULT_ADDR", vaultAddr).
        WithExec([]string{
            "vault", "kv", "get",
            "-field=value",
            secretPath,
        }).
        Stdout(ctx)
    if err != nil {
        return nil, fmt.Errorf("fetching vault secret: %w", err)
    }

    return dag.SetSecret("vault-secret", output), nil
}
```

## Caching Strategies

Dagger's cache volumes persist between pipeline runs, dramatically reducing build times for dependency downloads and compilation.

### Go Module Cache

```go
// OptimizedGoBuild demonstrates multi-level caching for Go builds.
func (p *Pipeline) OptimizedGoBuild(
    ctx context.Context,
    source *Directory,
) (*Container, error) {
    // Named cache volumes persist between runs
    goPkgCache := dag.CacheVolume("go-pkg-cache")
    goBuildCache := dag.CacheVolume("go-build-cache")

    return dag.Container().
        From("golang:1.22-alpine").
        // Mount Go module cache - prevents re-downloading dependencies
        WithMountedCache("/go/pkg/mod", goPkgCache).
        // Mount Go build cache - preserves compiled packages
        WithMountedCache("/root/.cache/go-build", goBuildCache).
        WithDirectory("/src", source).
        WithWorkdir("/src").
        // Download dependencies first (cached layer)
        WithExec([]string{"go", "mod", "download"}).
        // Build binary (uses cached compiled packages)
        WithExec([]string{"go", "build", "-o", "/bin/app", "./..."}).
        Sync(ctx)
}
```

### npm Cache

```go
func (p *Pipeline) BuildFrontend(
    ctx context.Context,
    source *Directory,
) (*Directory, error) {
    nodeModulesCache := dag.CacheVolume("node-modules-cache")

    buildOutput, err := dag.Container().
        From("node:20-alpine").
        WithMountedCache("/root/.npm", nodeModulesCache).
        WithDirectory("/app", source.Directory("frontend")).
        WithWorkdir("/app").
        WithExec([]string{"npm", "ci", "--prefer-offline"}).
        WithExec([]string{"npm", "run", "build"}).
        Sync(ctx)
    if err != nil {
        return nil, err
    }

    return buildOutput.Directory("/app/dist"), nil
}
```

## Pipeline Composition

Dagger pipelines compose naturally because functions return typed values that other functions can consume.

### Full CI Pipeline

```go
// CI represents the complete continuous integration pipeline.
// It runs tests, builds the image, scans for vulnerabilities,
// and publishes on success.
func (p *Pipeline) CI(
    ctx context.Context,
    source *Directory,
    // tag is the git tag or commit SHA
    tag string,
    // registryPassword for pushing to registry
    registryPassword *Secret,
) error {
    // Step 1: Lint
    lintOutput, err := p.Lint(ctx, source)
    if err != nil {
        return fmt.Errorf("lint failed: %w", err)
    }
    fmt.Println("Lint:", lintOutput)

    // Step 2: Test
    testOutput, err := p.Test(ctx, source)
    if err != nil {
        return fmt.Errorf("tests failed: %w", err)
    }
    fmt.Println("Tests:", testOutput)

    // Step 3: Build image
    image, err := p.BuildImage(ctx, source, tag)
    if err != nil {
        return fmt.Errorf("build failed: %w", err)
    }

    // Step 4: Security scan
    scanResult, err := p.SecurityScan(ctx, image)
    if err != nil {
        return fmt.Errorf("security scan failed: %w", err)
    }
    fmt.Println("Security scan:", scanResult)

    // Step 5: Publish (only if all previous steps succeeded)
    imageRef, err := image.
        WithRegistryAuth("ghcr.io", "github-token", registryPassword).
        Publish(ctx, fmt.Sprintf("ghcr.io/company/app:%s", tag))
    if err != nil {
        return fmt.Errorf("publish failed: %w", err)
    }
    fmt.Println("Published:", imageRef)

    return nil
}

// Lint runs golangci-lint on the source.
func (p *Pipeline) Lint(ctx context.Context, source *Directory) (string, error) {
    return dag.Container().
        From("golangci/golangci-lint:v1.57-alpine").
        WithDirectory("/src", source).
        WithWorkdir("/src").
        WithExec([]string{
            "golangci-lint", "run",
            "--timeout=5m",
            "--out-format=colored-line-number",
        }).
        Stdout(ctx)
}

// SecurityScan runs Trivy vulnerability scanning on a container image.
func (p *Pipeline) SecurityScan(
    ctx context.Context,
    image *Container,
) (string, error) {
    imageRef, err := image.Publish(ctx, "ttl.sh/scan-target:latest")
    if err != nil {
        return "", fmt.Errorf("publishing for scan: %w", err)
    }

    return dag.Container().
        From("aquasec/trivy:latest").
        WithExec([]string{
            "trivy", "image",
            "--exit-code=1",
            "--severity=CRITICAL,HIGH",
            "--no-progress",
            imageRef,
        }).
        Stdout(ctx)
}
```

## Multi-Platform Builds

```go
// MultiPlatformBuild builds container images for multiple architectures.
func (p *Pipeline) MultiPlatformBuild(
    ctx context.Context,
    source *Directory,
    tag string,
    registryPassword *Secret,
) (string, error) {
    platforms := []Platform{
        "linux/amd64",
        "linux/arm64",
        "linux/arm/v7",
    }

    platformVariants := make([]*Container, 0, len(platforms))

    for _, platform := range platforms {
        // Parse platform string
        os, arch, variant := parsePlatform(string(platform))

        binary, err := dag.Container().
            From("golang:1.22-alpine").
            WithMountedCache("/root/pkg", dag.CacheVolume("go-pkg")).
            WithMountedCache("/root/.cache/go-build", dag.CacheVolume("go-build-"+arch)).
            WithDirectory("/src", source).
            WithWorkdir("/src").
            WithEnvVariable("CGO_ENABLED", "0").
            WithEnvVariable("GOOS", os).
            WithEnvVariable("GOARCH", arch).
            WithEnvVariable("GOARM", variant).
            WithExec([]string{
                "go", "build",
                "-trimpath",
                "-ldflags=-s -w",
                "-o", "/bin/app",
                "./cmd/server",
            }).
            File("/bin/app"), nil
        if err != nil {
            return "", fmt.Errorf("building for %s: %w", platform, err)
        }

        platformVariant := dag.Container(dagger.ContainerOpts{Platform: platform}).
            From("gcr.io/distroless/static-debian12:nonroot").
            WithFile("/app", binary).
            WithEntrypoint([]string{"/app"}).
            WithExposedPort(8080)

        platformVariants = append(platformVariants, platformVariant)
    }

    // Publish multi-arch manifest
    return dag.Container().
        Publish(ctx,
            fmt.Sprintf("ghcr.io/company/app:%s", tag),
            dagger.ContainerPublishOpts{
                PlatformVariants: platformVariants,
            },
            dagger.WithRegistryAuth("ghcr.io", "company-bot", registryPassword),
        )
}

func parsePlatform(platform string) (os, arch, variant string) {
    parts := strings.Split(platform, "/")
    os = parts[0]
    if len(parts) > 1 {
        arch = parts[1]
    }
    if len(parts) > 2 {
        variant = parts[2]
    }
    return
}
```

## GitHub Actions Integration

Dagger pipelines run in GitHub Actions with a single step:

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:

env:
  DAGGER_VERSION: "0.14.0"

jobs:
  ci:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      - name: Install Dagger
        run: |
          curl -fsSL https://dl.dagger.io/dagger/install.sh | DAGGER_VERSION=$DAGGER_VERSION sh
          echo "$HOME/.local/bin" >> $GITHUB_PATH

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: "1.22"

      - name: Run CI Pipeline
        env:
          REGISTRY_PASSWORD: ${{ secrets.GITHUB_TOKEN }}
        run: |
          cd ci
          go run . ci \
            --source=.. \
            --tag=${{ github.sha }} \
            --registry-password=env:REGISTRY_PASSWORD

      # Optional: cache Dagger engine layers
      - name: Cache Dagger layers
        uses: actions/cache@v4
        with:
          path: ~/.local/share/dagger
          key: dagger-${{ runner.os }}-${{ hashFiles('ci/go.sum') }}
          restore-keys: |
            dagger-${{ runner.os }}-
```

### Using Dagger Cloud for Remote Caching

Dagger Cloud provides a remote cache that can be shared between CI runs and developer machines:

```yaml
      - name: Run CI Pipeline
        env:
          DAGGER_CLOUD_TOKEN: ${{ secrets.DAGGER_CLOUD_TOKEN }}
          REGISTRY_PASSWORD: ${{ secrets.GITHUB_TOKEN }}
        run: |
          cd ci
          go run . ci \
            --source=.. \
            --tag=${{ github.sha }} \
            --registry-password=env:REGISTRY_PASSWORD
```

With `DAGGER_CLOUD_TOKEN` set, Dagger automatically pushes and pulls cache layers from Dagger Cloud, enabling cache hits between different CI runners.

## Services: Running Dependencies

Dagger services allow pipeline steps to depend on running containers (databases, message queues, etc.) without external infrastructure:

```go
// TestWithDatabase runs integration tests against a real PostgreSQL database.
func (p *Pipeline) TestWithDatabase(
    ctx context.Context,
    source *Directory,
) (string, error) {
    // Start a PostgreSQL service
    postgres := dag.Container().
        From("postgres:16-alpine").
        WithEnvVariable("POSTGRES_DB", "testdb").
        WithEnvVariable("POSTGRES_USER", "test").
        WithEnvVariable("POSTGRES_PASSWORD", "testpass").
        WithExposedPort(5432).
        AsService()

    // Run tests that connect to the PostgreSQL service
    return dag.Container().
        From("golang:1.22-alpine").
        WithMountedCache("/root/pkg", dag.CacheVolume("go-pkg")).
        WithMountedCache("/root/.cache/go-build", dag.CacheVolume("go-build")).
        // Bind the postgres service - accessible as "postgres:5432"
        WithServiceBinding("postgres", postgres).
        WithDirectory("/src", source).
        WithWorkdir("/src").
        WithEnvVariable("DATABASE_URL", "postgres://test:testpass@postgres:5432/testdb?sslmode=disable").
        WithExec([]string{
            "go", "test",
            "-v",
            "-tags=integration",
            "./internal/db/...",
        }).
        Stdout(ctx)
}
```

## Development Workflow

### Local Development Helpers

```go
// Dev starts a development server with hot-reload for local development.
func (p *Pipeline) Dev(
    ctx context.Context,
    source *Directory,
) error {
    _, err := dag.Container().
        From("golang:1.22-alpine").
        WithMountedCache("/root/pkg", dag.CacheVolume("go-pkg")).
        WithMountedCache("/root/.cache/go-build", dag.CacheVolume("go-build")).
        WithExec([]string{"go", "install", "github.com/air-verse/air@latest"}).
        WithDirectory("/src", source).
        WithWorkdir("/src").
        WithExposedPort(8080).
        WithExec([]string{"air", "-c", ".air.toml"}).
        Sync(ctx)
    return err
}

// Shell opens an interactive shell in the build environment.
func (p *Pipeline) Shell(
    ctx context.Context,
    source *Directory,
) error {
    _, err := dag.Container().
        From("golang:1.22-alpine").
        WithMountedCache("/root/pkg", dag.CacheVolume("go-pkg")).
        WithDirectory("/src", source).
        WithWorkdir("/src").
        Terminal().
        Sync(ctx)
    return err
}
```

```bash
# Open interactive shell in build environment
dagger call shell --source=.

# Run dev server
dagger call dev --source=.
```

## Error Handling and Reporting

```go
// CIWithReport runs CI and generates a structured report.
func (p *Pipeline) CIWithReport(
    ctx context.Context,
    source *Directory,
    tag string,
) error {
    type stepResult struct {
        name     string
        output   string
        err      error
        duration time.Duration
    }

    results := []stepResult{}

    runStep := func(name string, fn func() (string, error)) {
        start := time.Now()
        output, err := fn()
        results = append(results, stepResult{
            name:     name,
            output:   output,
            err:      err,
            duration: time.Since(start),
        })
    }

    runStep("lint", func() (string, error) { return p.Lint(ctx, source) })
    runStep("test", func() (string, error) { return p.Test(ctx, source) })
    runStep("build", func() (string, error) {
        _, err := p.BuildImage(ctx, source, tag)
        return "", err
    })

    // Print report
    fmt.Println("\n=== CI Pipeline Results ===")
    hasErrors := false
    for _, r := range results {
        status := "PASS"
        if r.err != nil {
            status = "FAIL"
            hasErrors = true
        }
        fmt.Printf("[%s] %s (%v)\n", status, r.name, r.duration.Round(time.Millisecond))
        if r.err != nil {
            fmt.Printf("  Error: %v\n", r.err)
        }
    }

    if hasErrors {
        return fmt.Errorf("CI pipeline failed - see report above")
    }
    return nil
}
```

## Debugging Pipelines

```bash
# Run with debug output
DAGGER_LOG_LEVEL=debug dagger call ci --source=.

# Inspect what commands run inside a container
dagger call build --source=. --debug

# Open interactive shell at a specific pipeline stage
# Modify the pipeline to add .Terminal() at the desired stage:
# WithExec([]string{"go", "build", ...}).Terminal()
dagger call debug-build --source=.
```

## Performance Optimization

### Minimizing Source Upload

```go
// Exclude unnecessary files from the source directory upload.
// Large node_modules, .git directories, and test artifacts slow down uploads.
func (p *Pipeline) Build(ctx context.Context, source *Directory) (*Container, error) {
    // Filter the source directory before mounting
    filteredSource := source.
        WithoutDirectory(".git").
        WithoutDirectory("node_modules").
        WithoutDirectory(".dagger").
        WithoutFile(".env")

    return dag.Container().
        From("golang:1.22-alpine").
        WithDirectory("/src", filteredSource).
        ...
}
```

### Parallel Execution

```go
import "golang.org/x/sync/errgroup"

// ParallelCI runs lint, test, and security scan in parallel.
func (p *Pipeline) ParallelCI(ctx context.Context, source *Directory) error {
    g, ctx := errgroup.WithContext(ctx)

    g.Go(func() error {
        _, err := p.Lint(ctx, source)
        return err
    })

    g.Go(func() error {
        _, err := p.Test(ctx, source)
        return err
    })

    g.Go(func() error {
        _, err := p.SecurityScan(ctx, nil) // static analysis only
        return err
    })

    return g.Wait()
}
```

## Summary

Dagger's container-native pipeline model addresses the core deficiencies of YAML-based CI: platform lock-in, lack of local execution, and inability to apply software engineering practices (types, tests, abstractions) to pipeline code. Go pipelines written with the Dagger SDK compile, type-check, and run identically on developer workstations and CI platforms.

The key operational advantages: cache volumes shared between local and CI executions reduce redundant dependency downloads; service bindings enable integration tests without external infrastructure; multi-platform builds produce correct multi-arch manifests without qemu emulation; and the terminal primitive enables interactive debugging directly in the pipeline execution environment.

For teams migrating from GitHub Actions YAML, the practical approach is to start with the most painful YAML workflows—those with complex matrix builds, shared steps, or multi-step artifact passing—and rewrite them in Dagger. The initial investment in the Go SDK pays back immediately in local testability and cache efficiency.
