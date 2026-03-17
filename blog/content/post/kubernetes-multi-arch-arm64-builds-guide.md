---
title: "Kubernetes Multi-Architecture Builds: ARM64/AMD64 Docker Buildx, QEMU, and Mixed Node Pools"
date: 2028-07-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ARM64", "Docker Buildx", "Multi-Architecture", "CI/CD"]
categories:
- Kubernetes
- CI/CD
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to multi-architecture container builds covering Docker Buildx, QEMU emulation, native cross-compilation, multi-arch manifests, GitHub Actions workflows, and Kubernetes mixed ARM64/AMD64 node pool deployment patterns."
more_link: "yes"
url: "/kubernetes-multi-arch-arm64-builds-guide/"
---

AWS Graviton, Azure Cobalt, and Google Axion ARM64 instances deliver 20–40% better price-performance than equivalent x86 instances for most cloud-native workloads. Running heterogeneous Kubernetes clusters with mixed ARM64 and AMD64 nodes is now standard practice — but it requires multi-architecture container images at every layer of your stack. This guide covers the full build pipeline, from Dockerfile optimization to production deployment.

<!--more-->

# Kubernetes Multi-Architecture Builds: ARM64/AMD64 Docker Buildx, QEMU, and Mixed Node Pools

## Section 1: Architecture and Strategy

### Why Multi-Architecture Images

A single container image tag that works on both `linux/arm64` and `linux/amd64` is a Docker manifest list (also called a multi-arch manifest or OCI image index). When you `docker pull nginx:1.25`, Docker selects the correct architecture automatically from the manifest list.

```bash
# Inspect a multi-arch manifest
docker manifest inspect nginx:1.25 | jq '.manifests[] | {arch: .platform.architecture, os: .platform.os, digest: .digest}'
# {arch: "amd64", os: "linux", digest: "sha256:..."}
# {arch: "arm64", os: "linux", digest: "sha256:..."}
# {arch: "arm", os: "linux", digest: "sha256:..."}
```

### Build Strategies Comparison

| Strategy | Speed | Complexity | Best For |
|----------|-------|------------|----------|
| QEMU emulation | Slow (10-30x) | Low | Dev/testing, simple binaries |
| Cross-compilation | Fast | Medium | Go, Rust, C with proper toolchain |
| Native ARM64 runners | Fastest | Medium | CI with ARM runners available |
| Docker Buildx with remote builders | Fast | High | Production CI with dedicated builders |

---

## Section 2: Docker Buildx Setup

### Local Buildx Setup

```bash
# Create a new buildx builder with multi-platform support
docker buildx create \
  --name multiarch-builder \
  --driver docker-container \
  --platform linux/amd64,linux/arm64,linux/arm/v7 \
  --use

# Verify the builder
docker buildx inspect multiarch-builder --bootstrap

# Install QEMU for cross-architecture emulation
docker run --privileged --rm tonistiigi/binfmt --install all

# Verify QEMU interpreters are registered
ls /proc/sys/fs/binfmt_misc/

# Test multi-platform build
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag your-registry/test:latest \
  --push \
  .

# Inspect the resulting manifest
docker manifest inspect your-registry/test:latest
```

### Remote Builder for Production CI

```bash
# Set up a dedicated arm64 builder node
# This is faster than QEMU for arm64 builds

# On the ARM64 machine, expose Docker daemon
# /etc/docker/daemon.json
{
  "hosts": ["tcp://0.0.0.0:2376", "unix:///var/run/docker.sock"],
  "tls": true,
  "tlscert": "/etc/docker/tls/server-cert.pem",
  "tlskey": "/etc/docker/tls/server-key.pem",
  "tlscacert": "/etc/docker/tls/ca.pem",
  "tlsverify": true
}

# On the build machine, create a buildx builder with both nodes
docker buildx create \
  --name production-builder \
  --driver docker-container \
  --platform linux/amd64 \
  --node amd64-builder \
  --use

# Add the ARM64 node
docker buildx create \
  --append \
  --name production-builder \
  --driver docker-container \
  --platform linux/arm64 \
  --node arm64-builder \
  "tcp://arm64-host:2376" \
  --tlscacert /etc/docker/tls/ca.pem \
  --tlscert /etc/docker/tls/client-cert.pem \
  --tlskey /etc/docker/tls/client-key.pem

# Verify both nodes
docker buildx inspect production-builder
```

---

## Section 3: Dockerfile Optimization for Multi-Arch

### Go Multi-Stage Multi-Arch Dockerfile

```dockerfile
# Dockerfile
# This Dockerfile builds efficiently for both amd64 and arm64
# by using Go's native cross-compilation (no QEMU needed for the build stage)

# Build stage — always runs on the host architecture (fast)
FROM --platform=$BUILDPLATFORM golang:1.22-alpine AS builder

# BUILDPLATFORM = platform of the build machine (e.g., linux/amd64)
# TARGETPLATFORM = target platform (e.g., linux/arm64)
# TARGETOS, TARGETARCH = split from TARGETPLATFORM by Docker
ARG TARGETARCH
ARG TARGETOS
ARG TARGETPLATFORM

WORKDIR /app

# Download dependencies (cached independently of source changes)
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY . .

# Cross-compile for the target architecture
# CGO_ENABLED=0 produces a static binary — no shared libraries
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build \
    -ldflags="-s -w -X main.Version=$(git describe --tags --always 2>/dev/null || echo dev)" \
    -trimpath \
    -o /out/server \
    ./cmd/server/

# Verify the binary architecture
RUN file /out/server

# Runtime stage — built for the target architecture
FROM --platform=$TARGETPLATFORM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app

COPY --from=builder /out/server /app/server

# Use nonroot user from distroless
USER nonroot:nonroot

EXPOSE 8080 9090

ENTRYPOINT ["/app/server"]
```

### Node.js Multi-Arch Dockerfile

```dockerfile
# Dockerfile.node — Node.js with native modules
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder

ARG TARGETPLATFORM
ARG BUILDPLATFORM

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies for the target platform
# Use --platform to build native addons for target
RUN npm ci --ignore-scripts

# Copy source and build
COPY . .
RUN npm run build

# Production stage
FROM --platform=$TARGETPLATFORM node:20-alpine AS production

WORKDIR /app

# Copy package files and install production deps for target platform
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts && \
    npm rebuild   # Rebuild native modules for target arch

COPY --from=builder /app/dist ./dist

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### Python Multi-Arch with pip Wheels

```dockerfile
# Dockerfile.python — Python with compiled dependencies
FROM --platform=$BUILDPLATFORM python:3.12-slim AS builder

ARG TARGETPLATFORM
ARG TARGETARCH

WORKDIR /app

# Install build tools for the target platform
RUN apt-get update && apt-get install -y \
    gcc \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# Build wheels for the target architecture
RUN pip wheel \
    --wheel-dir=/wheels \
    --platform linux_${TARGETARCH/arm64/aarch64} \
    --python-version 312 \
    --implementation cp \
    --abi cp312 \
    -r requirements.txt 2>/dev/null || \
    pip wheel --wheel-dir=/wheels -r requirements.txt

# Runtime stage
FROM --platform=$TARGETPLATFORM python:3.12-slim

WORKDIR /app

COPY --from=builder /wheels /wheels
RUN pip install --no-index --find-links=/wheels -r /dev/stdin << 'EOF' && \
    rm -rf /wheels
$(cat requirements.txt)
EOF

COPY . .

USER nobody
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0"]
```

---

## Section 4: GitHub Actions Multi-Arch Workflow

### Standard Multi-Arch Build Workflow

```yaml
# .github/workflows/docker-multiarch.yml
name: Multi-Architecture Docker Build

on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write    # For keyless signing with cosign

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0   # Full history for git describe

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3
        with:
          platforms: arm64,arm

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
        with:
          driver-opts: |
            image=moby/buildkit:latest
            network=host

      - name: Log in to Registry
        if: github.event_name != 'pull_request'
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=semver,pattern={{major}}
            type=sha,prefix=sha-,format=short
          labels: |
            org.opencontainers.image.title=My Service
            org.opencontainers.image.vendor=Your Org

      - name: Build and push
        id: build
        uses: docker/build-push-action@v5
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          # Build args for reproducible builds
          build-args: |
            BUILD_DATE=${{ fromJSON(steps.meta.outputs.json).labels['org.opencontainers.image.created'] }}
            GIT_COMMIT=${{ github.sha }}

      - name: Sign image with cosign
        if: github.event_name != 'pull_request'
        uses: sigstore/cosign-installer@v3
        with:
          cosign-release: 'v2.2.3'
      - run: |
          cosign sign --yes ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}
        if: github.event_name != 'pull_request'
        env:
          COSIGN_EXPERIMENTAL: true

      - name: Verify multi-arch manifest
        if: github.event_name != 'pull_request'
        run: |
          docker manifest inspect ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ steps.meta.outputs.version }} | \
            jq '[.manifests[] | {arch: .platform.architecture, digest: .digest[:15]}]'
```

### Parallel Build with Native ARM64 Runners

```yaml
# .github/workflows/docker-parallel-native.yml
# Uses native ARM64 runners for maximum build speed
name: Parallel Native Multi-Arch Build

on:
  push:
    branches: [main]
    tags: ['v*']

jobs:
  build:
    strategy:
      matrix:
        include:
          - platform: linux/amd64
            runner: ubuntu-latest
          - platform: linux/arm64
            runner: ubuntu-22.04-arm   # GitHub's native ARM64 runner
    runs-on: ${{ matrix.runner }}

    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Prepare platform tag
        id: prep
        run: |
          platform=${{ matrix.platform }}
          echo "tag=${platform//\//-}" >> $GITHUB_OUTPUT

      - name: Build and push platform image
        uses: docker/build-push-action@v5
        with:
          context: .
          platforms: ${{ matrix.platform }}
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.sha }}-${{ steps.prep.outputs.tag }}
          cache-from: type=gha,scope=${{ matrix.platform }}
          cache-to: type=gha,scope=${{ matrix.platform }},mode=max

  merge:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Login to registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Create and push multi-arch manifest
        run: |
          docker buildx imagetools create \
            --tag ghcr.io/${{ github.repository }}:latest \
            --tag ghcr.io/${{ github.repository }}:${{ github.sha }} \
            ghcr.io/${{ github.repository }}:${{ github.sha }}-linux-amd64 \
            ghcr.io/${{ github.repository }}:${{ github.sha }}-linux-arm64

      - name: Inspect manifest
        run: |
          docker buildx imagetools inspect ghcr.io/${{ github.repository }}:${{ github.sha }}
```

---

## Section 5: Cross-Compilation Patterns

### Go Cross-Compilation

```makefile
# Makefile — Go multi-arch builds without QEMU

REGISTRY := ghcr.io/your-org
APP := myservice
VERSION := $(shell git describe --tags --always --dirty)

# Default: build for current platform
.PHONY: build
build:
	CGO_ENABLED=0 go build \
	  -ldflags="-s -w -X main.Version=$(VERSION)" \
	  -trimpath \
	  -o bin/$(APP) \
	  ./cmd/$(APP)/

# Build all platforms
.PHONY: build-all
build-all: build-linux-amd64 build-linux-arm64

.PHONY: build-linux-amd64
build-linux-amd64:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
	  -ldflags="-s -w -X main.Version=$(VERSION)" \
	  -trimpath \
	  -o bin/$(APP)-linux-amd64 \
	  ./cmd/$(APP)/

.PHONY: build-linux-arm64
build-linux-arm64:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build \
	  -ldflags="-s -w -X main.Version=$(VERSION)" \
	  -trimpath \
	  -o bin/$(APP)-linux-arm64 \
	  ./cmd/$(APP)/

# Docker multi-arch build using native cross-compilation
.PHONY: docker-multiarch
docker-multiarch:
	docker buildx build \
	  --platform linux/amd64,linux/arm64 \
	  --tag $(REGISTRY)/$(APP):$(VERSION) \
	  --tag $(REGISTRY)/$(APP):latest \
	  --push \
	  --build-arg VERSION=$(VERSION) \
	  .

# Verify the images
.PHONY: verify-multiarch
verify-multiarch:
	@echo "Verifying multi-arch manifest..."
	docker manifest inspect $(REGISTRY)/$(APP):$(VERSION) | \
	  jq '[.manifests[] | {arch: .platform.architecture, digest: .digest[:20]}]'
	@echo "Testing amd64 image..."
	docker run --rm --platform linux/amd64 $(REGISTRY)/$(APP):$(VERSION) --version
	@echo "Testing arm64 image (via QEMU)..."
	docker run --rm --platform linux/arm64 $(REGISTRY)/$(APP):$(VERSION) --version
```

### Go with CGO and Cross-Compilation

```dockerfile
# Dockerfile.cgo — when CGO is required (SQLite, etc.)
FROM --platform=$BUILDPLATFORM golang:1.22 AS builder

ARG TARGETARCH
ARG TARGETOS

# Install cross-compilers based on target architecture
RUN case ${TARGETARCH} in \
    "arm64") \
      apt-get update && apt-get install -y \
        gcc-aarch64-linux-gnu \
        && rm -rf /var/lib/apt/lists/* \
      ;; \
    "amd64") \
      # No cross-compiler needed when building on amd64 \
      echo "amd64 native build" \
      ;; \
  esac

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .

# Set cross-compiler based on target
RUN case ${TARGETARCH} in \
    "arm64") export CC=aarch64-linux-gnu-gcc ;; \
    "amd64") export CC=gcc ;; \
  esac && \
  CGO_ENABLED=1 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
  go build -o /out/server ./cmd/server/

FROM --platform=$TARGETPLATFORM debian:12-slim
COPY --from=builder /out/server /app/server
ENTRYPOINT ["/app/server"]
```

---

## Section 6: Kubernetes Mixed Node Pool Configuration

### Node Labeling and Architecture Detection

```bash
# View node architecture labels (set automatically by Kubernetes)
kubectl get nodes -o custom-columns=\
NAME:.metadata.name,\
ARCH:.metadata.labels.'kubernetes\.io/arch',\
OS:.metadata.labels.'kubernetes\.io/os',\
INSTANCE:.metadata.labels.'node\.kubernetes\.io/instance-type'

# Typical output:
# NAME                     ARCH    OS      INSTANCE
# node-amd64-1             amd64   linux   m7i.xlarge
# node-arm64-1             arm64   linux   m7g.xlarge
# node-arm64-2             arm64   linux   m7g.2xlarge
```

### Deployment with Architecture Preference

```yaml
# deployment-multiarch.yaml — prefers ARM64 for cost, falls back to AMD64
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-service
spec:
  replicas: 6
  selector:
    matchLabels:
      app: web-service
  template:
    metadata:
      labels:
        app: web-service
    spec:
      # Prefer ARM64 (Graviton) — cheaper per vCPU
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 80
              preference:
                matchExpressions:
                  - key: kubernetes.io/arch
                    operator: In
                    values: ["arm64"]

      # Spread across architectures for resilience
      topologySpreadConstraints:
        - maxSkew: 2
          topologyKey: kubernetes.io/arch
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: web-service
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: web-service

      containers:
        - name: web-service
          # Multi-arch image — Docker selects correct arch automatically
          image: ghcr.io/your-org/web-service:1.5.0
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
```

### Architecture-Specific Jobs

```yaml
# When you need to run on a specific architecture
apiVersion: batch/v1
kind: Job
metadata:
  name: arm64-benchmark
spec:
  template:
    spec:
      # Force ARM64 — e.g., benchmarking Graviton
      nodeSelector:
        kubernetes.io/arch: arm64

      containers:
        - name: benchmark
          image: ghcr.io/your-org/benchmark:latest
          command: ["/app/benchmark", "--arch-report"]
          resources:
            requests:
              cpu: 4
              memory: 8Gi
      restartPolicy: Never
```

### DaemonSet for Mixed Fleets

```yaml
# DaemonSets must run on ALL nodes — require multi-arch images
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-agent
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: node-agent
  template:
    metadata:
      labels:
        app: node-agent
    spec:
      tolerations:
        - operator: Exists   # Run on all nodes
      containers:
        - name: agent
          # MUST be multi-arch — runs on both amd64 and arm64 nodes
          image: ghcr.io/your-org/node-agent:1.0.0
          securityContext:
            privileged: true
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          volumeMounts:
            - name: proc
              mountPath: /host/proc
              readOnly: true
            - name: sys
              mountPath: /host/sys
              readOnly: true
      volumes:
        - name: proc
          hostPath:
            path: /proc
        - name: sys
          hostPath:
            path: /sys
      hostPID: true
      hostNetwork: true
```

---

## Section 7: Helm Chart Architecture-Aware Configuration

```yaml
# charts/my-service/values.yaml
image:
  repository: ghcr.io/your-org/my-service
  tag: "1.0.0"
  pullPolicy: IfNotPresent

# Architecture-specific defaults
architectureOverrides:
  arm64:
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: 2000m
        memory: 2Gi
  amd64:
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: 2000m
        memory: 2Gi

# Prefer ARM64 by default (cost optimization)
nodeArchPreference:
  - arm64
  - amd64
```

```yaml
# charts/my-service/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "my-service.fullname" . }}
spec:
  template:
    spec:
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            {{- range $idx, $arch := .Values.nodeArchPreference }}
            - weight: {{ sub 100 (mul $idx 30) }}
              preference:
                matchExpressions:
                  - key: kubernetes.io/arch
                    operator: In
                    values: [{{ $arch | quote }}]
            {{- end }}
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
```

---

## Section 8: Validating Multi-Arch Images

### Automated Validation Script

```bash
#!/bin/bash
# validate-multiarch.sh — validate a multi-arch image before deployment

set -euo pipefail

IMAGE="${1:-}"
if [[ -z "$IMAGE" ]]; then
  echo "Usage: $0 <image:tag>"
  exit 1
fi

echo "=== Multi-Arch Validation: $IMAGE ==="

# 1. Check manifest list
echo -n "Checking manifest list... "
MANIFEST=$(docker manifest inspect "$IMAGE" 2>/dev/null)
if [[ -z "$MANIFEST" ]]; then
  echo "FAIL: Not a valid manifest"
  exit 1
fi
echo "OK"

# 2. Check for required architectures
for arch in amd64 arm64; do
  echo -n "Checking $arch image... "
  HAS_ARCH=$(echo "$MANIFEST" | jq -r ".manifests[]? | select(.platform.architecture == \"$arch\") | .digest" | head -1)
  if [[ -z "$HAS_ARCH" ]]; then
    echo "FAIL: $arch image missing from manifest"
    exit 1
  fi
  echo "OK ($HAS_ARCH)"
done

# 3. Test each architecture (requires QEMU for arm64 on amd64 host)
for platform in linux/amd64 linux/arm64; do
  echo -n "Testing $platform... "
  if docker run --rm --platform="$platform" "$IMAGE" --version &>/dev/null || \
     docker run --rm --platform="$platform" "$IMAGE" /bin/sh -c "echo ok" &>/dev/null; then
    echo "OK"
  else
    echo "WARN: Could not run test for $platform (QEMU may not be installed)"
  fi
done

# 4. Check image sizes
echo ""
echo "Platform image sizes:"
echo "$MANIFEST" | jq -r '.manifests[]? | "\(.platform.architecture)\t\(.platform.os)\t\(.size // "N/A")"'

echo ""
echo "=== Validation passed: $IMAGE ==="
```

### CI Validation Job

```yaml
# Add to GitHub Actions workflow
  validate:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Validate multi-arch manifest
        run: |
          IMAGE="ghcr.io/${{ github.repository }}:${{ github.sha }}"

          # Check both architectures are present
          for arch in amd64 arm64; do
            DIGEST=$(docker manifest inspect "$IMAGE" | \
              jq -r ".manifests[] | select(.platform.architecture == \"$arch\") | .digest")
            if [[ -z "$DIGEST" ]]; then
              echo "ERROR: $arch image missing from manifest"
              exit 1
            fi
            echo "$arch: $DIGEST"
          done

      - name: Test amd64
        run: |
          docker run --rm --platform linux/amd64 \
            ghcr.io/${{ github.repository }}:${{ github.sha }} \
            --health-check

      - name: Test arm64
        run: |
          docker run --rm --platform linux/arm64 \
            ghcr.io/${{ github.repository }}:${{ github.sha }} \
            --health-check
```

---

## Section 9: Performance Benchmarking ARM64 vs AMD64

```go
// benchmark/main.go — compare performance across architectures
package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"runtime"
	"time"
)

type BenchmarkResult struct {
	Arch     string        `json:"arch"`
	CPU      string        `json:"cpu"`
	GoOS     string        `json:"os"`
	Tests    []TestResult  `json:"tests"`
}

type TestResult struct {
	Name      string        `json:"name"`
	Ops       int           `json:"ops"`
	Duration  time.Duration `json:"duration_ns"`
	OpsPerSec float64       `json:"ops_per_second"`
}

func main() {
	result := BenchmarkResult{
		Arch: runtime.GOARCH,
		GoOS: runtime.GOOS,
	}

	// Benchmark 1: Hashing (important for service mesh, auth)
	result.Tests = append(result.Tests, runBench("SHA256 1KB", func() {
		data := make([]byte, 1024)
		sha256.Sum256(data)
	}, 100000))

	// Benchmark 2: JSON serialization (API server workload)
	result.Tests = append(result.Tests, runBench("JSON marshal/unmarshal", func() {
		data := map[string]interface{}{
			"id": "test-123", "name": "test user",
			"email": "test@example.com", "created_at": time.Now(),
		}
		b, _ := json.Marshal(data)
		var out map[string]interface{}
		json.Unmarshal(b, &out)
	}, 100000))

	// Benchmark 3: Math (ML inference, analytics)
	result.Tests = append(result.Tests, runBench("Float64 math", func() {
		x := 3.14159
		for i := 0; i < 100; i++ {
			x = math.Sin(x) * math.Cos(x) + math.Sqrt(math.Abs(x))
		}
	}, 100000))

	// Output results
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.Encode(result)
}

func runBench(name string, fn func(), ops int) TestResult {
	start := time.Now()
	for i := 0; i < ops; i++ {
		fn()
	}
	duration := time.Since(start)
	return TestResult{
		Name:      name,
		Ops:       ops,
		Duration:  duration,
		OpsPerSec: float64(ops) / duration.Seconds(),
	}
}
```

```bash
# Run benchmark comparison
# AMD64
docker run --rm --platform linux/amd64 ghcr.io/your-org/benchmark:latest | \
  jq '{arch: .arch, tests: [.tests[] | {name: .name, ops_per_sec: (.ops_per_second | floor)}]}'

# ARM64
docker run --rm --platform linux/arm64 ghcr.io/your-org/benchmark:latest | \
  jq '{arch: .arch, tests: [.tests[] | {name: .name, ops_per_sec: (.ops_per_second | floor)}]}'
```

---

## Section 10: Common Issues and Fixes

### Debugging Architecture Issues

```bash
# Verify image architecture in pod
kubectl exec -it <pod-name> -- uname -m
# aarch64 = arm64
# x86_64 = amd64

# Check if wrong arch image was scheduled
kubectl get pod <pod-name> -o json | jq '.spec.nodeName'
kubectl get node <node-name> -o json | jq '.metadata.labels["kubernetes.io/arch"]'

# Check for ImagePullBackOff due to arch mismatch
kubectl describe pod <pod-name> | grep -A5 "Warning"

# Force pull specific architecture
docker pull --platform linux/arm64 ghcr.io/your-org/image:tag
```

### Common Errors

```bash
# Error: "exec format error"
# Cause: Binary compiled for wrong architecture was run
# Fix: Ensure Dockerfile uses --platform=$TARGETPLATFORM in runtime stage

# Error: "standard_init_linux.go:228: exec user process caused: exec format error"
# Same as above — binary arch doesn't match node arch

# Error: "no match for platform in manifest: not found"
# Cause: Image doesn't include the target architecture
# Fix: Rebuild with --platform linux/amd64,linux/arm64

# Verify QEMU is working
docker run --rm --platform linux/arm64 alpine uname -m
# Should output: aarch64

# If QEMU is not working:
docker run --privileged --rm tonistiigi/binfmt --install all
```

### Dependency Audit for ARM64 Compatibility

```bash
#!/bin/bash
# check-arm64-compat.sh — check if dependencies support ARM64

# Check Go modules for known ARM64-incompatible packages
MODULES=$(go list -m -json all | jq -r .Path)

# Known packages that historically had ARM64 issues
PROBLEMATIC=(
  "github.com/mattn/go-sqlite3"   # CGO required, needs arm64 cross-compiler
  "github.com/creack/pty"         # ARM64 support added in v1.1.18
)

echo "Checking for potentially ARM64-incompatible dependencies..."
for pkg in "${PROBLEMATIC[@]}"; do
  if echo "$MODULES" | grep -q "^${pkg}$"; then
    echo "WARNING: $pkg requires ARM64 cross-compilation setup"
  fi
done

# Check if any precompiled binaries are embedded
find . -name "*.so" -o -name "*.a" | while read f; do
  arch=$(file "$f" | grep -o "ARM\|x86")
  echo "Binary: $f -> $arch"
done
```

Multi-architecture builds have moved from an advanced feature to a baseline expectation for production container images. The combination of Go's trivial cross-compilation, Docker Buildx's multi-arch manifest support, and Kubernetes's architecture-aware scheduling makes the implementation straightforward once you understand the layer boundaries: build stage on the host, runtime stage for the target, and manifest lists to unify them.
