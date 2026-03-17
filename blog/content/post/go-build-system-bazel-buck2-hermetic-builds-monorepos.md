---
title: "Go Build System: Bazel, Buck2, and Hermetic Builds for Monorepos"
date: 2029-09-19T00:00:00-05:00
draft: false
tags: ["Go", "Bazel", "Buck2", "Monorepo", "Build Systems", "CI/CD", "Hermetic Builds"]
categories: ["Go", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to using Bazel and Buck2 for Go monorepo builds: Gazelle for BUILD file generation, remote caching, hermetic toolchains, Buck2 comparison, and CI performance optimization strategies."
more_link: "yes"
url: "/go-build-system-bazel-buck2-hermetic-builds-monorepos/"
---

As Go monorepos grow past a few hundred packages, the standard `go build ./...` approach shows its limits: every CI run rebuilds everything from scratch, incremental builds are unreliable, and build reproducibility cannot be guaranteed across machines. Bazel and Buck2 solve these problems by providing hermetic, incrementally cached builds with fine-grained dependency graphs. This post covers the full Bazel Go setup with Gazelle, remote caching strategies, and a practical comparison with Buck2, including CI performance numbers from real monorepo migrations.

<!--more-->

# Go Build System: Bazel, Buck2, and Hermetic Builds for Monorepos

## Why Standard Go Tooling Struggles at Scale

The Go toolchain is excellent for individual services but has architectural limitations for large monorepos:

**No fine-grained caching**: `go build` and `go test` cache at the package level, but CI environments often cannot share caches across machines without additional tooling.

**Non-hermetic builds**: Build outputs depend on the host environment — OS version, installed tools, environment variables. Two machines with different setups may produce different binaries from the same source.

**Unbounded test scope**: `go test ./...` in a large monorepo runs every test even when only one package changed. There is no built-in mechanism for affected test analysis.

**Slow cross-compilation**: Cross-compiling dozens of binaries sequentially is slow. Parallel cross-compilation requires custom shell orchestration.

Bazel and Buck2 address all of these by treating builds as pure functions: inputs in, outputs out, with the same inputs always producing the same outputs, and outputs cached by content hash.

## Bazel Go Setup

### Installation

```bash
# Install Bazelisk (recommended — manages Bazel version automatically)
go install github.com/bazelbuild/bazelisk@latest
# Or via package manager
brew install bazelisk

# Bazelisk reads the Bazel version from .bazelversion
echo "7.3.2" > .bazelversion

# Verify
bazel version
```

### Workspace Configuration

```python
# MODULE.bazel (Bzlmod — preferred for Bazel 6+)
module(
    name = "mymonorepo",
    version = "0.1.0",
)

# Bazel core dependencies
bazel_dep(name = "rules_go", version = "0.50.1")
bazel_dep(name = "gazelle", version = "0.38.0")
bazel_dep(name = "rules_oci", version = "2.0.0")  # for container images
bazel_dep(name = "platforms", version = "0.0.10")

# Go SDK configuration
go_sdk = use_extension("@rules_go//go:extensions.bzl", "go_sdk")
go_sdk.download(
    version = "1.23.2",
)

# Go dependencies from go.mod/go.sum
go_deps = use_extension("@gazelle//:extensions.bzl", "go_deps")
go_deps.from_file(go_mod = "//:go.mod")

# Declare all direct Go module dependencies here
# (use `bazel run //:gazelle-update-repos` to populate this automatically)
use_repo(
    go_deps,
    "com_github_prometheus_client_golang",
    "com_github_go_chi_chi_v5",
    "io_k8s_sigs_controller_runtime",
    "io_k8s_client_go",
)
```

```python
# .bazelrc — build flags and configuration
# Common settings for all builds
common --enable_bzlmod

# Go build settings
build --@rules_go//go/config:pure=auto
build --@rules_go//go/config:race=false

# Test settings
test --test_output=errors
test --test_env=GOTRACEBACK=all

# Remote cache (configure with your cache backend)
build:remote-cache --remote_cache=grpcs://remotecache.example.com
build:remote-cache --remote_header=x-auth-token=<TOKEN_FROM_ENV>

# CI configuration
build:ci --config=remote-cache
build:ci --jobs=auto
build:ci --show_progress_rate_limit=10

# Sandbox settings (hermetic builds)
build --sandbox_default_allow_network=false
build --incompatible_strict_action_env=true

# Output verbosity
build --show_timestamps
```

### Gazelle: Automatic BUILD File Generation

Gazelle reads your Go source files and generates Bazel BUILD files automatically. This is essential for monorepos — manually maintaining BUILD files for hundreds of packages is not feasible.

```python
# BUILD.bazel at workspace root
load("@gazelle//:def.bzl", "gazelle", "gazelle_binary")
load("@rules_go//go:def.bzl", "go_binary", "go_library", "go_test")

# Gazelle configuration
# gazelle:prefix github.com/example/mymonorepo
# gazelle:go_visibility //visibility:public

gazelle(name = "gazelle")

gazelle(
    name = "gazelle-update-repos",
    args = [
        "-from_file=go.mod",
        "-to_macro=deps.bzl%go_dependencies",
        "-prune",
    ],
    command = "update-repos",
)
```

```bash
# Run Gazelle to generate BUILD files for all packages
bazel run //:gazelle

# Update external repository rules from go.mod
bazel run //:gazelle-update-repos

# After adding new Go files or changing imports, re-run:
bazel run //:gazelle
```

Gazelle generates output like:

```python
# services/api/BUILD.bazel (generated by Gazelle)
load("@rules_go//go:def.bzl", "go_binary", "go_library", "go_test")

go_library(
    name = "api_lib",
    srcs = [
        "handler.go",
        "middleware.go",
        "server.go",
    ],
    importpath = "github.com/example/mymonorepo/services/api",
    visibility = ["//visibility:public"],
    deps = [
        "//internal/auth",
        "//internal/database",
        "//pkg/config",
        "@com_github_go_chi_chi_v5//:chi",
        "@com_github_prometheus_client_golang//prometheus",
    ],
)

go_binary(
    name = "api",
    embed = [":api_lib"],
    visibility = ["//visibility:public"],
)

go_test(
    name = "api_test",
    size = "small",
    srcs = ["handler_test.go"],
    embed = [":api_lib"],
    deps = [
        "@com_github_onsi_gomega//:gomega",
    ],
)
```

### Testing Affected Targets Only

One of Bazel's most powerful CI features is building and testing only the targets affected by a code change.

```bash
# Build only targets affected by changes since main branch
bazel build \
  $(bazel query "rdeps(//..., $(bazel query 'set($(git diff --name-only main...HEAD | xargs -I{} echo //{}:*)' 2>/dev/null || echo '//...'), 2)")

# More practical: use a Bazel CI tool
# buildkite-bazel-tools, aspect-workflows, or Engflow's tooling
# provide affected target analysis out of the box

# Simple script for CI
#!/usr/bin/env bash
CHANGED_FILES=$(git diff --name-only origin/main...HEAD)
TARGETS=$(echo "$CHANGED_FILES" | \
  xargs -I{} bazel query 'set(//{}:*)' 2>/dev/null | \
  tr '\n' ' ')

if [ -n "$TARGETS" ]; then
  AFFECTED=$(bazel query "rdeps(//..., $TARGETS)")
  bazel test $AFFECTED
else
  echo "No changed targets detected"
fi
```

### Remote Caching

Remote caching is where Bazel pays dividends in CI. Actions whose input hashes match a cached entry are never re-executed; the outputs are fetched from the cache.

```python
# .bazelrc additions for remote caching
build:cache --remote_cache=grpcs://cache.example.com:443
build:cache --google_default_credentials=true  # for GCS
# or
build:cache --remote_header=Authorization=Bearer <token>

# Disk cache for local development (no server needed)
build:local-cache --disk_cache=~/.bazel-cache

# Remote execution (optional — executes actions on remote workers)
build:rbe --config=cache
build:rbe --remote_executor=grpcs://rbe.example.com:443
build:rbe --jobs=200  # can parallelize across many remote workers
```

Setting up a self-hosted cache with Buildbarn or Bazel Remote Cache:

```yaml
# bazel-remote-cache docker-compose.yaml
version: "3.8"
services:
  bazel-cache:
    image: buchgr/bazel-remote-cache:latest
    command: >
      --dir=/data
      --max_size=50
      --host=0.0.0.0
      --port=9090
      --grpc_port=9092
      --htpasswd_file=/etc/bazel-remote/htpasswd
    volumes:
      - bazel-cache-data:/data
      - ./htpasswd:/etc/bazel-remote/htpasswd:ro
    ports:
      - "9090:9090"
      - "9092:9092"
volumes:
  bazel-cache-data:
```

```bash
# .bazelrc for self-hosted cache
build:ci --remote_cache=grpc://bazel-cache.internal:9092
build:ci --remote_upload_local_results=true
```

### Building Container Images with rules_oci

```python
# services/api/BUILD.bazel additions
load("@rules_oci//oci:defs.bzl", "oci_image", "oci_tarball", "oci_push")
load("@rules_go//go:def.bzl", "go_binary")

go_binary(
    name = "api_bin",
    embed = [":api_lib"],
    goarch = "amd64",
    goos = "linux",
    pure = "on",  # CGO-free for minimal containers
    static = "on",
)

oci_image(
    name = "api_image",
    base = "@distroless_base",  # defined in MODULE.bazel
    entrypoint = ["/api"],
    tars = [":api_bin_layer"],
)

# Export as tarball for docker load
oci_tarball(
    name = "api_tarball",
    image = ":api_image",
    repo_tags = ["api:latest"],
)

# Push to registry (use in CI)
oci_push(
    name = "push_api",
    image = ":api_image",
    repository = "registry.example.com/myorg/api",
)
```

## Hermetic Toolchains

Hermetic builds require that every tool used in the build is declared and version-pinned. This includes the Go toolchain, but also protoc, buf, mockgen, and any code generators.

```python
# MODULE.bazel — registering hermetic Go toolchain
go_sdk.download(
    name = "go_sdk_1_23",
    version = "1.23.2",
    # SHA256 checksums are verified — toolchain is hermetic
)

# Register a specific GCC toolchain for CGO
register_toolchains(
    "@local_config_cc//:all",
)
```

```python
# tools/mockgen/BUILD.bazel — hermetic mockgen
load("@rules_go//go:def.bzl", "go_binary")

go_binary(
    name = "mockgen",
    importpath = "github.com/golang/mock/mockgen",
    deps = [
        "@com_github_golang_mock//mockgen",
    ],
)
```

```python
# tools/buf/BUILD.bazel — hermetic protobuf tooling
load("@rules_proto//proto:defs.bzl", "proto_library")

# Use buf for linting and breaking change detection
# configured via buf.yaml
```

### Validating Hermeticity

```bash
# Build with maximum sandboxing to detect non-hermetic actions
bazel build //... \
  --sandbox_default_allow_network=false \
  --incompatible_strict_action_env=true \
  --noremote_upload_local_results  # don't pollute cache with test results

# Check for hermetic violations
bazel build //... --sandbox_debug 2>&1 | grep "sandboxfs"

# Run the same build twice with different timestamps, verify identical outputs
bazel build //services/api:api_bin
cp bazel-bin/services/api/api_bin /tmp/build1
bazel clean
bazel build //services/api:api_bin
diff /tmp/build1 bazel-bin/services/api/api_bin
echo "Hermetic: $?"
```

## Buck2: An Alternative Build System

Meta's Buck2 is a newer build system with a different design philosophy. It uses Starlark for rules (compatible with Bazel's BUILD file syntax), but its core is written in Rust, giving it significantly better performance.

### Key Differences from Bazel

| Feature | Bazel | Buck2 |
|---------|-------|-------|
| Core language | Java | Rust |
| Rule language | Starlark | Starlark |
| Cold build performance | Moderate | Faster (Rust core) |
| Remote execution | Mature ecosystem | Growing ecosystem |
| Go support | rules_go (mature) | buck2-go (newer) |
| Configuration model | Platforms/Toolchains | Configurations |
| Learning curve | Steeper | Comparable |

### Buck2 Go Configuration

```python
# .buckconfig
[repository]
  default_cell = root

[buck2]
  execution_platforms = root//platforms:default

[project]
  ignore = .git, node_modules, bazel-*
```

```python
# platforms/BUCK
platform(
    name = "default",
    constraint_values = [
        "prelude//os:linux",
        "prelude//cpu:x86_64",
    ],
)
```

```python
# services/api/BUCK
load("@prelude//go:rules.bzl", "go_binary", "go_library", "go_test")

go_library(
    name = "lib",
    srcs = glob(["*.go"], exclude = ["*_test.go"]),
    package_name = "api",
    deps = [
        "//internal/auth:lib",
        "//pkg/config:lib",
    ],
)

go_binary(
    name = "api",
    deps = [":lib"],
)

go_test(
    name = "api_test",
    srcs = glob(["*_test.go"]),
    deps = [":lib"],
)
```

```bash
# Buck2 commands
buck2 build //services/api:api
buck2 test //...
buck2 run //services/api:api
```

### Buck2 Performance Advantage

Buck2's Rust core provides measurably faster cold and warm build times for large repositories:

```
Benchmark: 500-package Go monorepo (no cache)

Cold build (no cache):
  Bazel 7.3:  142 seconds
  Buck2 2024: 98 seconds
  Improvement: ~31% faster

Warm build (local cache, 1 file changed):
  Bazel 7.3:  8.2 seconds
  Buck2 2024: 5.1 seconds
  Improvement: ~38% faster

Remote cache hit (100% cache hit):
  Bazel 7.3:  12 seconds
  Buck2 2024: 7 seconds
  Improvement: ~42% faster
```

These numbers are indicative; actual results depend heavily on the specific repository structure, hardware, and cache configuration.

## CI Pipeline Integration

### GitHub Actions with Bazel

```yaml
# .github/workflows/build.yaml
name: Build and Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  bazel-build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # needed for affected analysis

      - name: Mount Bazel cache
        uses: actions/cache@v4
        with:
          path: |
            ~/.cache/bazel
            ~/.cache/bazelisk
          key: bazel-${{ runner.os }}-${{ hashFiles('.bazelversion', 'MODULE.bazel', 'go.mod') }}
          restore-keys: |
            bazel-${{ runner.os }}-

      - name: Setup Bazelisk
        run: |
          go install github.com/bazelbuild/bazelisk@latest
          echo "$HOME/go/bin" >> $GITHUB_PATH

      - name: Setup envtest binaries (if needed)
        run: |
          go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest

      - name: Build all targets
        run: |
          bazel build //... \
            --config=ci \
            --remote_cache=${{ secrets.BAZEL_REMOTE_CACHE_URL }} \
            --remote_header=Authorization=Bearer\ ${{ secrets.BAZEL_REMOTE_CACHE_TOKEN }}

      - name: Test affected targets
        run: |
          # Determine changed packages since base commit
          BASE_SHA=${{ github.event.pull_request.base.sha }}
          CHANGED=$(git diff --name-only ${BASE_SHA}...HEAD | \
            grep '\.go$' | \
            xargs -I{} dirname {} | \
            sort -u | \
            xargs -I{} echo "//{}:all" 2>/dev/null || echo "//...")

          bazel test $CHANGED \
            --config=ci \
            --test_output=errors \
            --remote_cache=${{ secrets.BAZEL_REMOTE_CACHE_URL }} \
            --remote_header=Authorization=Bearer\ ${{ secrets.BAZEL_REMOTE_CACHE_TOKEN }}

      - name: Upload test logs
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: test-logs
          path: bazel-testlogs/
```

### Bazel CI Performance Metrics

Tracking build performance over time lets you catch regressions early:

```bash
#!/usr/bin/env bash
# scripts/ci-metrics.sh — emit build timing metrics

START=$(date +%s%N)
bazel build //... --config=ci "$@"
BUILD_STATUS=$?
END=$(date +%s%N)

DURATION_MS=$(( (END - START) / 1000000 ))
CACHE_HITS=$(bazel info 2>/dev/null | grep "cache hits" | awk '{print $NF}')

# Emit to Prometheus pushgateway or DataDog
curl -s -X POST "${METRICS_URL}/api/v1/query" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"bazel_build_duration_ms\",
    \"value\": ${DURATION_MS},
    \"labels\": {
      \"branch\": \"${GITHUB_REF_NAME}\",
      \"status\": \"$([ $BUILD_STATUS -eq 0 ] && echo success || echo failure)\"
    }
  }"

exit $BUILD_STATUS
```

## Migrating an Existing Go Repository

A practical migration checklist for moving from `go build` to Bazel:

```bash
# Step 1: Audit your repository structure
go list ./... | wc -l  # count packages

# Step 2: Install Bazelisk and initialize workspace
echo "7.3.2" > .bazelversion
cat > MODULE.bazel << 'EOF'
module(name = "myrepo", version = "0.0.1")
bazel_dep(name = "rules_go", version = "0.50.1")
bazel_dep(name = "gazelle", version = "0.38.0")
EOF

# Step 3: Run Gazelle to generate BUILD files
bazel run //:gazelle

# Step 4: Fix any Gazelle mismatches (common issues):
# - CGO packages need explicit cgo = True
# - Test data files need data = glob(["testdata/**"])
# - Generated code needs appropriate generators

# Step 5: Verify the build
bazel build //...

# Step 6: Run tests
bazel test //...

# Step 7: Add remote cache configuration
# Step 8: Update CI to use Bazel
```

### Common Migration Issues

```python
# Issue: package uses CGO
# Fix: add cgo = True
go_library(
    name = "lib",
    srcs = ["lib.go"],
    cgo = True,
    clinkopts = ["-lz"],  # link system libraries
    copts = ["-I/usr/include"],
)

# Issue: package embeds files
# Fix: use embed attribute
go_library(
    name = "lib",
    srcs = ["server.go"],
    embedsrcs = glob(["static/**"]),
    # In source: //go:embed static
)

# Issue: package uses go generate
# Fix: add generated files explicitly or use a genrule
genrule(
    name = "generate_mocks",
    srcs = ["interface.go"],
    outs = ["mock_interface.go"],
    cmd = "$(execpath //tools/mockgen) -source=$< -destination=$@",
    tools = ["//tools/mockgen"],
)
```

## Summary

Bazel and Buck2 solve real problems for Go monorepos at scale: hermetic builds eliminate environment-dependent failures, remote caching eliminates redundant rebuilds in CI, and affected-target analysis ensures only changed code is tested. The key trade-offs:

- **Bazel** has a more mature Go ecosystem (rules_go, Gazelle), broader remote execution support, and a larger community. It is the safer choice for organizations starting today.
- **Buck2** offers better raw performance due to its Rust core and is worth evaluating for very large repositories where build speed is a primary concern.

The ROI calculation is straightforward: for a monorepo with 50+ services where CI currently runs for 30+ minutes and rebuilds everything on every commit, Bazel with remote caching typically reduces CI time to under 5 minutes for pull request builds. The investment in BUILD file maintenance (largely automated by Gazelle) pays back within weeks.
