---
title: "Tekton Pipelines: Cloud-Native CI/CD for Kubernetes Workloads"
date: 2030-05-27T00:00:00-05:00
draft: false
tags: ["Tekton", "CI/CD", "Kubernetes", "DevOps", "GitOps", "Pipelines", "Go"]
categories:
- Kubernetes
- CI/CD
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Tekton implementation: Tasks and Pipelines, Workspaces, Triggers, PipelineRuns, secrets management with external secrets, caching strategies, and production pipeline patterns for Go services."
more_link: "yes"
url: "/tekton-pipelines-cloud-native-cicd-kubernetes-enterprise-guide/"
---

Tekton Pipelines is a Kubernetes-native CI/CD framework that defines build, test, and deploy workflows as first-class Kubernetes resources. Unlike Jenkins or GitLab CI, which run pipeline logic in external orchestration engines, Tekton executes every step as a container running directly in the cluster. This approach aligns pipeline infrastructure with the same resource management, RBAC, networking, and observability stack used for production workloads.

This guide covers production Tekton deployment for a Go service pipeline, including workspace management, trigger configuration, secrets integration with External Secrets Operator, and caching strategies that reduce build times from minutes to seconds.

<!--more-->

## Architecture and Core Concepts

### Resource Hierarchy

Tekton organizes CI/CD work into a hierarchy of CRDs:

```
ClusterTask / Task          -- Reusable step definitions (what to run)
Pipeline                    -- Ordered sequence of Tasks
TriggerTemplate             -- Template for creating PipelineRuns from events
TriggerBinding              -- Extracts parameters from webhook payloads
EventListener               -- HTTP server receiving webhook events
PipelineRun                 -- Single execution instance of a Pipeline
TaskRun                     -- Single execution instance of a Task
```

```
EventListener
    └── Interceptor (validate, filter)
        └── TriggerBinding (extract params from payload)
            └── TriggerTemplate (create PipelineRun)
                └── PipelineRun
                    └── Pipeline
                        ├── Task: clone
                        ├── Task: lint
                        ├── Task: test
                        ├── Task: build
                        └── Task: deploy
```

### Installation

```bash
# Install Tekton Pipelines
kubectl apply -f https://storage.googleapis.com/tekton-releases/pipeline/latest/release.yaml

# Install Tekton Triggers
kubectl apply -f https://storage.googleapis.com/tekton-releases/triggers/latest/release.yaml

# Install Tekton Dashboard
kubectl apply -f https://storage.googleapis.com/tekton-releases/dashboard/latest/release.yaml

# Install Tekton CLI
curl -LO https://github.com/tektoncd/cli/releases/latest/download/tkn_linux_amd64.tar.gz
tar xzf tkn_linux_amd64.tar.gz
sudo mv tkn /usr/local/bin/

# Verify installation
kubectl get pods -n tekton-pipelines
# NAME                                           READY   STATUS    RESTARTS
# tekton-pipelines-controller-7f9d58d9c7-lmx2q  1/1     Running   0
# tekton-pipelines-webhook-7d5d4fd7d4-9k5pb      1/1     Running   0
```

### Tekton Feature Configuration

```yaml
# tekton-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: feature-flags
  namespace: tekton-pipelines
data:
  # Enable alpha features (resolver, matrix, etc.)
  enable-api-fields: "stable"
  # Enable OCI bundle resolvers
  enable-tekton-oci-bundles: "false"
  # Set default timeout for TaskRuns
  default-timeout-minutes: "60"
  # Maximum number of TaskRun retries
  # default-max-matrix-combinations-count: "256"
  # Enable step action
  enable-step-actions: "stable"
```

## Task Definitions

### Reusable Go Build Task

```yaml
# task-go-build.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: go-build
  namespace: tekton-pipelines
  labels:
    app.kubernetes.io/version: "0.1"
  annotations:
    tekton.dev/pipelines.minVersion: "0.50.0"
    tekton.dev/tags: go,build
spec:
  description: >-
    Builds a Go binary, runs tests, and produces a container image.
    Requires a workspace with the source code checked out.

  params:
    - name: package
      description: Go module path (e.g., github.com/company/app)
      type: string
    - name: packages
      description: Packages to build (e.g., ./cmd/server)
      type: string
      default: "./..."
    - name: go-version
      description: Go version to use
      type: string
      default: "1.22"
    - name: flags
      description: Additional go build flags
      type: string
      default: "-ldflags='-w -s'"
    - name: goflags
      description: GOFLAGS environment variable
      type: string
      default: ""
    - name: goproxy
      description: GOPROXY value
      type: string
      default: "https://proxy.golang.org,direct"

  workspaces:
    - name: source
      description: Workspace containing the Go source code
    - name: cache
      description: Go module cache workspace
      optional: true

  results:
    - name: test-count
      description: Number of tests executed
    - name: coverage
      description: Code coverage percentage

  steps:
    - name: download-modules
      image: golang:$(params.go-version)
      workingDir: $(workspaces.source.path)
      env:
        - name: GOPATH
          value: /go
        - name: GOCACHE
          value: $(workspaces.cache.path)/go-build-cache
        - name: GOMODCACHE
          value: $(workspaces.cache.path)/go-mod-cache
        - name: GOPROXY
          value: $(params.goproxy)
        - name: GONOSUMCHECK
          value: "*.internal.example.com"
        - name: GOFLAGS
          value: $(params.goflags)
      script: |
        #!/bin/bash
        set -euo pipefail
        echo "Downloading Go modules..."
        go mod download
        go mod verify
        echo "Module download complete"

    - name: lint
      image: golangci/golangci-lint:v1.57.2
      workingDir: $(workspaces.source.path)
      env:
        - name: GOPATH
          value: /go
        - name: GOCACHE
          value: $(workspaces.cache.path)/go-build-cache
        - name: GOMODCACHE
          value: $(workspaces.cache.path)/go-mod-cache
      script: |
        #!/bin/bash
        set -euo pipefail
        golangci-lint run \
          --timeout=5m \
          --out-format=github-actions \
          --issues-exit-code=1 \
          $(params.packages)

    - name: test
      image: golang:$(params.go-version)
      workingDir: $(workspaces.source.path)
      env:
        - name: GOPATH
          value: /go
        - name: GOCACHE
          value: $(workspaces.cache.path)/go-build-cache
        - name: GOMODCACHE
          value: $(workspaces.cache.path)/go-mod-cache
        - name: GOPROXY
          value: $(params.goproxy)
      script: |
        #!/bin/bash
        set -euo pipefail

        go test \
          -v \
          -race \
          -coverprofile=/workspace/coverage.out \
          -covermode=atomic \
          $(params.packages) \
          2>&1 | tee /workspace/test-output.txt

        # Extract test count
        TEST_COUNT=$(grep -c "^--- " /workspace/test-output.txt || echo "0")
        echo -n "$TEST_COUNT" | tee $(results.test-count.path)

        # Extract coverage
        COVERAGE=$(go tool cover -func=/workspace/coverage.out | grep total | awk '{print $3}' | tr -d '%')
        echo -n "$COVERAGE" | tee $(results.coverage.path)

        echo "Tests passed: $TEST_COUNT, Coverage: ${COVERAGE}%"

    - name: build
      image: golang:$(params.go-version)
      workingDir: $(workspaces.source.path)
      env:
        - name: GOPATH
          value: /go
        - name: GOCACHE
          value: $(workspaces.cache.path)/go-build-cache
        - name: GOMODCACHE
          value: $(workspaces.cache.path)/go-mod-cache
        - name: GOPROXY
          value: $(params.goproxy)
        - name: CGO_ENABLED
          value: "0"
        - name: GOOS
          value: linux
        - name: GOARCH
          value: amd64
      script: |
        #!/bin/bash
        set -euo pipefail
        echo "Building Go binary..."
        go build \
          $(params.flags) \
          -o /workspace/bin/app \
          $(params.packages)
        echo "Build complete: $(du -sh /workspace/bin/app)"
```

### Container Image Build Task (Kaniko)

```yaml
# task-kaniko-build.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: kaniko-build
  namespace: tekton-pipelines
spec:
  params:
    - name: image
      description: Full image name with tag (registry/repo/name:tag)
      type: string
    - name: dockerfile
      description: Path to Dockerfile relative to context
      type: string
      default: ./Dockerfile
    - name: context
      description: Build context path
      type: string
      default: ./
    - name: build-args
      description: Build arguments (KEY=VALUE format, one per line)
      type: string
      default: ""
    - name: extra-args
      description: Additional kaniko flags
      type: string
      default: "--cache=true --cache-ttl=24h"

  workspaces:
    - name: source
      description: Source code workspace
    - name: docker-config
      description: Docker config.json for registry authentication

  results:
    - name: image-digest
      description: Digest of the built image

  steps:
    - name: build-and-push
      image: gcr.io/kaniko-project/executor:v1.23.0
      workingDir: $(workspaces.source.path)
      env:
        - name: DOCKER_CONFIG
          value: $(workspaces.docker-config.path)
      args:
        - --dockerfile=$(params.dockerfile)
        - --context=$(params.context)
        - --destination=$(params.image)
        - --digest-file=$(results.image-digest.path)
        - --build-arg=$(params.build-args)
        - --cache=true
        - --cache-ttl=24h
        - --cache-repo=$(params.image)-cache
        - --compressed-caching=false
        - --snapshot-mode=redo
        - --use-new-run
        $(params.extra-args)
      resources:
        requests:
          memory: 512Mi
          cpu: 500m
        limits:
          memory: 2Gi
          cpu: 2000m
```

### Git Clone Task

```yaml
# task-git-clone.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: git-clone
  namespace: tekton-pipelines
spec:
  params:
    - name: url
      description: Git repository URL
      type: string
    - name: revision
      description: Git revision (branch, tag, SHA)
      type: string
      default: main
    - name: depth
      description: Shallow clone depth (0 = full history)
      type: string
      default: "1"
    - name: submodules
      description: Initialize and fetch git submodules
      type: string
      default: "true"

  workspaces:
    - name: output
      description: Workspace where repository is cloned
    - name: ssh-directory
      description: SSH key for private repositories
      optional: true
    - name: basic-auth
      description: Username/password for HTTPS authentication
      optional: true

  results:
    - name: commit
      description: The precise commit SHA cloned
    - name: url
      description: The URL cloned

  steps:
    - name: clone
      image: gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/git-init:v0.50.0
      env:
        - name: HOME
          value: /tekton/home
      script: |
        #!/bin/bash
        set -euo pipefail

        # Configure SSH if workspace provided
        if [ -d "$(workspaces.ssh-directory.path)" ]; then
          mkdir -p ~/.ssh
          cp -r $(workspaces.ssh-directory.path)/. ~/.ssh/
          chmod 700 ~/.ssh
          chmod 600 ~/.ssh/id_* 2>/dev/null || true
          chmod 644 ~/.ssh/known_hosts 2>/dev/null || true
        fi

        /ko-app/git-init \
          -url="$(params.url)" \
          -revision="$(params.revision)" \
          -path="$(workspaces.output.path)" \
          -depth="$(params.depth)" \
          -submodules="$(params.submodules)"

        cd "$(workspaces.output.path)"
        RESULT_SHA="$(git rev-parse HEAD)"
        echo -n "${RESULT_SHA}" > "$(results.commit.path)"
        echo -n "$(params.url)"  > "$(results.url.path)"
        echo "Cloned $(params.url) at ${RESULT_SHA}"
```

## Pipeline Definition

### Full Go Service Pipeline

```yaml
# pipeline-go-service.yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: go-service-pipeline
  namespace: tekton-pipelines
  labels:
    app.kubernetes.io/version: "1.0"
spec:
  description: >-
    Full CI/CD pipeline for Go services: clone, lint, test, build image,
    scan for vulnerabilities, and deploy to Kubernetes.

  params:
    - name: git-url
      type: string
      description: Git repository URL
    - name: git-revision
      type: string
      description: Git revision to build
      default: main
    - name: image-name
      type: string
      description: Container image name (without tag)
    - name: image-tag
      type: string
      description: Container image tag
    - name: go-version
      type: string
      default: "1.22"
    - name: deploy-namespace
      type: string
      description: Kubernetes namespace to deploy to
      default: production
    - name: skip-deploy
      type: string
      description: Skip deployment step
      default: "false"

  workspaces:
    - name: source-code
      description: Shared workspace for source code
    - name: go-cache
      description: Go module and build cache
    - name: docker-config
      description: Docker registry credentials
    - name: git-credentials
      description: Git authentication (SSH key or token)
      optional: true

  results:
    - name: image-digest
      description: Digest of built container image
      value: $(tasks.build-image.results.image-digest)
    - name: commit-sha
      description: Git commit SHA that was built
      value: $(tasks.clone.results.commit)

  tasks:
    # Step 1: Clone the repository
    - name: clone
      taskRef:
        name: git-clone
      params:
        - name: url
          value: $(params.git-url)
        - name: revision
          value: $(params.git-revision)
        - name: depth
          value: "0"  # Full history for accurate versioning
      workspaces:
        - name: output
          workspace: source-code
        - name: ssh-directory
          workspace: git-credentials

    # Step 2: Run Go build, lint, and tests
    - name: go-build-test
      taskRef:
        name: go-build
      runAfter:
        - clone
      params:
        - name: package
          value: "github.com/company/$(params.image-name)"
        - name: packages
          value: "./..."
        - name: go-version
          value: $(params.go-version)
      workspaces:
        - name: source
          workspace: source-code
        - name: cache
          workspace: go-cache

    # Step 3: Security scan (SAST)
    - name: security-scan
      taskRef:
        name: trivy-scan
      runAfter:
        - clone
      params:
        - name: scan-type
          value: "fs"
        - name: scan-target
          value: "$(workspaces.source.path)"
        - name: severity
          value: "HIGH,CRITICAL"
        - name: exit-code
          value: "1"
      workspaces:
        - name: source
          workspace: source-code

    # Step 4: Build container image (after tests pass)
    - name: build-image
      taskRef:
        name: kaniko-build
      runAfter:
        - go-build-test
        - security-scan
      params:
        - name: image
          value: "$(params.image-name):$(params.image-tag)"
        - name: dockerfile
          value: ./Dockerfile
        - name: context
          value: ./
      workspaces:
        - name: source
          workspace: source-code
        - name: docker-config
          workspace: docker-config

    # Step 5: Container image vulnerability scan
    - name: scan-image
      taskRef:
        name: trivy-scan
      runAfter:
        - build-image
      params:
        - name: scan-type
          value: "image"
        - name: scan-target
          value: "$(params.image-name):$(params.image-tag)@$(tasks.build-image.results.image-digest)"
        - name: severity
          value: "CRITICAL"
        - name: exit-code
          value: "1"

    # Step 6: Deploy to Kubernetes
    - name: deploy
      taskRef:
        name: kubectl-deploy
      runAfter:
        - scan-image
      when:
        - input: $(params.skip-deploy)
          operator: in
          values: ["false"]
      params:
        - name: image
          value: "$(params.image-name):$(params.image-tag)@$(tasks.build-image.results.image-digest)"
        - name: namespace
          value: $(params.deploy-namespace)

  finally:
    # Always run: publish test results and notifications
    - name: publish-results
      taskRef:
        name: notify-pipeline-result
      params:
        - name: pipeline-status
          value: $(tasks.status)
        - name: image-tag
          value: $(params.image-tag)
        - name: commit-sha
          value: $(tasks.clone.results.commit)
```

## Workspaces and Caching

### PersistentVolumeClaim for Module Cache

```yaml
# pvc-go-cache.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: go-module-cache
  namespace: tekton-pipelines
spec:
  accessModes:
    - ReadWriteMany    # Required if multiple PipelineRuns use same PVC
  storageClassName: nfs-client   # Must support RWX
  resources:
    requests:
      storage: 20Gi
---
# For single-run access, use ReadWriteOnce with VolumeClaimTemplate
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: go-build-cache
  namespace: tekton-pipelines
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: fast-ssd
  resources:
    requests:
      storage: 10Gi
```

### VolumeClaimTemplate in PipelineRun

```yaml
# pipelinerun-example.yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: go-service-run-abc123
  namespace: tekton-pipelines
spec:
  pipelineRef:
    name: go-service-pipeline
  params:
    - name: git-url
      value: https://github.com/company/app-backend.git
    - name: git-revision
      value: main
    - name: image-name
      value: registry.internal.example.com/company/app-backend
    - name: image-tag
      value: v1.4.2-abc1234
    - name: deploy-namespace
      value: production
  workspaces:
    # Ephemeral workspace per run using VolumeClaimTemplate
    - name: source-code
      volumeClaimTemplate:
        spec:
          accessModes:
            - ReadWriteOnce
          storageClassName: fast-ssd
          resources:
            requests:
              storage: 2Gi

    # Shared persistent cache across runs
    - name: go-cache
      persistentVolumeClaim:
        claimName: go-module-cache

    # Docker config from existing secret
    - name: docker-config
      secret:
        secretName: registry-credentials
  taskRunTemplate:
    serviceAccountName: tekton-pipeline-sa
    podTemplate:
      nodeSelector:
        dedicated: cicd
      tolerations:
        - key: dedicated
          operator: Equal
          value: cicd
          effect: NoSchedule
```

## Triggers Configuration

### EventListener for GitHub Webhooks

```yaml
# trigger-github.yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: EventListener
metadata:
  name: github-webhook-listener
  namespace: tekton-pipelines
spec:
  serviceAccountName: tekton-triggers-sa
  resources:
    kubernetesResource:
      replicas: 2
      spec:
        template:
          spec:
            resources:
              requests:
                memory: 64Mi
                cpu: 25m
              limits:
                memory: 128Mi
                cpu: 100m
  triggers:
    # Push to main branch: full pipeline with deployment
    - name: push-to-main
      interceptors:
        - ref:
            name: github
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: webhook-secret
            - name: eventTypes
              value: ["push"]
        - ref:
            name: cel
          params:
            - name: filter
              value: "body.ref == 'refs/heads/main'"
      bindings:
        - ref: github-push-binding
      template:
        ref: pipeline-run-template-main

    # Pull request: build and test only, no deployment
    - name: pull-request
      interceptors:
        - ref:
            name: github
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: webhook-secret
            - name: eventTypes
              value: ["pull_request"]
        - ref:
            name: cel
          params:
            - name: filter
              value: "body.action in ['opened', 'synchronize', 'reopened']"
      bindings:
        - ref: github-pr-binding
      template:
        ref: pipeline-run-template-pr
---
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerBinding
metadata:
  name: github-push-binding
  namespace: tekton-pipelines
spec:
  params:
    - name: git-url
      value: $(body.repository.clone_url)
    - name: git-revision
      value: $(body.after)
    - name: image-tag
      value: $(body.after)
    - name: repo-name
      value: $(body.repository.name)
---
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerBinding
metadata:
  name: github-pr-binding
  namespace: tekton-pipelines
spec:
  params:
    - name: git-url
      value: $(body.pull_request.head.repo.clone_url)
    - name: git-revision
      value: $(body.pull_request.head.sha)
    - name: image-tag
      value: pr-$(body.pull_request.number)-$(body.pull_request.head.sha)
    - name: repo-name
      value: $(body.repository.name)
---
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerTemplate
metadata:
  name: pipeline-run-template-main
  namespace: tekton-pipelines
spec:
  params:
    - name: git-url
    - name: git-revision
    - name: image-tag
    - name: repo-name
  resourcetemplates:
    - apiVersion: tekton.dev/v1
      kind: PipelineRun
      metadata:
        generateName: $(tt.params.repo-name)-main-
        namespace: tekton-pipelines
        labels:
          tekton.dev/pipeline: go-service-pipeline
          git-revision: $(tt.params.git-revision)
          trigger: push-main
      spec:
        pipelineRef:
          name: go-service-pipeline
        params:
          - name: git-url
            value: $(tt.params.git-url)
          - name: git-revision
            value: $(tt.params.git-revision)
          - name: image-name
            value: registry.internal.example.com/company/$(tt.params.repo-name)
          - name: image-tag
            value: $(tt.params.image-tag)
          - name: skip-deploy
            value: "false"
        workspaces:
          - name: source-code
            volumeClaimTemplate:
              spec:
                accessModes:
                  - ReadWriteOnce
                storageClassName: fast-ssd
                resources:
                  requests:
                    storage: 2Gi
          - name: go-cache
            persistentVolumeClaim:
              claimName: go-module-cache
          - name: docker-config
            secret:
              secretName: registry-credentials
        taskRunTemplate:
          serviceAccountName: tekton-pipeline-sa
```

## Secrets Management with External Secrets Operator

```yaml
# external-secret-registry.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: registry-credentials
  namespace: tekton-pipelines
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: registry-credentials
    creationPolicy: Owner
    template:
      type: kubernetes.io/dockerconfigjson
      data:
        .dockerconfigjson: |
          {
            "auths": {
              "registry.internal.example.com": {
                "username": "{{ .username }}",
                "password": "{{ .password }}",
                "auth": "{{ printf \"%s:%s\" .username .password | b64enc }}"
              }
            }
          }
  data:
    - secretKey: username
      remoteRef:
        key: secret/tekton/registry
        property: username
    - secretKey: password
      remoteRef:
        key: secret/tekton/registry
        property: password
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: github-webhook-secret
  namespace: tekton-pipelines
spec:
  refreshInterval: 24h
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: github-webhook-secret
    creationPolicy: Owner
  data:
    - secretKey: webhook-secret
      remoteRef:
        key: secret/tekton/github
        property: webhook-secret
```

## RBAC Configuration

```yaml
# rbac-tekton.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: tekton-pipeline-sa
  namespace: tekton-pipelines
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: tekton-pipeline-role
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "update", "patch"]
  - apiGroups: [""]
    resources: ["configmaps", "secrets"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: tekton-pipeline-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: tekton-pipeline-role
subjects:
  - kind: ServiceAccount
    name: tekton-pipeline-sa
    namespace: tekton-pipelines
---
# Separate SA for triggers (needs more permissions)
apiVersion: v1
kind: ServiceAccount
metadata:
  name: tekton-triggers-sa
  namespace: tekton-pipelines
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: tekton-triggers-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: tekton-triggers-eventlistener-roles
subjects:
  - kind: ServiceAccount
    name: tekton-triggers-sa
    namespace: tekton-pipelines
```

## Pipeline Observability and Operations

### Monitoring with Prometheus

```yaml
# podmonitor-tekton.yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: tekton-pipelines
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
      - tekton-pipelines
  selector:
    matchLabels:
      app: tekton-pipelines-controller
  podMetricsEndpoints:
    - port: metrics
      interval: 30s
```

### CLI Operations

```bash
# List recent PipelineRuns
tkn pipelinerun list -n tekton-pipelines --limit 10

# Watch a running pipeline
tkn pipelinerun logs -n tekton-pipelines --last -f

# Describe a PipelineRun in detail
tkn pipelinerun describe app-backend-main-abc123 -n tekton-pipelines

# Cancel a running PipelineRun
tkn pipelinerun cancel app-backend-main-abc123 -n tekton-pipelines

# Delete old PipelineRuns (keep last 10)
tkn pipelinerun delete \
  --keep 10 \
  -n tekton-pipelines \
  --label "tekton.dev/pipeline=go-service-pipeline"

# Re-run last pipeline with same parameters
tkn pipeline start go-service-pipeline \
  --last \
  -n tekton-pipelines \
  --use-param-defaults
```

### Automatic PipelineRun Cleanup

```yaml
# tekton-config-cleanup.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-leader-election
  namespace: tekton-pipelines
---
# Configure pruner for automatic cleanup
apiVersion: operator.tekton.dev/v1alpha1
kind: TektonConfig
metadata:
  name: config
spec:
  pruner:
    disabled: false
    schedule: "0 */6 * * *"   # Every 6 hours
    keep: 20                   # Keep last 20 PipelineRuns per pipeline
    keepSince: 168             # Keep PipelineRuns from last 7 days (168 hours)
    resources:
      - pipelinerun
      - taskrun
```

## Summary

Tekton Pipelines delivers a fully cloud-native CI/CD solution where every pipeline execution is a Kubernetes workload. The combination of fine-grained RBAC, workspace-based artifact sharing, and native integration with Kubernetes secrets management makes Tekton particularly well-suited for enterprise environments with strict security requirements.

The patterns covered—reusable task libraries, persistent caching for Go modules, trigger-based automation from GitHub webhooks, and External Secrets Operator integration—form the foundation of a production pipeline that achieves sub-5-minute build cycles while maintaining the auditability and reproducibility requirements of regulated industries.
