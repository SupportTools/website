---
title: "Tekton Cloud-Native CI/CD on Kubernetes: Pipelines, Triggers, and Chains"
date: 2027-06-21T00:00:00-05:00
draft: false
tags: ["Tekton", "CI/CD", "Kubernetes", "Supply Chain Security", "Pipeline"]
categories:
- Tekton
- CI/CD
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete production guide to Tekton CI/CD on Kubernetes covering pipeline primitives, Tekton Hub reusable tasks, webhook-driven EventListeners, Tekton Chains supply chain attestation, SLSA provenance generation, and operational patterns for enterprise pipelines."
more_link: "yes"
url: "/tekton-cloud-native-cicd-kubernetes-guide/"
---

Tekton is the only CI/CD system that treats pipelines as Kubernetes-native primitives rather than external system configurations. This means pipelines have RBAC, run as pods with configurable resource limits, integrate naturally with Kubernetes secrets and service accounts, and scale using standard cluster autoscaling. For organizations already running Kubernetes, Tekton eliminates the operational overhead of managing a separate CI system while providing a supply chain security story through Tekton Chains that no other CI platform matches.

<!--more-->

# Tekton Cloud-Native CI/CD on Kubernetes

## Section 1: Tekton Architecture and Primitives

Tekton's object model maps directly to familiar CI/CD concepts but expressed as Kubernetes Custom Resources.

### The Object Hierarchy

**Task** is the smallest unit of work. A Task defines a series of steps, each running in a container. Steps within a Task share a workspace volume and run sequentially.

**Pipeline** composes multiple Tasks into a DAG (Directed Acyclic Graph). Tasks within a Pipeline can run in parallel, and dependencies are expressed declaratively with `runAfter` and `results`.

**TaskRun** is an instantiation of a Task with specific parameter values and workspace bindings. The Tekton controller creates one pod per TaskRun.

**PipelineRun** is an instantiation of a Pipeline. The controller creates TaskRuns for each Task, managing the execution graph.

**Workspace** is a shared filesystem mounted into steps. Workspaces can be backed by PersistentVolumeClaims, ConfigMaps, Secrets, or ephemeral volumes.

**Result** is an output value produced by a Task step that can be consumed by subsequent Tasks in a Pipeline.

### Installation

```bash
# Install Tekton Pipelines
kubectl apply -f https://storage.googleapis.com/tekton-releases/pipeline/latest/release.yaml

# Install Tekton Triggers
kubectl apply -f https://storage.googleapis.com/tekton-releases/triggers/latest/release.yaml
kubectl apply -f https://storage.googleapis.com/tekton-releases/triggers/latest/interceptors.yaml

# Install Tekton Dashboard
kubectl apply -f https://storage.googleapis.com/tekton-releases/dashboard/latest/release.yaml

# Install Tekton Chains
kubectl apply -f https://storage.googleapis.com/tekton-releases/chains/latest/release.yaml

# Verify installation
kubectl get pods -n tekton-pipelines
kubectl get pods -n tekton-triggers
kubectl get pods -n tekton-chains

# Install Tekton CLI
curl -LO https://github.com/tektoncd/cli/releases/latest/download/tkn_Linux_x86_64.tar.gz
tar xzf tkn_Linux_x86_64.tar.gz -C /usr/local/bin tkn
```

### Feature Flags Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: feature-flags
  namespace: tekton-pipelines
data:
  # Enable pipeline-level result propagation
  enable-api-fields: stable

  # Set default workspace storage class
  default-service-account: tekton-sa

  # Enable step actions (reusable step-level components)
  enable-step-actions: "true"

  # Coschedule pipeline run tasks on same node for cache hits
  coschedule: workspaces

  # Send cloud events for PipelineRun lifecycle
  send-cloudevents-for-runs: "true"
```

## Section 2: Building Blocks — Tasks and Pipelines

### Writing a Reusable Task

```yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: go-build-test
  namespace: tekton-pipelines
  labels:
    app.kubernetes.io/version: "0.1"
  annotations:
    tekton.dev/displayName: "Go Build and Test"
    tekton.dev/description: "Builds and tests a Go module with race detection and coverage reporting"
spec:
  description: |
    Builds a Go application, runs tests with the race detector enabled,
    and generates a coverage report.

  params:
  - name: package
    type: string
    description: "Go import path (e.g., github.com/org/app)"
  - name: go-version
    type: string
    description: "Go version to use"
    default: "1.22"
  - name: run-tests
    type: string
    description: "Whether to run tests"
    default: "true"
  - name: test-flags
    type: string
    description: "Additional flags for go test"
    default: "-race -count=1"

  workspaces:
  - name: source
    description: "Source code workspace"
  - name: cache
    description: "Go module cache"
    optional: true

  results:
  - name: binary-path
    description: "Path to the compiled binary"
  - name: test-coverage
    description: "Test coverage percentage"
  - name: commit-sha
    description: "Git commit SHA from the source workspace"

  stepTemplate:
    image: golang:$(params.go-version)-alpine
    workingDir: /workspace/source
    env:
    - name: GOCACHE
      value: /workspace/cache/gocache
    - name: GOMODCACHE
      value: /workspace/cache/gomodcache
    - name: CGO_ENABLED
      value: "0"
    - name: GOFLAGS
      value: "-mod=vendor"

  steps:
  - name: get-commit-sha
    image: alpine/git:latest
    script: |
      #!/bin/sh
      set -e
      cd /workspace/source
      SHA=$(git rev-parse HEAD)
      echo -n "${SHA}" > $(results.commit-sha.path)
      echo "Commit SHA: ${SHA}"

  - name: download-deps
    script: |
      #!/bin/sh
      set -e
      if [ ! -d vendor ]; then
        go mod download
        go mod vendor
      fi
      echo "Dependencies ready"

  - name: build
    script: |
      #!/bin/sh
      set -e
      OUTPUT_PATH=/workspace/source/bin/$(basename $(params.package))
      go build -v -o ${OUTPUT_PATH} ./cmd/...
      echo -n "${OUTPUT_PATH}" > $(results.binary-path.path)
      echo "Built: ${OUTPUT_PATH}"

  - name: test
    script: |
      #!/bin/sh
      set -e
      if [ "$(params.run-tests)" != "true" ]; then
        echo "Tests skipped"
        echo -n "0" > $(results.test-coverage.path)
        exit 0
      fi
      go test $(params.test-flags) -coverprofile=coverage.out ./...
      COVERAGE=$(go tool cover -func=coverage.out | grep total | awk '{print $3}' | tr -d '%')
      echo -n "${COVERAGE}" > $(results.test-coverage.path)
      echo "Coverage: ${COVERAGE}%"
      go tool cover -html=coverage.out -o /workspace/source/coverage.html

  - name: lint
    image: golangci/golangci-lint:latest
    script: |
      #!/bin/sh
      cd /workspace/source
      golangci-lint run --timeout=5m ./...
```

### Building a Container Image with Kaniko

```yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: kaniko-build-push
  namespace: tekton-pipelines
spec:
  params:
  - name: image
    type: string
    description: "Full image reference including registry and tag"
  - name: dockerfile
    type: string
    default: "./Dockerfile"
  - name: context
    type: string
    default: "./"
  - name: build-args
    type: array
    default: []

  workspaces:
  - name: source
    description: "Source code"
  - name: docker-credentials
    description: "Docker config.json secret"
    mountPath: /kaniko/.docker

  results:
  - name: image-digest
    description: "Image digest"
  - name: image-url
    description: "Full image URL with digest"

  steps:
  - name: build-and-push
    image: gcr.io/kaniko-project/executor:latest
    args:
    - --dockerfile=$(params.dockerfile)
    - --context=dir:///workspace/source/$(params.context)
    - --destination=$(params.image)
    - --digest-file=$(results.image-digest.path)
    - --cache=true
    - --cache-ttl=24h
    - --compressed-caching=false
    - --snapshot-mode=redo
    - $(params.build-args[*])
    env:
    - name: DOCKER_CONFIG
      value: /kaniko/.docker
    securityContext:
      runAsUser: 0

  - name: write-image-url
    image: alpine:3.19
    script: |
      #!/bin/sh
      DIGEST=$(cat $(results.image-digest.path))
      IMAGE_REPO=$(echo "$(params.image)" | cut -d: -f1)
      echo -n "${IMAGE_REPO}@${DIGEST}" > $(results.image-url.path)
      echo "Image: ${IMAGE_REPO}@${DIGEST}"
```

### Composing a Full CI Pipeline

```yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: go-application-ci
  namespace: tekton-pipelines
spec:
  description: "Full CI pipeline for a Go application"

  params:
  - name: repo-url
    type: string
  - name: revision
    type: string
    default: main
  - name: image-registry
    type: string
    default: ghcr.io/org
  - name: app-name
    type: string
  - name: go-package
    type: string

  workspaces:
  - name: shared-workspace
    description: "Shared workspace for all tasks"
  - name: go-cache
    description: "Go module and build cache"
    optional: true
  - name: docker-credentials
    description: "Docker registry credentials"

  results:
  - name: image-url
    description: "Built and pushed image URL"
    value: $(tasks.build-image.results.image-url)
  - name: image-digest
    description: "Image digest"
    value: $(tasks.build-image.results.image-digest)
  - name: commit-sha
    description: "Commit SHA"
    value: $(tasks.build-test.results.commit-sha)

  tasks:
  # Clone the repository
  - name: clone
    taskRef:
      resolver: hub
      params:
      - name: kind
        value: task
      - name: name
        value: git-clone
      - name: version
        value: "0.9"
    params:
    - name: url
      value: $(params.repo-url)
    - name: revision
      value: $(params.revision)
    - name: deleteExisting
      value: "true"
    workspaces:
    - name: output
      workspace: shared-workspace

  # Build and test
  - name: build-test
    runAfter: [clone]
    taskRef:
      kind: Task
      name: go-build-test
    params:
    - name: package
      value: $(params.go-package)
    workspaces:
    - name: source
      workspace: shared-workspace
    - name: cache
      workspace: go-cache

  # Static analysis — runs in parallel with build-test after clone
  - name: security-scan
    runAfter: [clone]
    taskRef:
      resolver: hub
      params:
      - name: kind
        value: task
      - name: name
        value: trivy-scanner
      - name: version
        value: "0.2"
    params:
    - name: IMAGE_PATH
      value: /workspace/source
    - name: ARGS
      value: ["filesystem", "--exit-code", "1", "--severity", "HIGH,CRITICAL"]
    workspaces:
    - name: manifest-dir
      workspace: shared-workspace

  # Build container image
  - name: build-image
    runAfter: [build-test, security-scan]
    taskRef:
      kind: Task
      name: kaniko-build-push
    params:
    - name: image
      value: "$(params.image-registry)/$(params.app-name):$(tasks.clone.results.commit)"
    workspaces:
    - name: source
      workspace: shared-workspace
    - name: docker-credentials
      workspace: docker-credentials

  # Sign image with Cosign (Tekton Chains also does this automatically)
  - name: sign-image
    runAfter: [build-image]
    taskRef:
      resolver: hub
      params:
      - name: kind
        value: task
      - name: name
        value: cosign
      - name: version
        value: "0.1"
    params:
    - name: IMAGE
      value: $(tasks.build-image.results.image-url)
    - name: COSIGN_FLAGS
      value: "--yes"
    workspaces:
    - name: source
      workspace: shared-workspace

  # Update manifests with new image tag
  - name: update-manifests
    runAfter: [sign-image]
    taskRef:
      resolver: hub
      params:
      - name: kind
        value: task
      - name: name
        value: github-set-status
      - name: version
        value: "0.4"
    params:
    - name: REPO_FULL_NAME
      value: org/$(params.app-name)
    - name: SHA
      value: $(tasks.build-test.results.commit-sha)
    - name: TARGET_URL
      value: ""
    - name: DESCRIPTION
      value: "Build successful — $(tasks.build-image.results.image-url)"
    - name: CONTEXT
      value: ci/build
    - name: STATE
      value: success

  finally:
  # Always run cleanup
  - name: cleanup
    taskRef:
      kind: Task
      name: cleanup-workspace
    workspaces:
    - name: source
      workspace: shared-workspace
```

## Section 3: Tekton Hub Reusable Tasks

Tekton Hub provides a community catalog of pre-built Tasks. Using the Hub resolver eliminates the need to copy task definitions into every cluster.

### Configuring the Hub Resolver

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: hubresolver-config
  namespace: tekton-pipelines-resolvers
data:
  default-tekton-hub-catalog: tekton
  tekton-hub-api: "https://api.hub.tekton.dev"
  default-artifact-hub-task-version: "0.6"
  default-artifact-hub-pipeline-version: "0.2"
```

### Common Hub Tasks

```yaml
# Git clone from Tekton Hub
- name: clone
  taskRef:
    resolver: hub
    params:
    - name: kind
      value: task
    - name: name
      value: git-clone
    - name: version
      value: "0.9"

# Buildah container build
- name: build-image
  taskRef:
    resolver: hub
    params:
    - name: kind
      value: task
    - name: name
      value: buildah
    - name: version
      value: "0.6"

# Helm upgrade/install
- name: deploy-helm
  taskRef:
    resolver: hub
    params:
    - name: kind
      value: task
    - name: name
      value: helm-upgrade-from-source
    - name: version
      value: "0.4"

# Send Slack notification
- name: notify-slack
  taskRef:
    resolver: hub
    params:
    - name: kind
      value: task
    - name: name
      value: send-to-webhook-slack
    - name: version
      value: "0.1"
```

### Creating a Tekton Bundle (OCI-backed Task Registry)

```bash
# Package local tasks as a Tekton bundle in OCI registry
tkn bundle push ghcr.io/org/tekton-catalog:latest \
  -f tasks/go-build-test.yaml \
  -f tasks/kaniko-build-push.yaml \
  -f pipelines/go-application-ci.yaml

# Reference from a bundle resolver
taskRef:
  resolver: bundles
  params:
  - name: bundle
    value: ghcr.io/org/tekton-catalog:latest
  - name: name
    value: go-build-test
  - name: kind
    value: Task
```

## Section 4: Tekton Triggers for Webhook-Driven Pipelines

Tekton Triggers connects external webhook events to pipeline execution through a chain of objects: EventListener, Trigger, TriggerBinding, and TriggerTemplate.

### EventListener

The EventListener creates a Service that receives webhook HTTP requests:

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: EventListener
metadata:
  name: github-ci-listener
  namespace: tekton-pipelines
spec:
  serviceAccountName: tekton-triggers-sa
  triggers:
  - name: github-push-trigger
    interceptors:
    # Validate GitHub webhook signature
    - ref:
        name: github
      params:
      - name: secretRef
        value:
          secretName: github-webhook-secret
          secretKey: secret
      - name: eventTypes
        value: ["push"]
    # Filter: only trigger on pushes to main or release branches
    - ref:
        name: cel
      params:
      - name: filter
        value: >
          (header.match("X-GitHub-Event", "push") &&
           (body.ref == "refs/heads/main" ||
            body.ref.startsWith("refs/heads/release/")))
      - name: overlays
        value:
        - key: branch_name
          expression: "body.ref.split('/')[2]"
        - key: short_sha
          expression: "body.head_commit.id.truncate(8)"
        - key: app_name
          expression: "body.repository.name"
    bindings:
    - ref: github-push-binding
    template:
      ref: go-ci-pipeline-template

  - name: github-pr-trigger
    interceptors:
    - ref:
        name: github
      params:
      - name: secretRef
        value:
          secretName: github-webhook-secret
          secretKey: secret
      - name: eventTypes
        value: ["pull_request"]
    - ref:
        name: cel
      params:
      - name: filter
        value: >
          body.action in ["opened", "synchronize", "reopened"]
    bindings:
    - ref: github-pr-binding
    template:
      ref: go-ci-pr-pipeline-template
```

### TriggerBinding

TriggerBindings extract values from the webhook payload:

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerBinding
metadata:
  name: github-push-binding
  namespace: tekton-pipelines
spec:
  params:
  - name: repo-url
    value: $(body.repository.clone_url)
  - name: revision
    value: $(body.head_commit.id)
  - name: branch
    value: $(extensions.branch_name)
  - name: short-sha
    value: $(extensions.short_sha)
  - name: app-name
    value: $(extensions.app_name)
  - name: author
    value: $(body.head_commit.author.name)
  - name: commit-message
    value: $(body.head_commit.message)
```

### TriggerTemplate

TriggerTemplates define the PipelineRun to create when a trigger fires:

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerTemplate
metadata:
  name: go-ci-pipeline-template
  namespace: tekton-pipelines
spec:
  params:
  - name: repo-url
  - name: revision
  - name: branch
  - name: short-sha
  - name: app-name
  - name: author
  - name: commit-message

  resourcetemplates:
  - apiVersion: tekton.dev/v1
    kind: PipelineRun
    metadata:
      generateName: "$(tt.params.app-name)-ci-"
      namespace: tekton-pipelines
      labels:
        tekton.dev/pipeline: go-application-ci
        app: $(tt.params.app-name)
        branch: $(tt.params.branch)
        commit: $(tt.params.short-sha)
      annotations:
        tekton.dev/gitURL: $(tt.params.repo-url)
        tekton.dev/gitRevision: $(tt.params.revision)
    spec:
      pipelineRef:
        name: go-application-ci
      params:
      - name: repo-url
        value: $(tt.params.repo-url)
      - name: revision
        value: $(tt.params.revision)
      - name: app-name
        value: $(tt.params.app-name)
      - name: go-package
        value: github.com/org/$(tt.params.app-name)
      - name: image-registry
        value: ghcr.io/org
      serviceAccountName: pipeline-runner-sa
      workspaces:
      - name: shared-workspace
        volumeClaimTemplate:
          spec:
            accessModes: [ReadWriteOnce]
            storageClassName: gp3
            resources:
              requests:
                storage: 5Gi
      - name: go-cache
        persistentVolumeClaim:
          claimName: go-module-cache-$(tt.params.app-name)
          readOnly: false
      - name: docker-credentials
        secret:
          secretName: ghcr-credentials
      timeouts:
        pipeline: 30m
        tasks: 20m
        finally: 5m
      taskRunTemplate:
        podTemplate:
          nodeSelector:
            node-role: ci
          tolerations:
          - key: ci
            operator: Exists
            effect: NoSchedule
          securityContext:
            runAsNonRoot: true
            seccompProfile:
              type: RuntimeDefault
```

### RBAC for Triggers

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: tekton-triggers-sa
  namespace: tekton-pipelines
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: tekton-triggers-role
  namespace: tekton-pipelines
rules:
- apiGroups: ["triggers.tekton.dev"]
  resources: ["eventlisteners", "triggerbindings", "triggertemplates", "triggers"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["tekton.dev"]
  resources: ["pipelineruns", "pipelineresources", "taskruns"]
  verbs: ["create", "delete"]
- apiGroups: [""]
  resources: ["configmaps", "secrets", "serviceaccounts"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: tekton-triggers-rolebinding
  namespace: tekton-pipelines
subjects:
- kind: ServiceAccount
  name: tekton-triggers-sa
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: tekton-triggers-role
```

## Section 5: Tekton Chains — Supply Chain Security

Tekton Chains is the supply chain security component of Tekton. It automatically intercepts TaskRun completions and generates signed attestations that prove what was built, from what source, and using what process.

### Chains Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: chains-config
  namespace: tekton-chains
data:
  # Artifact storage — where to push attestations
  artifacts.taskrun.format: "slsav1"
  artifacts.taskrun.storage: "oci"
  artifacts.taskrun.signer: "cosign"

  # OCI image attestations
  artifacts.oci.format: "simplesigning"
  artifacts.oci.storage: "oci,tekton"
  artifacts.oci.signer: "cosign"

  # SLSA provenance level
  artifacts.taskrun.signer.fulcio.enabled: "true"

  # Transparency log
  transparency.enabled: "true"
  transparency.url: "https://rekor.sigstore.dev"

  # Builder ID (appears in SLSA provenance)
  builder.id: "https://tekton.example.com/chains/v2"
```

### Signing Keys

For keyless signing with Fulcio (recommended for Kubernetes workloads):

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: chains-config
  namespace: tekton-chains
data:
  signers.x509.fulcio.enabled: "true"
  signers.x509.fulcio.address: "https://fulcio.sigstore.dev"
  signers.x509.rekor.address: "https://rekor.sigstore.dev"
```

For key-based signing (for air-gapped environments):

```bash
# Generate cosign key pair
cosign generate-key-pair k8s://tekton-chains/signing-secrets

# This creates a Kubernetes Secret with the private key
# The public key is stored in cosign.pub in the current directory
```

### SLSA Provenance Output

When Tekton Chains processes a TaskRun that built and pushed an image, it generates SLSA provenance. The provenance looks like:

```json
{
  "_type": "https://in-toto.io/Statement/v0.1",
  "predicateType": "https://slsa.dev/provenance/v1",
  "subject": [
    {
      "name": "ghcr.io/org/payment-api",
      "digest": {
        "sha256": "abc123def456..."
      }
    }
  ],
  "predicate": {
    "buildDefinition": {
      "buildType": "https://tekton.dev/chains/v2/slsa-tekton",
      "externalParameters": {
        "runSpec": {
          "pipelineRef": {
            "name": "go-application-ci"
          },
          "params": [
            {"name": "repo-url", "value": "https://github.com/org/payment-api"},
            {"name": "revision", "value": "abc123def456..."}
          ]
        }
      },
      "resolvedDependencies": [
        {
          "name": "pipeline",
          "uri": "https://github.com/org/platform-gitops",
          "digest": {"sha256": "def456abc123..."}
        }
      ]
    },
    "runDetails": {
      "builder": {
        "id": "https://tekton.example.com/chains/v2"
      },
      "metadata": {
        "invocationId": "tekton-pipelines/pipelinerun-abc123",
        "startedOn": "2027-06-21T10:00:00Z",
        "finishedOn": "2027-06-21T10:15:00Z"
      }
    }
  }
}
```

### Verifying Attestations

```bash
# Verify image signature
cosign verify \
  --certificate-identity-regexp "https://github.com/org/*" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ghcr.io/org/payment-api:latest

# Verify SLSA provenance attestation
cosign verify-attestation \
  --type slsaprovenance1 \
  --certificate-identity-regexp "https://tekton.example.com/chains/v2" \
  --certificate-oidc-issuer "https://kubernetes.default.svc" \
  ghcr.io/org/payment-api:latest | jq '.payload | @base64d | fromjson'

# Download and inspect the in-toto attestation
cosign download attestation ghcr.io/org/payment-api:latest | \
  jq -r '.payload' | base64 -d | jq .
```

## Section 6: Workspace Caching Strategies

Cache management is critical for CI performance. Without caching, every pipeline run downloads all dependencies from scratch.

### PVC-Based Go Module Cache

```yaml
# Persistent cache PVC (one per app or shared)
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: go-module-cache-payment-api
  namespace: tekton-pipelines
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: gp3
  resources:
    requests:
      storage: 10Gi
```

### S3-Compatible Cache with MinIO

For multi-node cache sharing, use an object storage backend:

```yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: cache-restore
  namespace: tekton-pipelines
spec:
  params:
  - name: cache-key
    type: string
    description: "Cache key (e.g., go-$(hash of go.sum))"
  - name: paths
    type: array
    description: "Paths to restore from cache"

  workspaces:
  - name: target
    description: "Where to restore the cache"

  steps:
  - name: restore
    image: amazon/aws-cli:latest
    script: |
      #!/bin/bash
      set -e
      CACHE_KEY="$(params.cache-key)"
      BUCKET="tekton-cache"

      # Try exact key first, then fallback keys
      if aws s3 ls "s3://${BUCKET}/${CACHE_KEY}.tar.gz" 2>/dev/null; then
        echo "Cache hit: ${CACHE_KEY}"
        aws s3 cp "s3://${BUCKET}/${CACHE_KEY}.tar.gz" /tmp/cache.tar.gz
        tar -xzf /tmp/cache.tar.gz -C /workspace/target
        echo "Cache restored"
      else
        echo "Cache miss: ${CACHE_KEY}"
      fi
    env:
    - name: AWS_ENDPOINT_URL
      value: "http://minio.minio.svc.cluster.local:9000"
    - name: AWS_ACCESS_KEY_ID
      valueFrom:
        secretKeyRef:
          name: minio-credentials
          key: access-key
    - name: AWS_SECRET_ACCESS_KEY
      valueFrom:
        secretKeyRef:
          name: minio-credentials
          key: secret-key
    - name: AWS_DEFAULT_REGION
      value: us-east-1
```

## Section 7: Pipeline Monitoring and the Tekton Dashboard

### Prometheus Metrics

Tekton exposes Prometheus metrics for pipeline observability:

```yaml
# Key metrics
# tekton_pipelines_controller_running_taskruns_count
# tekton_pipelines_controller_running_pipelineruns_count
# tekton_pipelines_controller_taskrun_duration_seconds (histogram)
# tekton_pipelines_controller_pipelinerun_duration_seconds (histogram)
# tekton_pipelines_controller_taskrun_count (by state: succeed/failed/cancelled)
# tekton_pipelines_controller_pipelinerun_count (by state)
```

```yaml
# ServiceMonitor for Prometheus scraping
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: tekton-pipelines
  namespace: tekton-pipelines
  labels:
    app: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      app: tekton-pipelines-controller
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

### Dashboard Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tekton-dashboard
  namespace: tekton-pipelines
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: tekton-dashboard-auth
    nginx.ingress.kubernetes.io/auth-realm: "Tekton Dashboard"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - tekton.example.com
    secretName: tekton-dashboard-tls
  rules:
  - host: tekton.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: tekton-dashboard
            port:
              number: 9097
```

## Section 8: Comparison with Jenkins and GitHub Actions

### Tekton vs Jenkins

| Aspect | Tekton | Jenkins |
|--------|--------|---------|
| Infrastructure | Runs natively on Kubernetes, pipelines are pods | JVM-based master/agent model, K8s plugin required |
| Configuration | Kubernetes YAML custom resources | Groovy DSL (Jenkinsfile) or classic UI |
| Scalability | Scales with cluster autoscaler, no master bottleneck | Master is a single point of management; agent pools require tuning |
| Secret management | Native Kubernetes secrets, RBAC | Credentials plugin, encrypted at rest in Jenkins config |
| Supply chain security | Native via Tekton Chains, automatic SLSA provenance | Third-party plugins (in-toto, etc.), complex setup |
| Maintenance | Upgrade via kubectl/Helm, GitOps-friendly | Upgrade Jenkins JAR + plugin compatibility matrix |
| Learning curve | Kubernetes YAML familiarity required | Groovy familiarity required, large plugin ecosystem to learn |
| Plugin ecosystem | Growing catalog via Tekton Hub | Massive ecosystem (1800+ plugins), but some abandoned |

### Tekton vs GitHub Actions

| Aspect | Tekton | GitHub Actions |
|--------|--------|----------------|
| Infrastructure | Self-hosted on Kubernetes, full control | GitHub-managed runners or self-hosted |
| Cost | Cluster compute costs only | Per-minute billing on GitHub-managed runners |
| Portability | Any Kubernetes cluster, cloud-agnostic | Tied to GitHub; GitLab/Bitbucket require custom solutions |
| Supply chain security | Native Tekton Chains with SLSA provenance | Sigstore Actions available but not automatic |
| Workflow definition | Kubernetes YAML CRDs | YAML in `.github/workflows/` |
| Multi-repo workflows | ApplicationSet-style templating via TriggerTemplates | Reusable workflows, `workflow_call` |
| Marketplace | Tekton Hub (smaller) | GitHub Marketplace (thousands of actions) |
| Network access | Cluster's network policies apply | GitHub-managed runners have broad internet access |
| Secrets management | Kubernetes secrets, Vault, External Secrets | GitHub repository/organization secrets |

Tekton's primary advantages are infrastructure ownership, supply chain security via Chains, and portability. GitHub Actions wins on developer experience, marketplace ecosystem, and zero infrastructure maintenance. Many organizations use both: Tekton for internal platform work where supply chain provenance matters, and GitHub Actions for developer-facing workflows where iteration speed matters.

## Section 9: Operational Best Practices

### Resource Quota for Pipeline Workloads

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tekton-pipelines-quota
  namespace: tekton-pipelines
spec:
  hard:
    pods: "100"
    requests.cpu: "20"
    requests.memory: "40Gi"
    limits.cpu: "40"
    limits.memory: "80Gi"
    persistentvolumeclaims: "50"
    requests.storage: "500Gi"
```

### Automatic PipelineRun Cleanup

PipelineRun objects accumulate and consume etcd space. Configure automatic cleanup:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-leader-election
  namespace: tekton-pipelines
data:
  # Keep the last N successful/failed runs per pipeline
  max-taskruns: "5"
  max-pipelineruns: "5"
```

Using a CronJob for cleanup:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: tekton-cleanup
  namespace: tekton-pipelines
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: tekton-cleanup-sa
          restartPolicy: OnFailure
          containers:
          - name: cleanup
            image: bitnami/kubectl:latest
            command:
            - /bin/sh
            - -c
            - |
              # Delete completed PipelineRuns older than 7 days
              kubectl get pipelinerun -n tekton-pipelines \
                --sort-by='.metadata.creationTimestamp' \
                -o json | \
              jq -r '.items[] | select(.status.completionTime != null) |
                select((now - (.status.completionTime | fromdateiso8601)) > 604800) |
                .metadata.name' | \
              xargs -r kubectl delete pipelinerun -n tekton-pipelines
```

Tekton's Kubernetes-native architecture, combined with Chains' automatic supply chain attestation, creates a CI/CD platform that satisfies both developer productivity requirements and enterprise security mandates. The ability to generate SLSA provenance automatically for every pipeline run without any developer changes is Tekton's most compelling enterprise feature.
