---
title: "Go Build Constraints and Platform-Specific Code"
date: 2029-04-26T00:00:00-05:00
draft: false
tags: ["Go", "Build Constraints", "Cross-Compilation", "GOOS", "GOARCH", "CGO", "Platform"]
categories: ["Go", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go build constraints: //go:build syntax, GOOS/GOARCH matrix, feature flags with build tags, CGO_ENABLED patterns, cross-compilation for Linux/Windows/Darwin/ARM, and platform-specific optimizations for production infrastructure tools."
more_link: "yes"
url: "/go-build-constraints-platform-specific-code/"
---

Go's build constraint system enables a single codebase to compile correctly on every supported platform, with platform-specific implementations cleanly separated and automatically selected at compile time. This is essential for infrastructure tools that must run on Linux servers (amd64, arm64), developer machines (Darwin amd64/arm64), and potentially Windows build agents. This guide covers the modern `//go:build` syntax, the GOOS/GOARCH matrix, CGO patterns, feature flags, and complete cross-compilation workflows for production tools.

<!--more-->

# Go Build Constraints and Platform-Specific Code

## Section 1: Build Constraint Syntax

### Modern Syntax: //go:build

Go 1.17 introduced the new `//go:build` syntax, replacing the old `// +build` tag. The old syntax remains supported but deprecated.

```go
// Modern syntax (Go 1.17+) — use this exclusively
//go:build linux

package main

// The constraint applies to the entire file
// This file will only be compiled on Linux
```

```go
// Old syntax (deprecated, do not use in new code)
// +build linux

package main
```

### Build Constraint Operators

```go
// AND: all conditions must be true
//go:build linux && amd64

// OR: any condition is sufficient
//go:build linux || darwin

// NOT: condition must be false
//go:build !windows

// Complex combinations
//go:build (linux || darwin) && !386

// Multiple architecture targets
//go:build linux && (amd64 || arm64)

// Negation with AND
//go:build !windows && !plan9
```

### Build Constraint Values

```go
// Operating systems (GOOS values)
//go:build linux
//go:build darwin
//go:build windows
//go:build freebsd
//go:build openbsd
//go:build netbsd
//go:build plan9
//go:build js        // WebAssembly
//go:build wasip1    // WASI (WebAssembly System Interface)

// Architectures (GOARCH values)
//go:build amd64
//go:build arm64
//go:build arm
//go:build 386
//go:build mips
//go:build riscv64
//go:build s390x
//go:build wasm

// Special tags
//go:build cgo      // CGO is enabled
//go:build !cgo     // CGO is disabled

// Go version (minimum version required)
//go:build go1.18   // File requires Go 1.18 or later
//go:build go1.21

// Custom tags (set with -tags flag)
//go:build integration
//go:build debug
//go:build enterprise
```

## Section 2: File-Level Platform Separation

### Filename-Based Constraints

Go automatically applies build constraints based on filename patterns — no explicit constraint needed:

```
Pattern: *_GOOS.go, *_GOARCH.go, *_GOOS_GOARCH.go

Examples:
  signal_unix.go         → only on unix-like systems
  signal_windows.go      → only on Windows
  mem_linux_amd64.go     → only on Linux amd64
  proc_darwin_arm64.go   → only on macOS arm64
  netpoll_epoll.go       → NOT a valid pattern (epoll is not a GOOS)
```

```bash
# Verify which files are compiled for a target
GOOS=linux GOARCH=amd64 go list -f '{{.GoFiles}}' ./...
GOOS=darwin GOARCH=arm64 go list -f '{{.GoFiles}}' ./...
GOOS=windows GOARCH=amd64 go list -f '{{.GoFiles}}' ./...
```

### Complete Platform Separation Example

```
mypackage/
├── process.go         # Shared interface and common code
├── process_linux.go   # Linux implementation (epoll, /proc)
├── process_darwin.go  # macOS implementation (kqueue, sysctl)
├── process_windows.go # Windows implementation (Win32 API)
└── process_stub.go    # Stub for unsupported platforms
```

```go
// process.go — shared interface
package mypackage

// Process provides platform-independent process inspection
type Process struct {
    PID  int
    Name string
    RSS  uint64 // Resident set size in bytes
    CPU  float64
}

// ProcessList returns all running processes
// Implementation is platform-specific
func ProcessList() ([]Process, error) {
    return platformProcessList()
}
```

```go
// process_linux.go — Linux implementation
//go:build linux

package mypackage

import (
    "fmt"
    "io/fs"
    "os"
    "strconv"
    "strings"
)

func platformProcessList() ([]Process, error) {
    var processes []Process

    entries, err := os.ReadDir("/proc")
    if err != nil {
        return nil, fmt.Errorf("read /proc: %w", err)
    }

    for _, entry := range entries {
        pid, err := strconv.Atoi(entry.Name())
        if err != nil {
            continue // Not a PID directory
        }

        proc, err := readLinuxProcess(pid)
        if err != nil {
            continue // Process may have exited
        }
        processes = append(processes, proc)
    }
    return processes, nil
}

func readLinuxProcess(pid int) (Process, error) {
    // Read /proc/<pid>/status
    data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
    if err != nil {
        return Process{}, err
    }

    p := Process{PID: pid}
    for _, line := range strings.Split(string(data), "\n") {
        if strings.HasPrefix(line, "Name:") {
            p.Name = strings.TrimSpace(strings.TrimPrefix(line, "Name:"))
        }
        if strings.HasPrefix(line, "VmRSS:") {
            fields := strings.Fields(line)
            if len(fields) >= 2 {
                kb, _ := strconv.ParseUint(fields[1], 10, 64)
                p.RSS = kb * 1024
            }
        }
    }
    return p, nil
}
```

```go
// process_darwin.go — macOS implementation
//go:build darwin

package mypackage

import (
    "fmt"
    "os/exec"
    "strconv"
    "strings"
)

func platformProcessList() ([]Process, error) {
    out, err := exec.Command("ps", "-axo", "pid,comm,rss").Output()
    if err != nil {
        return nil, fmt.Errorf("ps: %w", err)
    }

    var processes []Process
    lines := strings.Split(string(out), "\n")
    for _, line := range lines[1:] { // Skip header
        fields := strings.Fields(line)
        if len(fields) < 3 {
            continue
        }
        pid, _ := strconv.Atoi(fields[0])
        rss, _ := strconv.ParseUint(fields[2], 10, 64)
        processes = append(processes, Process{
            PID:  pid,
            Name: fields[1],
            RSS:  rss * 1024,
        })
    }
    return processes, nil
}
```

```go
// process_windows.go — Windows implementation
//go:build windows

package mypackage

import (
    "fmt"
    "unsafe"
    "golang.org/x/sys/windows"
)

func platformProcessList() ([]Process, error) {
    snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
    if err != nil {
        return nil, fmt.Errorf("CreateToolhelp32Snapshot: %w", err)
    }
    defer windows.CloseHandle(snapshot)

    var processes []Process
    var entry windows.ProcessEntry32
    entry.Size = uint32(unsafe.Sizeof(entry))

    if err := windows.Process32First(snapshot, &entry); err != nil {
        return nil, err
    }

    for {
        processes = append(processes, Process{
            PID:  int(entry.ProcessID),
            Name: windows.UTF16ToString(entry.ExeFile[:]),
        })
        if err := windows.Process32Next(snapshot, &entry); err != nil {
            break
        }
    }
    return processes, nil
}
```

```go
// process_stub.go — Stub for all other platforms
//go:build !linux && !darwin && !windows

package mypackage

import "fmt"

func platformProcessList() ([]Process, error) {
    return nil, fmt.Errorf("process listing not supported on this platform")
}
```

## Section 3: Custom Build Tags

Custom tags enable feature flags, build variants, and test separation.

### Feature Flag Tags

```go
// premium_features.go — Only compiled with -tags enterprise
//go:build enterprise

package licensing

import "fmt"

func AdvancedReporting() {
    fmt.Println("Generating enterprise report...")
}

func MultiTenantSupport() bool { return true }
```

```go
// community_features.go — Only compiled WITHOUT enterprise tag
//go:build !enterprise

package licensing

func MultiTenantSupport() bool { return false }
```

```bash
# Build community edition
go build ./...

# Build enterprise edition
go build -tags enterprise ./...

# Run with enterprise features
go run -tags enterprise ./cmd/server
```

### Integration Test Tags

```go
// database_integration_test.go — Only run in integration test mode
//go:build integration

package db_test

import (
    "database/sql"
    "testing"
    _ "github.com/lib/pq"
)

// This test requires a real PostgreSQL instance
// Run with: go test -tags integration -v ./...
func TestDatabaseConnection(t *testing.T) {
    db, err := sql.Open("postgres", "postgres://localhost/testdb?sslmode=disable")
    if err != nil {
        t.Fatalf("failed to connect: %v", err)
    }
    defer db.Close()

    if err := db.Ping(); err != nil {
        t.Fatalf("failed to ping: %v", err)
    }
}
```

```go
// unit_test.go — Always runs (no build tag, uses mocks)
package db_test

import (
    "testing"
)

func TestQueryBuilder(t *testing.T) {
    // Unit test with mock DB — always runs
    q := BuildQuery("users", map[string]string{"active": "true"})
    if q != "SELECT * FROM users WHERE active = 'true'" {
        t.Errorf("unexpected query: %s", q)
    }
}
```

```makefile
# Makefile
.PHONY: test test-unit test-integration

test-unit:
	go test ./...

test-integration:
	go test -tags integration -v ./...

test-all: test-unit test-integration
```

### Debug Build Tags

```go
// debug_logging.go
//go:build debug

package logger

import "log"

func DebugLog(format string, args ...interface{}) {
    log.Printf("[DEBUG] "+format, args...)
}
```

```go
// debug_logging_noop.go
//go:build !debug

package logger

func DebugLog(format string, args ...interface{}) {
    // No-op in production builds — zero overhead
}
```

## Section 4: CGO_ENABLED Patterns

CGO allows Go code to call C libraries. It is enabled by default but must be disabled for static binaries and cross-compilation.

### When CGO Is Required vs Optional

```go
// Uses CGO (links against system libs)
import "crypto/x509"  // Uses system certificate store on Linux via CGO
import "net"          // Uses system DNS resolver via CGO on some platforms
import "os/user"      // Uses NSS/passwd on Linux via CGO

// Pure Go alternatives (CGO_ENABLED=0 compatible)
import "golang.org/x/crypto/x509roots/fallback" // Pure Go cert bundle
// or: set GOTLS_CRYPTO_ENV=FIPS for Go's built-in FIPS
```

### Build Constraints for CGO vs Pure Go

```go
// cgo_enabled.go — CGO-specific implementation
//go:build cgo

package netutil

import "net"

// Uses system resolver (supports /etc/nsswitch.conf, LDAP, etc.)
func LookupHost(host string) ([]string, error) {
    return net.LookupHost(host) // Uses CGO by default
}
```

```go
// cgo_disabled.go — Pure Go fallback
//go:build !cgo

package netutil

import (
    "net"
    "context"
)

// Uses Go's built-in resolver (no CGO dependency)
func LookupHost(host string) ([]string, error) {
    resolver := &net.Resolver{PreferGo: true}
    return resolver.LookupHost(context.Background(), host)
}
```

### Static Binary Production Pattern

```bash
# Fully static binary (no CGO, no shared library dependencies)
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build \
  -ldflags="-s -w -extldflags=-static" \
  -o ./dist/myapp-linux-amd64 \
  ./cmd/myapp

# Verify static linking
ldd ./dist/myapp-linux-amd64
# Should output: not a dynamic executable

# Check binary size and symbols
ls -lh ./dist/myapp-linux-amd64
nm ./dist/myapp-linux-amd64 | head -20  # List symbols

# Compressed binary (upx)
upx --best ./dist/myapp-linux-amd64
```

### Minimal Docker Image with Static Binary

```dockerfile
# Dockerfile — Multi-stage build with static Go binary
FROM golang:1.23-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Build fully static binary
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
    -ldflags="-s -w -extldflags=-static" \
    -trimpath \
    -o /app/myapp \
    ./cmd/myapp

# Minimal runtime image
FROM scratch

# Copy only the binary and CA certificates
COPY --from=builder /app/myapp /myapp
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

ENTRYPOINT ["/myapp"]
```

## Section 5: Cross-Compilation

Go's cross-compilation is built into the toolchain — no separate compiler or SDK is needed.

### GOOS/GOARCH Matrix

```bash
# Show all supported platforms
go tool dist list

# Common targets for infrastructure tools:
# linux/amd64      — Most servers, CI agents
# linux/arm64      — AWS Graviton, Raspberry Pi 4, Apple M1 VMs
# linux/arm        — IoT, embedded systems
# darwin/amd64     — Intel Macs
# darwin/arm64     — Apple Silicon (M1/M2/M3)
# windows/amd64    — Windows servers, developer machines
# windows/arm64    — Windows on ARM
# freebsd/amd64    — BSD servers, firewalls
```

### Cross-Compilation Script

```makefile
# Makefile — Cross-compile for multiple platforms
APP_NAME    := myapp
VERSION     := $(shell git describe --tags --always --dirty)
LDFLAGS     := -s -w -X main.version=$(VERSION) -X main.buildTime=$(shell date -u +%Y-%m-%dT%H:%M:%SZ)
BUILD_FLAGS := -trimpath -ldflags "$(LDFLAGS)"

.PHONY: build-all build-linux build-darwin build-windows

build-linux-amd64:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
	  go build $(BUILD_FLAGS) -o dist/$(APP_NAME)-linux-amd64 ./cmd/$(APP_NAME)

build-linux-arm64:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
	  go build $(BUILD_FLAGS) -o dist/$(APP_NAME)-linux-arm64 ./cmd/$(APP_NAME)

build-darwin-amd64:
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 \
	  go build $(BUILD_FLAGS) -o dist/$(APP_NAME)-darwin-amd64 ./cmd/$(APP_NAME)

build-darwin-arm64:
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 \
	  go build $(BUILD_FLAGS) -o dist/$(APP_NAME)-darwin-arm64 ./cmd/$(APP_NAME)

build-windows-amd64:
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
	  go build $(BUILD_FLAGS) -o dist/$(APP_NAME)-windows-amd64.exe ./cmd/$(APP_NAME)

build-all: build-linux-amd64 build-linux-arm64 build-darwin-amd64 build-darwin-arm64 build-windows-amd64

# Create universal macOS binary (fat binary)
build-darwin-universal: build-darwin-amd64 build-darwin-arm64
	lipo -create -output dist/$(APP_NAME)-darwin-universal \
	  dist/$(APP_NAME)-darwin-amd64 \
	  dist/$(APP_NAME)-darwin-arm64

# Generate checksums
checksums: build-all
	cd dist && sha256sum * > checksums.txt
```

### Cross-Compilation in CI/CD

```yaml
# .github/workflows/release.yml — GitHub Actions cross-compilation
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
        - goos: linux
          goarch: amd64
        - goos: linux
          goarch: arm64
        - goos: darwin
          goarch: amd64
        - goos: darwin
          goarch: arm64
        - goos: windows
          goarch: amd64

    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-go@v5
      with:
        go-version: '1.23'
        cache: true

    - name: Build
      env:
        GOOS: ${{ matrix.goos }}
        GOARCH: ${{ matrix.goarch }}
        CGO_ENABLED: "0"
      run: |
        SUFFIX=""
        if [ "$GOOS" = "windows" ]; then SUFFIX=".exe"; fi
        go build \
          -ldflags="-s -w -X main.version=${GITHUB_REF_NAME}" \
          -trimpath \
          -o "dist/myapp-${GOOS}-${GOARCH}${SUFFIX}" \
          ./cmd/myapp

    - name: Upload artifact
      uses: actions/upload-artifact@v4
      with:
        name: myapp-${{ matrix.goos }}-${{ matrix.goarch }}
        path: dist/
```

### Multi-Architecture Docker Images with BuildKit

```dockerfile
# Dockerfile — BuildKit cross-compilation
# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS builder

ARG TARGETOS
ARG TARGETARCH

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build \
    -ldflags="-s -w" \
    -trimpath \
    -o /app/myapp \
    ./cmd/myapp

FROM scratch
COPY --from=builder /app/myapp /myapp
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
ENTRYPOINT ["/myapp"]
```

```bash
# Build multi-arch image with docker buildx
docker buildx create --name multiarch --use

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag myregistry/myapp:v1.0.0 \
  --push \
  .

# Inspect the manifest
docker manifest inspect myregistry/myapp:v1.0.0
```

## Section 6: Platform-Specific Optimizations

### SIMD/AVX Optimizations with Build Constraints

```go
// simd_amd64.go — Uses assembly with AVX2
//go:build amd64

package checksum

// Implemented in simd_amd64.s using AVX2 instructions
func checksumAVX2(data []byte) uint32

func Checksum(data []byte) uint32 {
    // CPU detection (at runtime, not compile time)
    if hasAVX2() {
        return checksumAVX2(data)
    }
    return checksumGeneric(data)
}
```

```go
// simd_arm64.go — Uses ARM NEON
//go:build arm64

package checksum

// Implemented in simd_arm64.s using NEON instructions
func checksumNEON(data []byte) uint32

func Checksum(data []byte) uint32 {
    if hasNEON() {
        return checksumNEON(data)
    }
    return checksumGeneric(data)
}
```

```go
// simd_generic.go — Pure Go fallback
//go:build !amd64 && !arm64

package checksum

func Checksum(data []byte) uint32 {
    return checksumGeneric(data)
}
```

### OS-Specific Signal Handling

```go
// signals_unix.go — Unix signal handling
//go:build !windows

package server

import (
    "os/signal"
    "syscall"
)

func SetupSignalHandlers(shutdown func(), reload func()) {
    ch := make(chan os.Signal, 1)
    signal.Notify(ch,
        syscall.SIGTERM, // Kubernetes Pod termination
        syscall.SIGINT,  // Ctrl+C
        syscall.SIGHUP,  // Config reload
        syscall.SIGUSR1, // Custom: log rotation
    )

    go func() {
        for sig := range ch {
            switch sig {
            case syscall.SIGTERM, syscall.SIGINT:
                shutdown()
                return
            case syscall.SIGHUP:
                reload()
            case syscall.SIGUSR1:
                rotateLog()
            }
        }
    }()
}
```

```go
// signals_windows.go — Windows signal handling
//go:build windows

package server

import (
    "os"
    "os/signal"
)

func SetupSignalHandlers(shutdown func(), reload func()) {
    ch := make(chan os.Signal, 1)
    // Windows only supports SIGINT (Ctrl+C) and SIGKILL
    signal.Notify(ch, os.Interrupt)

    go func() {
        for range ch {
            shutdown()
            return
        }
    }()
    // SIGHUP and SIGUSR1 not available on Windows
    // reload must be triggered via alternative mechanism (HTTP API, etc.)
}
```

### System Resource Limits

```go
// rlimit_linux.go — Linux rlimit (open file descriptors)
//go:build linux

package init_platform

import (
    "fmt"
    "syscall"
)

func SetMaxOpenFiles(n uint64) error {
    var rlim syscall.Rlimit
    if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &rlim); err != nil {
        return fmt.Errorf("getrlimit: %w", err)
    }

    rlim.Cur = n
    if n > rlim.Max {
        rlim.Max = n  // May fail without CAP_SYS_RESOURCE
    }

    if err := syscall.Setrlimit(syscall.RLIMIT_NOFILE, &rlim); err != nil {
        return fmt.Errorf("setrlimit: %w", err)
    }
    return nil
}
```

```go
// rlimit_darwin.go — macOS rlimit
//go:build darwin

package init_platform

import (
    "fmt"
    "syscall"
)

func SetMaxOpenFiles(n uint64) error {
    // macOS has different max limits and behavior
    var rlim syscall.Rlimit
    if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &rlim); err != nil {
        return fmt.Errorf("getrlimit: %w", err)
    }

    // macOS kern.maxfilesperproc limits the maximum
    rlim.Cur = n
    if err := syscall.Setrlimit(syscall.RLIMIT_NOFILE, &rlim); err != nil {
        return fmt.Errorf("setrlimit (darwin): %w", err)
    }
    return nil
}
```

```go
// rlimit_windows.go — Windows (no rlimit concept)
//go:build windows

package init_platform

func SetMaxOpenFiles(n uint64) error {
    // Windows handles file descriptors differently
    // CRT setmaxstdio handles stdio streams, but OS handles are unlimited
    return nil // No-op on Windows
}
```

## Section 7: Embedding Version and Build Metadata

```go
// version.go — Version info embedded at build time via ldflags
package version

var (
    Version   = "dev"           // Set via: -ldflags "-X package.Version=v1.0.0"
    GitCommit = "unknown"       // Set via: -ldflags "-X package.GitCommit=abc1234"
    BuildTime = "unknown"       // Set via: -ldflags "-X package.BuildTime=2029-04-26T10:00:00Z"
    GoVersion = runtime.Version()
    Platform  = runtime.GOOS + "/" + runtime.GOARCH
)

func String() string {
    return fmt.Sprintf("%s (commit: %s, built: %s, go: %s, platform: %s)",
        Version, GitCommit, BuildTime, GoVersion, Platform)
}
```

```makefile
# Inject version info at build time
VERSION    := $(shell git describe --tags --always --dirty)
GIT_COMMIT := $(shell git rev-parse --short HEAD)
BUILD_TIME := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
PKG        := github.com/example/myapp/internal/version

LDFLAGS := -X $(PKG).Version=$(VERSION) \
           -X $(PKG).GitCommit=$(GIT_COMMIT) \
           -X $(PKG).BuildTime=$(BUILD_TIME) \
           -s -w

build:
	go build -ldflags "$(LDFLAGS)" -trimpath -o dist/myapp ./cmd/myapp
```

## Section 8: Testing Across Platforms

### Cross-Platform Test Matrix

```yaml
# GitHub Actions matrix test
name: Test

on: [push, pull_request]

jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        go: ['1.22', '1.23']

    runs-on: ${{ matrix.os }}

    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-go@v5
      with:
        go-version: ${{ matrix.go }}

    - name: Run tests
      run: go test -v -race ./...

    - name: Run tests with no CGO
      env:
        CGO_ENABLED: "0"
      run: go test -v ./...
```

### Platform-Specific Test Skipping

```go
package process_test

import (
    "runtime"
    "testing"
)

func TestProcFS(t *testing.T) {
    if runtime.GOOS != "linux" {
        t.Skip("procfs only available on Linux")
    }

    processes, err := ProcessList()
    if err != nil {
        t.Fatal(err)
    }
    if len(processes) == 0 {
        t.Error("expected at least one process")
    }
}

func TestWindowsRegistry(t *testing.T) {
    if runtime.GOOS != "windows" {
        t.Skip("Windows registry only available on Windows")
    }
    // Windows-specific test
}
```

### go:build for Test Files

```go
// docker_test.go — Only run when Docker is available (detected by tag)
//go:build docker

package container_test

import (
    "testing"
    "github.com/docker/docker/client"
)

// Run with: go test -tags docker ./...
func TestDockerIntegration(t *testing.T) {
    cli, err := client.NewClientWithOpts(client.FromEnv)
    if err != nil {
        t.Skipf("Docker not available: %v", err)
    }
    defer cli.Close()
    // ...
}
```

## Section 9: Gotchas and Best Practices

### Gotcha 1: Both Constraint Styles in Same File

```go
// WRONG: Old and new style must match exactly
//go:build linux
// +build linux      ← Old style (deprecated but still valid in Go < 1.17 compat mode)

// go vet will warn if they don't match each other
```

```bash
# Check for mismatched constraints
go vet ./...
# will report: "go:build constraint is more complex than corresponding +build constraint"
```

### Gotcha 2: Constraint Must Precede Package Declaration

```go
// WRONG: Comment between constraint and package declaration
//go:build linux

// This is my Linux package.  ← This breaks the constraint association!

package mypackage

// CORRECT:
//go:build linux

package mypackage
```

### Gotcha 3: Filename Constraint Precedence

```go
// If a file is named process_linux.go, the filename constraint
// applies IN ADDITION TO any //go:build constraint in the file

// process_linux.go with this constraint:
//go:build linux && amd64

// Will ONLY compile on: linux AND (filename=linux) AND (go:build: linux && amd64)
// = only on linux/amd64

// But this is redundant. The filename already implies linux.
// Prefer: either filename or build tag, not both for the same constraint
```

### Best Practices Summary

```bash
# 1. Use filename suffixes for simple OS/arch separation
#    process_linux.go, process_darwin.go, process_windows.go

# 2. Use //go:build for complex logic or custom tags
#    //go:build (linux || darwin) && !386

# 3. Always provide a fallback stub
#    process_stub.go with //go:build !linux && !darwin && !windows

# 4. Verify compilation for all target platforms in CI
GOOS=linux GOARCH=amd64 go build ./... || exit 1
GOOS=darwin GOARCH=arm64 go build ./... || exit 1
GOOS=windows GOARCH=amd64 go build ./... || exit 1

# 5. Use go vet to catch constraint issues
go vet ./...

# 6. Test with CGO_ENABLED=0 for portability
CGO_ENABLED=0 go test ./...

# 7. Document why each constraint exists
```

## Conclusion

Go's build constraint system provides a clean, explicit mechanism for managing platform-specific code without preprocessing or runtime type switches. The combination of filename-based constraints (for simple OS/arch separation), `//go:build` expressions (for complex logic and custom tags), and CGO_ENABLED patterns enables a single codebase to compile correctly on every target platform.

For production infrastructure tools, the essential practice is: write platform-independent logic in shared files, implement platform-specific behavior in clearly named files, provide stubs for unsupported platforms, and verify compilation for all target architectures in CI. This approach keeps platform-specific code isolated, testable, and easy to extend when new platforms are required.
