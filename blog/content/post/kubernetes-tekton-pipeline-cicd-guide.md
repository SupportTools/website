---
title: "Tekton Pipelines: Cloud-Native CI/CD on Kubernetes"
date: 2028-11-07T00:00:00-05:00
draft: false
tags: ["Tekton", "CI/CD", "Kubernetes", "DevOps", "Pipeline"]
categories:
- Tekton
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Tekton Pipelines on Kubernetes: Task and Pipeline authoring, Workspaces, Results, Triggers for webhook-driven execution, multi-stage Docker builds with kaniko, test result reporting, and comparison with GitHub Actions and Argo Workflows."
more_link: "yes"
url: "/kubernetes-tekton-pipeline-cicd-guide/"
---

Tekton is the CI/CD framework that runs entirely inside your Kubernetes cluster. Unlike GitHub Actions or CircleCI, there is no external CI service calling back into your cluster — every pipeline step runs as a Kubernetes Pod in your own infrastructure, using your cluster's RBAC, networking, and secrets management. This makes Tekton the right choice when you need CI/CD that runs in air-gapped environments, uses your existing Kubernetes node pools for compute, or integrates deeply with Kubernetes-native tooling like kaniko and kpack.

This guide covers everything from Task and Pipeline basics through production patterns: workspace sharing between steps, result passing between tasks, webhook-driven triggers, kaniko builds, and how Tekton compares to GitHub Actions and Argo Workflows.

<!--more-->

# Tekton Pipelines: Cloud-Native CI/CD on Kubernetes

## Installing Tekton

```bash
# Install Tekton Pipelines (the core execution engine)
kubectl apply -f https://storage.googleapis.com/tekton-releases/pipeline/latest/release.yaml

# Install Tekton Triggers (for webhook-driven pipelines)
kubectl apply -f https://storage.googleapis.com/tekton-releases/triggers/latest/release.yaml

# Install the Tekton Dashboard (UI for viewing pipeline runs)
kubectl apply -f https://storage.googleapis.com/tekton-releases/dashboard/latest/release.yaml

# Wait for all components to be ready
kubectl wait --for=condition=Ready pods --all -n tekton-pipelines --timeout=3m

# Install the Tekton CLI (tkn)
# On Linux:
curl -LO https://github.com/tektoncd/cli/releases/download/v0.37.0/tkn_0.37.0_Linux_x86_64.tar.gz
tar xvzf tkn_0.37.0_Linux_x86_64.tar.gz -C /usr/local/bin tkn

# Verify
tkn version
```

## Core Concepts

```
Task        — A series of Steps (containers) that run sequentially in one Pod
Pipeline    — A DAG of Tasks connected by dependencies and data flow
Workspace   — Shared storage (PVC, ConfigMap, Secret, or emptyDir) passed to Tasks
Result      — Small string values emitted by Tasks and consumed by later Tasks
PipelineRun — Instantiation of a Pipeline with specific parameters
TaskRun     — Instantiation of a Task with specific parameters
Trigger     — Webhook listener that creates PipelineRuns from events
```

## Writing a Task

A Task is the fundamental unit of work. Each Step is a container:

```yaml
# task-git-clone.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: git-clone
  namespace: ci
spec:
  description: >
    Clone a Git repository into a Workspace. Supports SSH and HTTPS,
    with optional submodule initialization.

  params:
    - name: url
      type: string
      description: Repository URL to clone
    - name: revision
      type: string
      description: Branch, tag, or commit SHA
      default: main
    - name: submodules
      type: string
      description: Initialize and fetch submodules
      default: "true"
    - name: depth
      type: string
      description: Git clone depth. 0 = full history.
      default: "1"

  workspaces:
    - name: output
      description: The git repo will be cloned into this workspace
    - name: ssh-directory
      optional: true
      description: SSH key for private repos (as a mounted Secret)
    - name: basic-auth
      optional: true
      description: Basic auth credentials (as a mounted Secret)

  results:
    - name: commit
      description: The precise commit SHA that was fetched
    - name: url
      description: The precise URL that was fetched

  steps:
    - name: clone
      image: gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/git-init:v0.59.0
      env:
        - name: HOME
          value: /tekton/home
        - name: PARAM_URL
          value: $(params.url)
        - name: PARAM_REVISION
          value: $(params.revision)
        - name: PARAM_SUBMODULES
          value: $(params.submodules)
        - name: PARAM_DEPTH
          value: $(params.depth)
        - name: WORKSPACE_OUTPUT_PATH
          value: $(workspaces.output.path)
        - name: WORKSPACE_SSH_DIRECTORY_BOUND
          value: $(workspaces.ssh-directory.bound)
        - name: WORKSPACE_SSH_DIRECTORY_PATH
          value: $(workspaces.ssh-directory.path)
      script: |
        #!/usr/bin/env sh
        set -eu

        if [ "${WORKSPACE_SSH_DIRECTORY_BOUND}" = "true" ]; then
          cp -R "${WORKSPACE_SSH_DIRECTORY_PATH}" "${HOME}/.ssh"
          chmod 700 "${HOME}/.ssh"
          chmod -R 400 "${HOME}/.ssh/*"
        fi

        /ko-app/git-init \
          -url="${PARAM_URL}" \
          -revision="${PARAM_REVISION}" \
          -path="${WORKSPACE_OUTPUT_PATH}" \
          -sslVerify=true \
          -submodules="${PARAM_SUBMODULES}" \
          -depth="${PARAM_DEPTH}"

        cd "${WORKSPACE_OUTPUT_PATH}"
        RESULT_SHA="$(git rev-parse HEAD)"
        printf "%s" "${RESULT_SHA}" > $(results.commit.path)
        printf "%s" "${PARAM_URL}" > $(results.url.path)
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 500m
          memory: 256Mi
```

## A Complete Go Application Task

```yaml
# task-go-test.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: go-test
  namespace: ci
spec:
  params:
    - name: package
      type: string
      description: The Go package to test
      default: "./..."
    - name: go-version
      type: string
      default: "1.23"
    - name: flags
      type: string
      description: Additional go test flags
      default: "-race -count=1"

  workspaces:
    - name: source
      description: The source code workspace
    - name: cache
      optional: true
      description: Go module cache

  results:
    - name: test-result
      description: "PASS or FAIL"
    - name: coverage
      description: Code coverage percentage

  stepTemplate:
    # stepTemplate applies to all steps in this Task
    image: golang:$(params.go-version)
    workingDir: $(workspaces.source.path)
    env:
      - name: GOPATH
        value: /home/nonroot/go
      - name: GOCACHE
        value: $(workspaces.cache.path)/go-build
      - name: GOMODCACHE
        value: $(workspaces.cache.path)/go-mod
      - name: CGO_ENABLED
        value: "0"
    securityContext:
      runAsNonRoot: true
      runAsUser: 65532

  steps:
    - name: download-deps
      script: |
        #!/usr/bin/env bash
        set -euo pipefail
        go mod download
        go mod verify

    - name: lint
      image: golangci/golangci-lint:v1.61.0
      workingDir: $(workspaces.source.path)
      script: |
        #!/usr/bin/env bash
        set -euo pipefail
        golangci-lint run --timeout=5m --out-format=colored-line-number

    - name: test
      script: |
        #!/usr/bin/env bash
        set -euo pipefail

        go test $(params.flags) \
          -coverprofile=/tmp/coverage.out \
          -covermode=atomic \
          $(params.package) \
          2>&1 | tee /tmp/test-output.txt

        TEST_EXIT_CODE=${PIPESTATUS[0]}

        # Extract coverage percentage
        COVERAGE=$(go tool cover -func=/tmp/coverage.out | grep total | awk '{print $3}')
        printf "%s" "${COVERAGE}" > $(results.coverage.path)

        if [ ${TEST_EXIT_CODE} -eq 0 ]; then
          printf "PASS" > $(results.test-result.path)
        else
          printf "FAIL" > $(results.test-result.path)
          exit 1
        fi

    - name: coverage-report
      script: |
        #!/usr/bin/env bash
        go tool cover -html=/tmp/coverage.out -o /tmp/coverage.html
        cp /tmp/coverage.html $(workspaces.source.path)/coverage.html
      onError: continue  # Don't fail the pipeline if the HTML report fails
```

## Building Container Images with kaniko

kaniko builds Docker images without requiring Docker daemon access, making it safe for Kubernetes environments:

```yaml
# task-kaniko-build.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: kaniko-build
  namespace: ci
spec:
  params:
    - name: image
      type: string
      description: Full image reference including registry and tag
    - name: dockerfile
      type: string
      default: Dockerfile
    - name: context
      type: string
      description: Path within source workspace (relative to workspace root)
      default: "."
    - name: build-args
      type: array
      description: Additional Docker build arguments
      default: []
    - name: extra-args
      type: array
      description: Additional kaniko flags
      default: []

  workspaces:
    - name: source
      description: Source code workspace containing the Dockerfile
    - name: dockerconfig
      description: Docker registry credentials (mounted from Secret)
      optional: true

  results:
    - name: image-digest
      description: The digest of the built image
    - name: image-url
      description: The fully qualified image URL with digest

  steps:
    - name: build-and-push
      image: gcr.io/kaniko-project/executor:v1.23.2-debug
      args:
        - --dockerfile=$(workspaces.source.path)/$(params.dockerfile)
        - --context=$(workspaces.source.path)/$(params.context)
        - --destination=$(params.image)
        - --digest-file=$(results.image-digest.path)
        - --cache=true
        - --cache-ttl=24h
        - "$(params.build-args[*])"
        - "$(params.extra-args[*])"
      env:
        - name: DOCKER_CONFIG
          value: $(workspaces.dockerconfig.path)
      resources:
        requests:
          cpu: 1000m
          memory: 2Gi
        limits:
          cpu: 4000m
          memory: 4Gi

    - name: record-image-url
      image: bash:5.2
      script: |
        #!/usr/bin/env bash
        DIGEST=$(cat $(results.image-digest.path))
        IMAGE_URL="$(params.image)@${DIGEST}"
        printf "%s" "${IMAGE_URL}" > $(results.image-url.path)
        echo "Built and pushed: ${IMAGE_URL}"
```

## Assembling a Pipeline

A Pipeline connects Tasks in a DAG with explicit dependencies:

```yaml
# pipeline-go-app.yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: go-app-pipeline
  namespace: ci
spec:
  description: >
    Full CI pipeline for a Go application: clone, test, build image,
    scan for vulnerabilities, and deploy to staging.

  params:
    - name: repo-url
      type: string
    - name: revision
      type: string
      default: main
    - name: image-registry
      type: string
      default: registry.example.com
    - name: app-name
      type: string
    - name: deploy-namespace
      type: string
      default: staging

  workspaces:
    - name: shared-data
      description: Shared workspace for source code across all tasks
    - name: go-cache
      description: Go module and build cache
    - name: docker-credentials
      description: Registry authentication
    - name: ssh-creds
      optional: true

  results:
    - name: commit-sha
      description: The commit SHA that was built
      value: $(tasks.clone.results.commit)
    - name: image-url
      description: The built and pushed image reference
      value: $(tasks.build-image.results.image-url)

  tasks:
    # 1. Clone the repository
    - name: clone
      taskRef:
        name: git-clone
        kind: Task
      params:
        - name: url
          value: $(params.repo-url)
        - name: revision
          value: $(params.revision)
      workspaces:
        - name: output
          workspace: shared-data
        - name: ssh-directory
          workspace: ssh-creds

    # 2. Run tests (depends on clone)
    - name: test
      taskRef:
        name: go-test
        kind: Task
      runAfter: [clone]
      params:
        - name: package
          value: "./..."
        - name: flags
          value: "-race -count=1 -timeout=10m"
      workspaces:
        - name: source
          workspace: shared-data
        - name: cache
          workspace: go-cache

    # 3. Build and push image (depends on test passing)
    - name: build-image
      taskRef:
        name: kaniko-build
        kind: Task
      runAfter: [test]
      params:
        - name: image
          value: $(params.image-registry)/$(params.app-name):$(tasks.clone.results.commit)
        - name: dockerfile
          value: Dockerfile
      workspaces:
        - name: source
          workspace: shared-data
        - name: dockerconfig
          workspace: docker-credentials

    # 4. Scan the image for vulnerabilities (parallel with deploy, after build)
    - name: scan-image
      taskRef:
        name: trivy-scanner
        kind: Task
      runAfter: [build-image]
      params:
        - name: image
          value: $(tasks.build-image.results.image-url)
        - name: severity
          value: "CRITICAL,HIGH"

    # 5. Deploy to staging (after build, independent of scan)
    - name: deploy-staging
      taskRef:
        name: kubectl-apply
        kind: Task
      runAfter: [build-image]
      params:
        - name: image
          value: $(tasks.build-image.results.image-url)
        - name: namespace
          value: $(params.deploy-namespace)
        - name: app-name
          value: $(params.app-name)
      workspaces:
        - name: source
          workspace: shared-data

  # Finally block: runs regardless of pipeline success/failure
  finally:
    - name: notify-slack
      taskRef:
        name: slack-notify
        kind: Task
      params:
        - name: pipeline-status
          value: $(tasks.status)
        - name: app-name
          value: $(params.app-name)
        - name: revision
          value: $(params.revision)
        - name: image-url
          value: $(tasks.build-image.results.image-url)
```

## Workspace Configuration with Persistent Volume Claims

```yaml
# pipeline-run.yaml — Manually triggered PipelineRun with PVC workspace
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  generateName: go-app-pipeline-run-
  namespace: ci
spec:
  pipelineRef:
    name: go-app-pipeline
  params:
    - name: repo-url
      value: https://github.com/example/my-go-app.git
    - name: revision
      value: main
    - name: app-name
      value: my-go-app
    - name: image-registry
      value: registry.example.com

  workspaces:
    # Create a fresh PVC for each run (VolumeClaimTemplate)
    - name: shared-data
      volumeClaimTemplate:
        spec:
          accessModes: [ReadWriteOnce]
          resources:
            requests:
              storage: 2Gi
          storageClassName: fast-ssd

    # Persistent cache PVC — reused across runs for faster builds
    - name: go-cache
      persistentVolumeClaim:
        claimName: go-build-cache

    # Docker credentials from Secret
    - name: docker-credentials
      secret:
        secretName: registry-credentials
```

## Tekton Triggers: Webhook-Driven Pipelines

Triggers listen for events (GitHub webhooks, GitLab events, generic HTTP) and create PipelineRuns automatically:

```yaml
# trigger-binding.yaml — Extracts values from the webhook payload
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerBinding
metadata:
  name: github-push-binding
  namespace: ci
spec:
  params:
    - name: gitrevision
      value: $(body.head_commit.id)
    - name: gitrepositoryurl
      value: $(body.repository.clone_url)
    - name: gitrepository-name
      value: $(body.repository.name)
    - name: gitbranch
      value: $(body.ref)  # refs/heads/main
---
# trigger-template.yaml — Defines what to create when triggered
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerTemplate
metadata:
  name: github-push-template
  namespace: ci
spec:
  params:
    - name: gitrevision
    - name: gitrepositoryurl
    - name: gitrepository-name
    - name: gitbranch

  resourcetemplates:
    - apiVersion: tekton.dev/v1
      kind: PipelineRun
      metadata:
        generateName: $(tt.params.gitrepository-name)-
        namespace: ci
        labels:
          tekton.dev/pipeline: go-app-pipeline
          app.kubernetes.io/managed-by: tekton-triggers
      spec:
        pipelineRef:
          name: go-app-pipeline
        params:
          - name: repo-url
            value: $(tt.params.gitrepositoryurl)
          - name: revision
            value: $(tt.params.gitrevision)
          - name: app-name
            value: $(tt.params.gitrepository-name)
        workspaces:
          - name: shared-data
            volumeClaimTemplate:
              spec:
                accessModes: [ReadWriteOnce]
                resources:
                  requests:
                    storage: 2Gi
          - name: go-cache
            persistentVolumeClaim:
              claimName: go-build-cache
          - name: docker-credentials
            secret:
              secretName: registry-credentials
        timeouts:
          pipeline: 1h
---
# event-listener.yaml — HTTP server that receives webhooks
apiVersion: triggers.tekton.dev/v1beta1
kind: EventListener
metadata:
  name: github-listener
  namespace: ci
spec:
  serviceAccountName: tekton-triggers-sa
  triggers:
    - name: github-push-main
      interceptors:
        # GitHub HMAC signature verification
        - ref:
            name: github
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: secret-token
            - name: eventTypes
              value: [push]
        # Only trigger for pushes to main or release branches
        - ref:
            name: cel
          params:
            - name: filter
              value: >
                body.ref == 'refs/heads/main' ||
                body.ref.startsWith('refs/heads/release/')
      bindings:
        - ref: github-push-binding
      template:
        ref: github-push-template
---
# Expose the EventListener via an Ingress
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: github-webhook-ingress
  namespace: ci
spec:
  ingressClassName: nginx
  rules:
    - host: ci.example.com
      http:
        paths:
          - path: /github-webhook
            pathType: Prefix
            backend:
              service:
                name: el-github-listener  # EventListener creates this Service automatically
                port:
                  number: 8080
```

## RBAC for Tekton

```yaml
# rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: tekton-pipeline-sa
  namespace: ci
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: tekton-pipeline-role
rules:
  # Tekton Pipelines needs to manage its own resources
  - apiGroups: ["tekton.dev"]
    resources: ["*"]
    verbs: ["*"]
  # Needed to create Pods for TaskRuns
  - apiGroups: [""]
    resources: ["pods", "pods/log", "secrets", "configmaps", "persistentvolumeclaims"]
    verbs: ["get", "list", "create", "update", "delete", "watch"]
  # Needed for deployment updates
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "update", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: tekton-pipeline-binding
subjects:
  - kind: ServiceAccount
    name: tekton-pipeline-sa
    namespace: ci
roleRef:
  kind: ClusterRole
  name: tekton-pipeline-role
  apiGroup: rbac.authorization.k8s.io
---
# Service account for Triggers
apiVersion: v1
kind: ServiceAccount
metadata:
  name: tekton-triggers-sa
  namespace: ci
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: tekton-triggers-binding
subjects:
  - kind: ServiceAccount
    name: tekton-triggers-sa
    namespace: ci
roleRef:
  kind: ClusterRole
  name: tekton-triggers-admin
  apiGroup: rbac.authorization.k8s.io
```

## Monitoring and Observability

Tekton exports Prometheus metrics from its pipelines controller:

```bash
# Key Tekton metrics
# tekton_pipelineruns_created_total — Rate of new pipeline runs
# tekton_pipelineruns_duration_seconds — Pipeline execution time histogram
# tekton_taskruns_duration_seconds — Task execution time histogram
# tekton_pipelineruns_count — Gauge of running/pending/succeeded/failed

# View pipeline run status
tkn pipelinerun list -n ci --limit 20

# View logs for a running task
tkn pipelinerun logs go-app-pipeline-run-xxxxx -n ci -f

# Describe a failed pipeline run
tkn pipelinerun describe go-app-pipeline-run-xxxxx -n ci

# Clean up old pipeline runs (keep last 10)
tkn pipelinerun delete --keep 10 -n ci
```

## Tekton vs GitHub Actions vs Argo Workflows

| Dimension | Tekton | GitHub Actions | Argo Workflows |
|-----------|--------|----------------|----------------|
| Runs in | Your cluster | GitHub's runners | Your cluster |
| Trigger | Webhook (Triggers) | Git events | Manual, cron, webhook |
| Primary use | CI/CD | CI/CD | General data pipelines |
| DSL | Kubernetes YAML | YAML | Kubernetes YAML |
| Parallelism | DAG within Pipeline | Matrix, parallel jobs | DAG, parallel steps |
| Artifact storage | PVC Workspaces | Actions cache/artifacts | Artifact repository |
| Air-gapped support | Yes | No | Yes |
| UI | Tekton Dashboard | GitHub UI | Argo Workflows UI |
| Community tasks | Tekton Hub | GitHub Marketplace | None built-in |
| Learning curve | High (Kubernetes knowledge) | Low | Medium |
| Cost | Your cluster cost | Free tier + per-minute | Your cluster cost |

**Choose Tekton when**:
- You need CI/CD in air-gapped or on-premises environments
- You want to reuse Kubernetes compute resources (spot instances, GPU nodes)
- Your team already operates Kubernetes and wants a consistent operational model
- You need fine-grained RBAC on pipeline resources

**Choose GitHub Actions when**:
- Your code is on GitHub and you want minimal operational overhead
- You need quick integration with GitHub's ecosystem
- Your team is not running Kubernetes

**Choose Argo Workflows when**:
- You need complex DAG orchestration for data pipelines (not primarily CI/CD)
- You need long-running jobs with many parallel steps
- You want Argo's more sophisticated UI and artifact management

## Practical Tips for Production Tekton

```bash
# Use Tekton Hub for community tasks instead of writing your own
tkn hub search golang
tkn hub install task git-clone
tkn hub install task golang-build
tkn hub install task kaniko

# Set up a PVC for the build cache to dramatically speed up Go builds
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: go-build-cache
  namespace: ci
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 10Gi
  storageClassName: fast-ssd
EOF

# Configure Pipeline timeouts to prevent stuck runs
# In PipelineRun spec:
# timeouts:
#   pipeline: 1h       # Total pipeline timeout
#   tasks: 45m         # Timeout for all tasks combined
#   finally: 10m       # Timeout for finally tasks

# Use TaskRun results in subsequent tasks to avoid re-running heavy work
# results.image-digest.path contains the exact digest of what was built
```

## Summary

Tekton provides a production-grade CI/CD foundation that runs entirely within your Kubernetes cluster:

1. **Tasks** define reusable units of work as containers — keep them focused on one concern (build, test, scan, deploy)
2. **Workspaces** share data between steps and tasks — use VolumeClaimTemplates for ephemeral per-run storage and persistent PVCs for caches
3. **Results** pass small values between tasks — image digests, test results, version strings
4. **Pipelines** compose Tasks in a DAG with explicit dependencies and parallel execution
5. **Triggers** convert GitHub/GitLab webhooks into PipelineRuns with HMAC signature verification
6. **Tekton Hub** provides community tasks for common operations — use them instead of reimplementing git clone, kaniko builds, and Slack notifications
7. The operational overhead of running Tekton in your cluster pays off in air-gapped environments, fine-grained RBAC requirements, and reuse of existing Kubernetes compute capacity
