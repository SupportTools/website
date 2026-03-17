---
title: "Kubernetes Multi-Architecture Builds: ARM64 and AMD64 Manifests with Buildx"
date: 2029-03-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Docker", "ARM64", "Buildx", "CI/CD", "Multi-Architecture"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to building multi-architecture container images for Kubernetes using Docker Buildx, covering QEMU emulation, native ARM64 build nodes, manifest lists, CI pipeline integration, and node affinity for mixed-arch clusters."
more_link: "yes"
url: "/kubernetes-multi-architecture-builds-arm64-amd64-buildx-deep-dive/"
---

AWS Graviton, Google Axion, and Ampere Altra processors offer 20–40% better price-performance than x86-64 for many Kubernetes workloads. Running mixed ARM64/AMD64 node pools requires container images published as multi-architecture manifest lists—a single image tag that resolves to the correct architecture automatically.

Docker Buildx with the `docker-container` driver provides the tooling to build and publish these manifest lists. This guide covers the complete workflow from Dockerfile optimization for multi-arch builds through CI pipeline configuration, with attention to the performance tradeoffs between QEMU emulation and native ARM64 build nodes.

<!--more-->

## Understanding Multi-Architecture Image Manifests

A container image is not a single binary artifact. The OCI image specification defines two manifest types:

- **Image manifest**: Points to layers and a config blob for a single platform.
- **Image index (manifest list)**: Points to multiple image manifests, each tagged with a platform descriptor (`os`, `arch`, `variant`).

When a container runtime pulls `registry.example.com/api:v2.1.0`, it requests the manifest, detects that it is an index, and selects the matching platform entry.

```bash
# Inspect a multi-arch manifest
docker buildx imagetools inspect registry.example.com/api:v2.1.0

# Example output:
# Name:      registry.example.com/api:v2.1.0
# MediaType: application/vnd.oci.image.index.v1+json
# Digest:    sha256:abc123...
#
# Manifests:
#   Name:      registry.example.com/api:v2.1.0@sha256:def456...
#   MediaType: application/vnd.oci.image.manifest.v1+json
#   Platform:  linux/amd64
#
#   Name:      registry.example.com/api:v2.1.0@sha256:ghi789...
#   MediaType: application/vnd.oci.image.manifest.v1+json
#   Platform:  linux/arm64/v8
```

---

## Build Strategy Selection

Two strategies exist for building ARM64 images on AMD64 CI infrastructure:

| Strategy | Build Time | Quality | Infrastructure Cost |
|----------|-----------|---------|---------------------|
| QEMU emulation | 3–10x slower | Identical binary | No extra nodes |
| Native ARM64 nodes | 1x | Identical binary | ARM64 build node |
| Cross-compilation (CGO-free Go) | ~1x | Identical binary | No extra nodes |

For Go services with `CGO_ENABLED=0`, cross-compilation is the optimal strategy: build once with `GOOS=linux GOARCH=arm64` and copy the binary into a minimal base image. QEMU emulation is needed only for CGO-dependent builds or builds that run architecture-specific test suites during the image build.

---

## Setting Up Buildx

```bash
# Create a builder with the docker-container driver
docker buildx create \
  --name multiarch-builder \
  --driver docker-container \
  --driver-opt network=host \
  --driver-opt image=moby/buildkit:v0.14.0 \
  --use

# Bootstrap the builder
docker buildx inspect --bootstrap

# Verify available platforms
docker buildx ls
# NAME/NODE             DRIVER/ENDPOINT  STATUS  BUILDKIT PLATFORMS
# multiarch-builder *   docker-container running v0.14.0  linux/amd64, linux/arm64, linux/arm/v7
```

For QEMU emulation, install the binfmt-misc handlers:

```bash
docker run --privileged --rm tonistiigi/binfmt --install all
# This installs qemu-user-static handlers for all supported architectures.
# Verify:
ls /proc/sys/fs/binfmt_misc/ | grep qemu
# qemu-aarch64
# qemu-arm
# qemu-s390x
```

---

## Optimized Multi-Stage Dockerfile

The key to fast multi-arch builds for Go services is separating the compilation stage (which uses cross-compilation) from the runtime stage (which uses a native base image):

```dockerfile
# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM golang:1.22-alpine AS builder

# TARGETPLATFORM and BUILDPLATFORM are injected by Buildx.
# TARGETOS and TARGETARCH are derived from TARGETPLATFORM.
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
ARG VERSION=dev
ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown

WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/root/go/pkg/mod \
    go mod download

COPY . .

# Cross-compile for the target architecture.
# The build happens on the host architecture (BUILDPLATFORM),
# producing a binary for TARGETOS/TARGETARCH.
RUN --mount=type=cache,target=/root/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 \
    GOOS=${TARGETOS} \
    GOARCH=${TARGETARCH} \
    GOARM=${TARGETVARIANT##v} \
    go build \
      -trimpath \
      -ldflags="-s -w \
        -X main.Version=${VERSION} \
        -X main.GitCommit=${GIT_COMMIT} \
        -X main.BuildDate=${BUILD_DATE}" \
      -o /out/api \
      ./cmd/api

# Verify the binary matches the target architecture
RUN file /out/api


# Final stage: use native base image for the target platform
FROM --platform=$TARGETPLATFORM gcr.io/distroless/static-debian12:nonroot

LABEL org.opencontainers.image.title="acme-api"
LABEL org.opencontainers.image.source="https://github.com/acme/api"
LABEL org.opencontainers.image.revision="${GIT_COMMIT}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"

COPY --from=builder /out/api /api
COPY --from=builder /src/config/defaults.yaml /etc/api/defaults.yaml

USER nonroot:nonroot
EXPOSE 8080 9090
ENTRYPOINT ["/api"]
```

The `--platform=$BUILDPLATFORM` on the builder stage ensures the Go compiler runs natively (no emulation). Only the final `COPY --from=builder` switches to the target platform's base image.

---

## Building and Pushing Multi-Arch Images

```bash
# Build for both architectures and push to registry
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --builder multiarch-builder \
  --build-arg VERSION=2.1.0 \
  --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
  --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --tag registry.example.com/api:2.1.0 \
  --tag registry.example.com/api:latest \
  --push \
  .

# Verify the manifest list was created correctly
docker buildx imagetools inspect registry.example.com/api:2.1.0
```

For local testing without pushing:

```bash
# Load only the current platform into the local Docker daemon
docker buildx build \
  --platform linux/amd64 \
  --builder multiarch-builder \
  --tag registry.example.com/api:dev \
  --load \
  .
```

---

## GitHub Actions CI Pipeline

```yaml
# .github/workflows/build-multiarch.yml
name: Build Multi-Architecture Image

on:
  push:
    tags:
      - "v*.*.*"
  pull_request:
    branches: [main]

env:
  REGISTRY: registry.example.com
  IMAGE_NAME: api

jobs:
  build:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3
        with:
          platforms: linux/arm64

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
        with:
          version: v0.14.0
          driver-opts: |
            image=moby/buildkit:v0.14.0
            network=host

      - name: Log in to registry
        if: github.event_name != 'pull_request'
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ secrets.REGISTRY_USERNAME }}
          password: ${{ secrets.REGISTRY_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha,prefix=,suffix=,format=short
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          build-args: |
            VERSION=${{ github.ref_name }}
            GIT_COMMIT=${{ github.sha }}
            BUILD_DATE=${{ github.event.repository.updated_at }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: true
          sbom: true
```

The `cache-from: type=gha` and `cache-to: type=gha,mode=max` directives use GitHub Actions cache for BuildKit layer caching, significantly reducing build times on repeated builds.

---

## Native ARM64 Build Nodes

For CGO-dependent builds, QEMU emulation is too slow. Use native ARM64 runners:

```yaml
# GitHub Actions with ARM64 native runner (requires GitHub-hosted ARM64 runners
# or self-hosted runners on Graviton/Axion instances)
jobs:
  build-amd64:
    runs-on: ubuntu-24.04    # x86-64
    steps:
      - uses: actions/checkout@v4
      - name: Build AMD64
        uses: docker/build-push-action@v5
        with:
          platforms: linux/amd64
          outputs: type=image,push-by-digest=true,name-canonical=true,push=true
          tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}

  build-arm64:
    runs-on: ubuntu-24.04-arm  # ARM64 native runner
    steps:
      - uses: actions/checkout@v4
      - name: Build ARM64
        uses: docker/build-push-action@v5
        with:
          platforms: linux/arm64
          outputs: type=image,push-by-digest=true,name-canonical=true,push=true
          tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}

  merge:
    runs-on: ubuntu-24.04
    needs: [build-amd64, build-arm64]
    steps:
      - name: Merge into manifest list
        uses: docker/build-push-action@v5
        with:
          push: true
          tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
```

---

## Kubernetes Node Affinity for Mixed-Arch Clusters

With multi-arch images, workloads can run on any node. Explicit affinity rules direct cost-sensitive workloads to ARM64 nodes:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  replicas: 6
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 80
              preference:
                matchExpressions:
                  - key: kubernetes.io/arch
                    operator: In
                    values: [arm64]
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: kubernetes.io/arch
                    operator: In
                    values: [amd64, arm64]
      containers:
        - name: api
          image: registry.example.com/api:2.1.0
          resources:
            requests:
              cpu: "250m"
              memory: "256Mi"
            limits:
              cpu: "1000m"
              memory: "512Mi"
```

The `preferredDuringScheduling` rule with weight 80 directs 80% of pods to ARM64 nodes when available, falling back to AMD64 without failing the deployment.

---

## Verifying Architecture at Runtime

```bash
# Check which architecture a running pod is using
kubectl exec -it api-server-abc123 -n production -- uname -m
# aarch64  (ARM64)
# or
# x86_64   (AMD64)

# Check the node labels
kubectl get nodes -L kubernetes.io/arch
# NAME               STATUS  ROLES   AGE   VERSION   ARCH
# ip-10-0-1-50       Ready   <none>  12d   v1.30.2   arm64
# ip-10-0-1-51       Ready   <none>  12d   v1.30.2   arm64
# ip-10-0-2-50       Ready   <none>  12d   v1.30.2   amd64

# Verify pod distribution
kubectl get pods -n production -o wide | awk '{print $7}' | sort | uniq -c
```

---

## Troubleshooting Common Issues

### Issue: `exec format error` on Container Start

The container runtime selected the wrong architecture manifest entry, or the registry does not serve the manifest index correctly.

```bash
# Check if the image is actually a manifest list
docker manifest inspect registry.example.com/api:2.1.0 2>&1 | head -5
# If it returns a single-arch manifest, the push did not create a manifest list.
# Re-push with --push (not --load).
```

### Issue: Build Fails with QEMU Segfault

Some packages (notably those with complex build scripts) fail under QEMU due to kernel version mismatches between the runner and the QEMU-emulated environment.

```bash
# Pin to a specific kernel version in the builder image
docker buildx create \
  --name multiarch-builder \
  --driver docker-container \
  --driver-opt image=moby/buildkit:v0.14.0 \
  --platform linux/amd64,linux/arm64 \
  --use

# Or use native ARM64 runners for affected packages.
```

---

## Summary

Multi-architecture Kubernetes deployments require multi-architecture images. The recommended workflow:

1. Use `--platform=$BUILDPLATFORM` in the builder stage to compile natively regardless of target architecture.
2. For CGO-free Go services, use `GOOS`/`GOARCH` cross-compilation; the binary is identical to a native build.
3. Use GitHub Actions cache with BuildKit for fast incremental CI builds.
4. For CGO-dependent services, provision native ARM64 build nodes and merge digests into a manifest list in a final merge step.
5. Use `preferredDuringScheduling` node affinity to direct cost-optimized workloads to ARM64 nodes while maintaining `amd64` as a fallback.

The combined result is a single image tag that works on any architecture, with CI build times under 5 minutes for Go services, and 20-40% compute cost reduction by leveraging ARM64 node pools.
