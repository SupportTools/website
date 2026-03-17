---
title: "Kubernetes Tekton Pipelines v1: PipelineRun Orchestration, Workspace Sharing, Results Passing, and Triggers"
date: 2031-10-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Tekton", "CI/CD", "Pipelines", "GitOps", "DevOps"]
categories:
- Kubernetes
- CI/CD
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to Tekton Pipelines v1 API covering PipelineRun orchestration patterns, workspace sharing strategies, result passing between tasks, Tekton Triggers for event-driven pipelines, and enterprise best practices."
more_link: "yes"
url: "/kubernetes-tekton-pipelines-v1-pipelinerun-workspace-sharing-results-triggers/"
---

Tekton Pipelines v1 API stabilized in Tekton v0.44, delivering a mature Kubernetes-native CI/CD framework with first-class support for cloud-native build patterns. Unlike external CI systems, Tekton runs entirely inside the cluster, using standard Kubernetes primitives — pods, service accounts, secrets — for isolation and access control. This guide covers production patterns for complex multi-stage pipelines including workspace sharing, cross-task result passing, fan-out/fan-in, and event-driven execution via Tekton Triggers.

<!--more-->

# Kubernetes Tekton Pipelines v1

## Section 1: Tekton v1 API Overview

Tekton v1 promotes the `tekton.dev/v1` API group from beta. The key stable resources are:

- `Task` — a sequence of steps running in a single pod
- `TaskRun` — an instantiation of a Task
- `Pipeline` — an ordered DAG of Tasks
- `PipelineRun` — an instantiation of a Pipeline

### Installation

```bash
# Install Tekton Pipelines
kubectl apply -f https://storage.googleapis.com/tekton-releases/pipeline/latest/release.yaml

# Install Tekton Triggers (for event-driven execution)
kubectl apply -f https://storage.googleapis.com/tekton-releases/triggers/latest/release.yaml

# Install Tekton Dashboard
kubectl apply -f https://storage.googleapis.com/tekton-releases/dashboard/latest/release-full.yaml

# Wait for components
kubectl -n tekton-pipelines rollout status deployment/tekton-pipelines-controller
kubectl -n tekton-pipelines rollout status deployment/tekton-pipelines-webhook

# Configure feature flags for v1
kubectl -n tekton-pipelines patch configmap feature-flags --type=merge -p '
{
  "data": {
    "enable-api-fields": "stable",
    "enable-provenance-in-status": "true",
    "results-from": "sidecar-logs",
    "max-result-size": "4096",
    "set-security-context": "true",
    "enable-step-actions": "true"
  }
}'
```

## Section 2: Tasks in Depth

### Production-Ready Task Definition

```yaml
# task-build-and-push.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: build-and-push
  namespace: tekton-pipelines
  labels:
    app.kubernetes.io/version: "1.0"
  annotations:
    tekton.dev/pipelines.minVersion: "0.44.0"
    tekton.dev/displayName: "Build and Push Container Image"
spec:
  description: |
    Builds a container image from source code using kaniko
    and pushes it to the configured registry.

  # Params define the contract for the task
  params:
    - name: IMAGE
      type: string
      description: "Image reference to build and push (e.g., registry.example.com/myapp:v1.2.3)"
    - name: CONTEXT
      type: string
      description: "Build context path within the workspace"
      default: "."
    - name: DOCKERFILE
      type: string
      default: "Dockerfile"
    - name: BUILD_ARGS
      type: array
      default: []
    - name: CACHE_REPO
      type: string
      default: ""
      description: "Optional registry for layer caching"
    - name: EXTRA_ARGS
      type: array
      default: ["--compressed-caching=false"]

  # Workspaces define storage dependencies
  workspaces:
    - name: source
      description: "Source code workspace"
    - name: dockerconfig
      description: "Docker config.json for registry auth"
      mountPath: /kaniko/.docker

  # Results that this task produces
  results:
    - name: IMAGE_DIGEST
      description: "Digest of the pushed image"
      type: string
    - name: IMAGE_URL
      description: "Full image URL including digest"
      type: string

  steps:
    - name: build-and-push
      image: gcr.io/kaniko-project/executor:v1.19.2
      args:
        - "--dockerfile=$(workspaces.source.path)/$(params.DOCKERFILE)"
        - "--context=dir://$(workspaces.source.path)/$(params.CONTEXT)"
        - "--destination=$(params.IMAGE)"
        - "--digest-file=$(results.IMAGE_DIGEST.path)"
        - "$(params.EXTRA_ARGS[*])"
        - "$(params.BUILD_ARGS[*])"
      env:
        - name: DOCKER_CONFIG
          value: /kaniko/.docker
      resources:
        requests:
          cpu: "1"
          memory: "2Gi"
        limits:
          cpu: "4"
          memory: "8Gi"
      securityContext:
        runAsUser: 0
        runAsGroup: 0

    - name: write-image-url
      image: cgr.dev/chainguard/bash:latest
      script: |
        #!/usr/bin/env bash
        set -euo pipefail
        DIGEST=$(cat $(results.IMAGE_DIGEST.path))
        IMAGE_REF="$(params.IMAGE)@${DIGEST}"
        echo -n "${IMAGE_REF}" | tee $(results.IMAGE_URL.path)
        echo "Built and pushed: ${IMAGE_REF}"

  # Pod-level template (applies to all steps)
  stepTemplate:
    env:
      - name: HOME
        value: /tekton/home
    securityContext:
      allowPrivilegeEscalation: false
```

### Task with Sidecar

```yaml
# task-integration-test.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: integration-test
  namespace: tekton-pipelines
spec:
  params:
    - name: TEST_COMMAND
      type: string
      default: "go test ./... -tags=integration"

  workspaces:
    - name: source

  results:
    - name: TEST_RESULT
      type: string

  sidecars:
    - name: postgres
      image: postgres:16-alpine
      env:
        - name: POSTGRES_DB
          value: testdb
        - name: POSTGRES_USER
          value: testuser
        - name: POSTGRES_PASSWORD
          value: testpassword-not-real
      readinessProbe:
        exec:
          command: ["pg_isready", "-U", "testuser", "-d", "testdb"]
        initialDelaySeconds: 5
        periodSeconds: 3

    - name: redis
      image: redis:7-alpine
      readinessProbe:
        exec:
          command: ["redis-cli", "ping"]
        initialDelaySeconds: 3
        periodSeconds: 2

  steps:
    - name: wait-for-deps
      image: cgr.dev/chainguard/bash:latest
      script: |
        #!/usr/bin/env bash
        echo "Waiting for PostgreSQL..."
        until pg_isready -h localhost -U testuser -d testdb; do
          sleep 2
        done
        echo "Waiting for Redis..."
        until redis-cli -h localhost ping; do
          sleep 2
        done
        echo "Dependencies ready"
      env:
        - name: PGPASSWORD
          value: testpassword-not-real

    - name: run-tests
      image: golang:1.22-alpine
      workingDir: $(workspaces.source.path)
      script: |
        #!/bin/sh
        set -e
        export POSTGRES_DSN="postgres://testuser:testpassword-not-real@localhost/testdb?sslmode=disable"
        export REDIS_URL="redis://localhost:6379"
        $(params.TEST_COMMAND) 2>&1 | tee /tmp/test-output.txt
        echo -n "passed" | tee $(results.TEST_RESULT.path)
      env:
        - name: CGO_ENABLED
          value: "0"
        - name: GOPATH
          value: /go
        - name: GOCACHE
          value: /go/cache
```

## Section 3: Pipeline Orchestration

### Multi-Stage Pipeline with Dependencies

```yaml
# pipeline-full-cicd.yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: full-cicd
  namespace: tekton-pipelines
spec:
  description: |
    Complete CI/CD pipeline: clone, lint, test, build, scan, push, deploy.

  params:
    - name: GIT_URL
      type: string
    - name: GIT_REVISION
      type: string
      default: "main"
    - name: IMAGE_REGISTRY
      type: string
      default: "registry.example.com"
    - name: APP_NAME
      type: string
    - name: DEPLOY_ENV
      type: string
      default: "staging"
    - name: SKIP_TESTS
      type: string
      default: "false"

  workspaces:
    - name: shared-source
      description: "Source code shared between tasks"
    - name: docker-credentials
      description: "Registry credentials"
    - name: ssh-credentials
      description: "Git SSH credentials"
    - name: sonar-settings
      description: "SonarQube settings"
    - name: argocd-credentials
      description: "ArgoCD server credentials"

  results:
    - name: IMAGE_URL
      description: "Final image URL"
      value: "$(tasks.build-image.results.IMAGE_URL)"
    - name: IMAGE_DIGEST
      description: "Image digest"
      value: "$(tasks.build-image.results.IMAGE_DIGEST)"

  tasks:
    # Stage 1: Clone
    - name: clone
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: task
          - name: name
            value: git-clone
          - name: namespace
            value: tekton-pipelines
      workspaces:
        - name: output
          workspace: shared-source
        - name: ssh-directory
          workspace: ssh-credentials
      params:
        - name: url
          value: $(params.GIT_URL)
        - name: revision
          value: $(params.GIT_REVISION)
        - name: deleteExisting
          value: "true"
        - name: depth
          value: "0"   # Full clone for proper git history

    # Stage 2a: Lint (parallel after clone)
    - name: lint
      taskRef:
        name: golangci-lint
      runAfter: ["clone"]
      workspaces:
        - name: source
          workspace: shared-source
      params:
        - name: args
          value: ["--timeout", "5m", "--config", ".golangci.yaml"]

    # Stage 2b: Unit tests (parallel after clone)
    - name: unit-test
      taskRef:
        name: go-test
      runAfter: ["clone"]
      when:
        - input: "$(params.SKIP_TESTS)"
          operator: in
          values: ["false"]
      workspaces:
        - name: source
          workspace: shared-source
      params:
        - name: PACKAGES
          value: "./..."
        - name: FLAGS
          value: ["-race", "-count=1", "-coverprofile=/workspace/source/coverage.out"]

    # Stage 2c: SAST scan (parallel after clone)
    - name: sast-scan
      taskRef:
        name: sonarqube-scanner
      runAfter: ["clone"]
      workspaces:
        - name: source
          workspace: shared-source
        - name: sonar-settings
          workspace: sonar-settings

    # Stage 3: Build image (after lint + test)
    - name: build-image
      taskRef:
        name: build-and-push
      runAfter: ["lint", "unit-test", "sast-scan"]
      workspaces:
        - name: source
          workspace: shared-source
        - name: dockerconfig
          workspace: docker-credentials
      params:
        - name: IMAGE
          value: "$(params.IMAGE_REGISTRY)/$(params.APP_NAME):$(tasks.clone.results.commit)"
        - name: CACHE_REPO
          value: "$(params.IMAGE_REGISTRY)/cache/$(params.APP_NAME)"

    # Stage 4a: Image vulnerability scan (parallel after build)
    - name: image-scan
      taskRef:
        name: trivy-scan
      runAfter: ["build-image"]
      params:
        - name: IMAGE
          value: "$(tasks.build-image.results.IMAGE_URL)"
        - name: EXIT_CODE
          value: "1"  # Fail on HIGH/CRITICAL CVEs
        - name: SEVERITY
          value: "HIGH,CRITICAL"

    # Stage 4b: Sign image (parallel after build)
    - name: sign-image
      taskRef:
        name: cosign-sign
      runAfter: ["build-image"]
      params:
        - name: IMAGE
          value: "$(tasks.build-image.results.IMAGE_URL)"

    # Stage 5: Deploy to environment (after scan + sign)
    - name: deploy
      taskRef:
        name: argocd-sync
      runAfter: ["image-scan", "sign-image"]
      workspaces:
        - name: argocd-credentials
          workspace: argocd-credentials
      params:
        - name: APP_NAME
          value: "$(params.APP_NAME)-$(params.DEPLOY_ENV)"
        - name: IMAGE_TAG
          value: "$(tasks.clone.results.commit)"
        - name: WAIT
          value: "true"
        - name: TIMEOUT
          value: "300"

  # Finally tasks run regardless of pipeline success or failure
  finally:
    - name: notify-slack
      taskRef:
        name: send-slack-notification
      params:
        - name: WEBHOOK_SECRET
          value: slack-webhook
        - name: MESSAGE
          value: "Pipeline $(context.pipeline.name) completed. Status: $(tasks.deploy.status)"
        - name: CHANNEL
          value: "#ci-cd-notifications"

    - name: cleanup-workspace
      taskRef:
        name: cleanup
      workspaces:
        - name: source
          workspace: shared-source
```

## Section 4: Workspace Sharing Strategies

### Workspace Binding Strategies

```yaml
# pipelinerun-workspace-examples.yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: myapp-build-run-001
  namespace: ci
spec:
  pipelineRef:
    name: full-cicd

  params:
    - name: GIT_URL
      value: "git@github.com:example-org/myapp.git"
    - name: GIT_REVISION
      value: "main"
    - name: APP_NAME
      value: "myapp"
    - name: IMAGE_REGISTRY
      value: "registry.example.com"
    - name: DEPLOY_ENV
      value: "staging"

  workspaces:
    # PVC workspace — persistent across tasks, use for large source trees
    - name: shared-source
      volumeClaimTemplate:
        spec:
          accessModes: ["ReadWriteOnce"]
          storageClassName: longhorn-nvme
          resources:
            requests:
              storage: 5Gi

    # Secret workspace — for credentials
    - name: docker-credentials
      secret:
        secretName: registry-credentials

    - name: ssh-credentials
      secret:
        secretName: git-ssh-key

    # ConfigMap workspace — for non-sensitive config
    - name: sonar-settings
      configMap:
        name: sonarqube-config

    # Projected workspace — combine multiple sources
    - name: argocd-credentials
      projected:
        sources:
          - secret:
              name: argocd-token
          - configMap:
              name: argocd-server-config

  # Task-level timeout
  timeouts:
    pipeline: 1h
    tasks: 45m
    finally: 10m

  # Pod template applied to all TaskRun pods
  taskRunTemplate:
    serviceAccountName: tekton-ci-sa
    podTemplate:
      nodeSelector:
        workload-type: ci
      tolerations:
        - key: workload-type
          operator: Equal
          value: ci
          effect: NoSchedule
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
```

### Sharing Workspaces Between Tasks with SubPath

When tasks write to specific subdirectories, use `subPath` to avoid collisions:

```yaml
# pipeline-subpath-example.yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: parallel-builds
spec:
  workspaces:
    - name: shared-build

  tasks:
    - name: build-frontend
      taskRef:
        name: npm-build
      workspaces:
        - name: source
          workspace: shared-build
          subPath: frontend   # Isolated subdirectory

    - name: build-backend
      taskRef:
        name: go-build
      workspaces:
        - name: source
          workspace: shared-build
          subPath: backend    # Different subdirectory

    - name: package-all
      runAfter: ["build-frontend", "build-backend"]
      taskRef:
        name: docker-build-multi-artifact
      workspaces:
        - name: artifacts
          workspace: shared-build  # Access to both subdirectories
```

## Section 5: Results Passing

### Task Results to Pipeline Parameters

```yaml
# Results flow through the pipeline via parameter references:
# $(tasks.<task-name>.results.<result-name>)

apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: version-propagation
spec:
  tasks:
    - name: determine-version
      taskRef:
        name: semver-calculator
      # Produces result: NEW_VERSION

    - name: build
      runAfter: ["determine-version"]
      taskRef:
        name: build-image
      params:
        - name: IMAGE_TAG
          value: "$(tasks.determine-version.results.NEW_VERSION)"
      # Produces results: IMAGE_DIGEST, IMAGE_URL

    - name: update-manifests
      runAfter: ["build"]
      taskRef:
        name: update-kustomize-image
      params:
        - name: IMAGE
          value: "$(tasks.build.results.IMAGE_URL)"
        - name: DIGEST
          value: "$(tasks.build.results.IMAGE_DIGEST)"
```

### Array Results (Tekton v0.48+)

```yaml
# task-discover-services.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: discover-services
spec:
  results:
    - name: SERVICES
      type: array
      description: "List of changed services"

  steps:
    - name: detect-changes
      image: cgr.dev/chainguard/git:latest
      script: |
        #!/usr/bin/env sh
        set -e
        # Find directories with changes in this PR
        CHANGED=$(git diff --name-only HEAD~1 HEAD | \
          awk -F/ 'NF>1{print $1}' | sort -u | \
          jq -R -s 'split("\n") | map(select(length > 0))')
        echo -n "$CHANGED" | tee $(results.SERVICES.path)
```

```yaml
# pipeline using array results for fan-out
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: matrix-build
spec:
  tasks:
    - name: discover
      taskRef:
        name: discover-services
      # Produces: SERVICES (array)

    - name: build-services
      runAfter: ["discover"]
      taskRef:
        name: build-service
      # Matrix fan-out: one TaskRun per service
      matrix:
        params:
          - name: SERVICE
            value: "$(tasks.discover.results.SERVICES[*])"
      params:
        - name: SERVICE
          value: ""  # Filled by matrix
```

## Section 6: Tekton Triggers

### EventListener, TriggerTemplate, and TriggerBinding

```yaml
# trigger-binding-github-push.yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerBinding
metadata:
  name: github-push-binding
  namespace: ci
spec:
  params:
    - name: git-revision
      value: $(body.after)
    - name: git-url
      value: $(body.repository.clone_url)
    - name: git-branch
      value: $(body.ref)
    - name: app-name
      value: $(body.repository.name)
    - name: pusher-email
      value: $(body.pusher.email)
```

```yaml
# trigger-template-pipeline.yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerTemplate
metadata:
  name: pipeline-trigger-template
  namespace: ci
spec:
  params:
    - name: git-revision
    - name: git-url
    - name: git-branch
    - name: app-name
    - name: pusher-email

  resourcetemplates:
    - apiVersion: tekton.dev/v1
      kind: PipelineRun
      metadata:
        # generateName produces a unique name for each run
        generateName: "$(tt.params.app-name)-"
        namespace: ci
        labels:
          tekton.dev/pipeline: full-cicd
          git-branch: "$(tt.params.git-branch)"
        annotations:
          triggered-by: "$(tt.params.pusher-email)"
      spec:
        pipelineRef:
          name: full-cicd
        params:
          - name: GIT_URL
            value: "$(tt.params.git-url)"
          - name: GIT_REVISION
            value: "$(tt.params.git-revision)"
          - name: APP_NAME
            value: "$(tt.params.app-name)"
          - name: DEPLOY_ENV
            value: "staging"
        workspaces:
          - name: shared-source
            volumeClaimTemplate:
              spec:
                accessModes: ["ReadWriteOnce"]
                storageClassName: longhorn
                resources:
                  requests:
                    storage: 5Gi
          - name: docker-credentials
            secret:
              secretName: registry-credentials
          - name: ssh-credentials
            secret:
              secretName: git-ssh-key
        timeouts:
          pipeline: 1h
        taskRunTemplate:
          serviceAccountName: tekton-ci-sa
```

```yaml
# event-listener.yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: EventListener
metadata:
  name: github-webhook-listener
  namespace: ci
spec:
  serviceAccountName: tekton-triggers-sa

  triggers:
    # Push to main branch → deploy to staging
    - name: push-to-main
      interceptors:
        - ref:
            name: github
            kind: ClusterInterceptor
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: secret
            - name: eventTypes
              value: ["push"]
        - ref:
            name: cel
            kind: ClusterInterceptor
          params:
            - name: filter
              value: "body.ref == 'refs/heads/main'"
            - name: overlays
              value:
                - key: truncated_sha
                  expression: "body.after.truncate(7)"
      bindings:
        - ref: github-push-binding
      template:
        ref: pipeline-trigger-template

    # Push to release branch → deploy to production
    - name: push-to-release
      interceptors:
        - ref:
            name: github
            kind: ClusterInterceptor
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: secret
            - name: eventTypes
              value: ["push"]
        - ref:
            name: cel
            kind: ClusterInterceptor
          params:
            - name: filter
              value: "body.ref.startsWith('refs/heads/release/')"
      bindings:
        - ref: github-push-binding
        - name: DEPLOY_ENV
          value: production
      template:
        ref: pipeline-trigger-template

    # Pull request → lint and test only
    - name: pull-request-check
      interceptors:
        - ref:
            name: github
            kind: ClusterInterceptor
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: secret
            - name: eventTypes
              value: ["pull_request"]
        - ref:
            name: cel
            kind: ClusterInterceptor
          params:
            - name: filter
              value: "body.action in ['opened', 'synchronize', 'reopened']"
      bindings:
        - ref: github-push-binding
      template:
        ref: pr-check-template
```

```yaml
# Expose EventListener via Ingress
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: github-webhook-ingress
  namespace: ci
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "5m"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - tekton-webhooks.example.com
      secretName: tekton-webhook-tls
  rules:
    - host: tekton-webhooks.example.com
      http:
        paths:
          - path: /github
            pathType: Prefix
            backend:
              service:
                name: el-github-webhook-listener
                port:
                  number: 8080
```

## Section 7: StepActions (Tekton v1 Reusable Steps)

```yaml
# stepaction-cosign-sign.yaml — reusable step definition
apiVersion: tekton.dev/v1alpha1
kind: StepAction
metadata:
  name: cosign-sign
  namespace: tekton-pipelines
spec:
  image: gcr.io/projectsigstore/cosign:v2.2.0
  params:
    - name: image
      type: string
    - name: keyless
      type: string
      default: "true"
  env:
    - name: COSIGN_EXPERIMENTAL
      value: $(params.keyless)
  args:
    - sign
    - --yes
    - $(params.image)
  securityContext:
    runAsNonRoot: true
    allowPrivilegeEscalation: false
```

```yaml
# Use StepAction in a Task
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: sign-and-verify
spec:
  params:
    - name: IMAGE
      type: string
  steps:
    - name: sign
      ref:
        name: cosign-sign
      params:
        - name: image
          value: $(params.IMAGE)
    - name: verify
      image: gcr.io/projectsigstore/cosign:v2.2.0
      args: ["verify", "$(params.IMAGE)"]
```

## Section 8: Pipeline Observability

### Tekton Results for Long-Term Storage

```bash
# Install Tekton Results
kubectl apply -f https://storage.googleapis.com/tekton-releases/results/latest/release.yaml

# Configure PostgreSQL backend
kubectl -n tekton-pipelines create secret generic tekton-results-postgres \
  --from-literal=POSTGRES_USER=tekton \
  --from-literal=POSTGRES_PASSWORD=tekton-db-password-placeholder \
  --from-literal=POSTGRES_DB=tekton_results

# Query results via CLI
tkn-results records list \
  --filter "data_type == 'tekton.dev/v1.PipelineRun' && record.data.metadata.labels['app-name'] == 'myapp'" \
  --order_by "create_time desc" \
  --page_size 10
```

### Prometheus Metrics

```yaml
# tekton-pipelines exposes metrics at :9090/metrics
# Key metrics to alert on:

# pipelinerun_count — number of pipeline runs
# pipelinerun_duration_seconds — duration histogram
# taskrun_count — number of task runs
# running_taskruns_count — currently running task runs (capacity)

apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: tekton-alerts
  namespace: monitoring
spec:
  groups:
    - name: tekton
      rules:
        - alert: TektonPipelineRunFailed
          expr: |
            increase(tekton_pipelines_controller_pipelinerun_count{status="failed"}[5m]) > 0
          labels:
            severity: warning
          annotations:
            summary: "Tekton PipelineRun failed"
            description: "{{ $value }} PipelineRun(s) failed in the last 5 minutes"

        - alert: TektonHighRunningTaskRuns
          expr: tekton_pipelines_controller_running_taskruns_count > 50
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High number of concurrent TaskRuns"
```

## Section 9: RBAC for Multi-Tenant Pipelines

```yaml
# sa-and-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: tekton-ci-sa
  namespace: ci
  annotations:
    # AWS IRSA if running on EKS
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/TektonCIRole
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: tekton-ci-role
  namespace: ci
rules:
  - apiGroups: ["tekton.dev"]
    resources: ["taskruns", "pipelineruns"]
    verbs: ["get", "list", "create", "patch", "update"]
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["secrets", "configmaps"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["create", "delete", "get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: tekton-ci-binding
  namespace: ci
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: tekton-ci-role
subjects:
  - kind: ServiceAccount
    name: tekton-ci-sa
    namespace: ci
```

## Section 10: Debugging Pipeline Failures

```bash
# List recent pipeline runs with status
tkn pipelinerun list -n ci --limit 20

# Describe a failed pipeline run
tkn pipelinerun describe myapp-build-run-001 -n ci

# Stream logs from a running pipeline
tkn pipelinerun logs myapp-build-run-001 -n ci -f

# Get logs from a specific task in a pipeline run
tkn pipelinerun logs myapp-build-run-001 -n ci --task build-image

# Get logs from a failed task run
TASKRUN=$(kubectl -n ci get taskrun \
  -l tekton.dev/pipelineRun=myapp-build-run-001 \
  -l tekton.dev/pipelineTask=build-image \
  -o name | head -1)
kubectl -n ci logs -l tekton.dev/taskRun=$(basename $TASKRUN) --all-containers

# Re-run a failed pipeline run
tkn pipelinerun rerun myapp-build-run-001 -n ci

# Check task run conditions
kubectl -n ci get taskrun -l tekton.dev/pipelineRun=myapp-build-run-001 \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.conditions[0].reason,MESSAGE:.status.conditions[0].message'

# Export pipeline run for post-mortem
tkn pipelinerun describe myapp-build-run-001 -n ci -o yaml > pipelinerun-debug.yaml
```

## Summary

Tekton v1 provides a stable, Kubernetes-native CI/CD foundation. The production patterns that matter most are:

- Use `volumeClaimTemplate` for workspace bindings in PipelineRuns to get a fresh PVC per run without pre-provisioning
- Pass results between tasks using `$(tasks.<name>.results.<result>)` references — this is the type-safe alternative to writing to shared workspace files
- Use `matrix` for fan-out parallelism when the same task needs to run against multiple inputs (services, platforms, environments)
- Tekton Triggers with CEL interceptors provides fine-grained control over which events spawn which pipelines
- The `finally` block runs even on pipeline failure — use it for notifications and cleanup, never for critical business logic
- Set `timeouts` at both `pipeline` and `tasks` level to prevent runaway builds from consuming cluster resources indefinitely
