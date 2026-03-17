---
title: "Linux Container Image Internals: OCI Specification and Layer Management"
date: 2029-07-12T00:00:00-05:00
draft: false
tags: ["Linux", "Containers", "OCI", "Docker", "overlayfs", "Container Images", "Kubernetes"]
categories: ["Linux", "Containers", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into container image internals: OCI image specification, layer diff algorithm, union filesystems (overlayfs), image manifest structure, content-addressable storage, and layer deduplication in production."
more_link: "yes"
url: "/linux-container-image-internals-oci-spec-layer-management/"
---

Container images appear simple from the outside—just a tarball with some metadata. Under the hood, the OCI Image Specification defines a precise format that enables content-addressable storage, layer deduplication, and efficient distribution. Understanding these internals helps you build smaller images, diagnose storage issues, optimize registry bandwidth, and understand what's actually happening when a container starts.

<!--more-->

# Linux Container Image Internals: OCI Specification and Layer Management

## The OCI Image Specification

The Open Container Initiative (OCI) Image Specification (currently v1.1) defines the format for container images. An OCI image consists of three components:

1. **Image Manifest** — describes the image's configuration and layers
2. **Image Configuration** — contains runtime metadata and the diff ID chain
3. **Image Layers** — compressed tar archives of filesystem changes

### Image Manifest Structure

```json
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "config": {
    "mediaType": "application/vnd.oci.image.config.v1+json",
    "digest": "sha256:a3ed95caeb02ffe68cdd9fd84406680ae93d633cb16422d00e8a7c22955b46d4",
    "size": 7023
  },
  "layers": [
    {
      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
      "digest": "sha256:8e402f1a9c5771c4b1bfcd4938a528f4f9e3b0e0a5b2b4c1d7a5f6e8b9c1d2e3",
      "size": 31337522
    },
    {
      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
      "digest": "sha256:7b1a4c8d2e6f0123456789abcdef0123456789abcdef0123456789abcdef0123",
      "size": 1234567
    },
    {
      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
      "digest": "sha256:1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c",
      "size": 8192
    }
  ],
  "annotations": {
    "org.opencontainers.image.created": "2029-07-01T00:00:00Z",
    "org.opencontainers.image.revision": "abc1234"
  }
}
```

### Examining a Real Image Manifest

```bash
# Pull an image and inspect its manifest
docker pull nginx:1.25
docker manifest inspect nginx:1.25 | python3 -m json.tool

# Using crane (OCI-native tool)
go install github.com/google/go-containerregistry/cmd/crane@latest
crane manifest nginx:1.25 | jq .

# Inspect all layers
crane manifest nginx:1.25 | jq '.layers[] | {digest: .digest, size: .size, "size_mb": (.size/1024/1024 | floor)}'

# Get the image configuration
MANIFEST=$(crane manifest nginx:1.25)
CONFIG_DIGEST=$(echo $MANIFEST | jq -r '.config.digest')
crane blob nginx:1.25@${CONFIG_DIGEST} | jq .
```

## Image Configuration Deep Dive

The image configuration contains both build-time metadata and the diff ID chain:

```json
{
  "architecture": "amd64",
  "os": "linux",
  "config": {
    "Cmd": ["nginx", "-g", "daemon off;"],
    "Env": [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "NGINX_VERSION=1.25.3"
    ],
    "ExposedPorts": {
      "80/tcp": {}
    },
    "Labels": {
      "maintainer": "NGINX Docker Maintainers"
    },
    "StopSignal": "SIGQUIT",
    "WorkingDir": ""
  },
  "history": [
    {
      "created": "2029-07-01T00:00:00Z",
      "created_by": "/bin/sh -c #(nop) ADD file:... in /",
      "comment": "buildkit.dockerfile.v0"
    },
    {
      "created": "2029-07-01T00:00:00Z",
      "created_by": "ENV NGINX_VERSION=1.25.3",
      "empty_layer": true
    },
    {
      "created": "2029-07-01T00:00:00Z",
      "created_by": "RUN /bin/sh -c apt-get update && apt-get install -y nginx",
      "comment": "buildkit.dockerfile.v0"
    }
  ],
  "rootfs": {
    "type": "layers",
    "diff_ids": [
      "sha256:abc123...",
      "sha256:def456...",
      "sha256:789ghi..."
    ]
  }
}
```

The `diff_ids` in `rootfs` are the SHA256 digests of the **uncompressed** layer tars. This is critical: the manifest contains digests of compressed layers (for download verification), while the configuration contains digests of uncompressed layers (for the chain of trust and deduplication).

```bash
# Verify the diff_id chain manually
docker save nginx:1.25 | tar -xO '*/layer.tar' | sha256sum
# The output should match the diff_ids in the config
```

## Content-Addressable Storage

OCI images use content-addressable storage (CAS): every object is named by its cryptographic hash. This enables deduplication across images.

### How containerd Stores Layers

```bash
# containerd's content store location
ls /var/lib/containerd/io.containerd.content.v1.content/blobs/sha256/

# Each file is named by its SHA256 digest
# The file's content hash matches its filename
sha256sum /var/lib/containerd/io.containerd.content.v1.content/blobs/sha256/<digest>

# Inspect containerd content store
ctr content ls | head -20
# TYPE                                        DIGEST              SIZE    LABELS
# application/vnd.oci.image.manifest.v1+json sha256:abc...        7023    ...
# application/vnd.oci.image.config.v1+json   sha256:def...        1234    ...
# application/vnd.oci.image.layer.v1.tar+gz  sha256:789...        31337   ...

# Get a blob by digest
ctr content get sha256:<manifest_digest>
```

### Docker's Content Store

```bash
# Docker stores layers in /var/lib/docker/overlay2/
ls /var/lib/docker/overlay2/

# Each layer directory contains:
# diff/  - the layer's filesystem changes
# link   - short hash alias for path length limits
# lower  - reference to parent layer(s)
# merged/ - union mounted filesystem (only for running containers)
# work/  - overlayfs work directory

# Inspect a layer's content
ls /var/lib/docker/overlay2/<layer_id>/diff/

# See which image uses which layers
docker inspect nginx:1.25 | jq '.[0].GraphDriver'
```

## Layer Diff Algorithm

When building container images, each Dockerfile instruction that modifies the filesystem creates a new layer. Understanding how layers are computed helps optimize image size.

### What Goes Into a Layer Diff

A layer is a tar archive of:
1. **Added files** — new files with full content
2. **Modified files** — files that changed, with full new content (not delta)
3. **Deleted files** — represented as "whiteout" files

```bash
# Inspect layer contents directly
docker save nginx:1.25 -o nginx.tar
mkdir nginx-layers
tar -xf nginx.tar -C nginx-layers

# List layers in order
cat nginx-layers/manifest.json | python3 -m json.tool

# Extract and inspect a specific layer
tar -xf nginx-layers/<layer_dir>/layer.tar -C /tmp/layer-contents/
ls /tmp/layer-contents/

# Look for whiteout files (deletions)
find nginx-layers -name '.wh.*' -o -name '.wh..wh..opq'
```

### Whiteout Files

```bash
# Whiteout file naming conventions:
# .wh.<filename>           - marks <filename> as deleted in this layer
# .wh..wh..opq            - opaque whiteout: treats entire directory as new
#                           (previous contents are hidden)

# Example: layer that deletes /etc/secrets and replaces /app/
# /etc/.wh.secrets         <- deletes /etc/secrets from lower layers
# /app/.wh..wh..opq        <- opaque whiteout: hide everything in /app from below
# /app/newfile             <- only /app/newfile is visible

# Build an image that demonstrates whiteouts
cat > Dockerfile.whiteout << 'EOF'
FROM alpine:3.19

# Layer 1: create files
RUN echo "secret" > /etc/secrets && \
    echo "data" > /tmp/oldfile && \
    mkdir -p /app && echo "v1" > /app/service

# Layer 2: delete /etc/secrets and replace /app entirely
RUN rm /etc/secrets && \
    rm /tmp/oldfile
RUN rm -rf /app && mkdir /app && echo "v2" > /app/service
EOF

docker build -f Dockerfile.whiteout -t whiteout-demo .
docker save whiteout-demo | tar -x -C /tmp/wh-demo/
find /tmp/wh-demo -name '.wh*'
```

### Minimizing Layer Size

```dockerfile
# ANTI-PATTERN: Creates a large layer even though files are deleted later
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y build-essential gcc python3
RUN make -C /src install
RUN apt-get remove -y build-essential gcc python3 && apt-get autoremove -y
# The deleted files still exist in the previous layer!

# GOOD PATTERN 1: Single RUN instruction
FROM ubuntu:22.04
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential gcc python3 && \
    make -C /src install && \
    apt-get remove -y build-essential gcc python3 && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# GOOD PATTERN 2: Multi-stage build
FROM ubuntu:22.04 AS builder
RUN apt-get update && apt-get install -y build-essential
COPY . /src
RUN make -C /src install

FROM ubuntu:22.04 AS runtime
COPY --from=builder /usr/local/bin/myapp /usr/local/bin/
# Only the final binary is in the runtime image's layer
```

## Union Filesystems: overlayfs Deep Dive

Linux's overlayfs is the standard union filesystem used by containerd and Docker. It presents a unified view of multiple directory layers by overlaying them.

### overlayfs Architecture

```
Container View (merged):
  /etc/nginx/nginx.conf  <- from: read-write layer (container)
  /app/server            <- from: read-write layer (container, copied from layer 3)
  /etc/passwd            <- from: read-only layer 3
  /usr/bin/nginx         <- from: read-only layer 2
  /bin/bash              <- from: read-only layer 1
  /lib/libc.so           <- from: read-only layer 1

overlayfs mount:
  upperdir = /var/lib/containerd/.../snapshots/42/fs    (read-write, container layer)
  lowerdir = /var/lib/containerd/.../snapshots/41/fs:   (layer 3)
             /var/lib/containerd/.../snapshots/23/fs:   (layer 2)
             /var/lib/containerd/.../snapshots/7/fs     (layer 1)
  workdir  = /var/lib/containerd/.../snapshots/42/work  (required by overlayfs)
  merged   = /run/containerd/.../<container-id>/rootfs  (container's view)
```

### Examining overlayfs Mounts

```bash
# View all overlayfs mounts
mount | grep overlay
# overlay on /run/containerd/.../rootfs type overlay
#   (rw,relatime,lowerdir=.../41/fs:.../23/fs:.../7/fs,
#    upperdir=.../42/fs,workdir=.../42/work)

# More detailed view
findmnt -t overlay -o TARGET,SOURCE,OPTIONS

# Inspect a running container's overlayfs
CONTAINER_ID=$(docker ps -q -f name=nginx)
docker inspect ${CONTAINER_ID} | jq '.[0].GraphDriver.Data'
# {
#   "LowerDir": "/var/lib/docker/overlay2/.../diff:...",
#   "MergedDir": "/var/lib/docker/overlay2/.../merged",
#   "UpperDir": "/var/lib/docker/overlay2/.../diff",
#   "WorkDir": "/var/lib/docker/overlay2/.../work"
# }

# Look at the upper layer (container's changes)
ls /var/lib/docker/overlay2/$(docker inspect ${CONTAINER_ID} | \
  jq -r '.[0].GraphDriver.Data.UpperDir | split("/")[-2]')/diff
```

### Copy-on-Write Behavior

When a container modifies a file from a lower layer:

```bash
# Start a container and modify a file
docker run --name overlay-demo -d nginx:1.25
docker exec overlay-demo sh -c "echo 'modified' >> /etc/nginx/nginx.conf"

# Find the container's upper layer
UPPER=$(docker inspect overlay-demo | jq -r '.[0].GraphDriver.Data.UpperDir')

# The modified file is now in the upper layer
ls -la ${UPPER}/etc/nginx/
# nginx.conf <- the copy-on-write copy, now in upper layer

# The original is still intact in the lower layer
cat /var/lib/docker/overlay2/.../diff/etc/nginx/nginx.conf
```

### overlayfs Kernel Parameters

```bash
# Check overlayfs module parameters
ls /sys/module/overlay/parameters/

# metacopy: only copy metadata on CoW, not full file (kernel 4.19+)
# Improves performance for writes that only change metadata (chmod, chown)
cat /sys/module/overlay/parameters/metacopy

# redirect_dir: enable directory rename optimization (kernel 4.10+)
cat /sys/module/overlay/parameters/redirect_dir

# Check kernel feature support
grep -E "OVERLAY|CONFIG_OVERLAY" /boot/config-$(uname -r)

# Performance-oriented mount options
# index=on: hardlink support in overlay
# nfs_export=on: NFS export support (needed for some K8s storage drivers)
mount -t overlay overlay \
  -o lowerdir=/lower,upperdir=/upper,workdir=/work,metacopy=on,redirect_dir=on \
  /merged
```

### overlayfs Performance Characteristics

```bash
# Benchmark overlayfs vs native filesystem
# Install fio
apt-get install -y fio

# Test 1: Sequential write performance in container
docker run --rm -v /tmp:/bench alpine sh -c \
  "apk add fio && fio --name=test --ioengine=libaio --rw=write \
   --bs=1M --size=1G --numjobs=1 --runtime=30 --filename=/bench/test.dat \
   --output-format=json" | jq '.jobs[0].write.bw'

# Test 2: Random read (benefits from page cache, overlayfs transparent)
docker run --rm alpine sh -c \
  "dd if=/dev/zero of=/tmp/test bs=4k count=1000000 2>&1 | tail -1"

# Common overlayfs performance bottleneck: too many lower layers
# Each file lookup traverses all lower layers in order
# Recommendation: merge layers during image build
# Check layer count:
docker inspect nginx:1.25 | jq '.[0].RootFS.Layers | length'
```

## Layer Deduplication in Practice

Content-addressable storage means identical layers are stored only once, regardless of how many images reference them.

### Checking Deduplication

```bash
# See how much space is being shared vs unique per image
docker system df -v

# Example output:
# Images space usage:
# REPOSITORY   TAG    IMAGE ID     CREATED      SIZE    SHARED SIZE   UNIQUE SIZE
# nginx        1.25   a6bd71f48f   2 weeks ago  192MB   133MB         59MB
# nginx        1.24   e784f43...   3 months ago 187MB   133MB         54MB
# myapp        latest f123abc...   1 day ago    245MB   192MB         53MB

# The "SHARED SIZE" represents layers shared with other images
# nginx:1.24 and nginx:1.25 share the base Debian layer (133MB)

# Inspect which layers are shared between two images
diff \
  <(docker inspect nginx:1.24 | jq -r '.[0].RootFS.Layers[]') \
  <(docker inspect nginx:1.25 | jq -r '.[0].RootFS.Layers[]')
```

### Building for Maximum Layer Reuse

```dockerfile
# Order Dockerfile instructions from least-to-most-frequently changing
# Stable layers first = more cache hits = fewer bytes to transfer

FROM golang:1.22-alpine AS builder

# Layer 1: System deps (changes rarely - maybe once a month)
RUN apk add --no-cache git ca-certificates

# Layer 2: Go module dependencies (changes when go.mod changes)
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

# Layer 3: Application source (changes every commit)
COPY . .
RUN CGO_ENABLED=0 go build -o /app/server ./cmd/server

FROM alpine:3.19 AS runtime

# Layer 4: Runtime deps (changes rarely)
RUN apk add --no-cache ca-certificates tzdata

# Layer 5: Application binary (changes every build)
COPY --from=builder /app/server /app/server

ENTRYPOINT ["/app/server"]
```

### Layer Squashing

Sometimes you want to merge all layers into one (reducing the number of overlayfs lower dirs):

```bash
# Using Docker's --squash flag (experimental)
docker build --squash -t myapp:squashed .

# Using crane to flatten
crane flatten nginx:1.25 -t nginx:1.25-flat

# Compare layer counts
docker inspect nginx:1.25 | jq '[.[0].RootFS.Layers | length]'
docker inspect nginx:1.25-flat | jq '[.[0].RootFS.Layers | length]'

# When to squash:
# - Security: removes deleted secrets from lower layers
# - Performance: very deep layer stacks (>125 layers, overlayfs limit)
# - Distribution: single layer = simpler transfer for small registries
#
# When NOT to squash:
# - Shared base layers (you lose deduplication)
# - Frequent rebuilds (squash can't be cached)
```

## OCI Distribution Specification and Registry Interactions

The OCI Distribution Spec defines how images are pushed and pulled from registries.

### Pull Process Step by Step

```bash
# Manual pull using the OCI distribution API
REGISTRY="registry-1.docker.io"
REPO="library/nginx"
TAG="1.25"
TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${REPO}:pull" | jq -r '.token')

# Step 1: Fetch manifest
MANIFEST=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/vnd.oci.image.manifest.v1+json" \
  "https://${REGISTRY}/v2/${REPO}/manifests/${TAG}")
echo $MANIFEST | jq '.'

# Step 2: Fetch config blob
CONFIG_DIGEST=$(echo $MANIFEST | jq -r '.config.digest')
curl -s -H "Authorization: Bearer ${TOKEN}" \
  "https://${REGISTRY}/v2/${REPO}/blobs/${CONFIG_DIGEST}" | jq '.'

# Step 3: Fetch each layer (normally done in parallel)
echo $MANIFEST | jq -r '.layers[].digest' | while read DIGEST; do
  echo "Downloading layer: ${DIGEST}"
  curl -s -H "Authorization: Bearer ${TOKEN}" \
    "https://${REGISTRY}/v2/${REPO}/blobs/${DIGEST}" \
    -o "/tmp/layer-${DIGEST##sha256:}.tar.gz"
  echo "Downloaded: $(wc -c < /tmp/layer-${DIGEST##sha256:}.tar.gz) bytes"
done
```

### Resumable Layer Uploads

```bash
# OCI Distribution Spec: resumable blob upload
# Useful for large layers in CI/CD

REGISTRY="myregistry.example.com"
REPO="myapp"

# Initiate an upload
UPLOAD_URL=$(curl -s -i -X POST \
  "https://${REGISTRY}/v2/${REPO}/blobs/uploads/" \
  | grep Location | awk '{print $2}' | tr -d '\r')

echo "Upload URL: ${UPLOAD_URL}"

# Upload the layer (monolithic for layers < 5GB)
LAYER_FILE="layer.tar.gz"
DIGEST="sha256:$(sha256sum ${LAYER_FILE} | awk '{print $1}')"
LAYER_SIZE=$(wc -c < ${LAYER_FILE})

curl -X PUT \
  "${UPLOAD_URL}&digest=${DIGEST}" \
  -H "Content-Type: application/octet-stream" \
  -H "Content-Length: ${LAYER_SIZE}" \
  --data-binary @${LAYER_FILE}
```

## Analyzing Image Security with Layer Inspection

Understanding layers is essential for container security:

```bash
# Scan for secrets accidentally left in layers
# Even if deleted in a later layer, they exist in the image

# Flatten all layers and scan
docker save myapp:latest | \
  tar -x -O '*/layer.tar' | \
  tar -x | \
  grep -r "password\|secret\|private_key\|AWS_SECRET" --include="*.conf" --include="*.env" --include="*.json"

# Using dive for layer-by-layer analysis
docker run --rm -it \
  -v /var/run/docker.sock:/var/run/docker.sock \
  wagoodman/dive:latest nginx:1.25

# Trivy for vulnerability scanning per layer
trivy image --format json nginx:1.25 | \
  jq '.Results[] | {Layer: .Target, Vulnerabilities: [.Vulnerabilities[] | select(.Severity == "HIGH" or .Severity == "CRITICAL") | .VulnerabilityID]}'

# Find which layer introduced a vulnerability
trivy image --format json nginx:1.25 | \
  jq '.Results[] | select(.Vulnerabilities != null) | {layer: .Target, count: (.Vulnerabilities | length)}'
```

## BuildKit Internals

BuildKit is the modern Docker build engine. Understanding its internals helps optimize builds:

```bash
# Enable BuildKit
export DOCKER_BUILDKIT=1

# BuildKit uses a content-addressable build cache
# Located at: /var/lib/buildkit/
ls /var/lib/buildkit/

# Inspect BuildKit cache
buildctl debug workers
buildctl debug info

# Export BuildKit cache for CI/CD
docker buildx build \
  --cache-from type=registry,ref=myregistry/myapp:cache \
  --cache-to type=registry,ref=myregistry/myapp:cache,mode=max \
  -t myregistry/myapp:latest .

# Local cache export
docker buildx build \
  --cache-from type=local,src=/tmp/buildcache \
  --cache-to type=local,dest=/tmp/buildcache,mode=max \
  -t myapp:latest .
```

### BuildKit Cache Mounts

```dockerfile
# syntax=docker/dockerfile:1.6

FROM golang:1.22-alpine

# Mount Go module cache - persists between builds without becoming a layer
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    go build -o /app/server ./...

# Mount apt cache - faster package installs
RUN --mount=type=cache,target=/var/cache/apt \
    --mount=type=cache,target=/var/lib/apt \
    apt-get update && apt-get install -y build-essential

# Secret mount - available during build, never in any layer
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm install
```

## Image Index for Multi-Architecture Support

```json
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.index.v1+json",
  "manifests": [
    {
      "mediaType": "application/vnd.oci.image.manifest.v1+json",
      "digest": "sha256:amd64digest...",
      "size": 1234,
      "platform": {
        "architecture": "amd64",
        "os": "linux"
      }
    },
    {
      "mediaType": "application/vnd.oci.image.manifest.v1+json",
      "digest": "sha256:arm64digest...",
      "size": 1235,
      "platform": {
        "architecture": "arm64",
        "os": "linux",
        "variant": "v8"
      }
    }
  ]
}
```

```bash
# Build and push multi-arch image
docker buildx create --name multiarch --driver docker-container --use
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --push \
  -t myregistry/myapp:latest .

# Inspect the multi-arch manifest
crane manifest myregistry/myapp:latest | jq '.manifests[] | {platform: .platform, digest: .digest}'

# Pull a specific architecture
docker pull --platform linux/arm64 myregistry/myapp:latest
```

## Summary

Container image internals matter for production operations:

1. **OCI Manifest** contains compressed layer digests for transfer verification; image config contains uncompressed diff_ids for the chain of trust
2. **Content-addressable storage** enables layer deduplication — identical layers across images are stored only once
3. **overlayfs** implements union filesystem semantics with copy-on-write, mapping directly to the layer stack in the image manifest
4. **Whiteout files** represent deletions in the diff algorithm — deleted files are hidden but still exist in lower layers (affecting image size)
5. **Layer ordering** in Dockerfiles dramatically affects build caching and registry bandwidth — stable dependencies first
6. **BuildKit cache mounts** allow build-time caches that never become image layers

Understanding this stack enables you to build smaller images (layer squashing, proper ordering), debug storage issues (overlayfs mount inspection), analyze security (layer-by-layer scanning), and optimize CI/CD (BuildKit cache strategies).
