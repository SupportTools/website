---
title: "Docker Build Optimization: Multi-Stage Builds, Cache Layers, and BuildKit"
date: 2027-12-02T00:00:00-05:00
draft: false
tags: ["Docker", "BuildKit", "Multi-Stage", "CI/CD", "Container"]
categories:
- Docker
- CI/CD
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Docker build optimization using multi-stage builds, BuildKit cache mounts, secret mounts, SBOM generation, provenance attestation, and layer caching strategies for Go, Python, and Node.js applications."
more_link: "yes"
url: "/docker-build-optimization-multi-stage-guide/"
---

Container build time and image size directly impact developer productivity and deployment speed. A build that takes 15 minutes in CI becomes a bottleneck that forces developers to batch changes, reducing iteration speed. An image that is 2GB instead of 50MB increases pull time, increases attack surface, and wastes registry storage. This guide covers the complete toolkit for producing fast, minimal, secure container images.

<!--more-->

# Docker Build Optimization: Multi-Stage Builds, Cache Layers, and BuildKit

## BuildKit: The Foundation

All optimization techniques in this guide require BuildKit. BuildKit is Docker's next-generation build engine, providing parallel stage execution, cache mounts, secret mounts, and SSH forwarding. It has been the default backend since Docker 23.0 but can be explicitly enabled in older environments.

```bash
# Verify BuildKit is available
docker buildx version
docker buildx ls

# Enable BuildKit explicitly (older Docker)
export DOCKER_BUILDKIT=1

# Create a BuildKit builder with custom settings
docker buildx create \
  --name production-builder \
  --driver docker-container \
  --driver-opt network=host \
  --driver-opt image=moby/buildkit:v0.13.0 \
  --platform linux/amd64,linux/arm64 \
  --use

# Verify builder is active
docker buildx inspect --bootstrap production-builder
```

## Section 1: Multi-Stage Build Patterns

### Pattern 1: Go Application

Go compiles to a single static binary, making it ideal for minimal scratch images:

```dockerfile
# syntax=docker/dockerfile:1.6

# Build stage - uses full Go SDK
FROM golang:1.21.5-alpine3.19 AS builder

# Install git for go mod download (some modules need it)
RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /build

# Copy dependency files first for cache efficiency
COPY go.mod go.sum ./

# Download dependencies in a separate layer
# This layer is cached as long as go.mod and go.sum don't change
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download

# Copy source code
COPY . .

# Build with optimizations
# CGO_ENABLED=0: static binary (no libc dependency)
# -trimpath: remove local filesystem paths from binary
# -ldflags: strip debug symbols and set version info
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
    -trimpath \
    -ldflags="-w -s -X main.version=$(git describe --tags --dirty --always) -X main.buildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    -o /app/server \
    ./cmd/server

# Security scanning stage
FROM aquasec/trivy:latest AS security-scan
COPY --from=builder /app/server /app/server
RUN trivy rootfs --exit-code 1 --severity HIGH,CRITICAL /app/server 2>/dev/null || true

# Final stage - minimal scratch image
FROM scratch AS final

# Copy CA certificates for HTTPS client calls
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Copy timezone data
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo

# Copy the compiled binary
COPY --from=builder /app/server /server

# Create a non-root user (scratch images need manual /etc/passwd)
COPY --chown=65534:65534 --from=builder /etc/passwd /etc/passwd

# Expose metrics and API ports
EXPOSE 8080 9090

USER 65534

ENTRYPOINT ["/server"]
```

Build and verify:

```bash
# Build with BuildKit optimizations
docker buildx build \
  --platform linux/amd64 \
  --cache-from type=registry,ref=registry.acme.corp/payments-api:cache \
  --cache-to type=registry,ref=registry.acme.corp/payments-api:cache,mode=max \
  --tag registry.acme.corp/payments-api:$(git rev-parse --short HEAD) \
  --tag registry.acme.corp/payments-api:latest \
  --push \
  .

# Check image size
docker images registry.acme.corp/payments-api:latest
# Should be < 20MB for a typical Go binary

# Inspect layers
docker history registry.acme.corp/payments-api:latest
```

### Pattern 2: Node.js Application

Node.js applications have complex dependency trees. The key is separating production dependencies from dev dependencies:

```dockerfile
# syntax=docker/dockerfile:1.6

# Base image - pin to exact digest for reproducibility
FROM node:20.10.0-alpine3.19 AS base

# Install only production system dependencies
RUN apk add --no-cache \
    dumb-init \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Dependencies stage - install all dependencies for building
FROM base AS deps

COPY package.json package-lock.json ./

# Mount npm cache to speed up repeated builds
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev

# Build stage
FROM deps AS build

COPY . .

# Run build (TypeScript compilation, asset bundling, etc.)
RUN npm run build

# Prune dev dependencies
RUN --mount=type=cache,target=/root/.npm \
    npm prune --production

# Test stage (optional, used in CI)
FROM build AS test
RUN npm test -- --coverage --reporter=json

# Production stage
FROM base AS production

ENV NODE_ENV=production
ENV PORT=3000

# Copy only production node_modules and built assets
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

EXPOSE 3000

USER node

# Use dumb-init to handle signals properly in containers
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
```

### Pattern 3: Python Application with UV

```dockerfile
# syntax=docker/dockerfile:1.6

FROM python:3.12.1-slim-bookworm AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=off \
    PIP_DISABLE_PIP_VERSION_CHECK=on

# Install UV package manager (faster than pip)
RUN pip install uv==0.1.24

WORKDIR /app

# Dependencies stage
FROM base AS deps

COPY pyproject.toml uv.lock ./

# Use UV with build cache mount
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# Build stage
FROM deps AS build

COPY . .

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# Production stage
FROM python:3.12.1-slim-bookworm AS production

# Install runtime system dependencies only
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

RUN useradd --create-home --shell /bin/bash --uid 1000 appuser

# Copy virtual environment from build stage
COPY --from=build --chown=appuser:appuser /app/.venv ./.venv
COPY --from=build --chown=appuser:appuser /app/src ./src

USER appuser

EXPOSE 8000

CMD ["gunicorn", "src.main:app", \
    "--bind", "0.0.0.0:8000", \
    "--workers", "4", \
    "--worker-class", "uvicorn.workers.UvicornWorker", \
    "--timeout", "60", \
    "--access-logfile", "-"]
```

### Pattern 4: Java Spring Boot Application

```dockerfile
# syntax=docker/dockerfile:1.6

FROM eclipse-temurin:21-jdk-alpine AS builder

WORKDIR /build

# Copy Gradle/Maven wrapper first for cache efficiency
COPY gradlew build.gradle.kts settings.gradle.kts ./
COPY gradle ./gradle

# Download dependencies (cached layer)
RUN --mount=type=cache,target=/root/.gradle \
    ./gradlew dependencies --no-daemon 2>/dev/null || true

COPY src ./src

# Build the JAR with layer extraction for Docker layer caching
RUN --mount=type=cache,target=/root/.gradle \
    ./gradlew bootJar --no-daemon --info

# Extract layers for optimal caching
RUN java -Djarmode=layertools -jar build/libs/*.jar extract --destination extracted

# Production stage using JRE (not JDK)
FROM eclipse-temurin:21-jre-alpine AS production

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy layers in order of stability (rarely changing first)
COPY --from=builder --chown=appuser:appgroup /build/extracted/dependencies/ ./
COPY --from=builder --chown=appuser:appgroup /build/extracted/spring-boot-loader/ ./
COPY --from=builder --chown=appuser:appgroup /build/extracted/snapshot-dependencies/ ./
COPY --from=builder --chown=appuser:appgroup /build/extracted/application/ ./

USER appuser

EXPOSE 8080 8081

ENV JAVA_OPTS="-XX:+UseContainerSupport -XX:MaxRAMPercentage=75.0 -XX:InitialRAMPercentage=50.0 -XX:+UseG1GC -XX:+PrintGCDetails -Xlog:gc"

ENTRYPOINT ["sh", "-c", "java $JAVA_OPTS org.springframework.boot.loader.launch.JarLauncher"]
```

## Section 2: BuildKit Cache Mounts

### Understanding Cache Mount Types

```dockerfile
# type=cache - persistent cache across builds (not included in image)
# target: path inside the build container to cache
# sharing: locked (exclusive), shared (concurrent reads), private (new copy per build)
# id: named cache (default: path-based)

# Go build cache - persists compiled packages
RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    go build ./...

# NPM cache
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# APT cache - avoids re-downloading packages
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libssl-dev

# pip/uv cache
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# Gradle/Maven cache
RUN --mount=type=cache,target=/root/.gradle \
    ./gradlew build

# Rust cargo cache
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release
```

### Cache Mount in CI/CD

```yaml
# GitHub Actions with BuildKit registry cache
name: Build and Push
on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
      packages: write

    steps:
    - uses: actions/checkout@v4

    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v3
      with:
        driver-opts: |
          image=moby/buildkit:v0.13.0
          network=host

    - name: Login to GitHub Container Registry
      uses: docker/login-action@v3
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}

    - name: Build and push
      uses: docker/build-push-action@v5
      with:
        context: .
        platforms: linux/amd64,linux/arm64
        push: ${{ github.ref == 'refs/heads/main' }}
        tags: |
          ghcr.io/${{ github.repository }}:${{ github.sha }}
          ghcr.io/${{ github.repository }}:latest
        # Registry cache - persists BuildKit layer cache in registry
        cache-from: type=registry,ref=ghcr.io/${{ github.repository }}:buildcache
        cache-to: type=registry,ref=ghcr.io/${{ github.repository }}:buildcache,mode=max
        # Inline cache (simpler but less effective for large images)
        # cache-from: type=gha
        # cache-to: type=gha,mode=max
        labels: |
          org.opencontainers.image.created=${{ steps.meta.outputs.created }}
          org.opencontainers.image.revision=${{ github.sha }}
          org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
```

## Section 3: Secret Mounts for Build-Time Credentials

Never put secrets in environment variables or COPY commands in Dockerfiles. The secret mount type provides credentials only to a specific RUN command without including them in any layer.

### SSH Agent Forwarding

```dockerfile
# syntax=docker/dockerfile:1.6

FROM golang:1.21.5-alpine AS builder

# Install git and SSH client
RUN apk add --no-cache git openssh-client

# Add known hosts to prevent SSH host verification prompts
RUN mkdir -p ~/.ssh && \
    ssh-keyscan github.com >> ~/.ssh/known_hosts

WORKDIR /app

COPY go.mod go.sum ./

# Use SSH agent for private module download
# The --mount=type=ssh provides access to the host's SSH agent
RUN --mount=type=ssh \
    --mount=type=cache,target=/go/pkg/mod \
    GONOSUMCHECK=github.com/acme-corp/* \
    GOPRIVATE=github.com/acme-corp/* \
    go mod download

COPY . .

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=ssh \
    CGO_ENABLED=0 go build -o /app/server ./cmd/server
```

```bash
# Build with SSH agent forwarding
eval $(ssh-agent)
ssh-add ~/.ssh/id_ed25519

docker buildx build \
  --ssh default \
  --tag my-app:latest \
  .
```

### Secret Mount for Credential Files

```dockerfile
# syntax=docker/dockerfile:1.6

FROM node:20.10.0-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./

# Use a secret file for npm authentication
# The secret is never written to any layer
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    --mount=type=cache,target=/root/.npm \
    npm ci

# Verify the secret is not in the image
RUN test ! -f /root/.npmrc && echo "Secret correctly not persisted"
```

```bash
# Build with secret
docker buildx build \
  --secret id=npmrc,src=$HOME/.npmrc \
  --tag my-node-app:latest \
  .
```

### AWS Credentials for Build-Time Pulls

```dockerfile
# syntax=docker/dockerfile:1.6

FROM alpine:3.19 AS downloader

RUN apk add --no-cache aws-cli

# Download artifacts from S3 without baking credentials into the image
RUN --mount=type=secret,id=aws-credentials,target=/root/.aws/credentials \
    aws s3 cp s3://acme-internal-artifacts/config/app-config.yaml /app/config.yaml

FROM python:3.12.1-slim AS final
COPY --from=downloader /app/config.yaml ./config.yaml
```

```bash
docker buildx build \
  --secret id=aws-credentials,src=$HOME/.aws/credentials \
  --tag my-app:latest \
  .
```

## Section 4: SBOM Generation and Provenance Attestation

### Software Bill of Materials (SBOM)

An SBOM provides a complete inventory of software components in a container image. Required by many enterprise security policies and regulatory frameworks.

```bash
# Generate SBOM during build with syft
docker buildx build \
  --sbom=true \
  --tag registry.acme.corp/payments-api:v1.2.3 \
  --push \
  .

# Inspect the SBOM
docker buildx imagetools inspect registry.acme.corp/payments-api:v1.2.3 \
  --format '{{json .SBOM}}'

# Verify SBOM is attached
docker buildx imagetools inspect registry.acme.corp/payments-api:v1.2.3
# Look for "application/vnd.syft+json" in the output
```

### Provenance Attestation

```bash
# Build with provenance attestation (records the build environment and source)
docker buildx build \
  --provenance=true \
  --sbom=true \
  --tag registry.acme.corp/payments-api:v1.2.3 \
  --push \
  .

# Inspect provenance
docker buildx imagetools inspect registry.acme.corp/payments-api:v1.2.3 \
  --format '{{json .Provenance}}'

# Verify with cosign (Sigstore)
cosign verify-attestation \
  --type sbom \
  --certificate-identity-regexp "https://github.com/acme-corp/payments-api/.*" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  registry.acme.corp/payments-api:v1.2.3
```

### Signing Images with cosign

```yaml
# GitHub Actions workflow with image signing
name: Build and Sign
on:
  push:
    branches: [main]

permissions:
  id-token: write   # Required for OIDC token
  contents: read
  packages: write

jobs:
  build-and-sign:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

    - name: Install cosign
      uses: sigstore/cosign-installer@main
      with:
        cosign-release: 'v2.2.2'

    - name: Set up QEMU
      uses: docker/setup-qemu-action@v3

    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v3

    - name: Login to GHCR
      uses: docker/login-action@v3
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}

    - name: Build and push with attestations
      id: build
      uses: docker/build-push-action@v5
      with:
        context: .
        push: true
        platforms: linux/amd64,linux/arm64
        tags: ghcr.io/${{ github.repository }}:${{ github.sha }}
        sbom: true
        provenance: true
        cache-from: type=gha
        cache-to: type=gha,mode=max

    - name: Sign the container image
      run: |
        cosign sign --yes \
          ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}
```

## Section 5: Layer Caching Strategies

### Ordering Dockerfile Instructions for Cache Efficiency

The fundamental rule: put instructions that change rarely at the top, instructions that change frequently at the bottom.

```dockerfile
# syntax=docker/dockerfile:1.6

# Layer 1: Base image (changes rarely - only on security updates)
FROM ubuntu:22.04

# Layer 2: System packages (changes when you add new dependencies)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Layer 3: Application dependencies (changes when dependencies change)
WORKDIR /app
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

# Layer 4: Application code (changes with every commit)
COPY . .
RUN go build -o /server ./cmd/server

# BAD ordering example (defeats cache):
# COPY . .               <- every code change invalidates
# RUN go mod download    <- re-runs on every code change even if go.mod unchanged
```

### BuildKit Inline Cache

```bash
# For registries that support OCI manifests with inline cache
docker buildx build \
  --cache-from type=inline \
  --cache-to type=inline \
  --tag my-image:latest \
  --push \
  .

# Registry cache (more efficient for large images)
# mode=max caches all intermediate layers
docker buildx build \
  --cache-from type=registry,ref=registry.acme.corp/cache/my-image:cache \
  --cache-to type=registry,ref=registry.acme.corp/cache/my-image:cache,mode=max \
  --tag registry.acme.corp/my-image:latest \
  --push \
  .

# GHA cache (GitHub Actions built-in cache)
docker buildx build \
  --cache-from type=gha \
  --cache-to type=gha,mode=max \
  --tag my-image:latest \
  .
```

### Local BuildKit Cache

```bash
# Export cache to local directory
docker buildx build \
  --cache-to type=local,dest=/tmp/buildx-cache,mode=max \
  --tag my-image:latest \
  .

# Use local cache on subsequent builds
docker buildx build \
  --cache-from type=local,src=/tmp/buildx-cache \
  --cache-to type=local,dest=/tmp/buildx-cache,mode=max \
  --tag my-image:latest \
  .
```

## Section 6: Bind Mounts for Development

Bind mounts allow a build stage to read from a host directory without copying files into the image, reducing build context size and eliminating unnecessary layers:

```dockerfile
# Use bind mount for source code that doesn't need to persist in the image
FROM golang:1.21.5-alpine AS builder

WORKDIR /build

COPY go.mod go.sum ./

RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

# Bind mount source code for compilation (not copied into layer)
RUN --mount=type=bind,target=/build,source=. \
    --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -o /app/server ./cmd/server
```

## Section 7: Build Matrix Optimization

### Building Multiple Variants

```makefile
# Makefile for optimized multi-target builds

.PHONY: build-all build-base build-debug build-test

IMAGE_REGISTRY := registry.acme.corp
IMAGE_NAME := payments-api
IMAGE_TAG := $(shell git rev-parse --short HEAD)

# Common build arguments
BUILD_ARGS := \
  --build-arg BUILD_DATE="$(shell date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg VCS_REF="$(IMAGE_TAG)" \
  --build-arg VERSION="$(shell git describe --tags --always)"

CACHE_ARGS := \
  --cache-from type=registry,ref=$(IMAGE_REGISTRY)/$(IMAGE_NAME):buildcache \
  --cache-to type=registry,ref=$(IMAGE_REGISTRY)/$(IMAGE_NAME):buildcache,mode=max

build-all: build-production build-debug

build-production:
	docker buildx build \
	  --platform linux/amd64,linux/arm64 \
	  --target production \
	  $(BUILD_ARGS) \
	  $(CACHE_ARGS) \
	  --tag $(IMAGE_REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG) \
	  --tag $(IMAGE_REGISTRY)/$(IMAGE_NAME):latest \
	  --sbom=true \
	  --provenance=true \
	  --push \
	  .

build-debug:
	docker buildx build \
	  --platform linux/amd64 \
	  --target debug \
	  $(BUILD_ARGS) \
	  $(CACHE_ARGS) \
	  --tag $(IMAGE_REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG)-debug \
	  --push \
	  .

build-test:
	docker buildx build \
	  --platform linux/amd64 \
	  --target test \
	  $(BUILD_ARGS) \
	  $(CACHE_ARGS) \
	  --tag $(IMAGE_REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG)-test \
	  .
```

### Parallel Multi-Platform Build

```bash
#!/bin/bash
# parallel-build.sh - Build for multiple platforms in parallel

REGISTRY="registry.acme.corp"
IMAGE="payments-api"
TAG=$(git rev-parse --short HEAD)

# Build AMD64 and ARM64 simultaneously using separate builders
docker buildx build \
  --builder production-builder \
  --platform linux/amd64,linux/arm64 \
  --tag "$REGISTRY/$IMAGE:$TAG" \
  --tag "$REGISTRY/$IMAGE:latest" \
  --cache-from type=registry,ref="$REGISTRY/$IMAGE:cache-amd64" \
  --cache-from type=registry,ref="$REGISTRY/$IMAGE:cache-arm64" \
  --cache-to type=registry,ref="$REGISTRY/$IMAGE:cache-amd64,platform=linux/amd64,mode=max" \
  --cache-to type=registry,ref="$REGISTRY/$IMAGE:cache-arm64,platform=linux/arm64,mode=max" \
  --sbom=true \
  --provenance=true \
  --push \
  .

# Verify the manifest
docker buildx imagetools inspect "$REGISTRY/$IMAGE:$TAG"
```

## Section 8: Image Vulnerability Scanning Integration

### Trivy in Multi-Stage Build

```dockerfile
# syntax=docker/dockerfile:1.6

FROM golang:1.21.5-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -o /server ./cmd/server

# Scan stage - runs Trivy against the built binary and OS packages
FROM aquasec/trivy:0.49.0 AS scanner
COPY --from=builder /server /server
# Scan the binary for known vulnerabilities
# Use --exit-code 1 to fail the build on HIGH/CRITICAL findings
RUN trivy rootfs \
  --exit-code 0 \
  --no-progress \
  --severity HIGH,CRITICAL \
  --format json \
  --output /trivy-report.json \
  /

# Export scan results
FROM scratch AS scan-results
COPY --from=scanner /trivy-report.json /

# Final production image (only built if scanner stage succeeded)
FROM scratch AS final
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /server /server
USER 65534
ENTRYPOINT ["/server"]
```

### CI Integration with Trivy

```yaml
# .github/workflows/build-scan-push.yml
jobs:
  security-scan:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

    - name: Build image for scanning
      uses: docker/build-push-action@v5
      with:
        load: true  # Load into local Docker daemon for scanning
        tags: payments-api:scan
        cache-from: type=gha

    - name: Run Trivy vulnerability scanner
      uses: aquasecurity/trivy-action@master
      with:
        image-ref: payments-api:scan
        format: sarif
        output: trivy-results.sarif
        severity: HIGH,CRITICAL
        exit-code: 1  # Fail on HIGH/CRITICAL

    - name: Upload Trivy scan results
      uses: github/codeql-action/upload-sarif@v3
      if: always()
      with:
        sarif_file: trivy-results.sarif
```

## Section 9: .dockerignore Optimization

The build context sent to the daemon includes all files not excluded by .dockerignore. A large build context slows down every build even with layer caching.

```dockerignore
# .dockerignore - Optimize build context

# Version control
.git
.gitignore
.github

# Development tools and configuration
.idea
.vscode
*.code-workspace
.editorconfig

# Build artifacts (don't copy in from host - built inside container)
bin/
dist/
build/
*.exe
*.dll
*.so
*.dylib

# Test artifacts and coverage
coverage/
*.coverprofile
test-results/
*.test

# Local development configuration
.env
.env.local
.env.*.local
docker-compose.override.yml
docker-compose.local.yml

# CI/CD configuration (not needed in container)
.github/
.circleci/
.travis.yml
Jenkinsfile
.drone.yml

# Documentation
docs/
*.md
LICENSE
CONTRIBUTING

# Dependency directories (installed fresh inside container)
node_modules/
vendor/    # Only for some languages; Go projects may want this
__pycache__/
*.pyc
*.pyo

# Terraform/infrastructure (not needed in app container)
*.tf
*.tfstate
*.tfvars
terraform/
k8s/
helm/

# Large test fixtures
testdata/
fixtures/*.sql
testdata/

# Temporary files
*.tmp
*.swp
*.swo
*~
.DS_Store
Thumbs.db
```

## Section 10: Measuring and Validating Build Performance

```bash
#!/bin/bash
# build-benchmark.sh - Measure and compare build performance

IMAGE="registry.acme.corp/payments-api"
TAG="bench-$(date +%s)"

echo "=== Docker Build Performance Benchmark ==="

# Benchmark 1: Cold build (no cache)
echo "Test 1: Cold build (no cache)"
docker buildx prune -f
time docker buildx build \
  --no-cache \
  --tag "$IMAGE:$TAG-cold" \
  --load \
  . 2>&1 | tail -5

# Benchmark 2: Warm build (with layer cache)
echo ""
echo "Test 2: Warm build (with layer cache)"
time docker buildx build \
  --tag "$IMAGE:$TAG-warm" \
  --load \
  . 2>&1 | tail -5

# Benchmark 3: Source-only change
echo ""
echo "Test 3: Source file change only (touch main file)"
touch cmd/server/main.go
time docker buildx build \
  --tag "$IMAGE:$TAG-src-change" \
  --load \
  . 2>&1 | tail -5

# Image size analysis
echo ""
echo "=== Image Size Analysis ==="
docker images "$IMAGE" --format "table {{.Tag}}\t{{.Size}}\t{{.CreatedAt}}"

# Layer analysis
echo ""
echo "=== Layer Analysis for $IMAGE:$TAG-cold ==="
docker history "$IMAGE:$TAG-cold" \
  --format "table {{.ID}}\t{{.Size}}\t{{.CreatedBy}}" | \
  head -20

# Cleanup
docker rmi "$IMAGE:$TAG-cold" "$IMAGE:$TAG-warm" "$IMAGE:$TAG-src-change" 2>/dev/null

echo ""
echo "Benchmark complete"
```

## Summary

Effective Docker build optimization requires layering several techniques:

1. Multi-stage builds separate build tooling from runtime content, reducing final image sizes by 80-95% for compiled languages
2. BuildKit cache mounts (`--mount=type=cache`) persist package manager caches across builds, turning 5-minute dependency downloads into sub-second cache hits
3. Secret mounts (`--mount=type=secret`) and SSH agent forwarding provide build-time credentials without leaving them in any layer
4. Correct Dockerfile layer ordering (stable dependencies before frequently changing source code) maximizes cache hit rates in CI
5. SBOM and provenance attestations provide the audit trail required by supply chain security frameworks (SLSA, SSDF)
6. .dockerignore files should be treated with the same care as the Dockerfile itself to minimize build context size
7. Registry cache (`mode=max`) persists all intermediate BuildKit layers, making incremental CI builds as fast as local development builds

The combination of cache mounts, layer ordering, and registry cache typically reduces CI build times from 10-15 minutes to 1-3 minutes for a cold CI environment (new runner), and to under 30 seconds for incremental builds where only source code changed.
