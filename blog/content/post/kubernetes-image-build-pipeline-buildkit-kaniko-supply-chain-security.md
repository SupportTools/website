---
title: "Kubernetes Image Build Pipeline: BuildKit, Kaniko, and Supply Chain Security"
date: 2030-08-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "BuildKit", "Kaniko", "Supply Chain Security", "Cosign", "SBOM", "SLSA", "GitOps"]
categories:
- Kubernetes
- Security
- CI/CD
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise image build guide covering BuildKit parallelism and cache mounts, rootless Kaniko in Kubernetes, SBOM generation with Syft, image signing with Cosign, SLSA provenance, and integrating build security into GitOps pipelines."
more_link: "yes"
url: "/kubernetes-image-build-pipeline-buildkit-kaniko-supply-chain-security/"
---

Container image supply chain security has become a first-order concern for enterprises following a wave of high-profile compromises that injected malicious code into public images and compromised build pipelines. A hardened image build pipeline performs three distinct functions: efficient, reproducible build execution; attestation generation that proves what went into the image; and cryptographic signing that allows consumers to verify the image is authentic and unmodified.

<!--more-->

## BuildKit Architecture and Parallelism

BuildKit is the build engine behind `docker buildx` and the recommended backend for high-performance image builds. Unlike the legacy Docker builder, BuildKit executes Dockerfile instructions in a dependency graph rather than sequentially, parallelizes independent stages, and provides a rich caching system that dramatically reduces build times for multi-stage Dockerfiles.

### BuildKit Daemon in Kubernetes

```yaml
# buildkitd-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: buildkitd
  namespace: build-system
spec:
  replicas: 3
  selector:
    matchLabels:
      app: buildkitd
  template:
    metadata:
      labels:
        app: buildkitd
    spec:
      containers:
        - name: buildkitd
          image: moby/buildkit:v0.14.1-rootless
          args:
            - --addr
            - unix:///run/user/1000/buildkit/buildkitd.sock
            - --addr
            - tcp://0.0.0.0:1234
            - --oci-worker-no-process-sandbox
          securityContext:
            seccompProfile:
              type: Unconfined
            runAsUser: 1000
            runAsGroup: 1000
          ports:
            - containerPort: 1234
          volumeMounts:
            - name: buildkit-storage
              mountPath: /home/user/.local/share/buildkit
      volumes:
        - name: buildkit-storage
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: buildkitd
  namespace: build-system
spec:
  selector:
    app: buildkitd
  ports:
    - port: 1234
      targetPort: 1234
```

### Multi-Stage Dockerfile with Cache Mounts

Cache mounts (`--mount=type=cache`) persist build tool caches (Go module cache, npm node_modules, pip cache) between builds without embedding them in the final image:

```dockerfile
# Dockerfile
# syntax=docker/dockerfile:1.7

# ── Stage 1: Go module download ──────────────────────────────────────────────
FROM golang:1.22-alpine AS deps
WORKDIR /app
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download

# ── Stage 2: Build ───────────────────────────────────────────────────────────
FROM deps AS builder
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w -X main.Version=$(git rev-parse --short HEAD)" \
    -o /app/server ./cmd/server

# ── Stage 3: Security scan ───────────────────────────────────────────────────
FROM builder AS scanner
RUN --mount=type=cache,target=/root/.cache \
    curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh -s -- -b /usr/local/bin && \
    syft /app/server -o spdx-json > /tmp/sbom.spdx.json

# ── Stage 4: Final minimal image ─────────────────────────────────────────────
FROM gcr.io/distroless/static:nonroot AS final
COPY --from=builder /app/server /server
COPY --from=scanner /tmp/sbom.spdx.json /sbom.spdx.json
USER nonroot:nonroot
ENTRYPOINT ["/server"]
```

### BuildKit Build with Remote Cache

```bash
# Build with registry-backed cache (push cache to registry on each build)
buildctl \
  --addr tcp://buildkitd.build-system.svc.cluster.local:1234 \
  build \
  --frontend=dockerfile.v0 \
  --local context=. \
  --local dockerfile=. \
  --output type=image,name=myregistry.example.com/myapp:$(git rev-parse --short HEAD),push=true \
  --export-cache type=registry,ref=myregistry.example.com/myapp:buildcache,mode=max \
  --import-cache type=registry,ref=myregistry.example.com/myapp:buildcache
```

---

## Rootless Kaniko in Kubernetes

Kaniko builds container images inside a Kubernetes pod without requiring the Docker daemon or privileged mode. It executes each Dockerfile instruction, snapshots the filesystem after each step, and uploads the final image to a registry.

### Kaniko Job

```yaml
# kaniko-build-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: kaniko-build-myapp
  namespace: build-system
spec:
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      restartPolicy: Never
      serviceAccountName: kaniko-builder
      initContainers:
        - name: git-clone
          image: alpine/git:2.43.0
          args:
            - clone
            - --depth=1
            - --branch=main
            - https://github.com/example/myapp.git
            - /workspace
          volumeMounts:
            - name: workspace
              mountPath: /workspace
      containers:
        - name: kaniko
          image: gcr.io/kaniko-project/executor:v1.23.0
          args:
            - --dockerfile=/workspace/Dockerfile
            - --context=dir:///workspace
            - --destination=myregistry.example.com/myapp:latest
            - --destination=myregistry.example.com/myapp:$(BUILD_SHA)
            - --cache=true
            - --cache-repo=myregistry.example.com/myapp-cache
            - --snapshot-mode=redo
            - --use-new-run
            - --compressed-caching=true
            - --log-format=json
            - --verbosity=info
          env:
            - name: BUILD_SHA
              value: "abc1234"
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: registry-credentials
              mountPath: /kaniko/.docker
          resources:
            requests:
              cpu: "2"
              memory: 4Gi
            limits:
              cpu: "8"
              memory: 8Gi
      volumes:
        - name: workspace
          emptyDir: {}
        - name: registry-credentials
          secret:
            secretName: registry-credentials
            items:
              - key: .dockerconfigjson
                path: config.json
```

### Registry Credentials Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: registry-credentials
  namespace: build-system
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: <base64-encoded-docker-config-json>
```

---

## SBOM Generation with Syft

A Software Bill of Materials (SBOM) is a machine-readable inventory of all components in a container image — OS packages, language runtime libraries, and application dependencies.

### Generating an SBOM at Build Time

```bash
# Generate SBOM for an image in SPDX JSON format
syft myregistry.example.com/myapp:abc1234 \
    -o spdx-json=sbom.spdx.json \
    -o cyclonedx-json=sbom.cyclonedx.json

# Scan SBOM for vulnerabilities using Grype
grype sbom:sbom.spdx.json \
    --fail-on high \
    --output table
```

### Attaching SBOM to Image as OCI Artifact

Using the ORAS CLI, the SBOM can be attached to the image as a referrer in the OCI registry:

```bash
# Attach SBOM as OCI artifact referencing the image
oras attach \
    --artifact-type application/vnd.syft+json \
    myregistry.example.com/myapp:abc1234 \
    sbom.spdx.json:application/spdx+json

# Or use Cosign to attach as an attestation (preferred — adds signing)
cosign attest \
    --predicate sbom.spdx.json \
    --type spdxjson \
    --key cosign.key \
    myregistry.example.com/myapp:abc1234
```

---

## Image Signing with Cosign

Cosign (part of the Sigstore project) provides cryptographic signing for container images. Signatures are stored in the same OCI registry as the image, making them portable without a separate signature storage system.

### Keyless Signing with Sigstore (Recommended)

Keyless signing uses OIDC tokens from GitHub Actions, GitLab CI, or Google Cloud Build to create ephemeral short-lived keys. The signing event is recorded in the Rekor transparency log.

```bash
# In GitHub Actions (GITHUB_TOKEN provides the OIDC token)
cosign sign \
    --yes \
    myregistry.example.com/myapp:abc1234@sha256:<digest>

# Verify the signature
cosign verify \
    --certificate-identity https://github.com/example/myapp/.github/workflows/build.yaml@refs/heads/main \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    myregistry.example.com/myapp:abc1234
```

### Key-Pair Signing for Air-Gapped Environments

```bash
# Generate a cosign key pair
cosign generate-key-pair

# Sign the image with the private key
cosign sign \
    --key cosign.key \
    myregistry.example.com/myapp:abc1234

# Verify with the public key
cosign verify \
    --key cosign.pub \
    myregistry.example.com/myapp:abc1234

# Store cosign.pub in a Kubernetes Secret for use by admission controllers
kubectl create secret generic cosign-public-key \
    --from-file=cosign.pub=./cosign.pub \
    -n policy-system
```

---

## SLSA Provenance Generation

SLSA (Supply-chain Levels for Software Artifacts) provenance is a metadata document that describes how an artifact was built: what source code was used, which builder executed the build, and what build parameters were used.

### Generating SLSA Provenance with slsa-github-generator

```yaml
# .github/workflows/build-slsa.yaml
name: Build with SLSA Provenance

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      image: ${{ steps.build.outputs.image }}
      digest: ${{ steps.build.outputs.digest }}

    steps:
      - uses: actions/checkout@v4

      - name: Build and push image
        id: build
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            myregistry.example.com/myapp:${{ github.sha }}
            myregistry.example.com/myapp:latest

      - name: Output digest
        id: digest
        run: |
          echo "digest=$(docker inspect --format='{{index .RepoDigests 0}}' myregistry.example.com/myapp:${{ github.sha }} | cut -d@ -f2)" >> $GITHUB_OUTPUT

  provenance:
    needs: [build]
    permissions:
      id-token: write
      contents: read
    uses: slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@v1.10.0
    with:
      image: myregistry.example.com/myapp
      digest: ${{ needs.build.outputs.digest }}
    secrets:
      registry-username: ${{ github.actor }}
      registry-password: ${{ secrets.GITHUB_TOKEN }}
```

### Verifying SLSA Provenance

```bash
# Verify provenance using slsa-verifier
slsa-verifier verify-image \
    myregistry.example.com/myapp:abc1234 \
    --source-uri github.com/example/myapp \
    --source-branch main \
    --builder-id https://github.com/slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@refs/tags/v1.10.0
```

---

## Integrating Build Security into GitOps Pipelines

### Tekton Pipeline with Security Gates

```yaml
# tekton/pipeline-secure-build.yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: secure-image-build
  namespace: build-system
spec:
  params:
    - name: git-url
      type: string
    - name: git-revision
      type: string
    - name: image-name
      type: string

  workspaces:
    - name: source

  tasks:
    # Step 1: Clone source
    - name: clone
      taskRef:
        name: git-clone
        kind: ClusterTask
      params:
        - name: url
          value: $(params.git-url)
        - name: revision
          value: $(params.git-revision)
      workspaces:
        - name: output
          workspace: source

    # Step 2: Static analysis
    - name: lint
      runAfter: [clone]
      taskRef:
        name: golangci-lint
      workspaces:
        - name: source
          workspace: source

    # Step 3: Unit tests
    - name: test
      runAfter: [lint]
      taskRef:
        name: golang-test
      workspaces:
        - name: source
          workspace: source

    # Step 4: Build image with Kaniko
    - name: build-image
      runAfter: [test]
      taskRef:
        name: kaniko-build
      params:
        - name: image
          value: $(params.image-name)
        - name: context
          value: .
      workspaces:
        - name: source
          workspace: source

    # Step 5: Generate SBOM
    - name: generate-sbom
      runAfter: [build-image]
      taskSpec:
        steps:
          - name: syft-scan
            image: anchore/syft:1.0.1
            command:
              - syft
              - $(params.image-name)
              - -o
              - spdx-json=/workspace/sbom.spdx.json

    # Step 6: Vulnerability scan — fail on HIGH/CRITICAL
    - name: vulnerability-scan
      runAfter: [generate-sbom]
      taskSpec:
        steps:
          - name: grype-scan
            image: anchore/grype:0.74.0
            command:
              - grype
              - sbom:/workspace/sbom.spdx.json
              - --fail-on
              - high
              - --output
              - table

    # Step 7: Sign image
    - name: sign-image
      runAfter: [vulnerability-scan]
      taskSpec:
        steps:
          - name: cosign-sign
            image: gcr.io/projectsigstore/cosign:v2.2.3
            command:
              - cosign
              - sign
              - --yes
              - --key
              - k8s://build-system/cosign-signing-key
              - $(params.image-name)

    # Step 8: Attach SBOM as attestation
    - name: attest-sbom
      runAfter: [sign-image]
      taskSpec:
        steps:
          - name: cosign-attest
            image: gcr.io/projectsigstore/cosign:v2.2.3
            command:
              - cosign
              - attest
              - --yes
              - --key
              - k8s://build-system/cosign-signing-key
              - --predicate
              - /workspace/sbom.spdx.json
              - --type
              - spdxjson
              - $(params.image-name)
```

---

## Admission Control: Enforcing Signed Images at Deploy Time

### Sigstore Policy Controller

The Sigstore Policy Controller webhook validates that every pod's container image has a valid Cosign signature before the pod is admitted to the cluster.

```yaml
# Install Sigstore Policy Controller
helm repo add sigstore https://sigstore.github.io/helm-charts
helm install policy-controller sigstore/policy-controller \
    --namespace policy-system \
    --create-namespace \
    --version 0.9.0

# ClusterImagePolicy — require valid signatures for production namespace
---
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: require-signed-images
spec:
  images:
    - glob: "myregistry.example.com/**"
  authorities:
    - keyless:
        url: https://fulcio.sigstore.dev
        identities:
          - issuer: https://token.actions.githubusercontent.com
            subjectRegExp: "https://github.com/example/.*/.github/workflows/build.yaml@refs/heads/main"
    - key:
        secret:
          name: cosign-public-key
          namespace: policy-system
  policy:
    fetchConfigFileFromOCIRegistry: false
    type: cue
    data: |
      package signature
      import "time"
      # Reject if signature is older than 90 days
      isRecent: time.Parse(time.RFC3339, cert.notAfter) > time.Now() - 90 * 24 * time.Hour
```

---

## Registry Mirror and Caching

For air-gapped or bandwidth-constrained environments, a local registry mirror reduces external pull traffic and provides a pull-through cache:

```yaml
# distribution-mirror.yaml — run Harbor or Zot as a local mirror
apiVersion: apps/v1
kind: Deployment
metadata:
  name: registry-mirror
  namespace: build-system
spec:
  replicas: 2
  selector:
    matchLabels:
      app: registry-mirror
  template:
    spec:
      containers:
        - name: registry
          image: ghcr.io/project-zot/zot-linux-amd64:v2.0.1
          args:
            - serve
            - /etc/zot/config.json
          volumeMounts:
            - name: config
              mountPath: /etc/zot
            - name: storage
              mountPath: /var/lib/registry
      volumes:
        - name: config
          configMap:
            name: zot-config
        - name: storage
          persistentVolumeClaim:
            claimName: registry-mirror-pvc
```

---

## Build Metrics and Observability

### BuildKit Metrics

BuildKit exposes OpenTelemetry traces when `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the buildkitd environment:

```yaml
# buildkitd environment for observability
env:
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: http://otel-collector.monitoring.svc.cluster.local:4317
  - name: OTEL_SERVICE_NAME
    value: buildkitd
```

### Tekton Pipeline Metrics

```yaml
# tekton-config for metrics
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-observability
  namespace: tekton-pipelines
data:
  metrics.backend-destination: prometheus
  metrics.allow-stack-driver-metrics-collection: "false"
  metrics.stackdriver-custom-domain: tekton.dev
  metrics.count.enable-reason: "true"
```

---

## Conclusion

A secure image build pipeline is not a single tool but a composed workflow: BuildKit or Kaniko for efficient, reproducible builds; Syft for SBOM generation; Grype for vulnerability scanning as a build gate; Cosign for cryptographic attestation; and SLSA provenance for supply chain traceability. The Policy Controller closes the loop by enforcing at admission time that only images with verified signatures reach production. This pipeline transforms image builds from opaque processes into auditable, verifiable artifacts where every deployment can trace its provenance back to a specific commit, build environment, and dependency set.
