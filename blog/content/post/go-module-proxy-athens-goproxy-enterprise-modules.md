---
title: "Go Module Proxy and Private Modules: Athens, GOPROXY, and Enterprise Module Management"
date: 2030-03-13T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Modules", "Athens", "GOPROXY", "Supply Chain Security", "Air-Gapped"]
categories: ["Go", "DevOps", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to deploying Athens proxy server, GOPROXY chain configuration, private module authentication with GONOSUMCHECK, and module mirroring for air-gapped environments."
more_link: "yes"
url: "/go-module-proxy-athens-goproxy-enterprise-modules/"
---

Enterprise Go development requires control over module dependencies: ensuring builds are reproducible across CI and developer machines, preventing supply-chain attacks through untrusted modules, satisfying audit requirements for software composition, and enabling development in environments without internet access. The Go module proxy protocol provides a standardized interface for these capabilities, and Athens is the production-grade open-source implementation. This guide covers the complete Athens deployment, GOPROXY configuration, private module authentication, and air-gapped module management.

<!--more-->

## Go Module Proxy Protocol

The Go module proxy protocol is a simple HTTP API that all Go proxy servers implement. Understanding the protocol helps you make informed decisions about proxy configuration and troubleshoot issues.

### Protocol Endpoints

```
GET $GOPROXY/<module>/@v/list          - List available versions
GET $GOPROXY/<module>/@v/<version>.info - Version metadata (JSON)
GET $GOPROXY/<module>/@v/<version>.mod  - go.mod file contents
GET $GOPROXY/<module>/@v/<version>.zip  - Module source archive
GET $GOPROXY/<module>/@latest          - Latest version info
```

Module paths use URL encoding where capital letters are escaped with `!` followed by the lowercase letter (e.g., `github.com/BurntSushi/toml` becomes `github.com/!burnt!sushi/toml`).

```bash
# Test a proxy directly
PROXY=https://proxy.golang.org

# List versions of a module
curl "${PROXY}/github.com/gin-gonic/gin/@v/list"
# v1.9.0
# v1.9.1
# v1.10.0

# Get version metadata
curl "${PROXY}/github.com/gin-gonic/gin/@v/v1.10.0.info"
# {"Version":"v1.10.0","Time":"2024-06-05T17:32:16Z"}

# Get go.mod
curl "${PROXY}/github.com/gin-gonic/gin/@v/v1.10.0.mod"

# Download module zip
curl -o gin-v1.10.0.zip \
    "${PROXY}/github.com/gin-gonic/gin/@v/v1.10.0.zip"

# Check the module sum database
curl "https://sum.golang.org/lookup/github.com/gin-gonic/gin@v1.10.0"
```

### GOPROXY Configuration

```bash
# Default GOPROXY (what go uses out of the box)
go env GOPROXY
# https://proxy.golang.org,direct

# The GOPROXY value is a comma-separated list:
# - Each entry is tried in order on 404 or 410
# - "direct" means go directly to the VCS (GitHub, etc.)
# - "off" means fail if previous proxies don't have the module

# Enterprise configuration examples:
# Use Athens, fall back to proxy.golang.org, then direct
export GOPROXY="https://athens.internal.example.com,https://proxy.golang.org,direct"

# Air-gapped: use only internal proxy, fail if not found
export GOPROXY="https://athens.internal.example.com,off"

# Development: bypass proxy for everything
export GOPROXY="direct"

# Check what proxy would be used for a specific module
go env GOPROXY
```

### GONOSUMCHECK and GONOSUMDB

```bash
# GONOSUMDB: comma-separated list of modules to NOT verify against sum database
# Use for private modules that aren't in the public sum database
export GONOSUMDB="git.internal.example.com,*.example.com"

# GONOSUMCHECK: similar but for sum checking in go.sum
export GONOSUMCHECK="git.internal.example.com/*"

# GOFLAGS: persistent flags for all go commands
export GOFLAGS="-mod=mod"

# GONOSUMDB supports prefix and glob patterns
# Private org prefix:
export GONOSUMDB="github.com/myorg"

# All private domains:
export GONOSUMDB="*.internal.example.com"

# GOPRIVATE: shorthand that sets both GONOSUMDB and GONOPROXY
export GOPRIVATE="git.internal.example.com,github.com/myorg"
# This is equivalent to:
# GONOSUMDB=git.internal.example.com,github.com/myorg
# GONOPROXY=git.internal.example.com,github.com/myorg

# Set persistently via go env -w
go env -w GOPRIVATE="git.internal.example.com,github.com/myorg"
go env -w GOPROXY="https://athens.internal.example.com,https://proxy.golang.org,direct"
go env -w GONOSUMDB="git.internal.example.com,github.com/myorg"

# Verify current settings
go env GOPRIVATE GOPROXY GONOSUMDB GONOPROXY
```

## Deploying Athens Proxy

Athens is the reference production proxy implementation. It supports storage in S3, GCS, Azure Blob, and local filesystem.

### Kubernetes Deployment with Helm

```bash
# Add the Athens Helm chart repository
helm repo add gomods https://gomods.github.io/athens-charts
helm repo update

# Install Athens with S3 backend
helm install athens gomods/athens-proxy \
    --namespace athens \
    --create-namespace \
    --values athens-values.yaml
```

```yaml
# athens-values.yaml
replicaCount: 3

image:
  repository: gomods/athens
  tag: v0.14.0
  pullPolicy: IfNotPresent

# Service configuration
service:
  type: ClusterIP
  port: 3000

ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "0"   # No size limit for large modules
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: athens.internal.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: athens-tls
      hosts:
        - athens.internal.example.com

# Storage backend: S3
storage:
  type: s3
  s3:
    region: us-east-1
    bucket: company-go-modules
    prefix: athens-proxy

# IRSA for S3 access (no static credentials)
serviceAccount:
  create: true
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/AthensS3Role

# Configuration
config:
  # Which protocols Athens speaks
  download:
    mode: sync

  # No authentication for internal use
  # (Rely on network-level access controls)
  networkMode: ""

  # Log format
  log:
    level: info
    format: json

  # GitHub and GitLab access for private modules
  githubToken: ""  # Set via secret
  gitlabToken: ""  # Set via secret

  # Allow list: only proxy these modules
  # (If empty, all modules are allowed)
  # allowedPathPrefixes: []

# Resource requests
resources:
  requests:
    cpu: 200m
    memory: 256Mi
  limits:
    cpu: 1000m
    memory: 1Gi

# Autoscaling
autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 5
  targetCPUUtilizationPercentage: 70

# Persistence (for disk storage backup)
persistence:
  enabled: false  # Using S3

# Health checks
livenessProbe:
  httpGet:
    path: /healthz
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 30

readinessProbe:
  httpGet:
    path: /readyz
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
```

### Athens Configuration File

```yaml
# /config/config.toml for Athens
# Mount this as a ConfigMap

# The storage type for module downloads
StorageType = "s3"

# S3 configuration
[Storage.S3]
Bucket = "company-go-modules"
Region = "us-east-1"
Prefix = "athens-proxy"
ForcePathStyle = false

# Allow all modules to be proxied
# Use NoSumPatterns to skip checksum verification for private modules
NoSumPatterns = [
  "git.internal.example.com/*",
  "github.com/myorg/*"
]

# Private module authentication via .netrc or SSH keys
# VCS configuration for private Git repositories
[Storage.VCS]
  [[Storage.VCS.GitConfig]]
    Host = "git.internal.example.com"
    Protocol = "ssh"
    SSHKeyPath = "/etc/athens/ssh/id_ed25519"

  [[Storage.VCS.GitConfig]]
    Host = "github.com"
    Protocol = "token"
    Token = "ghp_xxxx"  # Read from secret in practice

# Gzip compression for stored modules
GoBinaryEnvVars = ["GONOSUMDB=git.internal.example.com,github.com/myorg", "GOFLAGS=-mod=mod"]

# Download mode: sync, async, redirect, none
DownloadMode = "sync"

# File location for download mode config
DownloadModeFile = ""

# Timeout for VCS operations
Timeout = 300

# Network mode: strict, offline, fallback
NetworkMode = ""

# Port
Port = ":3000"

# TLS (terminate at ingress, not Athens itself in most cases)
TLSCertFile = ""
TLSKeyFile = ""

# Log level: debug, info, warn, error, fatal, panic
LogLevel = "info"

# Log format: plain, json
LogFormat = "json"

# Global endpoint for downloading modules
GoGetWorkers = 10
```

### Private Module Authentication

For private GitHub/GitLab repositories, Athens needs credentials to fetch modules:

```yaml
# Kubernetes Secret for Athens VCS credentials
apiVersion: v1
kind: Secret
metadata:
  name: athens-vcs-credentials
  namespace: athens
type: Opaque
stringData:
  # .netrc format for token authentication
  .netrc: |
    machine github.com
    login oauth2
    password ghp_yourtoken

    machine gitlab.com
    login oauth2
    password glpat_yourtoken

    machine git.internal.example.com
    login token
    password your-internal-token

  # SSH private key for SSH authentication (base64-encoded key content)
  # Store the actual key in a Kubernetes Secret and mount it, not inline in Athens config
  id_ed25519: "<base64-encoded-openssh-private-key>"
```

```yaml
# Mount credentials in Athens deployment
spec:
  template:
    spec:
      volumes:
      - name: athens-netrc
        secret:
          secretName: athens-vcs-credentials
          items:
          - key: .netrc
            path: .netrc
      - name: athens-ssh
        secret:
          secretName: athens-vcs-credentials
          items:
          - key: id_ed25519
            path: id_ed25519
          defaultMode: 0600
      containers:
      - name: athens
        volumeMounts:
        - name: athens-netrc
          mountPath: /root/.netrc
          subPath: .netrc
          readOnly: true
        - name: athens-ssh
          mountPath: /etc/athens/ssh
          readOnly: true
        env:
        - name: GIT_SSH_COMMAND
          value: "ssh -i /etc/athens/ssh/id_ed25519 -o StrictHostKeyChecking=no"
```

## GOAUTH: Go 1.21+ Authentication

Go 1.21 introduced `GOAUTH` as a more flexible alternative to `.netrc` for module authentication:

```bash
# GOAUTH can use multiple authentication methods
export GOAUTH="netrc,git"

# Or specify a custom authentication command
export GOAUTH="off"  # Disable auth
export GOAUTH="netrc"  # Use ~/.netrc
export GOAUTH="git"   # Use git credentials helper

# Custom authentication helper (must exit 0 and print credentials)
# Create a script /usr/local/bin/go-auth-helper:
cat > /usr/local/bin/go-auth-helper << 'EOF'
#!/bin/bash
# Called by go with: URL on stdin
read URL
if echo "$URL" | grep -q "git.internal.example.com"; then
    echo "machine git.internal.example.com"
    echo "login token"
    echo "password $(cat /etc/athens/secrets/internal-token)"
fi
EOF
chmod +x /usr/local/bin/go-auth-helper

export GOAUTH="/usr/local/bin/go-auth-helper"
```

## Air-Gapped Module Management

In environments without internet access, modules must be pre-populated into the proxy.

### Bulk Module Pre-loading

```bash
#!/bin/bash
# preload-modules.sh - Pre-populate Athens with all modules from go.sum files
# Run this from an internet-connected machine, then push to air-gapped Athens

ATHENS_URL="http://localhost:3000"  # Local dev Athens instance
ENTERPRISE_ATHENS="https://athens.airgapped.example.com"

# Collect all module requirements from all Go projects
find /src -name "go.sum" -exec cat {} \; | \
    sort -u | \
    grep -v "^$" | \
    awk '{print $1 "@" $2}' | \
    grep -v "/go.mod$" | \
    sort -u > /tmp/all-modules.txt

echo "Found $(wc -l < /tmp/all-modules.txt) unique modules"

# Download each module into local cache
while read -r module; do
    echo "Caching: $module"
    GOPROXY="$ATHENS_URL,direct" \
    GONOSUMDB="*" \
    go mod download "$module" 2>&1 || true
done < /tmp/all-modules.txt

# Athens automatically caches downloaded modules in S3
# Now synchronize the S3 bucket to the air-gapped environment
```

### Using go mod vendor for Air-Gapped Builds

For maximum reproducibility, vendor all dependencies:

```bash
# Create vendor directory with all dependencies
cd your-project
go mod vendor

# The vendor/ directory contains all dependencies
ls vendor/
# github.com/
# golang.org/
# modules.txt

# Build from vendor directory (no network access required)
go build -mod=vendor ./...

# Run tests from vendor
go test -mod=vendor ./...

# Verify vendor is up to date
go mod verify

# Check vendor contents match go.sum
go mod vendor -v

# Add vendor to .gitignore or commit it
# For air-gapped: commit vendor directory
git add vendor/
git commit -m "vendor: update all dependencies"
```

### Module Mirror Tool

The `gomod-proxy` tool can mirror all transitive dependencies:

```bash
# Install gomod-proxy
go install github.com/goproxyio/goproxy/cmd/goproxy@latest

# Create a local mirror
GOPATH=/tmp/mirror goproxy -listen 0.0.0.0:8080 -cacheDir /data/modules &

# Pre-populate from a module list
while read -r module; do
    curl -s "http://localhost:8080/${module}/@v/list" > /dev/null
done < module-list.txt
```

### Athens Download Mode File

Control which modules Athens proxies with a download mode configuration:

```yaml
# /etc/athens/download.hcl
# Controls behavior per module path pattern

downloadURL = "https://proxy.golang.org"

mode = "sync"

# Standard library and well-known modules: always proxy
override "golang.org/x/*" {
  mode = "sync"
  vcs = "git"
}

# Your private modules: go directly
override "git.internal.example.com/*" {
  mode = "sync"
  vcs = "git"
}

# Third-party modules from approved list: sync
override "github.com/approved-org/*" {
  mode = "sync"
}

# Block unapproved external modules (for strict control)
# override "*" {
#   mode = "none"
# }
```

## Module Version Pinning and Security

### Verifying Module Checksums

```bash
# The go.sum file contains expected checksums for each module
cat go.sum | head -5
# github.com/gin-gonic/gin v1.10.0 h1:nnt...=
# github.com/gin-gonic/gin v1.10.0/go.mod h1:abc...=

# Verify all modules match their expected checksums
go mod verify
# all modules verified

# If verification fails:
# github.com/example/module v1.2.3: checksum mismatch
# This indicates tampering or corruption

# Tidy go.sum to remove unused entries
go mod tidy

# Manually check a specific module's checksum against the sum database
curl "https://sum.golang.org/lookup/github.com/gin-gonic/gin@v1.10.0"
```

### GONOSUMCHECK Patterns

```bash
# Skip sum checking for specific modules (use with extreme care)
# Only appropriate for internal modules not in the public sum database
export GONOSUMDB="git.internal.example.com/*"

# Verify that public modules still go through sum checking
go env GONOSUMDB
# git.internal.example.com/*

# For development: allow all (dangerous, do not use in CI)
export GONOSUMDB="*"
export GONOSUMCHECK="*"
# This bypasses all checksum verification

# For CI: enforce strict checksum verification
export GONOSUMDB=""  # Empty = verify everything against sum.golang.org
export GONOSUMCHECK=""
export GOFLAGS="-mod=readonly"  # Fail if go.sum is missing entries
```

### Supply Chain Security with Provenance

```bash
# Check module provenance using govulncheck
go install golang.org/x/vuln/cmd/govulncheck@latest
govulncheck ./...

# Output:
# Vulnerability #1: GO-2023-1714
#   github.com/foo/bar@v1.2.3
#   Fixed in v1.2.4
#   Call stack:
#     main.go:45:  main.processRequest -> bar.HandleInput

# Use nancy for comprehensive vulnerability scanning
go list -json -m all | nancy sleuth

# OSV scanner for broader coverage
osv-scanner --lockfile go.mod

# GitHub security advisories integration
# In .github/workflows/security.yml:
# - uses: golang/govulncheck-action@v1
#   with:
#     go-version-input: 1.22
#     go-package: ./...
```

## CI/CD Configuration

### GitHub Actions with Athens

```yaml
# .github/workflows/build.yml
name: Build

on: [push, pull_request]

env:
  GOPROXY: "https://athens.internal.example.com,https://proxy.golang.org,direct"
  GONOSUMDB: "git.internal.example.com,github.com/myorg"
  GOPRIVATE: "git.internal.example.com,github.com/myorg"
  GOFLAGS: "-mod=readonly"

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.22'
          # Cache modules from our proxy
          cache: true

      - name: Configure private module access
        run: |
          # Set up .netrc for private module access
          echo "machine git.internal.example.com" >> ~/.netrc
          echo "login token" >> ~/.netrc
          echo "password ${{ secrets.INTERNAL_GIT_TOKEN }}" >> ~/.netrc
          chmod 600 ~/.netrc

      - name: Verify module checksums
        run: go mod verify

      - name: Check for vulnerabilities
        run: |
          go install golang.org/x/vuln/cmd/govulncheck@latest
          govulncheck ./...

      - name: Build
        run: go build ./...

      - name: Test
        run: go test -race -count=1 ./...
```

### Dockerfile with Module Caching

```dockerfile
# Multi-stage Dockerfile with efficient module caching
FROM golang:1.22-alpine AS builder

# Build arguments for proxy configuration
ARG GOPROXY=https://athens.internal.example.com,https://proxy.golang.org,direct
ARG GONOSUMDB=git.internal.example.com
ARG GOPRIVATE=git.internal.example.com

ENV GOPROXY=${GOPROXY}
ENV GONOSUMDB=${GONOSUMDB}
ENV GOPRIVATE=${GOPRIVATE}
ENV GOFLAGS="-mod=readonly"
ENV CGO_ENABLED=0
ENV GOOS=linux

WORKDIR /build

# Mount SSH key for private module access (BuildKit secret)
# Build with: docker buildx build --secret id=ssh_key,src=~/.ssh/id_ed25519 .
RUN --mount=type=secret,id=ssh_key \
    mkdir -p /root/.ssh && \
    cp /run/secrets/ssh_key /root/.ssh/id_ed25519 && \
    chmod 600 /root/.ssh/id_ed25519 && \
    ssh-keyscan git.internal.example.com >> /root/.ssh/known_hosts

# Copy only dependency files first (for layer caching)
COPY go.mod go.sum ./

# Download dependencies (cached until go.mod/go.sum change)
RUN go mod download && go mod verify

# Copy source and build
COPY . .
RUN go build -trimpath -ldflags="-s -w" -o /app ./cmd/server

# Runtime image
FROM gcr.io/distroless/static-debian12 AS runtime
COPY --from=builder /app /app
ENTRYPOINT ["/app"]
```

## Athens Monitoring and Operations

```bash
# Health check
curl https://athens.internal.example.com/healthz
# {"healthy": true}

# Metrics endpoint (if enabled)
curl https://athens.internal.example.com/metrics | head -20

# Key metrics:
# athens_proxy_download_duration_seconds - Time to download a module
# athens_proxy_cache_hits_total          - Cache hit rate
# athens_proxy_cache_misses_total        - Cache misses (require VCS fetch)

# Prometheus scrape config
# - job_name: 'athens'
#   static_configs:
#   - targets: ['athens.athens.svc.cluster.local:3000']
#   metrics_path: '/metrics'

# Check the Athens catalog
curl https://athens.internal.example.com/catalog | jq . | head -20

# Clear Athens cache for a specific module (force re-download)
# (Athens doesn't have a direct purge API, but you can delete from S3)
aws s3 rm --recursive \
    s3://company-go-modules/athens-proxy/github.com/vulnerable/module/ \
    --region us-east-1
```

### Backup and Disaster Recovery

```bash
# Athens S3 bucket backup
# Enable versioning on the bucket for point-in-time recovery
aws s3api put-bucket-versioning \
    --bucket company-go-modules \
    --versioning-configuration Status=Enabled

# Cross-region replication for DR
aws s3api put-bucket-replication \
    --bucket company-go-modules \
    --replication-configuration file://replication-config.json

# replication-config.json:
# {
#   "Role": "arn:aws:iam::123456789012:role/S3ReplicationRole",
#   "Rules": [
#     {
#       "ID": "athens-replication",
#       "Status": "Enabled",
#       "Filter": {"Prefix": "athens-proxy/"},
#       "Destination": {
#         "Bucket": "arn:aws:s3:::company-go-modules-replica",
#         "StorageClass": "STANDARD_IA"
#       }
#     }
#   ]
# }

# Automated backup script
#!/bin/bash
aws s3 sync \
    s3://company-go-modules/athens-proxy/ \
    /backup/athens/ \
    --delete \
    --region us-east-1
```

## Key Takeaways

A well-configured Go module proxy is critical infrastructure for enterprise Go development, providing reproducibility, security, and supply chain control. The key principles for production deployment are:

1. Set `GOPROXY` to your Athens instance followed by `proxy.golang.org` for public modules — this gives you a warm cache for your most-used modules while maintaining access to the full public ecosystem
2. Use `GOPRIVATE` to set both `GONOSUMDB` and `GONOPROXY` for your private module prefixes simultaneously — forgetting to set `GONOSUMDB` causes build failures when the sum database cannot find your private module
3. Athens with S3 backend is highly available and requires no stateful volumes — the S3 bucket IS the module store, and Athens instances are stateless
4. For air-gapped environments, build a pre-population pipeline that runs on an internet-connected machine and syncs the Athens S3 bucket to the air-gapped environment before CI/CD pipelines are cut over
5. Set `GOFLAGS=-mod=readonly` in CI pipelines to fail if go.sum is out of date — this prevents CI from silently downloading unexpected module versions
6. The `.netrc` file for private module authentication should always be mounted as a Kubernetes secret, never baked into container images
7. Run `govulncheck` in your CI pipeline alongside the build — it finds vulnerabilities in your actual code paths, not just in all transitive dependencies, reducing false-positive noise
8. Enable S3 versioning on your Athens bucket and set a lifecycle policy to retain old module versions indefinitely — losing a module version that is referenced in historical go.sum files breaks reproducible builds
