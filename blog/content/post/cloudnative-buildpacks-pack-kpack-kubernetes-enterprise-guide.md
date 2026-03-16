---
title: "Cloud Native Buildpacks: Automated Container Builds with kpack on Kubernetes"
date: 2027-01-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Buildpacks", "kpack", "CI/CD", "Container Images"]
categories:
- CI/CD
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide for Cloud Native Buildpacks and kpack on Kubernetes: automated base image patching, ClusterStore/Stack/Builder CRDs, SBOM generation, and GitOps integration with ArgoCD Image Updater."
more_link: "yes"
url: "/cloudnative-buildpacks-pack-kpack-kubernetes-enterprise-guide/"
---

**Cloud Native Buildpacks (CNB)** automate the process of turning application source code into production-ready OCI images without requiring developers to write or maintain Dockerfiles. The **kpack** Kubernetes operator extends this by continuously rebuilding images whenever the underlying base stack (OS layers) or buildpacks (language runtimes) receive updates. In a security-conscious enterprise, this means a newly published CVE fix in the Ubuntu base image automatically triggers a rebuild of every affected application image within hours — without any developer involvement. This guide covers the full stack: `pack` CLI for local development, kpack CRDs for cluster-level automation, SBOM generation, and GitOps integration with ArgoCD Image Updater.

<!--more-->

## Buildpacks vs Dockerfile Trade-offs

| Dimension | Cloud Native Buildpacks | Dockerfile |
|-----------|------------------------|------------|
| Developer cognitive load | Low (auto-detects language) | High (must write and maintain) |
| Base image patching | Automatic via kpack rebuild | Manual Dockerfile update required |
| Security scanning surface | Controlled, layered | Depends on Dockerfile quality |
| Build reproducibility | High (same inputs → same digest) | Variable |
| Multi-language support | Automatic detection | Requires per-language work |
| Build cache efficiency | High (layer reuse by content) | Depends on layer ordering |
| SBOM generation | Built-in (CycloneDX / SPDX) | External tooling required |
| Rootless builds | Yes | Requires BuildKit + rootless mode |
| Kubernetes-native | kpack operator | Kaniko/Buildah/BuildKit |
| Customization depth | Limited to buildpack API | Unlimited |

Dockerfiles remain the right choice for applications with unusual build requirements — custom build toolchains, non-standard runtimes, complex multi-stage optimizations. For the 80% of applications that use standard language runtimes (Go, Java, Node.js, Python, Ruby, .NET), buildpacks eliminate an entire category of Dockerfile maintenance burden.

## Cloud Native Buildpack Components

```
┌─────────────────────────────────────────────────────┐
│                    Builder Image                    │
│                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │  Buildpack  │  │  Buildpack  │  │  Buildpack  │  │
│  │  Go 1.22    │  │  Node 20    │  │  Java 21    │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │              Stack                          │    │
│  │  Build Image: ubuntu:22.04 + build tools    │    │
│  │  Run Image:   ubuntu:22.04 (minimal)        │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │              Lifecycle                      │    │
│  │  detect → analyze → restore →               │    │
│  │  build → export                             │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

- **Buildpack**: Detects whether it applies to the source (e.g., presence of `go.mod`), downloads dependencies, compiles the application, and configures the runtime environment.
- **Stack**: Defines the base OS image used during build and at runtime. Build and run images can differ — the run image is minimal.
- **Builder**: A composite image bundling a lifecycle binary, a stack, and a set of buildpacks. This is the single pull required to build any supported language.
- **Lifecycle**: Orchestrates the detect/build/export phases across all buildpacks.

## pack CLI: Local Development Workflow

```bash
# Install pack CLI
curl -sSL https://github.com/buildpacks/pack/releases/download/v0.35.0/pack-v0.35.0-linux.tgz \
  | tar -xz -C /usr/local/bin

# Build a Go application (auto-detects from go.mod)
pack build registry.internal.example.com/platform/my-app:latest \
  --builder paketobuildpacks/builder-jammy-full:latest \
  --path ./my-app

# Inspect what buildpacks were used
pack inspect registry.internal.example.com/platform/my-app:latest

# Rebase an image onto a new run stack (no rebuild required)
pack rebase registry.internal.example.com/platform/my-app:latest \
  --run-image paketobuildpacks/run-jammy-full:latest \
  --report

# Generate an SBOM for the built image
pack sbom download registry.internal.example.com/platform/my-app:latest \
  --output-dir ./sbom-output

# Trust a builder for repeated use
pack config trusted-builders add paketobuildpacks/builder-jammy-full:latest
```

### project.toml for Per-Repo Build Configuration

```toml
# project.toml — placed at repo root
[_]
schema-version = "0.2"

[project]
id = "com.example.my-app"
name = "My Application"
version = "1.0.0"

[[build.buildpacks]]
uri = "docker://gcr.io/buildpacks/google-go:v1"

[build.env]
GOOGLE_BUILDABLE = "./cmd/server"
GOFLAGS = "-mod=vendor"

[[build.tags]]
name = "1.0.0"
```

## Installing kpack on Kubernetes

```bash
# Install kpack via kubectl apply
kubectl apply -f https://github.com/buildpacks-community/kpack/releases/download/v0.14.0/release-0.14.0.yaml

# Verify kpack is running
kubectl -n kpack wait --for=condition=ready pod -l app=kpack-controller --timeout=120s
kubectl -n kpack wait --for=condition=ready pod -l app=kpack-webhook --timeout=120s

# Install the kpack CLI
curl -sSL https://github.com/buildpacks-community/kpack-cli/releases/download/v0.14.0/kp-linux-amd64-0.14.0 \
  -o /usr/local/bin/kp
chmod +x /usr/local/bin/kp
```

## kpack CRD Hierarchy

```
ClusterStore  ──► contains buildpacks from multiple OCI sources
      │
ClusterStack  ──► defines build and run base images (Ubuntu 22.04)
      │
   Builder    ──► ClusterStore + ClusterStack + buildpack order
      │
    Image     ──► source (Git repo) + Builder + registry destination
      │
   Build      ──► auto-created per rebuild; contains build logs and metadata
```

### ClusterStore: Buildpack Sources

```yaml
# clusterstore.yaml
apiVersion: kpack.io/v1alpha2
kind: ClusterStore
metadata:
  name: default
spec:
  sources:
    # Paketo Buildpacks - Go
    - image: gcr.io/paketo-buildpacks/go:4.7.0
    # Paketo Buildpacks - Java
    - image: gcr.io/paketo-buildpacks/java:14.5.0
    # Paketo Buildpacks - Node.js
    - image: gcr.io/paketo-buildpacks/nodejs:20.11.0
    # Paketo Buildpacks - Python
    - image: gcr.io/paketo-buildpacks/python:2.6.0
    # Paketo Buildpacks - .NET
    - image: gcr.io/paketo-buildpacks/dotnet-core:0.46.0
    # Paketo Buildpacks - Procfile support
    - image: gcr.io/paketo-buildpacks/procfile:5.9.0
```

### ClusterStack: Base Images

```yaml
# clusterstack.yaml
apiVersion: kpack.io/v1alpha2
kind: ClusterStack
metadata:
  name: base-jammy
spec:
  id: io.buildpacks.stacks.jammy
  buildImage:
    image: paketobuildpacks/build-jammy-base:latest
  runImage:
    image: paketobuildpacks/run-jammy-base:latest
---
apiVersion: kpack.io/v1alpha2
kind: ClusterStack
metadata:
  name: full-jammy
spec:
  id: io.buildpacks.stacks.jammy
  buildImage:
    image: paketobuildpacks/build-jammy-full:latest
  runImage:
    image: paketobuildpacks/run-jammy-full:latest
```

### ClusterBuilder: Composite Builder

```yaml
# clusterbuilder.yaml
apiVersion: kpack.io/v1alpha2
kind: ClusterBuilder
metadata:
  name: platform-builder
spec:
  serviceAccountRef:
    name: kpack-service-account
    namespace: kpack
  tag: registry.internal.example.com/buildpacks/platform-builder:latest
  stack:
    name: full-jammy
    kind: ClusterStack
  store:
    name: default
    kind: ClusterStore
  order:
    - group:
        - id: paketo-buildpacks/go
    - group:
        - id: paketo-buildpacks/java
    - group:
        - id: paketo-buildpacks/nodejs
    - group:
        - id: paketo-buildpacks/python
    - group:
        - id: paketo-buildpacks/dotnet-core
    - group:
        - id: paketo-buildpacks/procfile
```

### Service Account and Registry Credentials

```bash
# Create registry pull/push credentials for kpack
kubectl create secret docker-registry kpack-registry-credentials \
  --namespace kpack \
  --docker-server=registry.internal.example.com \
  --docker-username=kpack-push \
  --docker-password=EXAMPLE_REGISTRY_PASSWORD

# Service account that kpack uses to push built images
kubectl apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kpack-service-account
  namespace: kpack
secrets:
  - name: kpack-registry-credentials
imagePullSecrets:
  - name: kpack-registry-credentials
EOF
```

### Image CRD: Application Build Definition

```yaml
# image-my-app.yaml
apiVersion: kpack.io/v1alpha2
kind: Image
metadata:
  name: my-app
  namespace: platform
spec:
  tag: registry.internal.example.com/platform/my-app
  serviceAccountName: kpack-service-account
  builder:
    name: platform-builder
    kind: ClusterBuilder

  source:
    git:
      url: https://git.internal.example.com/platform-team/my-app.git
      revision: main
    subPath: ""

  build:
    env:
      - name: BP_GO_TARGETS
        value: "./cmd/server"
      - name: BP_GO_BUILD_FLAGS
        value: "-ldflags='-s -w'"
      - name: BP_OCI_AUTHORS
        value: "Platform Engineering Team"
      - name: BP_OCI_SOURCE
        value: "https://git.internal.example.com/platform-team/my-app"
    resources:
      requests:
        cpu: 500m
        memory: 1Gi
      limits:
        cpu: "2"
        memory: 4Gi

  cache:
    volume:
      storageClassName: fast-ssd
      size: 2Gi

  failedBuildHistoryLimit: 5
  successBuildHistoryLimit: 10
  imageTaggingStrategy: BuildNumber
```

## Automated Base Image Patching Workflow

This is the core value proposition of kpack. When Paketo releases an updated `run-jammy-base` image (e.g., to patch a CVE in libssl), kpack detects the change and triggers a rebuild of every `Image` using that stack — automatically.

```
[Paketo releases patched ubuntu:22.04 run image]
                    │
                    ▼
     kpack ClusterStack controller polls
     paketobuildpacks/run-jammy-base:latest
                    │
       Digest changed → update ClusterStack
                    │
                    ▼
     All Images using this ClusterStack
     are queued for rebuild
                    │
                    ▼
     kpack creates Build objects for each Image
                    │
                    ▼
     Build runs (pack lifecycle, no source
     code download needed for rebase-eligible
     changes — only new run-image layers)
                    │
                    ▼
     New image digest pushed to registry
                    │
                    ▼
     ArgoCD Image Updater detects new digest
     → updates Deployment/Helm values
     → ArgoCD syncs → pods redeployed
```

### Monitoring the Rebuild Queue

```bash
# Watch builds as they execute
kp build list --namespace platform --watch

# Inspect a specific build's logs
kp build logs my-app -n platform -b 42

# Check if an image is up to date
kp image status my-app -n platform

# List all images across all namespaces and their last build status
kubectl get images --all-namespaces -o custom-columns=\
"NS:.metadata.namespace,NAME:.metadata.name,READY:.status.conditions[?(@.type==\"Ready\")].status,REASON:.status.conditions[?(@.type==\"Ready\")].reason,TAG:.status.latestImage"
```

## Build Caching

kpack uses a per-Image PVC as a build cache. The lifecycle re-uses layers from previous builds when the source inputs are unchanged, making subsequent builds after a base image patch very fast (only the changed base layers are pulled and rewritten).

```yaml
# Per-image cache configuration
spec:
  cache:
    volume:
      storageClassName: fast-ssd
      size: 2Gi
```

For `rebase`-eligible builds (only the run image changed, not the application source), kpack performs a rebase operation instead of a full build — downloading only the new run image layers and constructing a new manifest. This typically completes in under 30 seconds.

## SBOM Generation

Paketo Buildpacks automatically generate SBOMs during the build lifecycle. kpack surfaces these as annotations and as downloadable artifacts:

```bash
# Download the CycloneDX SBOM from the built image
IMAGE="registry.internal.example.com/platform/my-app:b42"

# The SBOM is stored as an OCI layer in the image itself
pack sbom download ${IMAGE} --output-dir ./sbom

ls ./sbom/
# launch.sbom.cdx.json   (runtime dependencies)
# build.sbom.cdx.json    (build-time dependencies)
# cache.sbom.cdx.json    (cached dependencies)
```

### Attaching SBOMs as OCI Referrers

```bash
# After kpack builds the image, attach the SBOM to Zot registry as an OCI referrer
IMAGE_DIGEST=$(crane digest registry.internal.example.com/platform/my-app:b42)

pack sbom download registry.internal.example.com/platform/my-app:b42 \
  --output-dir /tmp/sbom

cosign attach sbom \
  --sbom /tmp/sbom/launch.sbom.cdx.json \
  --type cyclonedx \
  "registry.internal.example.com/platform/my-app@${IMAGE_DIGEST}"
```

## Multi-Language Support Examples

### Java Spring Boot (Maven)

```yaml
apiVersion: kpack.io/v1alpha2
kind: Image
metadata:
  name: spring-api
  namespace: platform
spec:
  tag: registry.internal.example.com/platform/spring-api
  serviceAccountName: kpack-service-account
  builder:
    name: platform-builder
    kind: ClusterBuilder
  source:
    git:
      url: https://git.internal.example.com/platform-team/spring-api.git
      revision: main
  build:
    env:
      - name: BP_JVM_VERSION
        value: "21"
      - name: BP_MAVEN_BUILD_ARGUMENTS
        value: "-Dmaven.test.skip=true package"
      - name: BPL_JVM_THREAD_COUNT
        value: "50"
      - name: BPL_JVM_HEAD_ROOM
        value: "10"
```

### Node.js Application

```yaml
apiVersion: kpack.io/v1alpha2
kind: Image
metadata:
  name: node-frontend
  namespace: platform
spec:
  tag: registry.internal.example.com/platform/node-frontend
  serviceAccountName: kpack-service-account
  builder:
    name: platform-builder
    kind: ClusterBuilder
  source:
    git:
      url: https://git.internal.example.com/platform-team/node-frontend.git
      revision: main
  build:
    env:
      - name: BP_NODE_PROJECT_PATH
        value: "."
      - name: BP_NODE_VERSION
        value: "20.*"
      - name: NODE_ENV
        value: production
```

## GitOps Integration with ArgoCD Image Updater

**ArgoCD Image Updater** watches an OCI registry for new image tags and automatically commits updated image tags to Git, which ArgoCD then syncs to the cluster.

```bash
# Install ArgoCD Image Updater
kubectl apply -n argocd \
  -f https://raw.githubusercontent.com/argoproj-labs/argocd-image-updater/v0.14.0/manifests/install.yaml
```

### ArgoCD Application with Image Updater Annotations

```yaml
# argocd-application-my-app.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: argocd
  annotations:
    # Image Updater: watch for new builds from kpack
    argocd-image-updater.argoproj.io/image-list: |
      app=registry.internal.example.com/platform/my-app
    argocd-image-updater.argoproj.io/app.update-strategy: digest
    argocd-image-updater.argoproj.io/app.kustomize.image-name: |
      registry.internal.example.com/platform/my-app
    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/git-branch: main
    argocd-image-updater.argoproj.io/app.helm.image-name: image.repository
    argocd-image-updater.argoproj.io/app.helm.image-tag: image.tag
spec:
  project: default
  source:
    repoURL: https://git.internal.example.com/platform-team/k8s-configs.git
    targetRevision: main
    path: apps/my-app
    helm:
      valueFiles:
        - values.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: platform
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

When kpack builds a new image (e.g., triggered by a CVE patch in the base stack), ArgoCD Image Updater detects the new digest, commits the updated digest to the Helm values in Git, and ArgoCD automatically deploys the patched image. The entire pipeline from CVE patch release to running container update completes without any human intervention.

## kpack Monitoring with Prometheus

```yaml
# kpack exposes metrics at :8080/metrics on the controller
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kpack-controller
  namespace: kpack
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app: kpack-controller
  endpoints:
    - port: metrics
      interval: 60s
      path: /metrics
```

Key metrics:

```
# Number of images currently being built
kpack_build_initiated_count_total

# Build duration histogram
kpack_build_duration_seconds_bucket

# Build failure rate
kpack_build_error_count_total

# Images with ready=false (pending rebuild or failed)
kpack_image_ready_count{status="false"}
```

### Alerting Rules

```yaml
groups:
  - name: kpack-builds
    rules:
      - alert: KpackBuildFailed
        expr: increase(kpack_build_error_count_total[15m]) > 0
        labels:
          severity: warning
        annotations:
          summary: "kpack image build failed"
          description: "One or more kpack builds failed in the last 15 minutes. Check build logs."

      - alert: KpackImageOutOfDate
        expr: kpack_image_ready_count{status="false"} > 5
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "{{ $value }} kpack images are not ready"
          description: "Multiple images have been in a non-ready state for 30+ minutes."

      - alert: KpackBuildQueueBacklog
        expr: kpack_build_initiated_count_total - kpack_build_finished_count_total > 20
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "kpack build queue has {{ $value }} pending builds"
```

## Security Patching Workflow Summary

The complete automated security patching workflow operates as follows:

```bash
# Day 0: Engineer defines kpack Image CRD pointing to application source
kubectl apply -f image-my-app.yaml -n platform

# Day 0: kpack builds first image, pushes to registry
# kpack tracks: source commit SHA, buildpack versions, stack digest

# Day N: CVE announced in libssl (Ubuntu 22.04 package)
# Paketo team releases updated run-jammy-base image with fix

# Day N+hours: kpack ClusterStack controller detects new digest
# kpack queues rebuild for ALL images using full-jammy stack

# Day N+hours: kpack builds new image with patched base
# New digest pushed: registry.internal.example.com/platform/my-app@sha256:newdigest

# Day N+hours: ArgoCD Image Updater detects new digest
# Commits updated digest to Git values file

# Day N+hours: ArgoCD syncs Application
# Deployment rolls out with patched image
# Old pods terminated only after new pods pass readiness probe

# Result: CVE fully remediated with zero developer action required
```

## Custom Buildpack Development

When the standard Paketo buildpacks do not support a specific language version or build tool, a custom buildpack can be written:

```bash
# buildpack.toml — buildpack descriptor
[buildpack]
  id = "com.example.buildpacks.rust"
  name = "Example Rust Buildpack"
  version = "0.1.0"

[[stacks]]
  id = "io.buildpacks.stacks.jammy"
```

```bash
#!/usr/bin/env bash
# bin/detect — exit 0 if this buildpack applies, exit 1 otherwise
set -e

BUILD_DIR=$1

if [[ -f "${BUILD_DIR}/Cargo.toml" ]]; then
  exit 0
fi

exit 1
```

```bash
#!/usr/bin/env bash
# bin/build — compile the application
set -e

BUILD_DIR=$1
CACHE_DIR=$2
LAYERS_DIR=$3

RUST_LAYER="${LAYERS_DIR}/rust"
mkdir -p "${RUST_LAYER}/bin"

# Install Rust toolchain into the layer (cached across builds)
if [[ ! -f "${RUST_LAYER}/bin/rustc" ]]; then
  curl -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain stable --no-modify-path
  cp -r ~/.cargo/bin/* "${RUST_LAYER}/bin/"
fi

export PATH="${RUST_LAYER}/bin:${PATH}"

# Build the application
cd "${BUILD_DIR}"
cargo build --release

# Write layer metadata
cat > "${RUST_LAYER}.toml" <<TOML
launch = true
build = false
cache = true
TOML
```

Package and push the custom buildpack as an OCI image:

```bash
# Pack the buildpack into an OCI image
pack buildpack package com.example.buildpacks.rust:0.1.0 \
  --config ./package.toml \
  --publish \
  --tag registry.internal.example.com/buildpacks/rust:0.1.0

# Add to ClusterStore
kubectl patch clusterstore default --type=json \
  -p '[{"op":"add","path":"/spec/sources/-","value":{"image":"registry.internal.example.com/buildpacks/rust:0.1.0"}}]'
```

## Namespace-Scoped Builder for Team Autonomy

ClusterBuilders are cluster-wide resources managed by platform teams. Application teams can create namespace-scoped `Builder` resources that use different buildpack combinations:

```yaml
# Builder (namespace-scoped) for the data team
apiVersion: kpack.io/v1alpha2
kind: Builder
metadata:
  name: data-team-builder
  namespace: data-platform
spec:
  serviceAccountName: kpack-service-account
  tag: registry.internal.example.com/buildpacks/data-builder:latest
  stack:
    name: full-jammy
    kind: ClusterStack
  store:
    name: default
    kind: ClusterStore
  order:
    - group:
        - id: paketo-buildpacks/python
          optional: false
    - group:
        - id: paketo-buildpacks/java
          optional: false
```

## Build Resource Limits and Node Affinity

Builds are computationally intensive. Isolating build workloads to dedicated nodes prevents them from competing with production workloads:

```yaml
# Image spec with node affinity for builds
spec:
  build:
    nodeSelector:
      workload-type: ci-builds
    tolerations:
      - key: workload-type
        operator: Equal
        value: ci-builds
        effect: NoSchedule
    affinity:
      nodeAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          nodeSelectorTerms:
            - matchExpressions:
                - key: workload-type
                  operator: In
                  values: ["ci-builds"]
    resources:
      requests:
        cpu: "1"
        memory: 2Gi
      limits:
        cpu: "4"
        memory: 8Gi
```

Label the dedicated build nodes:

```bash
kubectl label node build-node-1 workload-type=ci-builds
kubectl taint node build-node-1 workload-type=ci-builds:NoSchedule
```

## Comparison: kpack vs Tanzu Build Service

**Tanzu Build Service (TBS)** is VMware's enterprise product built on top of kpack. It adds:

- A web UI for build visibility
- Enterprise support SLAs
- Integration with Tanzu platform authentication
- Curated Paketo buildpack updates with CVE SLAs

For open-source Kubernetes deployments, kpack is the direct equivalent without the commercial wrapper. For VMware Tanzu customers, TBS provides the same automation with vendor-managed buildpack updates.

## Troubleshooting Common Issues

### Build Fails with "no buildpacks participating"

The detect phase ran all buildpacks and none matched the source. Check that the application has the expected entrypoint file (`go.mod`, `package.json`, `pom.xml`, etc.) in the root of the source directory or `subPath`:

```bash
kp build logs my-app -n platform -b 10 2>&1 | grep -A5 "Detecting"
```

If the source uses a monorepo layout, set the `subPath` in the Image spec to point to the application subdirectory.

### Rebase Fails with Stack Mismatch

```bash
# Check the stack ID embedded in the image
pack inspect registry.internal.example.com/platform/my-app:b42 \
  | grep "Stack ID"

# Compare with ClusterStack
kubectl get clusterstack full-jammy -o jsonpath='{.status.buildImage.latestImage}'
```

If the stack IDs differ (e.g., image was built with `io.buildpacks.stacks.bionic` but ClusterStack is `jammy`), a full rebuild rather than a rebase is required.

### Build Pod Stuck in Pending

```bash
# Check build pod events
kubectl describe pod -n platform -l image.kpack.io/image=my-app | tail -30

# Common causes:
# - PVC for cache cannot be provisioned (StorageClass full or unavailable)
# - Node selector/affinity prevents scheduling
# - Resource limits exceed available node capacity
```

Cloud Native Buildpacks with kpack eliminate the most common source of unpatched CVEs in container environments — the "Dockerfile that nobody wants to touch." By making base image patching automatic and invisible to developers, security teams can achieve continuous patching cadences that were previously only possible with dedicated security engineering effort.
