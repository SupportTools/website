---
title: "Cloud Native Buildpacks: Image Building Without Dockerfiles"
date: 2027-12-20T00:00:00-05:00
draft: false
tags: ["Buildpacks", "Kubernetes", "kpack", "Paketo", "Container Security", "CI/CD", "Supply Chain", "Tekton"]
categories:
- Kubernetes
- DevOps
- Container Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Cloud Native Buildpacks covering the pack CLI, Paketo buildpacks, lifecycle phases, kpack on Kubernetes, image rebasing for CVE patching, supply chain security, and Tekton pipeline integration."
more_link: "yes"
url: "/cloudnative-buildpacks-production-guide/"
---

Cloud Native Buildpacks eliminate Dockerfiles by detecting the language and framework of an application and producing an OCI-compliant container image through a reproducible, auditable build process. The key production advantage is rebasing: when a base OS image is patched for a CVE, all application images built on that base can be updated in seconds without rebuilding the application layer. This guide covers the full buildpack lifecycle, Paketo buildpack selection, kpack continuous image building on Kubernetes, and supply chain security integration.

<!--more-->

# Cloud Native Buildpacks: Image Building Without Dockerfiles

## Why Buildpacks Over Dockerfiles

The Dockerfile model puts responsibility for OS hardening, runtime selection, dependency installation, and layer optimization on every development team. The results in practice:

- Inconsistent base images across services (some on Ubuntu 20.04, some on Alpine, some on scratch)
- No systematic CVE patching process for application base layers
- Developers with root-equivalent build permissions crafting arbitrary container instructions
- No reproducibility: the same Dockerfile can produce different images on different days

Cloud Native Buildpacks (CNB) address these problems with a separation of concerns:

- **Buildpack authors** (framework teams, Paketo) maintain the build intelligence
- **Platform operators** control which builders and base images are approved
- **Application developers** provide source code; the platform determines how to package it
- **Rebasing** patches base layers without developer involvement

## Architecture: Lifecycle Phases

A CNB build proceeds through four lifecycle phases executed in sequence:

```
┌──────────────────────────────────────────────────────┐
│                   Builder Image                       │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐  │
│  │  Detect    │  │   Build    │  │    Export      │  │
│  │ (which BP  │  │ (install   │  │ (write layers  │  │
│  │  applies?) │  │  deps,     │  │  to OCI image) │  │
│  │            │  │  compile)  │  │                │  │
│  └────────────┘  └────────────┘  └────────────────┘  │
└──────────────────────────────────────────────────────┘
         │                │                  │
    Source Code      Build Layer         Run Image
    (read-only)     (temporary)        (final image)
```

1. **Detect**: Each buildpack tests whether it applies to the source (e.g., `go.mod` present → Go buildpack applies). The first compatible group wins.
2. **Analyze**: Reads existing image metadata to determine which layers can be reused.
3. **Restore**: Restores cached build artifacts from a previous build.
4. **Build**: Each buildpack in the detected group contributes build output (compiled binaries, installed dependencies) to distinct layers.
5. **Export**: Combines the run image with build layers to produce the final OCI image.

## pack CLI Installation and Usage

```bash
# Install pack CLI
(curl -sSL "https://github.com/buildpacks/pack/releases/download/v0.36.4/pack-v0.36.4-linux.tgz" | sudo tar -C /usr/local/bin/ --no-same-owner -xzv pack)

pack version
# 0.36.4+git-abcdef1 (linux/amd64)
```

### Building a Go Application

```bash
# Build using Paketo Buildpacks
pack build registry.internal.example.com/platform/payment-service:latest \
  --builder paketobuildpacks/builder-jammy-base:latest \
  --path ./payment-service \
  --env BP_GO_TARGETS=./cmd/server \
  --env BP_GO_BUILD_FLAGS="-ldflags=-s -w" \
  --publish

# Inspect the resulting image
pack inspect registry.internal.example.com/platform/payment-service:latest
```

### Building a Java Application

```bash
pack build registry.internal.example.com/platform/billing-service:latest \
  --builder paketobuildpacks/builder-jammy-base:latest \
  --path ./billing-service \
  --env BP_JVM_VERSION=21 \
  --env BP_MAVEN_BUILD_ARGUMENTS="-Dmaven.test.skip=true package" \
  --env BPE_JAVA_TOOL_OPTIONS="-XX:MaxDirectMemorySize=10M -Xss512K -XX:ReservedCodeCacheSize=32M -Xmx384m" \
  --publish
```

### Building a Node.js Application

```bash
pack build registry.internal.example.com/platform/frontend-api:latest \
  --builder paketobuildpacks/builder-jammy-base:latest \
  --path ./frontend-api \
  --env BP_NODE_VERSION=20.* \
  --env BP_NPM_CI_BUILD=true \
  --env NODE_ENV=production \
  --publish
```

## Paketo Buildpacks Reference

Paketo provides language-specific buildpacks that compose automatically:

| Language | Detection Signal | Key Environment Variables |
|----------|------------------|--------------------------|
| Go | `go.mod` | `BP_GO_TARGETS`, `BP_GO_BUILD_FLAGS` |
| Java | `pom.xml`, `build.gradle` | `BP_JVM_VERSION`, `BP_MAVEN_BUILD_ARGUMENTS` |
| Node.js | `package.json` | `BP_NODE_VERSION`, `BP_NPM_CI_BUILD` |
| Python | `requirements.txt`, `Pipfile`, `pyproject.toml` | `BP_CPYTHON_VERSION` |
| Ruby | `Gemfile` | `BP_MRI_VERSION` |
| .NET | `*.csproj`, `*.sln` | `BP_DOTNET_FRAMEWORK_VERSION` |
| PHP | `composer.json` | `BP_PHP_VERSION` |
| Static (nginx) | `index.html` | `BP_WEB_SERVER`, `BP_WEB_SERVER_ROOT` |

## Custom Builder Creation

Organizations should maintain their own builder that enforces approved base images and buildpack versions:

```toml
# builder.toml
description = "Example Corp Production Builder"

[[buildpacks]]
  uri = "docker://gcr.io/paketo-buildpacks/go:4.10.1"

[[buildpacks]]
  uri = "docker://gcr.io/paketo-buildpacks/java:14.3.0"

[[buildpacks]]
  uri = "docker://gcr.io/paketo-buildpacks/nodejs:3.6.0"

[[buildpacks]]
  uri = "docker://gcr.io/paketo-buildpacks/python:3.2.0"

[[order]]
  [[order.group]]
    id = "paketo-buildpacks/go"
    version = "4.10.1"

[[order]]
  [[order.group]]
    id = "paketo-buildpacks/java"
    version = "14.3.0"

[[order]]
  [[order.group]]
    id = "paketo-buildpacks/nodejs"
    version = "3.6.0"

[[order]]
  [[order.group]]
    id = "paketo-buildpacks/python"
    version = "3.2.0"

[build]
  image = "paketobuildpacks/build-jammy-base:latest"

[run]
  [[run.images]]
    image = "paketobuildpacks/run-jammy-base:latest"
    mirrors = [
      "registry.internal.example.com/platform/run-jammy-base:latest"
    ]

[stack]
  id = "io.buildpacks.stacks.jammy"
  build-image = "paketobuildpacks/build-jammy-base:latest"
  run-image = "paketobuildpacks/run-jammy-base:latest"
```

```bash
pack builder create registry.internal.example.com/platform/builder:latest \
  --config ./builder.toml \
  --publish
```

## kpack: Continuous Image Building on Kubernetes

kpack watches source repositories and automatically rebuilds images when source code or base images change.

### Installing kpack

```bash
kubectl apply -f https://github.com/buildpacks-community/kpack/releases/download/v0.14.0/release-0.14.0.yaml

kubectl get pods -n kpack
# NAME                                READY   STATUS
# kpack-controller-...                1/1     Running
# kpack-webhook-...                   1/1     Running
```

### kpack ClusterStore (Buildpack Registry)

```yaml
# kpack-clusterstore.yaml
apiVersion: kpack.io/v1alpha2
kind: ClusterStore
metadata:
  name: platform-store
spec:
  sources:
    - image: gcr.io/paketo-buildpacks/go:4.10.1
    - image: gcr.io/paketo-buildpacks/java:14.3.0
    - image: gcr.io/paketo-buildpacks/nodejs:3.6.0
    - image: gcr.io/paketo-buildpacks/python:3.2.0
```

### kpack ClusterStack (Base Images)

```yaml
# kpack-clusterstack.yaml
apiVersion: kpack.io/v1alpha2
kind: ClusterStack
metadata:
  name: jammy-base
spec:
  id: io.buildpacks.stacks.jammy
  buildImage:
    image: paketobuildpacks/build-jammy-base:latest
  runImage:
    image: paketobuildpacks/run-jammy-base:latest
```

### kpack ClusterBuilder

```yaml
# kpack-clusterbuilder.yaml
apiVersion: kpack.io/v1alpha2
kind: ClusterBuilder
metadata:
  name: platform-builder
spec:
  tag: registry.internal.example.com/platform/builder:kpack-managed
  serviceAccountRef:
    name: kpack-service-account
    namespace: kpack
  stack:
    name: jammy-base
    kind: ClusterStack
  store:
    name: platform-store
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
```

### kpack Image (Continuous Build for a Service)

```yaml
# kpack-image-payment-service.yaml
apiVersion: kpack.io/v1alpha2
kind: Image
metadata:
  name: payment-service
  namespace: payments
spec:
  tag: registry.internal.example.com/payments/payment-service
  serviceAccountName: kpack-service-account
  builderRef:
    name: platform-builder
    kind: ClusterBuilder
  source:
    git:
      url: https://github.com/example-org/payment-service
      revision: main
    subPath: ""
  build:
    env:
      - name: BP_GO_TARGETS
        value: "./cmd/server"
      - name: BP_GO_BUILD_FLAGS
        value: "-ldflags=-s -w"
    resources:
      requests:
        cpu: "1"
        memory: "1Gi"
      limits:
        cpu: "4"
        memory: "4Gi"
  cache:
    volume:
      storageClassName: local-path
      size: "2Gi"
  failedBuildHistoryLimit: 5
  successBuildHistoryLimit: 5
  imageTaggingStrategy: BuildNumber
```

### Monitoring kpack Builds

```bash
# List all images and their status
kubectl get images -A

# Check build history for a specific image
kubectl get builds -n payments -l image.kpack.io/image=payment-service --sort-by=.metadata.creationTimestamp

# Tail logs of the current build
kubectl logs -n payments \
  $(kubectl get builds -n payments -l image.kpack.io/image=payment-service \
    --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1].metadata.name}') \
  --all-containers --follow

# Check why a build failed
kubectl describe build -n payments payment-service-build-3
```

## Image Rebasing for CVE Patching

Rebasing is the key differentiator of buildpacks for security teams. When a CVE is discovered in the run image (Ubuntu, JVM, etc.), the run image can be patched and all application images rebased in minutes without re-running any application build:

```bash
# A new run image with CVE fix is published: paketobuildpacks/run-jammy-base:20241215

# Update the ClusterStack run image
kubectl patch clusterstack jammy-base \
  --type merge \
  -p '{"spec":{"runImage":{"image":"paketobuildpacks/run-jammy-base:20241215"}}}'

# kpack automatically detects the stack change and queues rebase builds
# for all Image resources using this stack - no source code changes required

# Verify rebase builds completed
kubectl get builds -A -l "image.kpack.io/reason=STACK" \
  --sort-by=.metadata.creationTimestamp | tail -20
```

Manual rebase with pack CLI:

```bash
# Rebase a single image to the new run image
pack rebase registry.internal.example.com/payments/payment-service:latest \
  --run-image paketobuildpacks/run-jammy-base:20241215 \
  --publish

# Rebase is nearly instantaneous - only the base layers change
# Application layers remain identical (no rebuild required)
```

## Supply Chain Security

### SBOM Generation

Paketo buildpacks generate Software Bill of Materials automatically:

```bash
# Inspect SBOM attached to a built image
pack sbom download registry.internal.example.com/payments/payment-service:latest \
  --output-dir ./sbom

ls ./sbom/launch/
# sbom.cdx.json    (CycloneDX format)
# sbom.spdx.json   (SPDX format)

# Parse dependency list from SBOM
jq '.components[].name' ./sbom/launch/sbom.cdx.json | sort
```

### Cosign Signing with kpack

Sign images produced by kpack using Cosign and Sigstore:

```yaml
# kpack-signing-policy.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: signing-config
  namespace: kpack
data:
  cosign.yaml: |
    signing:
      signingKeys:
        - name: platform-signing-key
          secretRef:
            name: cosign-key-secret
```

```bash
# Sign a buildpack-produced image
cosign sign --key k8s://kpack/cosign-key-secret \
  registry.internal.example.com/payments/payment-service@sha256:abcdef...

# Verify before deployment
cosign verify \
  --key k8s://kpack/cosign-key-secret \
  registry.internal.example.com/payments/payment-service:latest
```

### Kyverno Policy for Buildpack-Only Images

Enforce that only images built by kpack (signed with the platform key) can be deployed:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-buildpack-signature
  annotations:
    policies.kyverno.io/title: Verify Buildpack Signature
    policies.kyverno.io/description: |
      All production images must be signed by the platform kpack builder.
      This ensures only approved buildpack builds are deployed.
spec:
  validationFailureAction: enforce
  background: false
  rules:
    - name: verify-image-signature
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces:
                - payments
                - identity
                - api-gateway
      verifyImages:
        - imageReferences:
            - "registry.internal.example.com/*"
          attestors:
            - entries:
                - keys:
                    publicKeys: |-
                      -----BEGIN PUBLIC KEY-----
                      MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEplatform_public_key_here==
                      -----END PUBLIC KEY-----
                    signatureAlgorithm: sha256
          mutateDigest: true
          verifyDigest: true
          required: true
```

## Tekton Pipeline Integration

Integrate kpack image builds into a Tekton delivery pipeline:

```yaml
# tekton-pipeline-with-buildpacks.yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: buildpack-delivery
  namespace: tekton-pipelines
spec:
  params:
    - name: image-name
      type: string
    - name: source-namespace
      type: string
    - name: git-revision
      type: string
      default: main

  tasks:
    - name: unit-tests
      taskRef:
        name: golang-test
      params:
        - name: package
          value: ./...

    - name: trigger-kpack-build
      taskRef:
        name: kpack-image-trigger
      runAfter: [unit-tests]
      params:
        - name: image-name
          value: $(params.image-name)
        - name: namespace
          value: $(params.source-namespace)
        - name: git-revision
          value: $(params.git-revision)

    - name: wait-for-build
      taskRef:
        name: kpack-build-wait
      runAfter: [trigger-kpack-build]
      params:
        - name: image-name
          value: $(params.image-name)
        - name: namespace
          value: $(params.source-namespace)
        - name: timeout-seconds
          value: "1200"

    - name: sign-image
      taskRef:
        name: cosign-sign
      runAfter: [wait-for-build]
      params:
        - name: image-ref
          value: $(tasks.wait-for-build.results.image-ref)
        - name: signing-key-secret
          value: cosign-key-secret

    - name: scan-image
      taskRef:
        name: trivy-scan
      runAfter: [sign-image]
      params:
        - name: image
          value: $(tasks.wait-for-build.results.image-ref)
        - name: severity
          value: "CRITICAL,HIGH"
        - name: exit-code
          value: "1"

    - name: deploy-staging
      taskRef:
        name: argocd-sync
      runAfter: [scan-image]
      params:
        - name: app-name
          value: $(params.image-name)-staging
        - name: image-tag
          value: $(tasks.wait-for-build.results.image-tag)
```

Custom Task for waiting on kpack builds:

```yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: kpack-build-wait
  namespace: tekton-pipelines
spec:
  params:
    - name: image-name
      type: string
    - name: namespace
      type: string
    - name: timeout-seconds
      type: string
      default: "900"
  results:
    - name: image-ref
      description: The full image reference including digest
    - name: image-tag
      description: The image tag assigned by kpack
  steps:
    - name: wait-for-build
      image: bitnami/kubectl:latest
      script: |
        #!/bin/bash
        set -e
        TIMEOUT=$(params.timeout-seconds)
        ELAPSED=0
        INTERVAL=15

        while [ $ELAPSED -lt $TIMEOUT ]; do
          STATUS=$(kubectl get image $(params.image-name) \
            -n $(params.namespace) \
            -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')

          REASON=$(kubectl get image $(params.image-name) \
            -n $(params.namespace) \
            -o jsonpath='{.status.conditions[?(@.type=="Ready")].reason}')

          if [ "$STATUS" = "True" ]; then
            IMAGE_REF=$(kubectl get image $(params.image-name) \
              -n $(params.namespace) \
              -o jsonpath='{.status.latestImage}')
            IMAGE_TAG=$(kubectl get image $(params.image-name) \
              -n $(params.namespace) \
              -o jsonpath='{.status.latestBuildImageGeneration}')

            echo -n "$IMAGE_REF" > $(results.image-ref.path)
            echo -n "build-$IMAGE_TAG" > $(results.image-tag.path)
            echo "Build completed: $IMAGE_REF"
            exit 0
          elif [ "$REASON" = "BuildFailure" ]; then
            echo "Build failed: $REASON"
            exit 1
          fi

          echo "Build in progress ($ELAPSED/${TIMEOUT}s)..."
          sleep $INTERVAL
          ELAPSED=$((ELAPSED + INTERVAL))
        done

        echo "Build timed out after ${TIMEOUT}s"
        exit 1
```

## Buildpack Environment Variable Reference

Environment variables configure buildpack behavior without modifying application source:

```yaml
# Complete environment variable reference for Go buildpack
env:
  - name: BP_GO_TARGETS          # Build targets: ./cmd/server,./cmd/worker
    value: "./cmd/server"
  - name: BP_GO_BUILD_FLAGS      # Extra go build flags
    value: "-ldflags=-s -w -X main.version=$(IMAGE_TAG)"
  - name: BP_GO_INSTALL_TOOLS    # Additional go tools to install
    value: "false"
  - name: BP_INCLUDE_FILES       # Files to include beyond binary
    value: "migrations/*.sql,static/**/*"
  - name: BP_EXCLUDE_FILES       # Files to exclude from final image
    value: "*.test"
```

```yaml
# JVM buildpack key variables
env:
  - name: BP_JVM_VERSION          # JVM version: 11, 17, 21
    value: "21"
  - name: BP_MAVEN_BUILD_ARGUMENTS
    value: "-Dmaven.test.skip=true --no-transfer-progress package"
  - name: BP_GRADLE_BUILD_ARGUMENTS
    value: "bootJar"
  - name: BPE_JAVA_TOOL_OPTIONS   # Runtime JVM flags
    value: "-XX:MaxRAMPercentage=75.0 -XX:+UseG1GC"
  - name: BP_JVM_JLINK_ENABLED    # Build minimal JVM (reduces image size)
    value: "true"
  - name: BP_JVM_JLINK_ARGS
    value: "--no-header-files --no-man-pages --strip-debug --compress=2"
```

## Troubleshooting

### Detect Phase Fails - No Buildpack Applies

```bash
pack build test-image --builder paketobuildpacks/builder-jammy-base:latest \
  --path ./my-app \
  --verbose 2>&1 | grep -A 3 "Detecting"
```

Common cause: Missing language signals. Ensure `go.mod`, `package.json`, `pom.xml`, etc. exist at the root or specified sub-path.

### Build Produces Oversized Image

Enable JVM JLink for Java apps, strip debug symbols for Go:

```bash
# Go: verify strip flags
pack inspect registry.internal.example.com/app:latest | grep "go build"

# Java: enable JLink
pack build test-image \
  --env BP_JVM_JLINK_ENABLED=true \
  --env BP_JVM_JLINK_ARGS="--no-header-files --no-man-pages --strip-debug"
```

### kpack Image Stuck in "Unknown" State

```bash
kubectl describe image payment-service -n payments | grep -A 10 "Conditions:"
kubectl get build -n payments -l image.kpack.io/image=payment-service \
  -o jsonpath='{.items[-1].status.conditions}' | jq .
```

Common causes: Registry credentials expired, source repository access denied, resource limits too low for the build.

## Summary

Cloud Native Buildpacks bring reproducibility, security, and operational simplicity to container image building. The critical production patterns are:

1. Use a custom ClusterBuilder pinning specific buildpack versions for reproducible builds
2. Deploy kpack for continuous image building triggered by source or base image changes
3. Leverage image rebasing to patch CVEs in base layers without application team involvement
4. Generate and store SBOMs from every build for compliance and vulnerability tracking
5. Sign all images with Cosign and enforce signature verification with Kyverno
6. Integrate kpack build status into Tekton pipelines for end-to-end delivery automation
7. Use environment variables for build configuration rather than modifying buildpack internals
