---
title: "Go Module Proxy and Private Modules: GOPROXY, GONOSUMCHECK, and Enterprise Registry"
date: 2031-03-15T00:00:00-05:00
draft: false
tags: ["Go", "Modules", "DevOps", "Enterprise", "Security", "Air-Gap"]
categories:
- Go
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Go module proxy configuration: GOPROXY chain setup, Athens and goproxy private proxy deployment, GONOSUMCHECK for private modules, GOMODCACHE management, GOAUTH authentication, and air-gap development environments."
more_link: "yes"
url: "/go-module-proxy-private-modules-enterprise-registry/"
---

Go's module system is elegant for individual developers but requires deliberate configuration for enterprise environments with private code, compliance requirements, air-gap networks, or reproducibility mandates. The combination of GOPROXY, GONOSUMDB, GOPRIVATE, and GOAUTH variables—and their interactions with module caches and authentication—creates a configuration space that trips up teams regularly. This guide provides a systematic approach to enterprise Go module management, from basic proxy configuration through fully air-gapped deployments.

<!--more-->

# Go Module Proxy and Private Modules: GOPROXY, GONOSUMCHECK, and Enterprise Registry

## Section 1: Go Module Resolution Fundamentals

Before configuring enterprise proxies, understand how Go resolves module downloads.

### The Resolution Chain

When `go get` or `go mod download` needs a module, it follows this sequence:

1. Check the module cache (`$GOPATH/pkg/mod` or `$GOMODCACHE`)
2. Consult the GOPROXY list in order, stopping at first success
3. For each proxy in GOPROXY, try to fetch the module
4. If a proxy returns a 410 (Gone) or 404, continue to next proxy (controlled by fallback directives)
5. Verify the module's checksum against GONOSUMDB/GONOSUMCHECK and the checksum database

### GOPROXY Syntax

```bash
# GOPROXY format:
# proxy1[,proxy2,...][|direct][,off]
#
# Fallback directives:
# ,   (comma)  - Continue to next proxy on any error (404, 410, timeout, etc.)
# |   (pipe)   - Only continue on 404 or 410 (not on other errors)
# direct       - Fetch directly from the VCS
# off          - Return error instead of trying further

# Examples:
export GOPROXY="https://proxy.golang.org,direct"  # Default
export GOPROXY="https://athens.corp.com,https://proxy.golang.org,direct"  # Private proxy first
export GOPROXY="https://athens.corp.com|https://proxy.golang.org,direct"  # Only fall through on 404/410
export GOPROXY="off"  # No network access (use module cache only)
```

### The Checksum Database

Go verifies module integrity against the checksum database (sum.golang.org by default). This prevents supply chain attacks where a module version is modified after publication.

```bash
# GONOSUMDB: comma-separated list of module path prefixes to skip sum database
export GONOSUMDB="github.com/internal/*,gitlab.corp.com/*"

# GONOSUMCHECK: patterns for which to skip checksum verification entirely
# (use with caution - removes security guarantee)
export GONOSUMCHECK="github.com/internal/*"

# GOPRIVATE: shorthand for setting both GONOSUMDB and GONOPROXY
export GOPRIVATE="github.com/myorg/*,gitlab.corp.com/*"
# Equivalent to:
export GONOSUMDB="github.com/myorg/*,gitlab.corp.com/*"
export GONOPROXY="github.com/myorg/*,gitlab.corp.com/*"
```

## Section 2: GOPROXY Chain Configuration

### Basic Enterprise Configuration

For most enterprises, the goal is:
1. Private modules served from an internal proxy
2. Public modules cached by an internal proxy (dependency on external internet reduced)
3. Checksum verification skipped for internal modules

```bash
# ~/.bashrc or /etc/profile.d/go-env.sh (system-wide)
export GOPROXY="https://proxy.athens.corp.com,https://proxy.golang.org,direct"
export GOPRIVATE="github.com/myorg/*,gitlab.corp.com/*,gopkg.corp.com/*"
export GONOSUMDB="github.com/myorg/*,gitlab.corp.com/*,gopkg.corp.com/*"
export GOFLAGS="-mod=readonly"  # Prevent implicit module updates in CI
```

### In Kubernetes Pods

For CI/CD pipelines running in Kubernetes:

```yaml
# Pod environment configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: go-env-config
  namespace: ci
data:
  GOPROXY: "https://athens.tools.svc.cluster.local:3000,https://proxy.golang.org,direct"
  GOPRIVATE: "github.com/myorg/*,gitlab.corp.com/*"
  GONOSUMDB: "github.com/myorg/*,gitlab.corp.com/*"
  GOFLAGS: "-mod=readonly"
  GOMODCACHE: "/go/pkg/mod"

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: go-builder
spec:
  template:
    spec:
      containers:
      - name: builder
        image: golang:1.22
        envFrom:
        - configMapRef:
            name: go-env-config
        env:
        - name: GOPATH
          value: /go
        volumeMounts:
        - name: go-module-cache
          mountPath: /go/pkg/mod
      volumes:
      - name: go-module-cache
        persistentVolumeClaim:
          claimName: go-module-cache-pvc
```

### Testing Your Proxy Configuration

```bash
# Test proxy connectivity
go env GOPROXY
# https://proxy.athens.corp.com,https://proxy.golang.org,direct

# Verify a module can be fetched through the proxy
GOMODCACHE=/tmp/test-cache go get github.com/gin-gonic/gin@v1.9.1

# Check which proxy served the module
GOPROXY=https://proxy.athens.corp.com go mod download -json github.com/gin-gonic/gin@v1.9.1
# {"Path":"github.com/gin-gonic/gin","Version":"v1.9.1",...,"Proxy":"https://proxy.athens.corp.com"}

# Force direct download (bypass all proxies)
GOPROXY=direct go get github.com/myorg/mylib@v1.2.3
```

## Section 3: Athens Private Module Proxy

Athens is the most mature open-source Go module proxy server. It stores modules locally, caches public modules, and provides access control for private modules.

### Athens Deployment on Kubernetes

```yaml
# athens-deployment.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: athens
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: athens-storage
  namespace: athens
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
  storageClassName: fast-ssd
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: athens-config
  namespace: athens
data:
  config.toml: |
    # Athens configuration
    LogLevel = "info"
    CloudRuntime = "none"
    EnableCSRFProtection = false
    GoBinary = "go"
    GoEnv = "production"
    GoGetWorkers = 10
    ProtocolWorkers = 30
    Timeout = 300
    StorageType = "disk"
    GlobalEndpoint = ""
    Port = ":3000"
    EnablePprof = false

    [Storage]
      [Storage.Disk]
        RootPath = "/var/lib/athens"

    [Proxy]
      # Private VCS credentials
      SourceInfo = ""

    [Olympus]
      GlobalEndpoint = ""

    [Tracing]
      Exporter = ""

    # Upstream proxy (fall through to public proxy for modules not in Athens)
    [Storage]
      [Storage.Upstream]
        "proxy.golang.org" = "https://proxy.golang.org"

    # Access control
    [NetworkMode]
      Private = true

    # Allowed module prefixes (whitelist mode)
    FilterFile = "/etc/athens/filter.conf"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: athens-filter
  namespace: athens
data:
  filter.conf: |
    # Allow specific public module paths
    + github.com/
    + golang.org/
    + google.golang.org/
    + gopkg.in/
    + k8s.io/
    + sigs.k8s.io/

    # Allow internal modules
    + github.com/myorg/
    + gitlab.corp.com/

    # Block everything else by default
    - *
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: athens
  namespace: athens
spec:
  replicas: 2
  selector:
    matchLabels:
      app: athens
  template:
    metadata:
      labels:
        app: athens
    spec:
      containers:
      - name: athens
        image: gomods/athens:latest
        ports:
        - containerPort: 3000
        env:
        - name: ATHENS_STORAGE_TYPE
          value: disk
        - name: ATHENS_DISK_STORAGE_ROOT
          value: /var/lib/athens
        - name: ATHENS_GOGET_WORKERS
          value: "10"
        - name: ATHENS_PROXY_TIMEOUT
          value: "300"
        - name: ATHENS_BEHIND_PROXY
          value: "true"
        # Git credentials for private repositories
        - name: ATHENS_SSH_PRIVATE_KEY
          valueFrom:
            secretKeyRef:
              name: athens-git-credentials
              key: ssh-private-key
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi
        livenessProbe:
          httpGet:
            path: /healthz
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /healthz
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
        volumeMounts:
        - name: storage
          mountPath: /var/lib/athens
        - name: config
          mountPath: /etc/athens
        - name: netrc
          mountPath: /root/.netrc
          subPath: .netrc
          readOnly: true
        - name: gitconfig
          mountPath: /root/.gitconfig
          subPath: .gitconfig
          readOnly: true
      volumes:
      - name: storage
        persistentVolumeClaim:
          claimName: athens-storage
      - name: config
        configMap:
          name: athens-filter
      - name: netrc
        secret:
          secretName: athens-git-credentials
          items:
          - key: netrc
            path: .netrc
          defaultMode: 0600
      - name: gitconfig
        secret:
          secretName: athens-git-credentials
          items:
          - key: gitconfig
            path: .gitconfig
---
apiVersion: v1
kind: Service
metadata:
  name: athens
  namespace: athens
spec:
  selector:
    app: athens
  ports:
  - port: 3000
    targetPort: 3000
  type: ClusterIP
```

### Athens Git Credentials Secret

```bash
# Create credentials for private Git repositories
# Note: Use placeholder values - real credentials go in your secret manager

# .netrc format for HTTPS authentication
cat > /tmp/netrc << 'EOF'
machine github.com
  login git
  password <github-personal-access-token>

machine gitlab.corp.com
  login git
  password <gitlab-token>
EOF

kubectl -n athens create secret generic athens-git-credentials \
  --from-file=netrc=/tmp/netrc \
  --from-literal=gitconfig='[url "git@github.com:"]
  insteadOf = https://github.com/'

rm /tmp/netrc
```

### Pre-warming Athens Cache

```bash
# Pre-populate Athens cache with known dependencies
# This ensures fast builds even on first container start

cat dependencies.txt
# github.com/gin-gonic/gin@v1.9.1
# github.com/go-sql-driver/mysql@v1.7.1
# k8s.io/client-go@v0.28.4
# ...

while IFS= read -r dep; do
    module=$(echo "$dep" | cut -d@ -f1)
    version=$(echo "$dep" | cut -d@ -f2)
    echo "Pre-caching: $module@$version"
    curl -si "https://athens.tools.corp.com/download/$module/@v/$version.info" > /dev/null
done < dependencies.txt
```

## Section 4: Goproxy.io Alternative and Custom Proxy Implementation

### Simple Read-Through Proxy with goproxy

For simpler use cases, `goproxy` is a lightweight alternative:

```bash
# Install goproxy
go install github.com/goproxyio/goproxy/cmd/goproxy@latest

# Run with local storage
goproxy \
  -listen 0.0.0.0:8080 \
  -cacheDir /var/lib/goproxy \
  -proxy "https://proxy.golang.org,direct" \
  -exclude "github.com/myorg/*,gitlab.corp.com/*"
```

### Custom Module Proxy Implementation in Go

For organizations with specific requirements, implementing a custom proxy is straightforward. The Go module proxy protocol is simple:

```go
package main

import (
    "encoding/json"
    "fmt"
    "io"
    "log"
    "net/http"
    "os"
    "path/filepath"
    "strings"
    "time"
)

// GoModProxy implements the Go module proxy protocol.
// See: https://golang.org/ref/mod#goproxy-protocol
type GoModProxy struct {
    cacheDir   string
    upstream   string
    httpClient *http.Client
}

type ModuleInfo struct {
    Version string    `json:"Version"`
    Time    time.Time `json:"Time"`
}

func NewGoModProxy(cacheDir, upstream string) *GoModProxy {
    return &GoModProxy{
        cacheDir: cacheDir,
        upstream: upstream,
        httpClient: &http.Client{
            Timeout: 60 * time.Second,
        },
    }
}

// ServeHTTP handles all proxy requests.
// URL format: /{module}/@v/{version}.{info|mod|zip}
// or: /{module}/@v/list
// or: /{module}/@latest
func (p *GoModProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    log.Printf("Request: %s %s", r.Method, r.URL.Path)

    if r.Method != http.MethodGet {
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        return
    }

    // Parse the URL path
    path := strings.TrimPrefix(r.URL.Path, "/")
    parts := strings.Split(path, "/@v/")
    if len(parts) != 2 && !strings.Contains(path, "/@latest") {
        http.Error(w, "invalid module path", http.StatusBadRequest)
        return
    }

    // Try to serve from cache first
    cachePath := filepath.Join(p.cacheDir, filepath.FromSlash(path))
    if data, err := os.ReadFile(cachePath); err == nil {
        w.Header().Set("Content-Type", contentTypeForPath(path))
        w.Write(data)
        return
    }

    // Fetch from upstream
    upstreamURL := p.upstream + "/" + path
    resp, err := p.httpClient.Get(upstreamURL)
    if err != nil {
        log.Printf("Upstream error for %s: %v", path, err)
        http.Error(w, "upstream error", http.StatusBadGateway)
        return
    }
    defer resp.Body.Close()

    if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
        w.WriteHeader(resp.StatusCode)
        return
    }

    if resp.StatusCode != http.StatusOK {
        http.Error(w, "upstream returned "+resp.Status, resp.StatusCode)
        return
    }

    body, err := io.ReadAll(resp.Body)
    if err != nil {
        http.Error(w, "read error", http.StatusInternalServerError)
        return
    }

    // Cache the response
    if err := os.MkdirAll(filepath.Dir(cachePath), 0755); err == nil {
        os.WriteFile(cachePath, body, 0644)
    }

    w.Header().Set("Content-Type", contentTypeForPath(path))
    w.Write(body)
}

func contentTypeForPath(path string) string {
    switch {
    case strings.HasSuffix(path, ".info"):
        return "application/json"
    case strings.HasSuffix(path, ".mod"):
        return "text/plain; charset=utf-8"
    case strings.HasSuffix(path, ".zip"):
        return "application/zip"
    case strings.HasSuffix(path, "/list"):
        return "text/plain; charset=utf-8"
    default:
        return "application/octet-stream"
    }
}

func main() {
    cacheDir := os.Getenv("GOPROXY_CACHE_DIR")
    if cacheDir == "" {
        cacheDir = "/var/lib/goproxy"
    }

    upstream := os.Getenv("GOPROXY_UPSTREAM")
    if upstream == "" {
        upstream = "https://proxy.golang.org"
    }

    if err := os.MkdirAll(cacheDir, 0755); err != nil {
        log.Fatalf("Cannot create cache dir: %v", err)
    }

    proxy := NewGoModProxy(cacheDir, upstream)

    addr := ":8080"
    log.Printf("Starting Go module proxy on %s", addr)
    log.Printf("Cache dir: %s, Upstream: %s", cacheDir, upstream)
    log.Fatal(http.ListenAndServe(addr, proxy))
}
```

## Section 5: GONOSUMCHECK and Checksum Verification

### Understanding the Checksum Database

The Go checksum database (sum.golang.org) maintains cryptographic hashes of all publicly available module versions. When you download a module, the `go` tool:

1. Computes the hash of the downloaded content
2. Queries the checksum database for the expected hash
3. Refuses to use the module if hashes don't match

This prevents scenarios where a proxy or VCS serves a modified version of a module.

### go.sum File Management

```bash
# Verify all modules in go.sum match the checksum database
go mod verify

# Show the hash for a specific module
go mod download -json github.com/gin-gonic/gin@v1.9.1 | jq '.Hash'

# Update go.sum for all dependencies
go mod tidy

# Check if go.sum is complete
go mod tidy -diff  # Show what would change without modifying
```

### GONOSUMDB vs GONOSUMCHECK vs GOFLAGS=-mod=vendor

```bash
# GONOSUMDB: Skip checksum database lookup, but still verify against local go.sum
# Use for: private modules where you can't query sum.golang.org
export GONOSUMDB="github.com/myorg/*"

# GONOSUMCHECK: Skip ALL checksum verification
# Use for: local development with in-progress modules
# WARNING: Removes security guarantee
export GONOSUMCHECK="github.com/myorg/experimental-*"

# GONOSUMDB is the safe default for private modules:
# - Module hashes are not sent to sum.golang.org
# - Local go.sum still verifies integrity across machines
# - Team members still get hash verification

# For completely disabling all sum checking (use only in isolated environments):
export GONOSUMDB="*"
export GOFLAGS="-insecure"
```

### Setting Up a Private Checksum Database

For air-gap environments where you need checksum verification but cannot access sum.golang.org:

```bash
# Install gosum server
go install golang.org/x/mod/sumdb/cmd/gosum@latest

# Or use the reference implementation
# sumdb runs a transparency log for Go module checksums

# Configure GONOSUMDB to point to your private sumdb
export GONOSUMDB="*"  # Don't check public database
export GONOSUMCHECK=""  # Use the GOPROXY for checksum info
```

In practice, most enterprises use `GONOSUMDB` with their private module paths and rely on the private Athens proxy to serve consistent module content, combined with go.sum file checking in CI:

```bash
# CI script: verify go.sum is committed and up to date
go mod tidy
if ! git diff --exit-code go.sum; then
    echo "ERROR: go.sum is out of date. Run 'go mod tidy' and commit."
    exit 1
fi
```

## Section 6: GOMODCACHE Management

### Understanding the Module Cache Structure

```bash
# Default module cache location
go env GOMODCACHE
# /home/user/go/pkg/mod

# Structure:
# $GOMODCACHE/
# ├── cache/
# │   ├── download/     <- Proxy cache (zipped modules)
# │   │   └── github.com/gin-gonic/gin/@v/
# │   │       ├── v1.9.1.info
# │   │       ├── v1.9.1.mod
# │   │       ├── v1.9.1.zip
# │   │       └── v1.9.1.ziphash
# │   └── lock/         <- File locks
# └── github.com/       <- Extracted module source
#     └── gin-gonic/gin@v1.9.1/
```

### Module Cache for CI/CD Performance

Caching the module cache in CI dramatically speeds up builds:

```yaml
# GitHub Actions workflow with module cache
name: Build

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

    - name: Setup Go
      uses: actions/setup-go@v5
      with:
        go-version: '1.22'
        cache: true  # Automatically caches $GOMODCACHE

    - name: Download dependencies
      run: go mod download

    - name: Build
      run: go build ./...
```

For custom CI systems:

```yaml
# GitLab CI with module cache
variables:
  GOPATH: $CI_PROJECT_DIR/.gopath
  GOMODCACHE: $CI_PROJECT_DIR/.gopath/pkg/mod

cache:
  key: "$CI_JOB_NAME-$CI_COMMIT_REF_SLUG"
  paths:
  - .gopath/pkg/mod/cache/download/

build:
  script:
  - go build ./...
```

### Controlling Module Cache Size

```bash
# Show module cache size
du -sh $(go env GOMODCACHE)

# List modules in cache with sizes
go clean -cache -n 2>/dev/null || true
find $(go env GOMODCACHE)/cache/download -name "*.zip" -printf "%s\t%p\n" | \
  sort -rn | head -20

# Clean specific modules from cache
go clean -modcache  # WARNING: removes all cached modules

# More selective cleanup (keep recent modules)
find $(go env GOMODCACHE)/cache/download -name "*.zip" \
  -mtime +90 -delete  # Delete modules not accessed in 90 days
```

### Read-Only Module Cache in Containers

For security-conscious deployments where you don't want build processes modifying the module cache:

```dockerfile
FROM golang:1.22 AS deps
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download  # Populate cache

FROM golang:1.22 AS builder
WORKDIR /app
# Copy the pre-populated module cache
COPY --from=deps /root/go /root/go
# Copy source
COPY . .
# Build (module cache is already populated, no network access needed)
RUN GOFLAGS="-mod=readonly" GOPROXY=off go build ./...
```

## Section 7: GOAUTH for Module Authentication

Go 1.21 introduced GOAUTH, a mechanism for providing authentication credentials to module proxies and VCS servers.

### Basic GOAUTH Configuration

```bash
# GOAUTH specifies authentication commands for different hosts
# Format: "command1 args...[;command2 args...]"

# Use netrc file
export GOAUTH="netrc"  # Reads from ~/.netrc

# Custom authentication command
export GOAUTH="git credential fill"

# Multiple authenticators for different hosts
export GOAUTH="netrc;myauth github.com"
```

### Custom GOAUTH Implementation

```go
// goauth-helper/main.go
// This binary is called by the go command to get credentials
// It reads from stdin: "host\npath\n" or just "host\n"
// It writes to stdout: "key: value\n" headers (HTTP auth headers)
package main

import (
    "bufio"
    "fmt"
    "os"
    "strings"
)

// credentialStore maps hostnames to credentials
var credentials = map[string]string{
    "gitlab.corp.com": "PRIVATE-TOKEN=<token-from-env>",
    "github.com":      "Authorization=token <token-from-env>",
}

func main() {
    scanner := bufio.NewScanner(os.Stdin)

    // Read the URL that needs credentials
    for scanner.Scan() {
        line := scanner.Text()
        if line == "" {
            break
        }

        // Find matching credentials
        for host, cred := range credentials {
            if strings.Contains(line, host) {
                // Output HTTP header format
                parts := strings.SplitN(cred, "=", 2)
                if len(parts) == 2 {
                    fmt.Printf("%s: %s\n", parts[0], parts[1])
                }
                break
            }
        }
    }
}
```

```bash
# Install and configure the GOAUTH helper
go build -o /usr/local/bin/go-auth ./goauth-helper/
export GOAUTH="/usr/local/bin/go-auth"
```

### Kubernetes Secret-Based GOAUTH

For CI/CD pipelines running in Kubernetes:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: go-credentials
  namespace: ci
type: Opaque
stringData:
  netrc: |
    machine github.com
    login git
    password <github-personal-access-token>

    machine gitlab.corp.com
    login ci-bot
    password <gitlab-ci-token>
```

```yaml
# Mount in CI pod
containers:
- name: builder
  image: golang:1.22
  env:
  - name: GOAUTH
    value: "netrc"
  - name: NETRC
    value: /secrets/.netrc
  volumeMounts:
  - name: go-credentials
    mountPath: /secrets
    readOnly: true
volumes:
- name: go-credentials
  secret:
    secretName: go-credentials
    defaultMode: 0400
```

## Section 8: Air-Gap Go Development Environments

In classified, highly regulated, or isolated environments, the Go toolchain must operate without any external network access. This requires pre-populating all dependencies.

### Vendoring Approach

The simplest air-gap approach: use `go mod vendor` to include all dependencies in the repository:

```bash
# In development environment (with internet access)
go mod tidy           # Ensure go.mod and go.sum are complete
go mod vendor         # Copy all dependencies to vendor/

# Commit vendor/ to your repository
git add vendor/
git commit -m "Add module vendor directory"

# In air-gap environment
GOFLAGS="-mod=vendor" GOPROXY=off go build ./...
```

The vendor directory contains the full source of all dependencies. No network access is required during build.

```bash
# Verify vendor directory is up to date
go mod verify
go mod vendor
git diff vendor/  # Should be empty if vendor is current
```

### Module Snapshot for Air-Gap

For environments where vendoring is impractical (very large dependency trees), create a module cache snapshot:

```bash
# Script to create module cache snapshot for air-gap deployment
#!/bin/bash
set -e

SNAPSHOT_DIR=/tmp/go-module-snapshot
PROJECTS=(
    /src/project1
    /src/project2
    /src/project3
)

# Create a clean GOMODCACHE
export GOMODCACHE="$SNAPSHOT_DIR/pkg/mod"
mkdir -p "$GOMODCACHE"

# Download all dependencies for all projects
for project in "${PROJECTS[@]}"; do
    echo "Downloading dependencies for $project..."
    cd "$project"
    GOPROXY="https://proxy.golang.org,direct" \
    GONOSUMDB="" \
    go mod download
done

echo "Creating tarball..."
tar -czf go-modules-$(date +%Y%m%d).tar.gz \
    -C "$SNAPSHOT_DIR" \
    pkg/mod/cache/download/

echo "Snapshot size: $(du -sh "$SNAPSHOT_DIR/pkg/mod/cache/download/")"
```

### Setting Up Air-Gap Athens

Deploy Athens in the air-gap environment with the pre-populated snapshot:

```bash
# Deploy Athens with pre-populated disk storage
kubectl -n athens create configmap module-snapshot \
  --from-file=modules.tar.gz=/path/to/go-modules-20260315.tar.gz

# Init container to extract the snapshot
initContainers:
- name: extract-modules
  image: alpine:3.18
  command:
  - /bin/sh
  - -c
  - |
    tar -xzf /snapshot/modules.tar.gz -C /storage/
  volumeMounts:
  - name: module-snapshot
    mountPath: /snapshot
  - name: athens-storage
    mountPath: /storage
```

### Air-Gap GONOSUMDB Configuration

In air-gap environments, you cannot reach sum.golang.org. Configure GONOSUMDB and use local checksums:

```bash
# Disable public checksum database
export GONOSUMDB="*"

# But still verify checksums locally
# The go.sum file provides this verification
# Make sure go.sum is committed to your repository

# In CI, verify go.sum is not modified
go mod verify 2>&1 | grep -v "all modules verified" && exit 1 || true
```

### Dockerfile for Air-Gap Builds

```dockerfile
# Stage 1: Builder with pre-populated module cache
FROM golang:1.22 AS builder

# Configure for air-gap operation
ENV GOPROXY=off
ENV GONOSUMDB=*
ENV GOFLAGS=-mod=vendor

WORKDIR /app

# Copy vendor directory (all dependencies)
COPY vendor/ vendor/

# Copy source
COPY . .

# Build (no network access needed)
RUN go build -o /bin/myapp ./cmd/myapp

# Stage 2: Minimal runtime image
FROM gcr.io/distroless/static-debian12
COPY --from=builder /bin/myapp /bin/myapp
ENTRYPOINT ["/bin/myapp"]
```

## Section 9: Module Authentication for Private GitLab/GitHub

### GitHub Enterprise Configuration

```bash
# Configure git to use HTTPS instead of SSH for module downloads
git config --global url."https://github.com/".insteadOf "git@github.com:"
git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

# Configure credentials
git config --global credential.helper store
cat >> ~/.git-credentials << 'EOF'
https://git:<github-personal-access-token>@github.com
EOF
chmod 600 ~/.git-credentials
```

### GitLab Enterprise Configuration

```bash
# For GitLab self-hosted
git config --global url."https://gitlab.corp.com/".insteadOf "git@gitlab.corp.com:"

# Configure GONOSUMDB for your GitLab domain
export GOPRIVATE="gitlab.corp.com/*"

# Use GOAUTH for authentication
export GOAUTH="netrc"
cat >> ~/.netrc << 'EOF'
machine gitlab.corp.com
  login ci-bot
  password <gitlab-token>
EOF
chmod 600 ~/.netrc
```

### SSH Key Authentication for Private Go Modules

```bash
# Configure git to use SSH for specific hosts
cat >> ~/.gitconfig << 'EOF'
[url "git@github.com:"]
    insteadOf = https://github.com/
[url "git@gitlab.corp.com:"]
    insteadOf = https://gitlab.corp.com/
EOF

# The GONOSUMDB and GOPRIVATE should be set to avoid sumdb lookups
export GOPRIVATE="github.com/myorg/*"

# Ensure SSH agent has the key
ssh-add /path/to/private-key
```

## Section 10: Troubleshooting Module Resolution

```bash
# Enable verbose module download logging
GOFLAGS=-v go get github.com/some/module@latest 2>&1

# Debug GOPROXY selection
GOPROXY="https://proxy.golang.org,direct" \
GOFLAGS=-v \
go mod download -json github.com/some/module@v1.0.0

# Test connectivity to proxy
curl -v "https://proxy.golang.org/github.com/some/module/@v/list"

# Check if module exists in the checksum database
curl "https://sum.golang.org/lookup/github.com/some/module@v1.0.0"

# Debug authentication issues
GIT_TERMINAL_PROMPT=0 \
GIT_TRACE_CURL=true \
GOFLAGS=-v \
go get github.com/myorg/private-module@v1.0.0 2>&1 | head -100

# Force re-download of a specific module
go clean -modcache
go mod download github.com/some/module@v1.0.0

# Check what GOAUTH is providing
GOAUTH_TRACE=1 go get github.com/myorg/private@latest 2>&1
```

## Summary

Enterprise Go module management requires a thoughtful configuration strategy:

- GOPROXY chains with an internal Athens or goproxy instance provide local caching, reduce external network dependency, and provide audit capability for all downloaded modules
- GOPRIVATE is the primary setting for private modules - it correctly sets both GONOSUMDB and GONOPROXY
- GONOSUMDB should cover all internal module prefixes; avoid GONOSUMCHECK which disables all verification
- For fully air-gapped environments, combine vendor directories for reproducible builds with module cache snapshots for environments requiring network access
- GOAUTH provides clean module authentication without embedding credentials in VCS URLs or environment variables
- The go.sum file is your primary defense against module tampering; ensure it's committed to version control and verified in CI
