---
title: "Linux Containers Without Docker: nerdctl, podman, and buildah"
date: 2029-08-11T00:00:00-05:00
draft: false
tags: ["Containers", "Linux", "podman", "nerdctl", "buildah", "containerd", "OCI"]
categories: ["Containers", "Linux"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to running and building Linux containers without Docker: nerdctl with containerd, podman rootless containers, buildah for Dockerfile and Containerfile builds, OCI compliance, and Kubernetes integration patterns."
more_link: "yes"
url: "/linux-containers-without-docker-nerdctl-podman-buildah/"
---

Docker the CLI is not the same as Docker the container runtime. Many production Kubernetes clusters already run containerd or CRI-O as the container runtime — Docker is nowhere in sight. This post covers the tools that let you work with OCI containers natively: nerdctl for a Docker-compatible CLI against containerd, podman for rootless container execution, and buildah for reproducible image builds without a daemon.

<!--more-->

# Linux Containers Without Docker: nerdctl, podman, and buildah

## Section 1: Why Move Away from Docker?

Docker Desktop changed its licensing for enterprise use. More importantly, Docker's architecture — a root daemon that all commands talk to — conflicts with security posture goals in modern environments:

- **Security**: Docker daemon runs as root; a socket exposure = full container escape
- **Rootless containers**: Running containers without root requires additional configuration in Docker; it is the default in podman
- **Kubernetes alignment**: Kubernetes dropped dockershim; production clusters use containerd or CRI-O directly
- **CI/CD**: Docker-in-Docker (DinD) is complex and slow; rootless podman/buildah eliminates the need for privileged builds

The OCI (Open Container Initiative) standardizes the image format and runtime interface. All three tools (Docker, podman, nerdctl) read and write the same image format, making migration transparent.

## Section 2: nerdctl — Docker CLI for containerd

nerdctl provides a Docker-compatible command-line interface for containerd. It is the natural choice for developers who want the same CLI experience while running against the same containerd that Kubernetes uses.

### Installing nerdctl

```bash
# Install containerd (if not already present)
sudo apt-get install -y containerd

# Install nerdctl (full bundle includes CNI, BuildKit)
NERDCTL_VERSION=1.7.6
curl -L https://github.com/containerd/nerdctl/releases/download/v${NERDCTL_VERSION}/nerdctl-full-${NERDCTL_VERSION}-linux-amd64.tar.gz \
    | sudo tar xz -C /usr/local

# Install nerdctl only (minimal)
curl -L https://github.com/containerd/nerdctl/releases/download/v${NERDCTL_VERSION}/nerdctl-${NERDCTL_VERSION}-linux-amd64.tar.gz \
    | sudo tar xz -C /usr/local/bin

# Verify installation
nerdctl --version
nerdctl info

# Enable containerd service
sudo systemctl enable --now containerd
```

### Basic Container Operations

```bash
# Pull and run — same syntax as Docker
nerdctl pull nginx:1.25
nerdctl run -d --name web -p 8080:80 nginx:1.25
nerdctl ps
nerdctl logs web
nerdctl exec -it web bash
nerdctl stop web
nerdctl rm web

# Images
nerdctl images
nerdctl image inspect nginx:1.25
nerdctl rmi nginx:1.25

# Volumes
nerdctl volume create mydata
nerdctl run -v mydata:/data ubuntu ls /data

# Networks
nerdctl network create mynet
nerdctl run --network mynet --name svc1 nginx:1.25
nerdctl run --network mynet --name svc2 curlimages/curl curl http://svc1
```

### Building Images with nerdctl + BuildKit

```bash
# BuildKit is included in the full nerdctl bundle
# Start the BuildKit daemon
sudo systemctl enable --now buildkit

# Build using Dockerfile
nerdctl build -t myapp:v1.0 -f Dockerfile .

# Build with build args
nerdctl build \
    --build-arg GO_VERSION=1.22 \
    --build-arg APP_VERSION=1.0.0 \
    -t myapp:v1.0 \
    .

# Multi-platform build (requires qemu-user-static)
sudo apt-get install qemu-user-static
nerdctl build --platform linux/amd64,linux/arm64 -t myapp:v1.0 .

# Push to registry
nerdctl login registry.internal
nerdctl push registry.internal/myapp:v1.0
```

### nerdctl Namespace Isolation

containerd uses namespaces to isolate resources. Kubernetes uses the `k8s.io` namespace.

```bash
# List containers in all namespaces
nerdctl --namespace k8s.io ps

# List images that Kubernetes sees
nerdctl --namespace k8s.io images

# Run a container in the k8s.io namespace (useful for debugging)
nerdctl --namespace k8s.io run -it --rm ubuntu:22.04 bash

# Set default namespace
export CONTAINERD_NAMESPACE=k8s.io
nerdctl ps
```

### Compose Support

```bash
# nerdctl includes a compose implementation
# docker-compose.yml works as-is
nerdctl compose up -d
nerdctl compose ps
nerdctl compose logs -f api
nerdctl compose down

# Example docker-compose.yml
cat > docker-compose.yml << 'EOF'
version: "3.9"
services:
  api:
    image: myapp:v1.0
    ports:
      - "8080:8080"
    environment:
      - DATABASE_URL=postgres://db:5432/mydb
    depends_on:
      - db
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      - POSTGRES_PASSWORD=secret
volumes:
  pgdata:
EOF
nerdctl compose up -d
```

## Section 3: podman — Rootless Containers

podman is a daemonless container engine that runs containers as the current user. It is the primary container tool on RHEL/Fedora and is increasingly popular in security-conscious environments.

### Installing podman

```bash
# Debian/Ubuntu
sudo apt-get install -y podman uidmap slirp4netns fuse-overlayfs

# RHEL/Fedora
sudo dnf install -y podman

# Verify rootless support
podman info | grep -A5 rootless
sysctl kernel.unprivileged_userns_clone   # must be 1
```

### Rootless Container Architecture

```bash
# Rootless mode uses user namespaces
# Your UID becomes root (0) inside the container
id
# uid=1000(mmattox) gid=1000(mmattox)

podman run --rm alpine id
# uid=0(root) gid=0(root)  ← root inside, but mapped to uid=1000 on host

# No daemon — podman is a regular process
ps aux | grep podman
# Shows the container process directly, not a daemon

# Storage is in the user's home directory
ls ~/.local/share/containers/storage/
```

### Running Containers Rootlessly

```bash
# All standard operations work rootlessly
podman pull nginx:1.25
podman run -d --name web -p 8080:80 nginx:1.25

# Port binding < 1024 requires rootless workaround or sysctl
echo "net.ipv4.ip_unprivileged_port_start=80" | sudo tee /etc/sysctl.d/50-podman-ports.conf
sudo sysctl -p /etc/sysctl.d/50-podman-ports.conf

# Or use port 8080 and add the pod to the host network
podman run -d --network host -p 80:80 nginx:1.25

# Mount host directories
podman run -v /home/mmattox/data:/data:Z ubuntu ls /data
# :Z relabels the directory for SELinux compatibility
# :z (shared) or :Z (private) are important on SELinux-enabled systems
```

### Podman Pods — Kubernetes-Like Grouping

```bash
# Create a pod (shares network namespace like a Kubernetes pod)
podman pod create --name myapp -p 8080:80

# Add containers to the pod
podman run -d --pod myapp --name nginx nginx:1.25
podman run -d --pod myapp --name sidecar prom/nginx-prometheus-exporter

# List pods
podman pod list
podman pod inspect myapp

# Generate Kubernetes YAML from a running pod
podman generate kube myapp > myapp-pod.yaml

# Apply the generated YAML to Kubernetes (with minor adjustments)
kubectl apply -f myapp-pod.yaml
```

### Podman Generate Kube — From Dev to Kubernetes

```bash
# Run your app locally with podman
podman run -d \
    --name api-server \
    -e DATABASE_URL=postgres://db/mydb \
    -e LOG_LEVEL=info \
    -p 8080:8080 \
    registry.internal/myapp:v1.0

# Export to Kubernetes YAML
podman generate kube api-server --service > api-server-k8s.yaml

# The generated YAML includes:
# - Pod spec with container definition
# - Environment variables
# - Port mappings as containerPorts
# - A Service (with --service flag)

# Review and apply
cat api-server-k8s.yaml
kubectl apply -f api-server-k8s.yaml
```

### systemd Integration — Running Containers as Services

```bash
# Generate a systemd unit file for a container
podman generate systemd --name web --files --restart-policy=always

# This creates container-web.service
cat container-web.service

# Install as a user service (rootless)
mkdir -p ~/.config/systemd/user
mv container-web.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now container-web

# Check status
systemctl --user status container-web

# For system-level containers (root)
sudo mv container-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now container-web
```

### Quadlet — Modern Podman systemd Integration

```bash
# Quadlet is the modern approach (podman 4.4+)
# Create a .container file in ~/.config/containers/systemd/

mkdir -p ~/.config/containers/systemd

cat > ~/.config/containers/systemd/web.container << 'EOF'
[Unit]
Description=Nginx Web Server
After=network-online.target

[Container]
Image=nginx:1.25
PublishPort=8080:80
Volume=/home/mmattox/www:/usr/share/nginx/html:ro
Environment=NGINX_HOST=example.com
AutoUpdate=registry

[Service]
Restart=always

[Install]
WantedBy=default.target
EOF

# Reload and start
systemctl --user daemon-reload
systemctl --user start web
systemctl --user status web

# Quadlet generates the unit file automatically from the .container spec
# Auto-updates can be triggered by:
podman auto-update
```

## Section 4: buildah — Dockerfile and Script-Based Image Builds

buildah builds OCI images without requiring a running daemon. It can build from Dockerfiles/Containerfiles or from scratch using shell commands.

### Installing buildah

```bash
# Debian/Ubuntu
sudo apt-get install -y buildah

# RHEL/Fedora
sudo dnf install -y buildah

# Verify
buildah --version
buildah info
```

### Building from Dockerfile

```bash
# Same as docker build
buildah bud -t myapp:v1.0 -f Dockerfile .

# Multi-stage builds work natively
buildah bud -t myapp:v1.0 .

# Build without caching
buildah bud --no-cache -t myapp:v1.0 .

# Build and push to registry
buildah bud -t registry.internal/myapp:v1.0 .
buildah push registry.internal/myapp:v1.0
```

### Script-Based Image Construction

buildah's native API lets you build images without any Dockerfile — useful for complex build logic.

```bash
#!/bin/bash
# build-app.sh — Build a Go application image without Dockerfile
set -euo pipefail

APP_VERSION="${1:-latest}"
IMAGE_NAME="registry.internal/myapp:${APP_VERSION}"

echo "=== Building ${IMAGE_NAME} ==="

# Create a working container from a base image
ctr=$(buildah from golang:1.22-bookworm)

# Set metadata
buildah config --author "support.tools" "$ctr"
buildah config --label "version=${APP_VERSION}" "$ctr"

# Mount the container filesystem
mnt=$(buildah mount "$ctr")

# Copy source code
cp -r ./src/* "${mnt}/app/"

# Run the Go build inside the container filesystem
buildah run "$ctr" -- /bin/sh -c '
    cd /app &&
    go mod download &&
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
        go build -ldflags="-s -w" -o /usr/local/bin/server ./cmd/server
'

# Remove build tools from the final image
buildah run "$ctr" -- rm -rf /usr/local/go /go

# Create the final minimal image
final=$(buildah from gcr.io/distroless/static-debian12:nonroot)
mnt_final=$(buildah mount "$final")

# Copy only the binary
cp "${mnt}/usr/local/bin/server" "${mnt_final}/server"

# Set runtime configuration
buildah config --entrypoint '["/server"]' "$final"
buildah config --port 8080 "$final"
buildah config --env "GIN_MODE=release" "$final"
buildah config --user nonroot "$final"

# Commit the final image
buildah commit "$final" "$IMAGE_NAME"

# Cleanup
buildah rm "$ctr" "$final"
buildah unmount "$ctr" "$final" 2>/dev/null || true

echo "=== Built ${IMAGE_NAME} ==="
buildah images "$IMAGE_NAME"
```

### Multi-Architecture Builds with buildah

```bash
# Enable cross-compilation via qemu
sudo apt-get install -y qemu-user-static
sudo systemctl restart systemd-binfmt

# Build for ARM64
buildah bud \
    --platform linux/arm64 \
    -t registry.internal/myapp:v1.0-arm64 \
    .

# Build for AMD64
buildah bud \
    --platform linux/amd64 \
    -t registry.internal/myapp:v1.0-amd64 \
    .

# Create a manifest list (multi-arch image)
buildah manifest create registry.internal/myapp:v1.0

buildah manifest add registry.internal/myapp:v1.0 \
    registry.internal/myapp:v1.0-amd64

buildah manifest add registry.internal/myapp:v1.0 \
    registry.internal/myapp:v1.0-arm64

# Push the manifest (all architectures in one push)
buildah manifest push --all \
    registry.internal/myapp:v1.0 \
    docker://registry.internal/myapp:v1.0
```

### Rootless Builds in CI/CD

```yaml
# .github/workflows/build.yml — rootless podman/buildah build
name: Build and Push
on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install podman and buildah
        run: |
          sudo apt-get update
          sudo apt-get install -y podman buildah

      - name: Login to registry
        run: |
          buildah login \
            --username ${{ secrets.REGISTRY_USER }} \
            --password ${{ secrets.REGISTRY_PASSWORD }} \
            registry.internal

      - name: Build image (rootless)
        run: |
          buildah bud \
            --layers \
            --cache-from registry.internal/myapp:buildcache \
            --cache-to registry.internal/myapp:buildcache \
            -t registry.internal/myapp:${{ github.sha }} \
            -f Dockerfile \
            .

      - name: Push image
        run: |
          buildah push registry.internal/myapp:${{ github.sha }}
          # Tag as latest on main
          buildah tag registry.internal/myapp:${{ github.sha }} \
              registry.internal/myapp:latest
          buildah push registry.internal/myapp:latest
```

## Section 5: OCI Compliance and Image Inspection

```bash
# Inspect OCI image manifest
nerdctl manifest inspect nginx:1.25
skopeo inspect docker://nginx:1.25
buildah inspect nginx:1.25

# Copy images between registries (skopeo — OCI-native tool)
skopeo copy \
    docker://docker.io/nginx:1.25 \
    docker://registry.internal/nginx:1.25

# Copy to OCI layout on disk
skopeo copy \
    docker://nginx:1.25 \
    oci:/tmp/nginx-oci:latest

# Inspect OCI layout
ls /tmp/nginx-oci/
cat /tmp/nginx-oci/index.json | jq .

# Convert between formats
skopeo copy \
    docker://nginx:1.25 \
    docker-archive:/tmp/nginx.tar

# Sign and verify images
cosign sign --key cosign.key registry.internal/myapp:v1.0
cosign verify --key cosign.pub registry.internal/myapp:v1.0
```

## Section 6: Kubernetes Integration

### containerd Socket for Debugging

```bash
# On a Kubernetes node, inspect containers using nerdctl
ssh k8s-node-1

# List running pods
sudo nerdctl --namespace k8s.io ps

# Find a specific pod's container
sudo nerdctl --namespace k8s.io ps | grep my-app

# Exec into a pod container directly (bypasses kubectl)
CONTAINER_ID=$(sudo nerdctl --namespace k8s.io ps | grep my-app | awk '{print $1}')
sudo nerdctl --namespace k8s.io exec -it "$CONTAINER_ID" /bin/sh

# Inspect container runtime config
sudo nerdctl --namespace k8s.io inspect "$CONTAINER_ID" | jq '.[]|.HostConfig.NetworkMode'

# Pull an image directly to the node (useful for pre-loading)
sudo nerdctl --namespace k8s.io pull registry.internal/myapp:v1.0
```

### crictl — CRI-Level Debugging

```bash
# crictl talks to the CRI (containerd socket) directly
# Useful when containerd is the runtime but nerdctl isn't installed
sudo apt-get install -y cri-tools

# Configure crictl to use containerd socket
cat > /etc/crictl.yaml << 'EOF'
runtime-endpoint: unix:///run/containerd/containerd.sock
image-endpoint: unix:///run/containerd/containerd.sock
timeout: 30
debug: false
EOF

# List pods and containers
sudo crictl pods
sudo crictl ps
sudo crictl images

# Exec into a container
sudo crictl exec -it <container-id> /bin/sh

# Get pod logs
sudo crictl logs <container-id>

# Inspect pod sandbox
sudo crictl inspectp <pod-id>
```

### Using podman as a Kubernetes Node Runtime

```bash
# cri-o is the Kubernetes CRI implementation that uses podman's underlying libraries
# Install cri-o
sudo apt-get install -y cri-o cri-o-runc

# Configure cri-o
cat > /etc/crio/crio.conf.d/10-crun.conf << 'EOF'
[crio.runtime]
default_runtime = "crun"

[crio.runtime.runtimes.crun]
runtime_path = "/usr/bin/crun"
runtime_type = "oci"
runtime_root = "/run/crun"
EOF

sudo systemctl enable --now crio

# In kubeadm init configuration
cat > kubeadm-config.yaml << 'EOF'
apiVersion: kubeadm.k8s.io/v1beta3
kind: InitConfiguration
nodeRegistration:
  criSocket: unix:///var/run/crio/crio.sock
---
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
kubernetesVersion: "1.30.0"
EOF
```

## Section 7: Security Considerations

### Rootless Container Hardening

```bash
# Verify containers are running as non-root on the host
ps aux | grep -v grep | grep containerd-shim | awk '{print $1}'
# uid=1000(mmattox)  ← not root!

# Check user namespace mapping
podman run --rm alpine cat /proc/self/uid_map
# 0    1000    1   ← root in container = uid 1000 on host

# Seccomp profile (applied by default)
podman run --security-opt seccomp=default --rm alpine /bin/sh

# Custom seccomp profile
podman run \
    --security-opt seccomp=/etc/containers/seccomp.json \
    --rm myapp:v1.0

# Drop all capabilities
podman run \
    --cap-drop ALL \
    --cap-add NET_BIND_SERVICE \
    --rm nginx:1.25

# Read-only root filesystem
podman run \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid \
    --rm myapp:v1.0
```

### Image Scanning

```bash
# Scan with trivy (works with all OCI images)
trivy image registry.internal/myapp:v1.0

# Scan before push in CI
trivy image \
    --exit-code 1 \
    --severity HIGH,CRITICAL \
    registry.internal/myapp:v1.0

# Scan from buildah-built image in local storage
trivy image --input /tmp/myapp.tar

# Integrate with buildah
buildah bud -t myapp:v1.0 .
buildah push myapp:v1.0 oci-archive:/tmp/myapp.tar
trivy image --input /tmp/myapp.tar --exit-code 1
```

## Section 8: Migration from Docker

```bash
# Export Docker images for import into containerd
docker save myapp:v1.0 | gzip > myapp.tar.gz

# Import into containerd via nerdctl
nerdctl load < myapp.tar.gz

# Or via ctr (containerd native CLI)
sudo ctr images import myapp.tar.gz

# Export from Docker and import to podman
docker save myapp:v1.0 | podman load

# Alias docker to nerdctl or podman for drop-in replacement
echo 'alias docker=nerdctl' >> ~/.bashrc
# or
echo 'alias docker=podman' >> ~/.bashrc
source ~/.bashrc

# Test alias
docker run --rm hello-world
```

## Section 9: Performance Comparison

```bash
# Benchmark container startup time
# nerdctl/containerd
time nerdctl run --rm alpine echo "hello"
# real 0m0.185s

# podman rootless
time podman run --rm alpine echo "hello"
# real 0m0.340s

# Docker (for comparison)
time docker run --rm alpine echo "hello"
# real 0m0.520s  (daemon adds overhead)

# Image pull performance (all similar, limited by registry bandwidth)
time nerdctl pull nginx:1.25
time podman pull nginx:1.25
```

## Section 10: Production Checklist

- [ ] nerdctl + containerd installed and matching Kubernetes node runtime version
- [ ] BuildKit daemon configured and running for image builds
- [ ] podman installed with uidmap and slirp4netns for rootless support
- [ ] `/etc/subuid` and `/etc/subgid` configured for user namespace mapping
- [ ] Container images built with buildah in CI/CD (no Docker daemon required)
- [ ] Image signing with cosign configured for supply chain security
- [ ] Trivy scanning integrated into build pipeline (fail on CRITICAL)
- [ ] Rootless builds verified: no `--privileged` or root in CI
- [ ] containerd namespace isolation understood: k8s.io for Kubernetes containers
- [ ] crictl configured on all Kubernetes nodes for runtime-level debugging
- [ ] Quadlet or systemd unit files for any host-level container services
- [ ] Docker alias configured for team members migrating from Docker CLI

## Conclusion

Docker is the command everyone learned, but it is not the only or best tool for every job. nerdctl provides a Docker-compatible experience with zero daemon overhead, running directly against the same containerd that powers your Kubernetes nodes. podman gives you rootless containers with Kubernetes-native pod semantics and systemd integration. buildah lets you build images from Dockerfiles or scripts without any daemon, making it ideal for secure CI/CD environments.

The OCI standard ensures images built by any of these tools run anywhere. Migration from Docker is mostly an alias change — the real work is updating CI/CD to use rootless builds and adopting the security benefits that come from dropping the privileged daemon.
