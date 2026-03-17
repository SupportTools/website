---
title: "Go Build Systems: Bazel, Earthly, and Hermetic Builds for Monorepo Microservices"
date: 2030-02-20T00:00:00-05:00
draft: false
tags: ["Go", "Bazel", "Earthly", "Monorepo", "Build Systems", "CI/CD", "Hermetic Builds", "DevOps"]
categories: ["Go", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to Go monorepo build tooling with Bazel Go rules and Earthly, covering remote caching, incremental builds, hermetic build guarantees, and practical migration paths from Makefiles."
more_link: "yes"
url: "/go-build-systems-bazel-earthly-monorepo/"
---

When a Go repository grows from a handful of microservices to dozens or hundreds, the standard `go build ./...` model starts to break down. A full build takes 15 minutes. CI rebuilds everything when only one service changed. Developers cannot reproduce a failing CI build locally because their environment differs subtly. Bazel and Earthly are the two mature solutions to these problems in 2030, and they take fundamentally different approaches: Bazel through strict hermeticity and fine-grained incremental builds, Earthly through composable Dockerfiles that run identically locally and in CI.

<!--more-->

## Why Standard Go Tooling Fails at Scale

Before choosing a build system, understand the specific failures:

**Rebuild everything on any change**: `go build ./...` rebuilds all packages whose transitive dependencies changed. In a monorepo with 50 services and shared libraries, a change to a core utility package triggers rebuilds of every service, even services that didn't change behavior.

**Non-reproducible builds**: `go build` includes the host machine's file timestamps, environment variables, and tool versions in cached build decisions. A developer with Go 1.22.3 and a CI runner with Go 1.22.4 get different binaries for the same source. This makes cross-environment debugging painful.

**No parallel remote caching**: The default Go build cache is local. When 20 CI runners are building the same monorepo, each performs the same computation independently.

**No cross-language builds**: Modern services often mix Go, TypeScript, Python, and Rust. Bazel builds all of these with the same dependency graph and caching model.

## Bazel for Go Monorepos

### Architecture

Bazel uses a directed acyclic graph (DAG) of build targets. Each target declares its inputs (source files, dependencies) and outputs (binaries, libraries, Docker images). Bazel's hermetic sandbox ensures that targets cannot access files outside their declared inputs, guaranteeing reproducibility.

The Go rules for Bazel (`rules_go`) and Gazelle (the BUILD file generator) handle the translation from Go module semantics to Bazel target semantics.

### Setting Up Bazel in a Go Monorepo

```python
# MODULE.bazel (Bazel 7+ / bzlmod format)
module(name = "mycompany", version = "0.0.0")

bazel_dep(name = "rules_go", version = "0.49.0")
bazel_dep(name = "gazelle", version = "0.36.0")
bazel_dep(name = "rules_oci", version = "1.7.6")
bazel_dep(name = "container_structure_test", version = "1.16.0")

# Go toolchain
go_sdk = use_extension("@rules_go//go:extensions.bzl", "go_sdk")
go_sdk.download(version = "1.23.3")

# Go dependencies from go.mod/go.sum
go_deps = use_extension("@gazelle//:extensions.bzl", "go_deps")
go_deps.from_file(go_mod = "//:go.mod")

# Explicitly list all Go module dependencies
# (Gazelle auto-generates this block)
use_repo(
    go_deps,
    "com_github_gin_gonic_gin",
    "com_github_prometheus_client_golang",
    "com_github_stretchr_testify",
    "org_golang_google_grpc",
    "org_golang_x_net",
)
```

### Workspace Layout

```
mycompany/
├── MODULE.bazel
├── go.mod
├── go.sum
├── .bazelrc
├── .bazelversion
├── BUILD.bazel          # Root build file
├── services/
│   ├── api/
│   │   ├── BUILD.bazel
│   │   ├── main.go
│   │   └── handler.go
│   ├── worker/
│   │   ├── BUILD.bazel
│   │   └── main.go
├── pkg/
│   ├── database/
│   │   ├── BUILD.bazel
│   │   └── client.go
│   ├── middleware/
│   │   ├── BUILD.bazel
│   │   └── auth.go
└── tools/
    ├── BUILD.bazel
    └── gazelle/
        └── main.go
```

### BUILD.bazel Files

```python
# services/api/BUILD.bazel
load("@rules_go//go:def.bzl", "go_binary", "go_library", "go_test")
load("@rules_oci//oci:defs.bzl", "oci_image", "oci_push", "oci_tarball")
load("@rules_go//go:def.bzl", "go_binary")

# Build the Go binary
go_binary(
    name = "api",
    embed = [":api_lib"],
    visibility = ["//visibility:public"],
    # Pure Go build (no CGo) for maximum reproducibility
    pure = "on",
    # Strip debug symbols for smaller binaries
    x_defs = {
        "main.version": "{STABLE_GIT_COMMIT}",
        "main.buildDate": "{BUILD_TIMESTAMP}",
    },
)

go_library(
    name = "api_lib",
    srcs = glob(["*.go"], exclude = ["*_test.go"]),
    importpath = "github.com/mycompany/services/api",
    deps = [
        "//pkg/database",
        "//pkg/middleware",
        "@com_github_gin_gonic_gin//:gin",
        "@com_github_prometheus_client_golang//prometheus",
        "@com_github_prometheus_client_golang//prometheus/promhttp",
        "@org_golang_google_grpc//:grpc",
    ],
)

go_test(
    name = "api_test",
    srcs = glob(["*_test.go"]),
    embed = [":api_lib"],
    deps = [
        "@com_github_stretchr_testify//assert",
        "@com_github_stretchr_testify//require",
    ],
)

# Build a minimal OCI image using a distroless base
oci_image(
    name = "api_image",
    base = "@distroless_static",
    entrypoint = ["/api"],
    tars = [":api_layer"],
)

# Tar the binary for inclusion in the OCI image
genrule(
    name = "api_layer",
    srcs = [":api"],
    outs = ["api_layer.tar"],
    cmd = "$(location @bazel_tools//tools/build_defs/pkg:make_tar) --output=$@ --file=$(location :api)=/api",
    tools = ["@bazel_tools//tools/build_defs/pkg:make_tar"],
)

# Push the image to a registry
oci_push(
    name = "push_api_image",
    image = ":api_image",
    repository = "registry.example.com/mycompany/api",
    remote_tags = ["{STABLE_GIT_COMMIT}", "latest"],
)
```

```python
# pkg/database/BUILD.bazel
load("@rules_go//go:def.bzl", "go_library", "go_test")

go_library(
    name = "database",
    srcs = glob(["*.go"], exclude = ["*_test.go"]),
    importpath = "github.com/mycompany/pkg/database",
    visibility = ["//visibility:public"],
    deps = [
        "@com_github_jackc_pgx_v5//:pgx",
    ],
)

go_test(
    name = "database_test",
    srcs = glob(["*_test.go"]),
    embed = [":database"],
    # Integration tests require a database — run with --test_tag_filters=integration
    tags = ["integration"],
    deps = [
        "@com_github_stretchr_testify//assert",
    ],
)
```

### .bazelrc Configuration

```ini
# .bazelrc

# Common settings
common --enable_bzlmod=true

# Build settings
build --jobs=auto
build --local_ram_resources=HOST_RAM*.70
build --local_cpu_resources=HOST_CPUS*.80

# Go-specific
build --platforms=@io_bazel_rules_go//go/toolchain:linux_amd64
build --stamp  # enable workspace status for version injection

# Hermetic build enforcement
build --sandbox_default_allow_network=false
build --incompatible_strict_action_env=true

# Remote caching (BuildBuddy / EngFlow / self-hosted)
build:remote --bes_results_url=https://buildbuddy.example.com/invocation/
build:remote --bes_backend=grpcs://buildbuddy.example.com
build:remote --remote_cache=grpcs://buildbuddy.example.com
build:remote --remote_timeout=3600
build:remote --remote_upload_local_results=true
build:remote --experimental_remote_cache_compression=true

# Remote execution (optional — for RBE)
build:rbe --config=remote
build:rbe --remote_executor=grpcs://buildbuddy.example.com
build:rbe --jobs=200

# Test settings
test --test_output=errors
test --test_timeout=300

# CI-specific settings
build:ci --config=remote
build:ci --noshow_progress
build:ci --show_result=0
build:ci --verbose_failures=true
```

### Gazelle: Auto-Generating BUILD Files

Gazelle analyzes Go imports and generates BUILD.bazel files automatically:

```bash
# Initial setup: generate all BUILD.bazel files
bazel run //:gazelle

# Update go_repository rules from go.mod
bazel run //:gazelle -- update-repos \
  -from_file=go.mod \
  -to_macro=deps.bzl%go_deps \
  -prune

# After adding new Go files, regenerate BUILD files
bazel run //:gazelle -- fix

# Check what would change without applying
bazel run //:gazelle -- fix --mode=check

# Add Gazelle to the root BUILD.bazel
# ROOT BUILD.bazel
# load("@gazelle//:def.bzl", "gazelle")
# gazelle(name = "gazelle")
```

### Running Builds and Tests

```bash
# Build a single service
bazel build //services/api:api

# Build all services
bazel build //services/...

# Build all services and run all unit tests
bazel test //... --test_tag_filters=-integration

# Build only services that changed vs. main branch
# (requires bazel-diff or similar tool)
git diff --name-only origin/main HEAD | \
  bazel query \
    --keep_going \
    "kind(go_binary, rdeps(//..., set($(cat))))" \
    2>/dev/null | \
  xargs bazel build

# Build and push a Docker image
bazel run //services/api:push_api_image

# Query the dependency graph
bazel query "deps(//services/api:api)" --output=graph | dot -Tsvg > deps.svg
```

## Earthly: Hermetic Builds with Dockerfile Syntax

### Why Earthly vs. Bazel

Earthly's key insight is that Docker already provides hermeticity. If you build in a container, the build is reproducible regardless of host environment. Earthly extends Dockerfile syntax with `COPY` from other targets (cross-target dependencies), `RUN --mount=type=cache` for persistent caching, and a target graph analogous to Bazel's.

Earthly is dramatically easier to adopt than Bazel because:
- No BUILD file generation step
- Dockerfile syntax is already known by most engineers
- Runs locally and in CI identically without setup
- No JVM required (unlike Bazel)
- Gradual adoption: start with a single service's Earthfile

### Earthfile Structure

```dockerfile
# Earthfile (root)
VERSION 0.8

# Base Go build environment
go-base:
    FROM golang:1.23-alpine
    WORKDIR /app

    # Install build dependencies
    RUN apk add --no-cache git make

    # Copy dependency files first (cache layer)
    COPY go.mod go.sum ./
    RUN go mod download

# Build a specific service
service-api:
    FROM +go-base

    # Copy shared packages first (separate cache layer)
    COPY pkg/ ./pkg/

    # Copy service-specific code
    COPY services/api/ ./services/api/

    # Build
    RUN --mount=type=cache,target=/root/.cache/go/build \
        CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
        go build \
            -ldflags="-w -s -X main.version=$(git rev-parse --short HEAD)" \
            -o /out/api \
            ./services/api/

    SAVE ARTIFACT /out/api AS LOCAL ./dist/api

# Run unit tests
test-api:
    FROM +go-base
    COPY pkg/ ./pkg/
    COPY services/api/ ./services/api/

    RUN --mount=type=cache,target=/root/.cache/go/build \
        go test -v -race -count=1 ./services/api/... ./pkg/...

    SAVE ARTIFACT coverage.out AS LOCAL ./coverage/api.out

# Build Docker image for the API service
docker-api:
    FROM gcr.io/distroless/static-debian12:nonroot

    COPY +service-api/api /api

    LABEL org.opencontainers.image.source="https://github.com/mycompany/monorepo"
    LABEL org.opencontainers.image.revision="$GIT_HASH"

    ENTRYPOINT ["/api"]

    SAVE IMAGE --push registry.example.com/mycompany/api:latest
    SAVE IMAGE --push registry.example.com/mycompany/api:$GIT_HASH

# Lint all Go code
lint:
    FROM +go-base
    RUN go install github.com/golangci/golangci-lint/cmd/golangci-lint@v1.62.0

    COPY . .
    RUN golangci-lint run \
        --timeout=5m \
        --issues-exit-code=1 \
        ./...

# Run all service builds in parallel
all:
    BUILD +docker-api
    BUILD +docker-worker
    BUILD +docker-scheduler
    BUILD +lint
```

### Service-Level Earthfiles

Each service can have its own Earthfile that imports from the root:

```dockerfile
# services/api/Earthfile
VERSION 0.8

IMPORT ../../ AS root

build:
    FROM root+go-base
    COPY root+vendor/vendor ./vendor

    COPY . .
    RUN --mount=type=cache,target=/root/.cache/go/build \
        CGO_ENABLED=0 go build -o /api .

    SAVE ARTIFACT /api

docker:
    FROM gcr.io/distroless/static-debian12:nonroot
    COPY +build/api /api
    ENTRYPOINT ["/api"]
    SAVE IMAGE --push registry.example.com/mycompany/api:${GIT_TAG:-latest}

test:
    FROM root+go-base
    COPY . .
    RUN go test -race -coverprofile=coverage.out ./...
    SAVE ARTIFACT coverage.out
```

### Running Earthly Builds

```bash
# Build and push a single service's Docker image
earthly --push +docker-api

# Run tests for all services
earthly +test-all

# Build everything in parallel
earthly +all

# Run with remote caching (Earthly Satellites)
earthly \
  --remote-cache=registry.example.com/mycompany/earthly-cache:api \
  +docker-api

# Run interactively (useful for debugging build failures)
earthly -i +build-api

# Run with secrets from environment
earthly \
  --secret GITHUB_TOKEN \
  --secret NPM_TOKEN \
  +build-frontend
```

### Earthly Remote Caching Configuration

```yaml
# .earthly/config.yml
global:
    # Use Earthly Satellites for remote execution
    # Provides consistent build environment across all developers
    org: mycompany
    satellite: production-sat

    # Remote cache
    cache_size_pct: 15  # Use 15% of satellite disk for cache

    # Network settings for private registries
    buildkit_additional_config: |
        [registry."registry.example.com"]
            ca=["/etc/ssl/certs/ca-certificates.crt"]
            insecure = false
```

## Migrating from Makefiles

### Assessment: What Your Makefile Does

Before migrating, categorize your Makefile targets:

```bash
# Audit a Makefile for migration priority
grep -E '^[a-zA-Z][a-zA-Z0-9_-]+:' Makefile | \
  grep -v '^\.' | \
  awk -F: '{print $1}' | \
  while read target; do
    body=$(sed -n "/^${target}:/,/^[a-zA-Z]/ { /^${target}:/! { /^[a-zA-Z]/! p } }" Makefile)
    echo "=== $target ==="
    echo "$body" | head -5
    echo ""
  done
```

### Incremental Migration Strategy

Phase 1: Move to Earthly while keeping Makefile as the developer interface:

```makefile
# Makefile (transition period — delegates to Earthly)
.PHONY: build test docker lint

build:
	earthly +service-api

test:
	earthly +test-api

docker:
	earthly --push +docker-api

lint:
	earthly +lint

# Legacy targets that are not yet migrated
migrate-db:
	./scripts/migrate.sh

deploy:
	./deploy.sh $(ENV)
```

Phase 2: Bazel migration for projects that need fine-grained incremental builds:

```bash
#!/bin/bash
# scripts/migrate-to-bazel.sh
# Generates initial BUILD.bazel files from existing Go module structure

set -euo pipefail

echo "Step 1: Initialize Bazel workspace files..."
cat > MODULE.bazel << 'EOF'
module(name = "mycompany", version = "0.0.0")
bazel_dep(name = "rules_go", version = "0.49.0")
bazel_dep(name = "gazelle", version = "0.36.0")
EOF

echo "Step 2: Generate BUILD files with Gazelle..."
bazel run //:gazelle

echo "Step 3: Update go_repository rules..."
bazel run //:gazelle -- update-repos \
  -from_file=go.mod \
  -to_macro=deps.bzl%go_deps \
  -prune

echo "Step 4: Verify builds..."
bazel build //... 2>&1 | tee /tmp/bazel-initial-build.log

BUILD_FAILURES=$(grep -c "^ERROR" /tmp/bazel-initial-build.log || true)
if [ "$BUILD_FAILURES" -gt 0 ]; then
  echo "WARNING: $BUILD_FAILURES build failures — review /tmp/bazel-initial-build.log"
else
  echo "SUCCESS: All targets build successfully"
fi

echo "Step 5: Verify tests..."
bazel test //... --test_tag_filters=-integration \
  2>&1 | tail -20
```

## GitHub Actions CI Integration

```yaml
# .github/workflows/ci.yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  bazel-build:
    name: Bazel Build
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0  # Required for affected-target detection

    - name: Mount Bazel cache
      uses: actions/cache@v4
      with:
        path: |
          ~/.cache/bazel
        key: bazel-${{ runner.os }}-${{ hashFiles('MODULE.bazel', 'go.sum') }}
        restore-keys: |
          bazel-${{ runner.os }}-

    - name: Install Bazelisk
      run: |
        curl -Lo /usr/local/bin/bazel \
          https://github.com/bazelbuild/bazelisk/releases/latest/download/bazelisk-linux-amd64
        chmod +x /usr/local/bin/bazel

    - name: Build affected targets
      run: |
        # Detect which targets are affected by this PR
        git diff --name-only origin/main HEAD > /tmp/changed_files.txt
        cat /tmp/changed_files.txt

        AFFECTED=$(bazel query \
          "rdeps(//..., set($(cat /tmp/changed_files.txt | tr '\n' ' ')))" \
          2>/dev/null || echo "//...")

        echo "Building affected targets: $AFFECTED"
        bazel build --config=ci $AFFECTED

    - name: Test affected targets
      run: |
        bazel test --config=ci //... \
          --test_tag_filters=-integration \
          --test_output=errors

  earthly-build:
    name: Earthly Build
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: earthly/actions-setup@v1
      with:
        version: "latest"
        use-cache: true
        cache-suffix: "${{ hashFiles('Earthfile', 'go.sum') }}"

    - name: Build and push images
      if: github.ref == 'refs/heads/main'
      env:
        REGISTRY_USER: ${{ secrets.REGISTRY_USER }}
        REGISTRY_PASS: ${{ secrets.REGISTRY_PASS }}
        GIT_HASH: ${{ github.sha }}
      run: |
        echo "${REGISTRY_PASS}" | \
          docker login registry.example.com -u "${REGISTRY_USER}" --password-stdin
        earthly --push +all
```

## Key Takeaways

Bazel and Earthly solve different problems. Bazel provides the deepest incremental build capability and the strongest hermeticity guarantees, but requires significant initial investment in BUILD file maintenance and toolchain configuration. Earthly provides reproducible container-based builds with a familiar Dockerfile syntax, enabling teams to eliminate "works on my machine" problems incrementally without rewriting their entire build system.

For most Go monorepos with 10-50 services, Earthly with remote caching provides 80% of the benefit of Bazel with 20% of the setup complexity. For monorepos above 50 services, or for organizations with mixed-language codebases where fine-grained incremental builds are critical to developer productivity, Bazel's investment pays off through dramatically reduced CI times.

Remote caching is the highest-leverage optimization for both systems. A cache hit on a build target eliminates the compute entirely, making the effective cost of a large build proportional to the number of changed targets rather than the total number of targets. In a 100-service monorepo where only 3 services change per commit, remote caching means CI runs in minutes rather than hours.

Hermetic builds are not optional for production pipelines. A build that depends on the host environment — the developer's Go installation version, local environment variables, or timing of file system operations — will produce different results in CI than locally, making debugging significantly harder. Both Bazel's sandbox and Earthly's containers enforce hermeticity, making failing builds reproducible.
