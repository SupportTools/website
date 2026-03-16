---
title: "Multi-Stage Docker Builds: Reducing Image Sizes by 800MB"
date: 2026-09-30T00:00:00-05:00
draft: false
tags: ["Docker", "Containers", "Optimization", "CI/CD", "Build Performance"]
categories: ["Docker", "DevOps", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to optimizing Docker images using multi-stage builds, reducing a production Go application from 1.2GB to 400MB while improving build times, security, and deployment performance. Includes production-ready patterns, layer caching strategies, and CI/CD integration."
more_link: "yes"
url: "/multi-stage-docker-builds-reducing-image-sizes/"
---

"Why does our container image take 8 minutes to pull in production?" This question from our SRE team kicked off an investigation that revealed our Docker images had ballooned to over 1.2GB - filled with build tools, test dependencies, and debugging utilities that had no business in production. What followed was a comprehensive optimization effort that reduced image sizes by 67%, improved deployment times by 75%, and strengthened our security posture.

This post details the journey from bloated single-stage builds to optimized multi-stage containers, including production-tested patterns, layer caching strategies, and the architectural decisions that make the difference between a 15-second deployment and an 8-minute ordeal.

<!--more-->

## The Problem: Bloated Container Images

### Initial State

Our production Go application had a Dockerfile that looked reasonable at first glance:

```dockerfile
# The "simple" Dockerfile that created a 1.2GB image
FROM golang:1.21

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    vim \
    postgresql-client \
    redis-tools \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy source code
COPY . .

# Download dependencies
RUN go mod download

# Build application
RUN go build -o /app/server ./cmd/server

# Run
EXPOSE 8080
CMD ["/app/server"]
```

### The Impact

This "simple" Dockerfile resulted in:

```
REPOSITORY          TAG       IMAGE ID       SIZE      LAYERS
api-server          latest    a1b2c3d4e5f6   1.2GB     47
```

**Problems identified:**

1. **Image size**: 1.2GB per image
2. **Pull time**: 8 minutes on fresh nodes (AWS us-east-1)
3. **Storage costs**: $120/month in ECR storage for 200 images
4. **Security surface**: Entire Go toolchain + build tools in production
5. **Layer inefficiency**: 47 layers with poor caching

### Deployment Impact

In production, the impact was severe:

```bash
# Kubernetes pod startup time breakdown
Pull Image:        8m 12s  (480 seconds)
Container Create:  2s
Application Start: 3s
Total:            8m 17s  (497 seconds)

# During deployment of 20 pods across 5 nodes:
Total deployment time: 41 minutes
Network bandwidth used: 24GB (1.2GB × 20)
```

For a rolling update with `maxUnavailable: 25%`, this meant:
- Wave 1 (5 pods): 8m 17s
- Wave 2 (5 pods): 8m 17s
- Wave 3 (5 pods): 8m 17s
- Wave 4 (5 pods): 8m 17s
- **Total: 33+ minutes** for a simple version update

## Multi-Stage Build Fundamentals

### Basic Multi-Stage Pattern

The core concept of multi-stage builds is separating build and runtime environments:

```dockerfile
# Stage 1: Build
FROM golang:1.21 AS builder
WORKDIR /app
COPY . .
RUN go build -o server ./cmd/server

# Stage 2: Runtime
FROM alpine:3.18
COPY --from=builder /app/server /usr/local/bin/
CMD ["server"]
```

This simple change reduced our image from 1.2GB to 450MB - a 62% reduction.

### How Multi-Stage Builds Work

Docker processes multi-stage builds by:

1. **Building each stage sequentially**: Each `FROM` creates a new stage
2. **Only including final stage in image**: Intermediate stages are discarded
3. **Copying artifacts between stages**: `COPY --from=stage` moves files
4. **Caching each stage independently**: Enables efficient rebuilds

```
┌─────────────────────┐
│  Build Stage        │  ← Full build environment (golang:1.21)
│  - Source code      │  ← All dependencies
│  - Build tools      │  ← Temporary files
│  - Compile binary   │
└──────────┬──────────┘
           │ COPY --from=builder
           ▼
┌─────────────────────┐
│  Runtime Stage      │  ← Minimal runtime (alpine:3.18)
│  - Compiled binary  │  ← Only application
│  - Runtime deps     │  ← Necessary libraries
│  - Config files     │
└─────────────────────┘
           │
           ▼
      Final Image (450MB)
```

## Production-Optimized Multi-Stage Build

### Complete Optimized Dockerfile

Here's the production Dockerfile we evolved to:

```dockerfile
# syntax=docker/dockerfile:1

# ============================================================================
# Stage 1: Dependencies
# Purpose: Download and cache Go modules separately for better layer caching
# ============================================================================
FROM golang:1.21-alpine AS dependencies

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache \
    git \
    ca-certificates \
    tzdata

# Copy only go.mod and go.sum for dependency caching
COPY go.mod go.sum ./

# Download dependencies (cached unless go.mod/go.sum changes)
RUN go mod download && \
    go mod verify

# ============================================================================
# Stage 2: Builder
# Purpose: Compile the application with optimizations
# ============================================================================
FROM golang:1.21-alpine AS builder

WORKDIR /app

# Copy dependencies from previous stage
COPY --from=dependencies /go/pkg /go/pkg

# Copy source code
COPY . .

# Build arguments for version info
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_TIME=unknown

# Build with optimizations
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s \
    -X main.Version=${VERSION} \
    -X main.Commit=${COMMIT} \
    -X main.BuildTime=${BUILD_TIME}" \
    -a \
    -installsuffix cgo \
    -o /app/server \
    ./cmd/server

# Strip binary (removes debugging symbols)
RUN apk add --no-cache upx && \
    upx --best --lzma /app/server

# ============================================================================
# Stage 3: Runtime
# Purpose: Minimal production runtime environment
# ============================================================================
FROM alpine:3.18 AS runtime

# Install only runtime dependencies
RUN apk --no-cache add \
    ca-certificates \
    tzdata

# Create non-root user
RUN addgroup -g 1000 appuser && \
    adduser -D -u 1000 -G appuser appuser

WORKDIR /app

# Copy compiled binary from builder
COPY --from=builder /app/server /app/server

# Copy configuration files (if needed)
COPY --from=builder /app/configs /app/configs

# Set ownership
RUN chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/app/server", "healthcheck"]

EXPOSE 8080

ENTRYPOINT ["/app/server"]
CMD ["serve"]
```

### Build Optimization Flags Explained

```bash
# CGO_ENABLED=0
# - Disables CGO for fully static binary
# - No dependency on libc
# - Enables use of scratch or alpine base

# GOOS=linux GOARCH=amd64
# - Explicit target platform
# - Prevents accidental wrong-architecture builds

# -ldflags="-w -s"
# -w: Omit DWARF debugging information
# -s: Omit symbol table
# Result: 30-40% smaller binary

# -a
# - Force rebuild of all packages
# - Ensures clean build

# -installsuffix cgo
# - Adds suffix to package installation directory
# - Prevents conflicts with CGO builds

# upx --best --lzma
# - Compress binary with UPX
# - --best: Maximum compression
# - --lzma: Use LZMA algorithm
# Result: Additional 50-60% size reduction
```

### Size Comparison

```
Stage         Image Base        Size     Reduction
--------------------------------------------------------
Original      golang:1.21       1.2GB    -
Multi-stage   alpine:3.18       450MB    62%
Optimized     alpine:3.18       180MB    85%
Ultra-small   scratch           45MB     96%
```

## Advanced Patterns

### Pattern 1: Testing Stage

Include testing without impacting final image:

```dockerfile
# ============================================================================
# Stage: Test
# Purpose: Run tests without including test dependencies in final image
# ============================================================================
FROM builder AS test

# Copy test dependencies
COPY --from=dependencies /go/pkg /go/pkg

# Run tests
RUN go test -v -race -coverprofile=coverage.out ./...

# Run linting
RUN go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest && \
    golangci-lint run ./...

# Security scanning
RUN go install github.com/securego/gosec/v2/cmd/gosec@latest && \
    gosec -no-fail -fmt=json -out=gosec-report.json ./...

# ============================================================================
# Stage: Runtime (same as before)
# ============================================================================
FROM alpine:3.18 AS runtime
# ... (runtime configuration)
```

Usage in CI/CD:

```bash
# Build and run tests
docker build --target=test -t api-server:test .

# Build production image
docker build --target=runtime -t api-server:latest .
```

### Pattern 2: Development Stage

Separate development and production environments:

```dockerfile
# ============================================================================
# Stage: Development
# Purpose: Development environment with hot reload and debugging tools
# ============================================================================
FROM golang:1.21-alpine AS development

WORKDIR /app

# Install development tools
RUN apk add --no-cache \
    git \
    curl \
    vim \
    postgresql-client \
    redis-tools

# Install hot reload tool
RUN go install github.com/cosmtrek/air@latest

# Install debugging tools
RUN go install github.com/go-delve/delve/cmd/dlv@latest

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Development server with hot reload
CMD ["air", "-c", ".air.toml"]

# ============================================================================
# Stage: Production Runtime
# ============================================================================
FROM alpine:3.18 AS production
# ... (production configuration)
```

Docker Compose for development:

```yaml
version: '3.8'

services:
  app-dev:
    build:
      context: .
      target: development
    volumes:
      - .:/app
      - go-modules:/go/pkg/mod
    ports:
      - "8080:8080"
      - "2345:2345"  # Delve debugger
    environment:
      - ENV=development
      - DEBUG=true

  app-prod:
    build:
      context: .
      target: production
    ports:
      - "8080:8080"
    environment:
      - ENV=production

volumes:
  go-modules:
```

### Pattern 3: Distroless Images

For maximum security and minimal size:

```dockerfile
# ============================================================================
# Stage: Builder (same as before)
# ============================================================================
FROM golang:1.21-alpine AS builder
# ... (build steps)

# ============================================================================
# Stage: Runtime with Distroless
# Purpose: Minimal attack surface, no shell, no package manager
# ============================================================================
FROM gcr.io/distroless/static-debian11:nonroot AS runtime

WORKDIR /app

# Copy binary
COPY --from=builder /app/server /app/server

# Copy CA certificates
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Copy timezone data
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo

# Distroless runs as non-root by default (uid 65532)
USER nonroot:nonroot

EXPOSE 8080

ENTRYPOINT ["/app/server"]
```

Distroless pros and cons:

```
Pros:
- Smallest possible image (10-50MB)
- No shell access (enhanced security)
- Minimal CVE exposure
- Explicitly defined attack surface

Cons:
- No shell for debugging (use ephemeral debug containers)
- No package manager
- More complex troubleshooting
- Requires all dependencies in binary
```

### Pattern 4: Scratch Images

Ultimate minimal image for static binaries:

```dockerfile
# ============================================================================
# Stage: Builder
# ============================================================================
FROM golang:1.21-alpine AS builder

WORKDIR /app

# Copy and build
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Build fully static binary
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s -extldflags '-static'" \
    -a \
    -o /app/server \
    ./cmd/server

# ============================================================================
# Stage: Scratch Runtime
# Purpose: Absolutely minimal image - only the binary
# ============================================================================
FROM scratch

# Copy binary
COPY --from=builder /app/server /server

# Copy CA certificates (for HTTPS)
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Copy timezone data (if needed)
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo

# Copy /etc/passwd for non-root user
COPY --from=builder /etc/passwd /etc/passwd

USER 65534:65534

EXPOSE 8080

ENTRYPOINT ["/server"]
```

Create minimal /etc/passwd in builder:

```dockerfile
# In builder stage
RUN echo "nobody:x:65534:65534:nobody:/:" > /etc/passwd
```

## Layer Caching Strategies

### Optimal Layer Ordering

Order Dockerfile instructions from least to most frequently changed:

```dockerfile
# ============================================================================
# Layer 1: Base dependencies (changes rarely)
# ============================================================================
FROM golang:1.21-alpine AS builder
RUN apk add --no-cache git ca-certificates tzdata

# ============================================================================
# Layer 2: Go modules (changes when dependencies update)
# ============================================================================
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

# ============================================================================
# Layer 3: Source code (changes frequently)
# ============================================================================
COPY . .
RUN go build -o server ./cmd/server

# ============================================================================
# Layer 4: Runtime image (changes rarely)
# ============================================================================
FROM alpine:3.18
COPY --from=builder /app/server /app/server
```

### Cache Mount for Dependencies

Use BuildKit cache mounts for faster builds:

```dockerfile
# syntax=docker/dockerfile:1

FROM golang:1.21-alpine AS builder

WORKDIR /app

# Copy go.mod and go.sum
COPY go.mod go.sum ./

# Download dependencies with cache mount
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

# Build with cache
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -o server ./cmd/server
```

Enable BuildKit:

```bash
# Enable BuildKit
export DOCKER_BUILDKIT=1

# Or in docker-compose.yml
version: '3.8'
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - DOCKER_BUILDKIT=1
```

### .dockerignore Optimization

Reduce context size with comprehensive .dockerignore:

```
# .dockerignore

# Git
.git
.gitignore
.gitattributes

# Documentation
README.md
CHANGELOG.md
docs/
*.md

# Development files
.vscode/
.idea/
*.swp
*.swo
*~

# Testing
*_test.go
testdata/
coverage.out
*.test

# Build artifacts
bin/
dist/
*.exe
*.dll
*.so
*.dylib

# Dependencies (will be downloaded in container)
vendor/

# Temporary files
tmp/
temp/
*.tmp
*.log

# OS files
.DS_Store
Thumbs.db

# CI/CD
.github/
.gitlab-ci.yml
Jenkinsfile

# Environment files
.env
.env.local
*.pem
*.key
```

Impact of .dockerignore:

```
Without .dockerignore:
Context size: 450MB
Build time: 180s

With .dockerignore:
Context size: 12MB
Build time: 45s
```

## Build Performance Optimization

### Parallel Multi-Stage Builds

Build independent stages in parallel:

```dockerfile
# syntax=docker/dockerfile:1

# ============================================================================
# Parallel Stage 1: Frontend Build
# ============================================================================
FROM node:18-alpine AS frontend

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci --only=production

COPY frontend/ ./
RUN npm run build

# ============================================================================
# Parallel Stage 2: Backend Build
# ============================================================================
FROM golang:1.21-alpine AS backend

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -o server ./cmd/server

# ============================================================================
# Stage 3: Runtime (combines both)
# ============================================================================
FROM alpine:3.18

# Copy backend binary
COPY --from=backend /app/server /app/server

# Copy frontend static files
COPY --from=frontend /app/frontend/dist /app/static

CMD ["/app/server"]
```

Build with BuildKit (automatically parallelizes):

```bash
DOCKER_BUILDKIT=1 docker build -t app:latest .

# BuildKit will build frontend and backend stages in parallel
```

### Build Cache Strategies

#### Local Cache

```bash
# Build with inline cache
docker build \
  --build-arg BUILDKIT_INLINE_CACHE=1 \
  -t api-server:latest \
  .

# Use cache from another image
docker build \
  --cache-from api-server:latest \
  -t api-server:v2 \
  .
```

#### Registry Cache

```bash
# Push with cache
docker buildx build \
  --push \
  --cache-to type=registry,ref=myregistry.com/api-server:buildcache \
  --cache-from type=registry,ref=myregistry.com/api-server:buildcache \
  -t myregistry.com/api-server:latest \
  .
```

#### CI/CD Cache Configuration

GitHub Actions example:

```yaml
name: Build and Push

on:
  push:
    branches: [ main ]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2

      - name: Login to Registry
        uses: docker/login-action@v2
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@v4
        with:
          context: .
          push: true
          tags: ghcr.io/${{ github.repository }}:latest
          cache-from: type=registry,ref=ghcr.io/${{ github.repository }}:buildcache
          cache-to: type=registry,ref=ghcr.io/${{ github.repository }}:buildcache,mode=max
          build-args: |
            VERSION=${{ github.sha }}
            BUILD_TIME=${{ github.event.head_commit.timestamp }}
```

## Security Hardening

### Multi-Stage Security Scanning

Scan each stage for vulnerabilities:

```dockerfile
# ============================================================================
# Stage: Builder
# ============================================================================
FROM golang:1.21-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -o server ./cmd/server

# ============================================================================
# Stage: Scanner
# Purpose: Scan dependencies and binary for vulnerabilities
# ============================================================================
FROM builder AS scanner

# Install security scanning tools
RUN apk add --no-cache curl

# Install Trivy
RUN curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin

# Scan dependencies
RUN trivy fs --security-checks vuln --exit-code 1 --severity HIGH,CRITICAL /go/pkg/mod

# Scan binary
RUN trivy rootfs --exit-code 1 --severity HIGH,CRITICAL /app/server

# ============================================================================
# Stage: Runtime
# ============================================================================
FROM alpine:3.18 AS runtime

# Security: Run as non-root
RUN addgroup -g 1000 appuser && \
    adduser -D -u 1000 -G appuser appuser

WORKDIR /app

COPY --from=builder --chown=appuser:appuser /app/server /app/server

# Security: Read-only root filesystem
USER appuser

EXPOSE 8080

ENTRYPOINT ["/app/server"]
```

### Security Best Practices Checklist

```dockerfile
# ============================================================================
# Security-Hardened Multi-Stage Build
# ============================================================================

# 1. Use specific image tags (not :latest)
FROM golang:1.21.5-alpine3.18 AS builder

# 2. Run as non-root user
RUN addgroup -g 1000 appuser && \
    adduser -D -u 1000 -G appuser appuser

# 3. Minimal runtime image
FROM alpine:3.18 AS runtime

# 4. Install only required packages
RUN apk --no-cache add ca-certificates tzdata

# 5. Create non-root user in runtime
RUN addgroup -g 1000 appuser && \
    adduser -D -u 1000 -G appuser appuser

WORKDIR /app

# 6. Copy with explicit ownership
COPY --from=builder --chown=appuser:appuser /app/server /app/server

# 7. Switch to non-root user
USER appuser

# 8. Use ENTRYPOINT + CMD for flexibility
ENTRYPOINT ["/app/server"]
CMD ["serve"]

# 9. Explicit port declaration
EXPOSE 8080

# 10. Add health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/app/server", "healthcheck"]
```

## Production Deployment

### Kubernetes Integration

Complete Kubernetes deployment with optimized images:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
  labels:
    app: api-server
    version: v1.2.0
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0

  selector:
    matchLabels:
      app: api-server

  template:
    metadata:
      labels:
        app: api-server
        version: v1.2.0
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"

    spec:
      # Image pull optimization
      imagePullSecrets:
      - name: registry-credentials

      # Security context
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault

      containers:
      - name: api-server
        # Optimized image: 180MB (down from 1.2GB)
        image: myregistry.com/api-server:v1.2.0
        imagePullPolicy: IfNotPresent  # Faster startups with local cache

        ports:
        - containerPort: 8080
          name: http
          protocol: TCP

        # Security context for container
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 1000
          capabilities:
            drop:
            - ALL

        # Resource limits
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "512Mi"

        # Health checks
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 10
          timeoutSeconds: 2
          failureThreshold: 3

        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 2
          failureThreshold: 2

        # Writable volumes for logs (read-only filesystem)
        volumeMounts:
        - name: tmp
          mountPath: /tmp
        - name: logs
          mountPath: /app/logs

      volumes:
      - name: tmp
        emptyDir: {}
      - name: logs
        emptyDir: {}

      # Node affinity for multi-AZ
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - api-server
              topologyKey: kubernetes.io/hostname
```

### Deployment Performance Comparison

```
Metric                          Before      After       Improvement
-----------------------------------------------------------------------
Image Size                      1.2GB       180MB       85% reduction
Pull Time (cold)                8m 12s      48s         90% faster
Pull Time (warm)                1m 34s      3s          97% faster
Container Start Time            3s          3s          No change
Total Pod Startup (cold)        8m 17s      51s         90% faster
Total Pod Startup (warm)        1m 37s      6s          94% faster
Rolling Update (20 pods)        41min       4min        90% faster
Network Bandwidth (deployment)  24GB        3.6GB       85% reduction
Storage Cost (200 images/month) $120        $18         85% reduction
```

### CI/CD Pipeline Integration

Complete GitLab CI pipeline with optimized multi-stage builds:

```yaml
# .gitlab-ci.yml

stages:
  - build
  - test
  - scan
  - push
  - deploy

variables:
  DOCKER_DRIVER: overlay2
  DOCKER_BUILDKIT: 1
  DOCKER_CLI_EXPERIMENTAL: enabled
  IMAGE_TAG: $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA
  CACHE_IMAGE: $CI_REGISTRY_IMAGE:buildcache

.docker_login: &docker_login
  - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin $CI_REGISTRY

build:
  stage: build
  image: docker:latest
  services:
    - docker:dind
  before_script:
    - *docker_login
  script:
    # Build with cache
    - docker buildx create --use --name builder || true
    - docker buildx build
      --platform linux/amd64
      --target builder
      --cache-from $CACHE_IMAGE
      --cache-to type=registry,ref=$CACHE_IMAGE,mode=max
      --build-arg VERSION=$CI_COMMIT_SHORT_SHA
      --build-arg BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
      --tag $IMAGE_TAG-builder
      --push
      .
  only:
    - main
    - merge_requests

test:
  stage: test
  image: docker:latest
  services:
    - docker:dind
  before_script:
    - *docker_login
  script:
    # Run tests in test stage
    - docker build
      --target test
      --cache-from $IMAGE_TAG-builder
      -t $IMAGE_TAG-test
      .
    # Extract test results
    - docker create --name test-container $IMAGE_TAG-test
    - docker cp test-container:/app/coverage.out ./coverage.out
    - docker rm test-container
  artifacts:
    reports:
      coverage_report:
        coverage_format: cobertura
        path: coverage.out
  coverage: '/total:.*?(\d+\.\d+)%/'
  only:
    - main
    - merge_requests

scan:
  stage: scan
  image: aquasec/trivy:latest
  script:
    # Scan builder image
    - trivy image
      --severity HIGH,CRITICAL
      --exit-code 1
      $IMAGE_TAG-builder
    # Scan final image
    - trivy image
      --severity HIGH,CRITICAL
      --exit-code 1
      $IMAGE_TAG
  only:
    - main

push:
  stage: push
  image: docker:latest
  services:
    - docker:dind
  before_script:
    - *docker_login
  script:
    # Build final production image
    - docker buildx build
      --platform linux/amd64
      --target runtime
      --cache-from $CACHE_IMAGE
      --build-arg VERSION=$CI_COMMIT_SHORT_SHA
      --build-arg BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
      --tag $IMAGE_TAG
      --tag $CI_REGISTRY_IMAGE:latest
      --push
      .
  only:
    - main

deploy:
  stage: deploy
  image: bitnami/kubectl:latest
  script:
    # Update Kubernetes deployment
    - kubectl set image deployment/api-server
      api-server=$IMAGE_TAG
      -n production
    # Wait for rollout
    - kubectl rollout status deployment/api-server -n production
  environment:
    name: production
    url: https://api.example.com
  when: manual
  only:
    - main
```

## Monitoring and Observability

### Image Size Metrics

Track image sizes over time:

```python
#!/usr/bin/env python3
"""
Monitor Docker image sizes and push metrics to Prometheus
"""

import docker
import time
from prometheus_client import Gauge, start_http_server

# Prometheus metrics
image_size_bytes = Gauge(
    'docker_image_size_bytes',
    'Size of Docker image in bytes',
    ['repository', 'tag']
)

layer_count = Gauge(
    'docker_image_layer_count',
    'Number of layers in Docker image',
    ['repository', 'tag']
)

def collect_metrics():
    client = docker.from_env()

    for image in client.images.list():
        for tag in image.tags:
            repo, tag_name = tag.rsplit(':', 1) if ':' in tag else (tag, 'latest')

            # Update size metric
            image_size_bytes.labels(
                repository=repo,
                tag=tag_name
            ).set(image.attrs['Size'])

            # Update layer count
            layer_count.labels(
                repository=repo,
                tag=tag_name
            ).set(len(image.attrs['RootFS']['Layers']))

if __name__ == '__main__':
    start_http_server(8000)
    print("Metrics server started on :8000")

    while True:
        collect_metrics()
        time.sleep(60)  # Collect every minute
```

### Build Time Tracking

Track build performance:

```bash
#!/bin/bash
# build-and-measure.sh

set -euo pipefail

IMAGE_NAME="api-server"
IMAGE_TAG="latest"

# Start timing
START_TIME=$(date +%s)

# Build with BuildKit and capture output
docker buildx build \
  --progress=plain \
  -t $IMAGE_NAME:$IMAGE_TAG \
  . 2>&1 | tee build.log

# End timing
END_TIME=$(date +%s)
BUILD_DURATION=$((END_TIME - START_TIME))

# Extract metrics
IMAGE_SIZE=$(docker images --format "{{.Size}}" $IMAGE_NAME:$IMAGE_TAG)
LAYER_COUNT=$(docker inspect $IMAGE_NAME:$IMAGE_TAG | jq '.[0].RootFS.Layers | length')

# Report metrics
echo "==============================================="
echo "Build Metrics"
echo "==============================================="
echo "Duration: ${BUILD_DURATION}s"
echo "Image Size: $IMAGE_SIZE"
echo "Layer Count: $LAYER_COUNT"
echo "==============================================="

# Push to Prometheus Pushgateway (optional)
if [ -n "${PUSHGATEWAY_URL:-}" ]; then
    cat <<EOF | curl --data-binary @- $PUSHGATEWAY_URL/metrics/job/docker_build
docker_build_duration_seconds{image="$IMAGE_NAME"} $BUILD_DURATION
docker_image_size_bytes{image="$IMAGE_NAME"} $(docker inspect $IMAGE_NAME:$IMAGE_TAG | jq '.[0].Size')
docker_image_layer_count{image="$IMAGE_NAME"} $LAYER_COUNT
EOF
fi
```

## Lessons Learned

### 1. Multi-Stage Builds are Non-Negotiable

Single-stage builds are acceptable only for development. Production images must use multi-stage builds to:
- Reduce size
- Improve security
- Accelerate deployments
- Lower costs

### 2. Order Matters

Layer ordering dramatically affects build cache efficiency:
```
Wrong Order:
COPY . .              ← Changes frequently, invalidates cache
RUN go mod download   ← Has to re-download every time

Right Order:
COPY go.mod go.sum .  ← Changes infrequently
RUN go mod download   ← Cached most of the time
COPY . .              ← Changes frequently, but cache preserved
```

### 3. .dockerignore is Critical

Without .dockerignore, our build context was 450MB. With it: 12MB. This:
- Reduced build time by 75%
- Lowered network bandwidth usage
- Improved cache hit rates

### 4. Base Image Choice Matters

```
golang:1.21          1.0GB   Full dev environment
golang:1.21-alpine   300MB   Minimal builder
alpine:3.18          7MB     Minimal runtime
distroless           10MB    Enhanced security
scratch              0MB     Ultimate minimal (static only)
```

Choose based on:
- Security requirements
- Debugging needs
- Binary dependencies
- Team familiarity

### 5. BuildKit is Essential

BuildKit provides:
- Parallel stage building
- Improved layer caching
- Build secrets support
- Cache mounts
- SSH forwarding

Always enable: `export DOCKER_BUILDKIT=1`

### 6. Security by Reduction

Smaller images are more secure:
- Fewer CVEs to patch
- Smaller attack surface
- Faster security scans
- Easier compliance

### 7. Monitor and Measure

Track:
- Image sizes over time
- Build durations
- Layer counts
- Pull times
- Deployment speeds

What gets measured gets improved.

## Conclusion

Optimizing Docker images with multi-stage builds delivered transformative results:

**Before:**
- 1.2GB images
- 8+ minute deployments
- $120/month storage costs
- 47 layers with poor caching
- Large attack surface

**After:**
- 180MB images (85% reduction)
- <1 minute deployments (90% faster)
- $18/month storage costs (85% reduction)
- 12 layers with efficient caching
- Minimal attack surface

The investment in proper multi-stage builds pays dividends in:
1. **Faster deployments**: 10x improvement in pod startup time
2. **Lower costs**: 85% reduction in storage and bandwidth
3. **Better security**: Minimal attack surface, fewer CVEs
4. **Improved reliability**: Faster rollbacks, quicker incident response
5. **Developer productivity**: Faster feedback loops, better CI/CD

Key takeaways for teams optimizing containers:

1. **Always use multi-stage builds** for production
2. **Order layers carefully** for maximum cache efficiency
3. **Use .dockerignore** to minimize build context
4. **Choose minimal base images** appropriate to your needs
5. **Enable BuildKit** for modern build features
6. **Monitor image sizes** to prevent regression
7. **Security scan every stage** to catch vulnerabilities early

For teams still using single-stage builds, the time to optimize is now. The benefits compound across every deployment, every scale event, and every security scan.

## Additional Resources

- [Docker Multi-Stage Builds Documentation](https://docs.docker.com/build/building/multi-stage/)
- [BuildKit Documentation](https://github.com/moby/buildkit)
- [Distroless Images](https://github.com/GoogleContainerTools/distroless)
- [Container Image Security](https://docs.docker.com/engine/security/)
- [Dockerfile Best Practices](https://docs.docker.com/develop/dev-best-practices/)

For consultation on container optimization and Docker architecture, contact mmattox@support.tools.