---
title: "Go Build Constraints and Cross-Compilation: Multi-Platform Binary Distribution"
date: 2030-12-15T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Cross-Compilation", "Build Constraints", "GoReleaser", "Docker", "BuildKit", "CI/CD"]
categories:
- Go
- DevOps
- Build Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go cross-compilation: build tags syntax with //go:build vs +build, GOOS/GOARCH matrix compilation, CGO cross-compilation challenges, Docker multi-platform builds with buildx, and automated multi-platform release pipelines with GoReleaser."
more_link: "yes"
url: "/go-build-constraints-cross-compilation-multi-platform-binary-distribution/"
---

Go's cross-compilation capability is one of its most powerful production features. A single Go toolchain can produce binaries for Linux, macOS, Windows, ARM, RISC-V, and more without requiring the target OS or hardware. This guide covers the full spectrum from basic build constraints to automated multi-platform release pipelines used in production CLI tools and Kubernetes operators.

<!--more-->

# Go Build Constraints and Cross-Compilation: Multi-Platform Binary Distribution

## Section 1: Build Constraints Syntax

Build constraints (also called build tags) control which files are included in a build. They are evaluated at compile time to include or exclude source files based on the target OS, architecture, Go version, or custom tags.

### The New //go:build Syntax (Go 1.17+)

Go 1.17 introduced a new build constraint syntax. Both syntaxes work in Go 1.17+, but the new syntax is required going forward:

```go
// NEW syntax (required in Go 1.17+)
//go:build linux && amd64

// OLD syntax (still supported but deprecated)
// +build linux,amd64

package main
```

**Critical rule**: The `//go:build` line must be at the top of the file, before the `package` declaration, with a blank line separating it from the package declaration.

### Boolean Logic in Build Constraints

```go
// AND: both conditions must be true
//go:build linux && amd64

// OR: either condition is true
//go:build linux || darwin

// NOT: condition must be false
//go:build !windows

// Complex: (linux AND amd64) OR (darwin AND arm64)
//go:build (linux && amd64) || (darwin && arm64)

// Go version constraint
//go:build go1.21

// Custom tag
//go:build integration

// Ignore this file in all builds
//go:build ignore
```

### Predefined Build Constraints

```go
// Operating systems (GOOS values)
//go:build linux
//go:build darwin
//go:build windows
//go:build freebsd
//go:build openbsd
//go:build netbsd
//go:build solaris
//go:build plan9
//go:build android
//go:build ios

// Architectures (GOARCH values)
//go:build amd64
//go:build arm64
//go:build arm
//go:build 386
//go:build mips
//go:build mips64
//go:build riscv64
//go:build ppc64le
//go:build s390x
//go:build wasm

// CGO availability
//go:build cgo
//go:build !cgo
```

### Platform-Specific File Naming

Go also uses filename suffixes for implicit build constraints (no build tag needed):

```
file_linux.go           → only compiled on Linux
file_windows.go         → only compiled on Windows
file_darwin_arm64.go    → only compiled on macOS ARM64
file_linux_amd64.go     → only compiled on Linux AMD64
file_test.go            → only compiled during tests
```

## Section 2: Platform-Specific Implementations

### OS-Specific System Calls

```go
// internal/system/process_linux.go
//go:build linux

package system

import (
    "fmt"
    "os"
    "runtime"
    "syscall"
)

// GetProcessMemoryMB returns the resident set size of the current process in MB.
// Linux implementation uses /proc/self/status.
func GetProcessMemoryMB() (float64, error) {
    data, err := os.ReadFile("/proc/self/status")
    if err != nil {
        return 0, fmt.Errorf("reading /proc/self/status: %w", err)
    }

    var vmRSS int64
    lines := strings.Split(string(data), "\n")
    for _, line := range lines {
        if strings.HasPrefix(line, "VmRSS:") {
            fmt.Sscanf(strings.TrimPrefix(line, "VmRSS:"), "%d", &vmRSS)
            return float64(vmRSS) / 1024.0, nil
        }
    }
    return 0, fmt.Errorf("VmRSS not found in /proc/self/status")
}

// SetProcessPriority sets the nice value of the current process.
func SetProcessPriority(priority int) error {
    return syscall.Setpriority(syscall.PRIO_PROCESS, os.Getpid(), priority)
}

// GetOSInfo returns OS information for Linux.
func GetOSInfo() OSInfo {
    return OSInfo{
        OS:   runtime.GOOS,
        Arch: runtime.GOARCH,
        // Read from /etc/os-release
    }
}
```

```go
// internal/system/process_darwin.go
//go:build darwin

package system

import (
    "fmt"
    "runtime"
    "syscall"
    "unsafe"
)

// GetProcessMemoryMB returns the resident set size of the current process in MB.
// macOS implementation uses sysctl.
func GetProcessMemoryMB() (float64, error) {
    // Use task_info via CGO or mach calls
    // Simplified: use rusage
    var usage syscall.Rusage
    if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
        return 0, fmt.Errorf("getrusage: %w", err)
    }
    // On macOS, ru_maxrss is in bytes
    return float64(usage.Maxrss) / (1024 * 1024), nil
}

func SetProcessPriority(priority int) error {
    return syscall.Setpriority(syscall.PRIO_PROCESS, syscall.Getpid(), priority)
}

func GetOSInfo() OSInfo {
    return OSInfo{
        OS:   runtime.GOOS,
        Arch: runtime.GOARCH,
    }
}

// Suppress "unused import" for unsafe when no CGO
var _ = unsafe.Pointer(nil)
```

```go
// internal/system/process_windows.go
//go:build windows

package system

import (
    "fmt"
    "runtime"
    "syscall"
    "unsafe"
)

var (
    kernel32               = syscall.NewLazyDLL("kernel32.dll")
    psapi                  = syscall.NewLazyDLL("psapi.dll")
    getProcessMemoryInfo   = psapi.NewProc("GetProcessMemoryInfo")
    getCurrentProcess      = kernel32.NewProc("GetCurrentProcess")
)

type processMemoryCounters struct {
    cb                         uint32
    pageFaultCount             uint32
    peakWorkingSetSize         uintptr
    workingSetSize             uintptr
    quotaPeakPagedPoolUsage    uintptr
    quotaPagedPoolUsage        uintptr
    quotaPeakNonPagedPoolUsage uintptr
    quotaNonPagedPoolUsage     uintptr
    pagefileUsage              uintptr
    peakPagefileUsage          uintptr
}

func GetProcessMemoryMB() (float64, error) {
    handle, _, _ := getCurrentProcess.Call()
    var pmc processMemoryCounters
    pmc.cb = uint32(unsafe.Sizeof(pmc))
    ret, _, err := getProcessMemoryInfo.Call(
        handle,
        uintptr(unsafe.Pointer(&pmc)),
        uintptr(pmc.cb),
    )
    if ret == 0 {
        return 0, fmt.Errorf("GetProcessMemoryInfo: %w", err)
    }
    return float64(pmc.workingSetSize) / (1024 * 1024), nil
}

func SetProcessPriority(priority int) error {
    // Windows uses different priority classes
    return nil
}

func GetOSInfo() OSInfo {
    return OSInfo{
        OS:   runtime.GOOS,
        Arch: runtime.GOARCH,
    }
}
```

```go
// internal/system/process_stub.go
//go:build !linux && !darwin && !windows

package system

import (
    "fmt"
    "runtime"
)

// Stub implementations for unsupported platforms

func GetProcessMemoryMB() (float64, error) {
    return 0, fmt.Errorf("GetProcessMemoryMB not supported on %s/%s",
        runtime.GOOS, runtime.GOARCH)
}

func SetProcessPriority(priority int) error {
    return fmt.Errorf("SetProcessPriority not supported on %s/%s",
        runtime.GOOS, runtime.GOARCH)
}

func GetOSInfo() OSInfo {
    return OSInfo{
        OS:   runtime.GOOS,
        Arch: runtime.GOARCH,
    }
}
```

```go
// internal/system/types.go — shared types, no build constraints
package system

type OSInfo struct {
    OS      string
    Arch    string
    Version string
}
```

### Custom Build Tags for Feature Flags

```go
// internal/metrics/metrics_full.go
//go:build !minimal

package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promhttp"
    "net/http"
)

// Full Prometheus metrics implementation for production builds
type Metrics struct {
    requestCount   *prometheus.CounterVec
    requestLatency *prometheus.HistogramVec
    activeConns    prometheus.Gauge
}

func New() *Metrics {
    m := &Metrics{
        requestCount: prometheus.NewCounterVec(
            prometheus.CounterOpts{
                Name: "http_requests_total",
                Help: "Total HTTP requests",
            },
            []string{"method", "path", "status"},
        ),
        requestLatency: prometheus.NewHistogramVec(
            prometheus.HistogramOpts{
                Name:    "http_request_duration_seconds",
                Help:    "HTTP request latency",
                Buckets: prometheus.DefBuckets,
            },
            []string{"method", "path"},
        ),
        activeConns: prometheus.NewGauge(prometheus.GaugeOpts{
            Name: "http_active_connections",
        }),
    }
    prometheus.MustRegister(m.requestCount, m.requestLatency, m.activeConns)
    return m
}

func Handler() http.Handler { return promhttp.Handler() }
```

```go
// internal/metrics/metrics_minimal.go
//go:build minimal

package metrics

import "net/http"

// Minimal no-op metrics for embedded/constrained builds
type Metrics struct{}

func New() *Metrics { return &Metrics{} }

func (m *Metrics) RecordRequest(method, path, status string, duration float64) {}
func (m *Metrics) IncrActiveConns() {}
func (m *Metrics) DecrActiveConns() {}
func Handler() http.Handler { return http.NotFoundHandler() }
```

Build with minimal metrics:
```bash
go build -tags minimal ./cmd/agent/
```

## Section 3: Cross-Compilation Matrix

### Basic Cross-Compilation

```bash
# Build for Linux AMD64 from any platform
GOOS=linux GOARCH=amd64 go build -o dist/myapp-linux-amd64 ./cmd/myapp/

# Build for macOS ARM64 (Apple Silicon)
GOOS=darwin GOARCH=arm64 go build -o dist/myapp-darwin-arm64 ./cmd/myapp/

# Build for Windows AMD64
GOOS=windows GOARCH=amd64 go build -o dist/myapp-windows-amd64.exe ./cmd/myapp/

# Build for Linux ARM64 (Raspberry Pi 4, AWS Graviton, Apple M1)
GOOS=linux GOARCH=arm64 go build -o dist/myapp-linux-arm64 ./cmd/myapp/

# Build for Linux ARMv7 (Raspberry Pi 3, older ARM devices)
GOOS=linux GOARCH=arm GOARM=7 go build -o dist/myapp-linux-armv7 ./cmd/myapp/

# Build for Linux RISC-V 64-bit
GOOS=linux GOARCH=riscv64 go build -o dist/myapp-linux-riscv64 ./cmd/myapp/

# Build for WebAssembly
GOOS=js GOARCH=wasm go build -o dist/myapp.wasm ./cmd/myapp/
```

### Build Script for Full Matrix

```bash
#!/bin/bash
# build-all-platforms.sh

set -euo pipefail

APP_NAME="myapp"
VERSION="${1:-$(git describe --tags --dirty)}"
BUILD_DIR="dist"
LDFLAGS="-s -w -X main.Version=${VERSION} -X main.BuildTime=$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BUILD_DIR"

# Platform matrix: "OS/ARCH[/GOARM]"
PLATFORMS=(
    "linux/amd64"
    "linux/arm64"
    "linux/arm/7"
    "linux/386"
    "linux/ppc64le"
    "linux/s390x"
    "darwin/amd64"
    "darwin/arm64"
    "windows/amd64"
    "windows/arm64"
    "freebsd/amd64"
    "freebsd/arm64"
)

for platform in "${PLATFORMS[@]}"; do
    IFS='/' read -ra parts <<< "$platform"
    GOOS="${parts[0]}"
    GOARCH="${parts[1]}"
    GOARM="${parts[2]:-}"

    # Determine output filename
    EXT=""
    if [ "$GOOS" = "windows" ]; then EXT=".exe"; fi

    if [ -n "$GOARM" ]; then
        OUTPUT="${BUILD_DIR}/${APP_NAME}-${GOOS}-${GOARCH}v${GOARM}${EXT}"
    else
        OUTPUT="${BUILD_DIR}/${APP_NAME}-${GOOS}-${GOARCH}${EXT}"
    fi

    echo "Building $OUTPUT..."

    env CGO_ENABLED=0 \
        GOOS="$GOOS" \
        GOARCH="$GOARCH" \
        GOARM="$GOARM" \
        go build \
            -trimpath \
            -ldflags "$LDFLAGS" \
            -o "$OUTPUT" \
            ./cmd/myapp/

    # Create checksums
    sha256sum "$OUTPUT" >> "${BUILD_DIR}/checksums.txt"
done

echo ""
echo "=== Build complete ==="
ls -lh "$BUILD_DIR/"
```

## Section 4: CGO Cross-Compilation

CGO complicates cross-compilation because it requires a C compiler for the target platform.

### When CGO is Required

```go
// This code requires CGO
import "github.com/mattn/go-sqlite3"  // Uses CGO for SQLite

// This code is pure Go (no CGO needed)
import "modernc.org/sqlite"           // Pure Go SQLite replacement
```

### Avoiding CGO for Cross-Compilation

```bash
# Disable CGO entirely — all dependencies must be pure Go
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build ./...

# Check if your binary has CGO dependencies
ldd dist/myapp-linux-amd64
# If output shows only "not a dynamic executable" → pure Go, portable binary
# If output shows .so files → CGO-linked, not portable
```

### CGO Cross-Compilation with Cross-Compilers

When CGO is unavoidable (e.g., SQLite, OpenSSL bindings):

```bash
# Install cross-compilation toolchain on Ubuntu
apt-get install -y \
    gcc-aarch64-linux-gnu \
    gcc-arm-linux-gnueabihf \
    gcc-x86-64-linux-gnu \
    mingw-w64  # For Windows cross-compilation

# Cross-compile Linux ARM64 with CGO
CGO_ENABLED=1 \
    GOOS=linux \
    GOARCH=arm64 \
    CC=aarch64-linux-gnu-gcc \
    go build -o dist/myapp-linux-arm64 ./cmd/myapp/

# Cross-compile Windows AMD64 with CGO
CGO_ENABLED=1 \
    GOOS=windows \
    GOARCH=amd64 \
    CC=x86_64-w64-mingw32-gcc \
    go build -o dist/myapp-windows-amd64.exe ./cmd/myapp/
```

### Using Docker for CGO Cross-Compilation

```dockerfile
# Dockerfile.cross-compile
FROM --platform=linux/amd64 golang:1.23-bullseye AS builder

# Install all cross-compilation toolchains
RUN apt-get update && apt-get install -y \
    gcc-aarch64-linux-gnu \
    gcc-arm-linux-gnueabihf \
    gcc-mingw-w64 \
    gcc-x86-64-linux-gnu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Build all platforms in parallel
RUN make build-all-platforms
```

## Section 5: Docker Multi-Platform Builds with Buildx

### Setting Up Buildx

```bash
# Install QEMU for non-native architecture emulation
docker run --privileged --rm tonistiigi/binfmt --install all

# Create a new buildx builder with multi-platform support
docker buildx create \
    --name multiplatform-builder \
    --driver docker-container \
    --driver-opt network=host \
    --use

docker buildx inspect --bootstrap

# Verify supported platforms
docker buildx inspect multiplatform-builder | grep Platforms
```

### Multi-Stage Multi-Platform Dockerfile

```dockerfile
# Dockerfile
# syntax=docker/dockerfile:1.6

# Stage 1: Build the Go binary
# This stage runs natively on the build host for all target platforms
# because Go cross-compilation is faster than QEMU emulation
FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS builder

# These ARGs are automatically populated by buildx
ARG TARGETPLATFORM
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT

# Build metadata
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_DATE=unknown

WORKDIR /app

# Cache dependencies separately from source
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Cross-compile for the target platform
RUN CGO_ENABLED=0 \
    GOOS=${TARGETOS} \
    GOARCH=${TARGETARCH} \
    GOARM=${TARGETVARIANT#v} \
    go build \
        -trimpath \
        -ldflags "-s -w \
            -X main.Version=${VERSION} \
            -X main.Commit=${COMMIT} \
            -X main.BuildDate=${BUILD_DATE}" \
        -o /app/myapp \
        ./cmd/myapp/

# Stage 2: Runtime image
# This runs on the target architecture
FROM --platform=$TARGETPLATFORM gcr.io/distroless/static:nonroot

COPY --from=builder /app/myapp /myapp

# These match the nonroot user in distroless
USER 65532:65532

ENTRYPOINT ["/myapp"]
```

```bash
# Build and push for multiple platforms
docker buildx build \
    --platform linux/amd64,linux/arm64,linux/arm/v7 \
    --build-arg VERSION=$(git describe --tags) \
    --build-arg COMMIT=$(git rev-parse HEAD) \
    --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
    --tag myrepo/myapp:latest \
    --tag myrepo/myapp:$(git describe --tags) \
    --push \
    .

# Inspect the resulting manifest list
docker buildx imagetools inspect myrepo/myapp:latest
```

### Buildx with GitHub Actions

```yaml
# .github/workflows/docker-multiplatform.yaml
name: Build Multi-Platform Docker Image

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
        with:
          driver-opts: |
            image=moby/buildkit:latest
            network=host

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha,prefix=sha-

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          platforms: linux/amd64,linux/arm64,linux/arm/v7
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          build-args: |
            VERSION=${{ github.ref_name }}
            COMMIT=${{ github.sha }}
            BUILD_DATE=${{ github.event.repository.updated_at }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

## Section 6: GoReleaser for Automated Multi-Platform Releases

GoReleaser automates the entire release process: building binaries for all platforms, creating archives, generating checksums, building Docker images, and publishing GitHub releases.

### Installation

```bash
# Install GoReleaser
go install github.com/goreleaser/goreleaser/v2@latest

# Or via Homebrew
brew install goreleaser/tap/goreleaser
```

### .goreleaser.yaml Configuration

```yaml
# .goreleaser.yaml
version: 2

project_name: myapp

before:
  hooks:
    - go mod tidy
    - go generate ./...

builds:
  - id: myapp
    main: ./cmd/myapp
    binary: myapp
    # Build for all relevant platforms
    goos:
      - linux
      - darwin
      - windows
      - freebsd
    goarch:
      - amd64
      - arm64
      - arm
      - 386
    goarm:
      - "7"
    # Exclude combinations that don't make sense
    ignore:
      - goos: darwin
        goarch: 386
      - goos: darwin
        goarch: arm
      - goos: windows
        goarch: arm
      - goos: freebsd
        goarch: arm
      - goos: freebsd
        goarch: 386
    # Pure Go build — no CGO
    env:
      - CGO_ENABLED=0
    ldflags:
      - -s -w
      - -X main.Version={{.Version}}
      - -X main.Commit={{.Commit}}
      - -X main.BuildDate={{.Date}}
    flags:
      - -trimpath

archives:
  - id: myapp-archives
    name_template: >-
      {{ .ProjectName }}_
      {{- title .Os }}_
      {{- if eq .Arch "amd64" }}x86_64
      {{- else if eq .Arch "386" }}i386
      {{- else }}{{ .Arch }}{{ end }}
      {{- if .Arm }}v{{ .Arm }}{{ end }}
    format_overrides:
      - goos: windows
        format: zip
    files:
      - README.md
      - LICENSE
      - docs/*

checksum:
  name_template: 'checksums.txt'
  algorithm: sha256

changelog:
  sort: asc
  use: github
  filters:
    exclude:
      - "^docs:"
      - "^test:"
      - "^ci:"
      - "Merge pull request"
      - "Merge branch"

release:
  github:
    owner: supporttools
    name: myapp
  name_template: "{{.ProjectName}} v{{.Version}}"
  draft: false
  prerelease: auto

# Build multi-platform Docker images
dockers:
  - id: myapp-amd64
    goos: linux
    goarch: amd64
    image_templates:
      - "ghcr.io/supporttools/{{ .ProjectName }}:{{ .Tag }}-amd64"
      - "ghcr.io/supporttools/{{ .ProjectName }}:latest-amd64"
    dockerfile: Dockerfile.goreleaser
    build_flag_templates:
      - "--pull"
      - "--label=org.opencontainers.image.created={{.Date}}"
      - "--label=org.opencontainers.image.name={{.ProjectName}}"
      - "--label=org.opencontainers.image.revision={{.FullCommit}}"
      - "--label=org.opencontainers.image.version={{.Version}}"
      - "--label=org.opencontainers.image.source={{.GitURL}}"
      - "--platform=linux/amd64"

  - id: myapp-arm64
    goos: linux
    goarch: arm64
    image_templates:
      - "ghcr.io/supporttools/{{ .ProjectName }}:{{ .Tag }}-arm64"
      - "ghcr.io/supporttools/{{ .ProjectName }}:latest-arm64"
    dockerfile: Dockerfile.goreleaser
    build_flag_templates:
      - "--pull"
      - "--platform=linux/arm64"

# Create the multi-arch manifest list
docker_manifests:
  - name_template: "ghcr.io/supporttools/{{ .ProjectName }}:{{ .Tag }}"
    image_templates:
      - "ghcr.io/supporttools/{{ .ProjectName }}:{{ .Tag }}-amd64"
      - "ghcr.io/supporttools/{{ .ProjectName }}:{{ .Tag }}-arm64"
  - name_template: "ghcr.io/supporttools/{{ .ProjectName }}:latest"
    image_templates:
      - "ghcr.io/supporttools/{{ .ProjectName }}:latest-amd64"
      - "ghcr.io/supporttools/{{ .ProjectName }}:latest-arm64"

# Generate SBOM for security compliance
sboms:
  - artifacts: archive
  - id: source
    artifacts: source

# Sign with cosign for supply chain security
signs:
  - cmd: cosign
    certificate: "${artifact}.pem"
    args:
      - "sign-blob"
      - "--output-certificate=${certificate}"
      - "--output-signature=${signature}"
      - "${artifact}"
      - "--yes"
    artifacts: checksum
```

### Dockerfile for GoReleaser

```dockerfile
# Dockerfile.goreleaser
FROM gcr.io/distroless/static:nonroot

# GoReleaser copies the pre-built binary here
COPY myapp /myapp

USER 65532:65532
ENTRYPOINT ["/myapp"]
```

### GitHub Actions Workflow for GoReleaser

```yaml
# .github/workflows/release.yaml
name: Release

on:
  push:
    tags:
      - 'v*.*.*'

jobs:
  goreleaser:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      packages: write
      id-token: write   # For cosign OIDC

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # GoReleaser needs full git history for changelog

      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true

      - name: Set up QEMU (for Docker multi-arch builds)
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Install cosign
        uses: sigstore/cosign-installer@v3

      - name: Run GoReleaser
        uses: goreleaser/goreleaser-action@v5
        with:
          distribution: goreleaser
          version: latest
          args: release --clean
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          COSIGN_EXPERIMENTAL: "true"
```

## Section 7: Version Information Injection

A robust version system uses ldflags to embed build metadata into the binary at compile time:

```go
// internal/version/version.go
package version

import (
    "fmt"
    "runtime"
)

// These are set at build time via -ldflags "-X ..."
var (
    Version   = "dev"
    Commit    = "none"
    BuildDate = "unknown"
    GoVersion = runtime.Version()
)

// Info holds all version information.
type Info struct {
    Version   string `json:"version"`
    Commit    string `json:"commit"`
    BuildDate string `json:"buildDate"`
    GoVersion string `json:"goVersion"`
    OS        string `json:"os"`
    Arch      string `json:"arch"`
}

// Get returns the current version information.
func Get() Info {
    return Info{
        Version:   Version,
        Commit:    Commit,
        BuildDate: BuildDate,
        GoVersion: GoVersion,
        OS:        runtime.GOOS,
        Arch:      runtime.GOARCH,
    }
}

// String returns a human-readable version string.
func String() string {
    return fmt.Sprintf("%s (commit: %s, built: %s, %s/%s)",
        Version, Commit, BuildDate, runtime.GOOS, runtime.GOARCH)
}
```

```go
// cmd/myapp/main.go
package main

import (
    "fmt"
    "os"

    "myapp/internal/version"
)

func main() {
    if len(os.Args) > 1 && os.Args[1] == "version" {
        fmt.Println(version.String())
        os.Exit(0)
    }
    // ... rest of main
}
```

```bash
# Build with version info
go build \
    -ldflags "-s -w \
        -X myapp/internal/version.Version=v1.2.3 \
        -X myapp/internal/version.Commit=$(git rev-parse --short HEAD) \
        -X myapp/internal/version.BuildDate=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    -o myapp ./cmd/myapp/

./myapp version
# v1.2.3 (commit: abc1234, built: 2030-12-15T00:00:00Z, linux/amd64)
```

Mastering Go's cross-compilation capabilities enables you to ship truly portable software from a single codebase. The combination of build constraints for platform-specific code, CGO-free pure Go dependencies, Docker buildx for container images, and GoReleaser for automated release pipelines provides a complete multi-platform distribution system that requires minimal maintenance.
