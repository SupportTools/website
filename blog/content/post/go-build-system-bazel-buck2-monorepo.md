---
title: "Go Build System: Bazel and Buck2 for Large-Scale Monorepo Builds"
date: 2031-03-22T00:00:00-05:00
draft: false
tags: ["Go", "Bazel", "Buck2", "Monorepo", "Build Systems", "CI/CD", "Remote Build Execution"]
categories:
- Go
- DevOps
- Build Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to using Bazel and Buck2 for Go monorepo builds, including Gazelle auto-generation, remote build execution configuration, incremental build optimization, and CI/CD integration strategies."
more_link: "yes"
url: "/go-build-system-bazel-buck2-monorepo/"
---

At scale, `go build ./...` becomes a liability. A monorepo with hundreds of Go packages spends enormous CI time recompiling code that hasn't changed, running tests for packages unaffected by a diff, and rebuilding Docker images from scratch. Bazel and Buck2 solve this through hermetic, reproducible builds with fine-grained dependency tracking that enables correct incremental builds and remote caching across machines.

This guide covers the complete workflow: structuring Go packages for Bazel, using Gazelle to auto-generate BUILD files, configuring remote build execution, evaluating Buck2 as a migration target, and integrating with GitHub Actions and Jenkins for CI builds that only run what changed.

<!--more-->

# Go Build System: Bazel and Buck2 for Large-Scale Monorepo Builds

## Section 1: Why Bazel for Go Monorepos

### The Problem with Standard Go Tooling at Scale

The Go toolchain's simplicity — `go build`, `go test` — is excellent for single-module projects but creates challenges in large monorepos:

- **No incremental builds**: `go test ./...` recompiles everything or relies on the build cache, which is invalidated across machines
- **All-or-nothing testing**: You cannot easily determine which tests to run based on changed files
- **No remote caching**: Build artifacts don't cross machine boundaries without complex caching setups
- **Docker layer inefficiency**: Builds rebuild entire binaries even for minor dependency changes

Bazel addresses these through:

1. **Hermetic builds**: Builds are isolated from the host system, making outputs fully reproducible
2. **Fine-grained dependency graph**: Each `go_library`, `go_binary`, and `go_test` target knows exactly what it depends on
3. **Remote Build Execution (RBE)**: Actions execute on a farm of workers and results are cached by content hash
4. **Affected target analysis**: `bazel query 'rdeps(//..., //path/to/changed:package)'` identifies exactly what needs rebuilding

### Monorepo Structure for Bazel

```
mycompany/
├── WORKSPACE                    # Root Bazel workspace
├── .bazelrc                     # Bazel configuration
├── .bazelversion                # Pin Bazel version
├── BUILD.bazel                  # Root BUILD file
├── go.mod                       # Single go.mod for entire monorepo
├── go.sum
├── deps.bzl                     # Generated Go dependency rules
├── tools/
│   ├── BUILD.bazel
│   └── tools.go                 # Tool dependencies
├── services/
│   ├── api/
│   │   ├── BUILD.bazel
│   │   ├── main.go
│   │   └── handlers/
│   │       ├── BUILD.bazel
│   │       └── user.go
│   └── worker/
│       ├── BUILD.bazel
│       └── main.go
└── pkg/
    ├── database/
    │   ├── BUILD.bazel
    │   └── client.go
    └── config/
        ├── BUILD.bazel
        └── config.go
```

## Section 2: WORKSPACE and Repository Setup

### Root WORKSPACE File

```python
# WORKSPACE
workspace(name = "mycompany")

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

# Bazel Skylib (required by rules_go)
http_archive(
    name = "bazel_skylib",
    sha256 = "66ffd9315665bfaafc96b52278f57c7e2dd09f5ede279ea6d39b2be471e7e3aa",
    urls = [
        "https://mirror.bazel.build/github.com/bazelbuild/bazel-skylib/releases/download/1.4.2/bazel-skylib-1.4.2.tar.gz",
        "https://github.com/bazelbuild/bazel-skylib/releases/download/1.4.2/bazel-skylib-1.4.2.tar.gz",
    ],
)

load("@bazel_skylib//:workspace.bzl", "bazel_skylib_workspace")
bazel_skylib_workspace()

# rules_go
http_archive(
    name = "io_bazel_rules_go",
    sha256 = "278b7ff5a826f3dc10f04feaf0b70d48b68748ccd512d7f98bf442077f043fe3",
    urls = [
        "https://mirror.bazel.build/github.com/bazelbuild/rules_go/releases/download/v0.41.0/rules_go-v0.41.0.zip",
        "https://github.com/bazelbuild/rules_go/releases/download/v0.41.0/rules_go-v0.41.0.zip",
    ],
)

load("@io_bazel_rules_go//go:deps.bzl", "go_register_toolchains", "go_rules_dependencies")
go_rules_dependencies()
go_register_toolchains(version = "1.21.5")

# Gazelle for BUILD file generation
http_archive(
    name = "bazel_gazelle",
    sha256 = "d3fa66a39028e97d76f9e2db8f1b0c11c099e8e01bf363a923074784e451f809",
    urls = [
        "https://mirror.bazel.build/github.com/bazelbuild/bazel-gazelle/releases/download/v0.33.0/bazel-gazelle-v0.33.0.tar.gz",
        "https://github.com/bazelbuild/bazel-gazelle/releases/download/v0.33.0/bazel-gazelle-v0.33.0.tar.gz",
    ],
)

load("@bazel_gazelle//:deps.bzl", "gazelle_dependencies")
load("//:deps.bzl", "go_dependencies")

# Load Go module dependencies (generated by Gazelle)
go_dependencies()

gazelle_dependencies()

# rules_oci for container image building
http_archive(
    name = "rules_oci",
    sha256 = "686f871f9697e08877b85ea6c16c8d48f911bf466c3aeaf108ca0ab2603c7306",
    strip_prefix = "rules_oci-1.3.4",
    url = "https://github.com/bazel-contrib/rules_oci/releases/download/v1.3.4/rules_oci-v1.3.4.tar.gz",
)

load("@rules_oci//:dependencies.bzl", "rules_oci_dependencies")
rules_oci_dependencies()

load("@rules_oci//:repositories.bzl", "LATEST_CRANE_VERSION", "oci_register_toolchains")
oci_register_toolchains(
    name = "oci",
    crane_version = LATEST_CRANE_VERSION,
)
```

### Root .bazelrc Configuration

```bash
# .bazelrc

# Use a local disk cache
build --disk_cache=~/.cache/bazel-disk-cache

# Enable Go module mode
build --@io_bazel_rules_go//go/config:pure=off

# Use stamping for versioning
build --workspace_status_command=./tools/workspace-status.sh

# Remote Build Execution (configure for your RBE provider)
# build:remote --remote_executor=grpcs://remotebuildexecution.googleapis.com
# build:remote --remote_instance_name=projects/myproject/instances/default
# build:remote --google_default_credentials

# Common build flags
build --jobs=AUTO
build --verbose_failures
build --show_timestamps

# Test configuration
test --test_output=errors
test --test_summary=detailed
test --cache_test_results=yes

# CI configuration
build:ci --noshow_progress
build:ci --show_result=0
build:ci --verbose_failures

# Sandbox settings (for reproducibility)
build --sandbox_default_allow_network=false
test --sandbox_default_allow_network=false
```

### Pin Bazel Version

```
# .bazelversion
6.4.0
```

## Section 3: Gazelle for BUILD File Auto-Generation

### Initial Setup

Gazelle is the official tool for generating Bazel BUILD files from Go source code. It reads `go.mod` and Go import statements to produce correct dependency declarations.

```python
# Root BUILD.bazel
load("@bazel_gazelle//:def.bzl", "gazelle")
load("@io_bazel_rules_go//go:def.bzl", "go_binary", "go_library")

# gazelle:prefix github.com/mycompany/myrepo
# gazelle:go_naming_convention import
gazelle(name = "gazelle")
```

```bash
# Install Gazelle
go install github.com/bazelbuild/bazel-gazelle/cmd/gazelle@latest

# Generate initial BUILD files
bazel run //:gazelle

# Update dependencies (after go.mod changes)
bazel run //:gazelle -- update-repos \
  -from_file=go.mod \
  -to_macro=deps.bzl%go_dependencies \
  -prune

# Regenerate BUILD files after source changes
bazel run //:gazelle -- update ./...
```

### Example Generated BUILD Files

After running `gazelle`, BUILD files are generated automatically:

```python
# pkg/database/BUILD.bazel (generated by Gazelle)
load("@io_bazel_rules_go//go:def.bzl", "go_library", "go_test")

go_library(
    name = "database",
    srcs = ["client.go"],
    importpath = "github.com/mycompany/myrepo/pkg/database",
    visibility = ["//visibility:public"],
    deps = [
        "@com_github_jackc_pgx_v5//:pgx",
        "@com_github_jackc_pgx_v5//pgconn",
    ],
)

go_test(
    name = "database_test",
    srcs = ["client_test.go"],
    embed = [":database"],
    deps = [
        "@com_github_stretchr_testify//require",
    ],
)
```

```python
# services/api/BUILD.bazel (generated by Gazelle)
load("@io_bazel_rules_go//go:def.bzl", "go_binary", "go_library")
load("@rules_oci//oci:defs.bzl", "oci_image", "oci_push", "oci_tarball")
load("@rules_pkg//:pkg.bzl", "pkg_tar")

go_library(
    name = "api_lib",
    srcs = ["main.go"],
    importpath = "github.com/mycompany/myrepo/services/api",
    visibility = ["//visibility:private"],
    deps = [
        "//pkg/config",
        "//pkg/database",
        "//services/api/handlers",
        "@com_github_gin_gonic_gin//:gin",
    ],
)

go_binary(
    name = "api",
    embed = [":api_lib"],
    visibility = ["//visibility:public"],
)

# Container image target
pkg_tar(
    name = "api-layer",
    srcs = [":api"],
)

oci_image(
    name = "api-image",
    base = "@distroless_base",
    tars = [":api-layer"],
    entrypoint = ["/api"],
)

oci_push(
    name = "push-api",
    image = ":api-image",
    repository = "gcr.io/myproject/api",
)
```

### Configuring Gazelle Directives

Gazelle behavior is controlled through comments in BUILD files:

```python
# pkg/generated/BUILD.bazel
# gazelle:ignore  (skip this directory)

# services/api/BUILD.bazel
# gazelle:go_test file  (generate per-file test targets instead of one per package)

# proto/BUILD.bazel
# gazelle:proto disable  (don't generate proto rules, we handle manually)
```

### Gazelle in CI

```makefile
# Makefile
.PHONY: gazelle-check
gazelle-check:
	@echo "Checking BUILD files are up to date..."
	@bazel run //:gazelle -- update --mode=diff ./... 2>&1 | \
		grep -E "^(---|\+\+\+|@@)" || true
	@echo "If diffs appear above, run 'make gazelle-update' to fix"

.PHONY: gazelle-update
gazelle-update:
	bazel run //:gazelle -- update-repos -from_file=go.mod \
		-to_macro=deps.bzl%go_dependencies -prune
	bazel run //:gazelle -- update ./...
```

## Section 4: Remote Build Execution Configuration

### RBE Overview

Remote Build Execution allows Bazel to distribute build and test actions across a pool of workers. Combined with a remote cache, this means:

- Actions execute in parallel across many machines
- Results are cached by content hash — identical inputs always produce cached outputs
- No worker needs to download dependencies it hasn't used before

### Google Cloud RBE Configuration

```bash
# .bazelrc additions for GCP RBE
build:remote --remote_executor=grpcs://remotebuildexecution.googleapis.com
build:remote --remote_instance_name=projects/myproject/instances/default_instance
build:remote --remote_timeout=3600

# Authentication
build:remote --google_default_credentials

# Platform configuration (OS/architecture of remote workers)
build:remote --host_platform=@io_bazel_rules_go//go/toolchain:linux_amd64
build:remote --platforms=@io_bazel_rules_go//go/toolchain:linux_amd64

# Remote cache (can be used without full RBE)
build:remote-cache --remote_cache=grpcs://remotebuildexecution.googleapis.com
build:remote-cache --remote_instance_name=projects/myproject/instances/default_instance
build:remote-cache --google_default_credentials

# Upload local results to remote cache
build:remote-cache --remote_upload_local_results=true
```

### Self-Hosted RBE with BuildBuddy

BuildBuddy is an open-source RBE implementation that's easy to self-host:

```yaml
# buildbuddy-deploy.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: buildbuddy
  namespace: build-system
spec:
  replicas: 3
  selector:
    matchLabels:
      app: buildbuddy
  template:
    metadata:
      labels:
        app: buildbuddy
    spec:
      containers:
        - name: buildbuddy
          image: gcr.io/flame-public/buildbuddy-app-onprem:latest
          ports:
            - containerPort: 8080   # HTTP
            - containerPort: 9090   # gRPC (GRPC builds)
            - containerPort: 1985   # gRPCS (GRPC builds, TLS)
          env:
            - name: BB_APP_SERVER_HTTP_PORT
              value: "8080"
            - name: BB_APP_SERVER_GRPC_PORT
              value: "9090"
          volumeMounts:
            - name: config
              mountPath: /config
            - name: storage
              mountPath: /data
          resources:
            requests:
              cpu: "2"
              memory: 4Gi
            limits:
              cpu: "4"
              memory: 8Gi
      volumes:
        - name: config
          configMap:
            name: buildbuddy-config
        - name: storage
          persistentVolumeClaim:
            claimName: buildbuddy-storage
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: buildbuddy-config
  namespace: build-system
data:
  config.yaml: |
    app:
      build_buddy_url: "https://buildbuddy.internal.company.com"
    database:
      data_source: "sqlite3:///data/buildbuddy.db"
    storage:
      ttl_seconds: 2592000  # 30 days
      chunk_file_size_bytes: 3000000
      disk:
        root_directory: /data/storage
    cache:
      max_size_bytes: 50000000000  # 50GB
      disk:
        root_directory: /data/cache
    executor:
      root_directory: /data/executor
      local_cache_size_bytes: 5000000000
```

Configure Bazel to use self-hosted BuildBuddy:

```bash
# .bazelrc additions for self-hosted BuildBuddy
build:buildbuddy --bes_backend=grpcs://buildbuddy.internal.company.com:1985
build:buildbuddy --bes_results_url=https://buildbuddy.internal.company.com/invocation/
build:buildbuddy --remote_cache=grpcs://buildbuddy.internal.company.com:1985
build:buildbuddy --remote_executor=grpcs://buildbuddy.internal.company.com:1985
build:buildbuddy --remote_timeout=600
build:buildbuddy --remote_upload_local_results=true

# Use BuildBuddy API key (from environment variable)
build:buildbuddy --remote_header=x-buildbuddy-api-key=${BUILDBUDDY_API_KEY}
```

### Configuring RBE Workers

```yaml
# rbe-worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bazel-rbe-worker
  namespace: build-system
spec:
  replicas: 10
  selector:
    matchLabels:
      app: rbe-worker
  template:
    metadata:
      labels:
        app: rbe-worker
    spec:
      containers:
        - name: worker
          image: gcr.io/flame-public/buildbuddy-executor:latest
          env:
            - name: BB_EXECUTOR_EXECUTOR_ROOT_DIRECTORY
              value: /executor
            - name: BB_EXECUTOR_EXECUTOR_REMOTE_RUNNER_ADDRESS
              value: "buildbuddy.build-system.svc.cluster.local:9090"
          resources:
            requests:
              cpu: "8"
              memory: 16Gi
            limits:
              cpu: "16"
              memory: 32Gi
          volumeMounts:
            - name: executor-storage
              mountPath: /executor
      volumes:
        - name: executor-storage
          emptyDir: {}
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                topologyKey: kubernetes.io/hostname
                labelSelector:
                  matchLabels:
                    app: rbe-worker
```

## Section 5: Incremental Build Benefits and Query Analysis

### Understanding Bazel's Incremental Build Model

Bazel builds an action graph from BUILD files. Each action has:
- A set of input files (fingerprinted by SHA-256)
- A command to execute
- A set of output files

When inputs haven't changed, Bazel serves outputs from the action cache. This makes incremental builds correct (not heuristic like `make`).

### Querying Affected Targets

```bash
# Find all targets that depend on a changed package
bazel query 'rdeps(//..., //pkg/database:database)'

# Find all tests affected by changes to pkg/database
bazel query 'kind("go_test", rdeps(//..., //pkg/database:database))'

# Build only affected targets after git diff
CHANGED_FILES=$(git diff --name-only HEAD~1 HEAD)
CHANGED_PACKAGES=$(echo "$CHANGED_FILES" | xargs -I{} dirname {} | sort -u | sed 's|^|//|; s|$|:all|')

bazel build $(bazel query "rdeps(//..., union(${CHANGED_PACKAGES}))" | head -100)

# Find the build graph for a specific binary
bazel query 'deps(//services/api:api)'

# Show reverse dependencies (what would break if this changes)
bazel query 'rdeps(//..., //pkg/config:config)' --output=label_kind
```

### Practical Affected-Target Script

```bash
#!/bin/bash
# affected-targets.sh
# Find and test only targets affected by changed files

set -euo pipefail

BASE_SHA="${1:-HEAD~1}"
HEAD_SHA="${2:-HEAD}"

echo "Finding affected targets between ${BASE_SHA} and ${HEAD_SHA}..."

# Get changed files
CHANGED_FILES=$(git diff --name-only "${BASE_SHA}" "${HEAD_SHA}")

if [[ -z "${CHANGED_FILES}" ]]; then
  echo "No changed files found"
  exit 0
fi

echo "Changed files:"
echo "${CHANGED_FILES}"

# Convert file paths to Bazel package labels
BAZEL_PACKAGES=""
while IFS= read -r file; do
  # Find the nearest BUILD.bazel file
  dir=$(dirname "${file}")
  while [[ "${dir}" != "." ]] && [[ ! -f "${dir}/BUILD.bazel" ]]; do
    dir=$(dirname "${dir}")
  done

  if [[ -f "${dir}/BUILD.bazel" ]]; then
    BAZEL_PACKAGES="${BAZEL_PACKAGES} //${dir}:all"
  fi
done <<< "${CHANGED_FILES}"

BAZEL_PACKAGES=$(echo "${BAZEL_PACKAGES}" | tr ' ' '\n' | sort -u | tr '\n' ' ')

if [[ -z "${BAZEL_PACKAGES}" ]]; then
  echo "No Bazel packages found for changed files"
  exit 0
fi

echo "Directly changed packages: ${BAZEL_PACKAGES}"

# Build query for all affected targets
UNION_QUERY="union(${BAZEL_PACKAGES// /, })"
AFFECTED_QUERY="rdeps(//..., ${UNION_QUERY})"

# Get all affected test targets
AFFECTED_TESTS=$(bazel query "kind('go_test', ${AFFECTED_QUERY})" 2>/dev/null || echo "")

if [[ -z "${AFFECTED_TESTS}" ]]; then
  echo "No tests affected by changes"
  exit 0
fi

echo "Affected test targets:"
echo "${AFFECTED_TESTS}"

# Run affected tests
echo "Running affected tests..."
# shellcheck disable=SC2086
bazel test ${AFFECTED_TESTS} \
  --test_output=errors \
  --build_event_publish_all_actions \
  --config=ci
```

## Section 6: Buck2 Migration Path

### Buck2 vs Bazel for Go Projects

Buck2 (Meta's successor to Buck) offers several advantages over Bazel:

| Aspect | Bazel | Buck2 |
|--------|-------|-------|
| Build language | Starlark (Python-like) | Starlark (same) |
| Rule language | Starlark | Starlark + BXL |
| Go support | rules_go (mature) | prelude rules (growing) |
| Remote execution | Via RBE APIs | Via RE APIs (compatible) |
| Performance | Good | Significantly faster (parallel analysis) |
| Daemon | No (each build starts fresh) | Yes (persistent daemon) |
| Error messages | Can be cryptic | Improved UX |

### Buck2 BUCK File Structure

```python
# BUCK (Buck2 root configuration)
load("@prelude//go:toolchain.bzl", "GoToolchain")

# services/api/BUCK
load("@prelude//go:defs.bzl", "go_binary", "go_library")

go_library(
    name = "api_lib",
    srcs = glob(["*.go"], exclude = ["*_test.go"]),
    deps = [
        "//pkg/config:config",
        "//pkg/database:database",
        "//services/api/handlers:handlers",
    ],
)

go_binary(
    name = "api",
    deps = [":api_lib"],
)
```

### Migration Strategy from Bazel to Buck2

```bash
#!/bin/bash
# migrate-to-buck2.sh
# Converts Bazel BUILD files to Buck2 BUCK files

# Step 1: Install Buck2
curl -L https://github.com/facebook/buck2/releases/latest/download/buck2-linux-x86_64.zst | \
  zstd -d > /usr/local/bin/buck2
chmod +x /usr/local/bin/buck2

# Step 2: Initialize Buck2 in the repository
buck2 init --git

# Step 3: Convert BUILD files
find . -name "BUILD.bazel" | while read -r build_file; do
  dir=$(dirname "${build_file}")
  echo "Converting ${build_file} -> ${dir}/BUCK"

  # Basic conversion: rename and adjust syntax
  cp "${build_file}" "${dir}/BUCK"

  # Replace Bazel-specific load statements
  sed -i 's|@io_bazel_rules_go//go:def.bzl|@prelude//go:defs.bzl|g' "${dir}/BUCK"
  sed -i 's|@bazel_gazelle//:def.bzl|@prelude//gazelle:defs.bzl|g' "${dir}/BUCK"

  echo "Converted ${dir}/BUCK"
done

# Step 4: Configure .buckconfig
cat > .buckconfig << 'BUCKCONFIG'
[cells]
  root = .
  prelude = prelude

[cell_aliases]
  config = prelude

[buildfile]
  name = BUCK

[project]
  ignore = .git, bazel-*

[build]
  execution_platforms = root//platforms:default
BUCKCONFIG
```

### Buck2 Remote Execution Configuration

```ini
# .buckconfig additions for RE
[buck2_re_client]
  engine_address = re.internal.company.com:9090
  action_cache_address = cache.internal.company.com:9090
  cas_address = cas.internal.company.com:9090

[buck2]
  materializations = deferred
```

## Section 7: CI/CD Integration

### GitHub Actions with Bazel

```yaml
# .github/workflows/bazel-ci.yml
name: Bazel CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write  # For GCP Workload Identity

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2  # Need parent commit for affected-target analysis

      - name: Setup Bazel
        uses: bazel-contrib/setup-bazel@0.8.1
        with:
          bazelisk-cache: true
          disk-cache: ${{ github.workflow }}
          repository-cache: true

      - name: Authenticate to GCP
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.WIF_PROVIDER }}
          service_account: ${{ secrets.BAZEL_SA }}

      - name: Find affected targets
        id: affected
        run: |
          chmod +x ./tools/affected-targets.sh
          AFFECTED=$(./tools/affected-targets.sh ${{ github.event.before }} ${{ github.sha }})
          echo "targets=${AFFECTED}" >> $GITHUB_OUTPUT
          echo "Affected targets: ${AFFECTED}"

      - name: Build affected targets
        if: steps.affected.outputs.targets != ''
        run: |
          bazel build \
            --config=remote-cache \
            --remote_header=x-buildbuddy-api-key=${{ secrets.BUILDBUDDY_API_KEY }} \
            ${{ steps.affected.outputs.targets }}

      - name: Test affected targets
        if: steps.affected.outputs.targets != ''
        run: |
          bazel test \
            --config=remote-cache \
            --remote_header=x-buildbuddy-api-key=${{ secrets.BUILDBUDDY_API_KEY }} \
            --test_output=errors \
            $(echo "${{ steps.affected.outputs.targets }}" | \
              xargs bazel query 'kind("go_test", {})' 2>/dev/null || echo "")

      - name: Full build on main branch
        if: github.ref == 'refs/heads/main'
        run: |
          bazel build \
            --config=remote \
            //...

      - name: Upload build event log
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: bazel-build-log
          path: ${{ env.HOME }}/.bazel_build_events*.json
```

### Jenkins Pipeline with Bazel Cache

```groovy
// Jenkinsfile
pipeline {
    agent {
        kubernetes {
            yaml """
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: bazel
    image: gcr.io/bazel-public/bazel:6.4.0
    command: ['cat']
    tty: true
    resources:
      requests:
        cpu: 4
        memory: 8Gi
      limits:
        cpu: 8
        memory: 16Gi
    volumeMounts:
    - name: bazel-cache
      mountPath: /root/.cache/bazel
  volumes:
  - name: bazel-cache
    persistentVolumeClaim:
      claimName: bazel-cache-pvc
"""
        }
    }

    environment {
        BUILDBUDDY_API_KEY = credentials('buildbuddy-api-key')
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Gazelle Check') {
            steps {
                container('bazel') {
                    sh '''
                        bazel run //:gazelle -- update --mode=diff ./... 2>&1 | \
                            grep -E "^(---|\+\+\+|@@)" && \
                            echo "ERROR: BUILD files out of date, run 'make gazelle-update'" && \
                            exit 1 || true
                    '''
                }
            }
        }

        stage('Build') {
            steps {
                container('bazel') {
                    sh """
                        bazel build \
                            --config=buildbuddy \
                            --remote_header=x-buildbuddy-api-key=${BUILDBUDDY_API_KEY} \
                            //...
                    """
                }
            }
        }

        stage('Test') {
            steps {
                container('bazel') {
                    sh """
                        bazel test \
                            --config=buildbuddy \
                            --remote_header=x-buildbuddy-api-key=${BUILDBUDDY_API_KEY} \
                            --test_output=errors \
                            --build_event_binary_file=build_events.bin \
                            //...
                    """
                }
            }
            post {
                always {
                    sh """
                        bazel run @buildbuddy//tools:bb -- \
                            print-build-events build_events.bin
                    """ ?: true
                }
            }
        }

        stage('Push Images') {
            when { branch 'main' }
            steps {
                container('bazel') {
                    sh """
                        bazel run \
                            --config=buildbuddy \
                            //services/api:push-api \
                            -- \
                            --tag=\$(git rev-parse --short HEAD)
                    """
                }
            }
        }
    }
}
```

## Section 8: Advanced Bazel Patterns for Go

### Cross-Compilation Targets

```python
# BUILD.bazel for cross-compilation
load("@io_bazel_rules_go//go:def.bzl", "go_binary")
load("@io_bazel_rules_go//go/private:rules/transition.bzl", "go_reset_target")

# Build for multiple platforms
[
    go_binary(
        name = "api-{}".format(platform),
        embed = [":api_lib"],
        goarch = goarch,
        goos = goos,
        pure = "on",
    )
    for platform, (goos, goarch) in {
        "linux-amd64": ("linux", "amd64"),
        "linux-arm64": ("linux", "arm64"),
        "darwin-amd64": ("darwin", "amd64"),
        "darwin-arm64": ("darwin", "arm64"),
        "windows-amd64": ("windows", "amd64"),
    }.items()
]
```

### Cgo Integration

```python
# pkg/native/BUILD.bazel
load("@io_bazel_rules_go//go:def.bzl", "go_library")

go_library(
    name = "native",
    srcs = [
        "native.go",
        "native_cgo.go",
    ],
    cgo = True,
    cdeps = [
        ":libnative",
    ],
    copts = ["-I$(GENDIR)"],
    importpath = "github.com/mycompany/myrepo/pkg/native",
    visibility = ["//visibility:public"],
)

cc_library(
    name = "libnative",
    srcs = ["native.c"],
    hdrs = ["native.h"],
)
```

### Test Size Configuration

```python
# Mark tests by expected duration for parallelism
go_test(
    name = "integration_test",
    srcs = ["integration_test.go"],
    size = "large",  # large = 15min timeout, fewer parallel
    tags = ["integration"],
    deps = [":mypackage"],
)

go_test(
    name = "unit_test",
    srcs = ["unit_test.go"],
    size = "small",  # small = 60s timeout, max parallelism
    deps = [":mypackage"],
)
```

## Section 9: Measuring Build Performance

### Benchmarking Bazel vs go build

```bash
#!/bin/bash
# benchmark-builds.sh
# Compare build times: go build vs bazel (clean vs cached)

echo "=== Benchmark: go build ./... (clean) ==="
go clean -cache
time go build ./...

echo ""
echo "=== Benchmark: go build ./... (cached) ==="
time go build ./...

echo ""
echo "=== Benchmark: bazel build //... (cold) ==="
bazel clean
time bazel build //...

echo ""
echo "=== Benchmark: bazel build //... (warm local cache) ==="
time bazel build //...

echo ""
echo "=== Benchmark: bazel build //... (with remote cache) ==="
bazel clean
time bazel build --config=buildbuddy //...

echo ""
echo "=== Benchmark: affected targets only ==="
# Simulate a PR changing one package
git stash
echo "// touched" >> pkg/config/config.go
AFFECTED_TARGETS=$(./tools/affected-targets.sh HEAD~0 HEAD)
echo "Affected targets: ${AFFECTED_TARGETS}"
time bazel build ${AFFECTED_TARGETS}
git stash pop
```

## Conclusion

Bazel and Buck2 transform Go monorepo builds from "rebuild everything" to "rebuild only what changed, correctly." The initial investment in WORKSPACE setup, Gazelle configuration, and RBE infrastructure pays back quickly in CI time savings for repositories with more than 50 packages.

The key adoption milestones are: get Gazelle generating correct BUILD files, configure a shared remote cache (even without full RBE), implement affected-target analysis in CI, and gradually migrate to remote execution for parallelism. Buck2 is worth evaluating if Bazel's analysis phase becomes a bottleneck — its persistent daemon and parallel analysis deliver meaningful speedups for very large repos.
