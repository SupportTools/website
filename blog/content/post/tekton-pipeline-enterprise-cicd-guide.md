---
title: "Tekton Pipelines: Cloud-Native CI/CD Built on Kubernetes"
date: 2027-12-28T00:00:00-05:00
draft: false
tags: ["Tekton", "CI/CD", "Kubernetes", "Supply Chain Security", "GitOps", "Pipelines"]
categories: ["CI/CD", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Tekton Pipelines covering Tasks, Pipelines, PipelineRuns, Tekton Chains for supply chain security, Triggers for GitHub webhooks, parallel execution, workspace patterns, and production deployment strategies."
more_link: "yes"
url: "/tekton-pipeline-enterprise-cicd-guide/"
---

Tekton is a Kubernetes-native CI/CD framework that models every aspect of the build pipeline — tasks, pipelines, triggers, and results — as Kubernetes custom resources. Unlike Jenkins or GitLab CI, Tekton pipelines run as ephemeral Pods, scale horizontally with cluster capacity, and integrate directly with Kubernetes RBAC, secrets management, and PersistentVolumes.

This guide covers the full enterprise CI/CD implementation: Task authoring with Workspaces, parallel Pipeline execution, Tekton Triggers for GitHub webhooks, Tekton Chains for SLSA supply chain provenance, Results for pipeline history, and the Dashboard for visibility. All patterns are production-validated for teams shipping Kubernetes-deployed applications.

<!--more-->

# Tekton Pipelines: Cloud-Native CI/CD Built on Kubernetes

## Section 1: Architecture and Core Concepts

### Component Hierarchy

```
Tekton Ecosystem
├── Pipelines          - Core CRDs (Task, Pipeline, PipelineRun, TaskRun)
├── Triggers           - Event-driven pipeline execution (EventListener, TriggerTemplate)
├── Chains             - Supply chain security (SLSA provenance, Sigstore signing)
├── Results            - Long-term pipeline history storage
├── Dashboard          - Web UI for pipeline visualization
└── Hub (tektonhub.io) - Community task catalog
```

### Resource Relationships

```
EventListener (receives GitHub webhook)
    └── TriggerBinding (extracts values from webhook payload)
        └── TriggerTemplate (creates PipelineRun from template)
            └── PipelineRun (execution instance)
                └── Pipeline (workflow definition)
                    ├── Task 1 (e.g., git-clone)
                    ├── Task 2 (e.g., build-image)
                    └── Task 3 (e.g., deploy-staging)
                        └── Step (container execution unit)
```

## Section 2: Installation

### Install Tekton Pipelines

```bash
# Install latest stable Tekton Pipelines
kubectl apply -f https://storage.googleapis.com/tekton-releases/pipeline/latest/release.yaml

# Verify installation
kubectl get pods -n tekton-pipelines

# Install Tekton CLI
curl -LO https://github.com/tektoncd/cli/releases/download/v0.37.0/tkn_0.37.0_Linux_x86_64.tar.gz
tar xzf tkn_0.37.0_Linux_x86_64.tar.gz
sudo install tkn /usr/local/bin/
tkn version
```

### Install Tekton Triggers

```bash
kubectl apply -f https://storage.googleapis.com/tekton-releases/triggers/latest/release.yaml
kubectl apply -f https://storage.googleapis.com/tekton-releases/triggers/latest/interceptors.yaml
kubectl get pods -n tekton-pipelines | grep trigger
```

### Install Tekton Dashboard

```bash
kubectl apply -f https://storage.googleapis.com/tekton-releases/dashboard/latest/release.yaml
kubectl get pods -n tekton-pipelines | grep dashboard

# Access dashboard via port-forward (production: use Ingress)
kubectl port-forward -n tekton-pipelines svc/tekton-dashboard 9097:9097 &
```

### Install Tekton Chains

```bash
kubectl apply -f https://storage.googleapis.com/tekton-releases/chains/latest/release.yaml
kubectl get pods -n tekton-chains
```

### Configure Tekton Feature Flags

```yaml
# feature-flags-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: feature-flags
  namespace: tekton-pipelines
data:
  # Enable alpha features (required for some advanced features)
  enable-api-fields: "stable"
  # Enable caching of task results
  results-from: "sidecar-logs"
  # Max retry attempts for task failures
  max-result-size: "4096"
  # Enable pipeline-level timeout
  default-timeout-minutes: "60"
  # Disable affinity assistant (required for shared workspaces with multiple tasks)
  disable-affinity-assistant: "true"
  # Enable step actions
  enable-step-actions: "true"
```

## Section 3: Tasks — The Basic Unit of Work

### Reusable Task Definition

```yaml
# task-git-clone.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: git-clone
  namespace: tekton-pipelines
  labels:
    app.kubernetes.io/version: "0.9"
  annotations:
    tekton.dev/pipelines.minVersion: "0.41.0"
    tekton.dev/categories: Git
    tekton.dev/tags: git
spec:
  description: |
    Clones a git repository into a workspace. Supports SSH and HTTPS authentication.
  workspaces:
    - name: output
      description: The git repo is cloned to this workspace
    - name: ssh-directory
      optional: true
      description: SSH key directory (.ssh/id_rsa, .ssh/known_hosts)
    - name: basic-auth
      optional: true
      description: Basic auth credentials (git-credentials file)
  params:
    - name: url
      type: string
      description: Repository URL to clone
    - name: revision
      type: string
      description: Branch/tag/SHA to checkout
      default: "main"
    - name: depth
      type: string
      description: Shallow clone depth
      default: "1"
    - name: submodules
      type: string
      description: Initialize submodules
      default: "true"
  results:
    - name: commit
      description: The precise commit SHA that was fetched
    - name: url
      description: The precise URL that was fetched
    - name: committer-date
      description: The epoch timestamp of the commit
  steps:
    - name: clone
      image: gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/git-init:v0.44.0
      env:
        - name: HOME
          value: /tekton/home
        - name: PARAM_URL
          value: $(params.url)
        - name: PARAM_REVISION
          value: $(params.revision)
        - name: PARAM_DEPTH
          value: $(params.depth)
        - name: WORKSPACE_OUTPUT_PATH
          value: $(workspaces.output.path)
      script: |
        #!/usr/bin/env sh
        set -eu

        if [ "$(workspaces.ssh-directory.bound)" = "true" ]; then
          cp -R "$(workspaces.ssh-directory.path)" "${HOME}/.ssh"
          chmod 700 "${HOME}/.ssh"
          chmod -R 400 "${HOME}/.ssh/"*
        fi

        /ko-app/git-init \
          -url="${PARAM_URL}" \
          -revision="${PARAM_REVISION}" \
          -path="${WORKSPACE_OUTPUT_PATH}" \
          -depth="${PARAM_DEPTH}" \
          -submodules="$(params.submodules)"

        cd "${WORKSPACE_OUTPUT_PATH}"
        RESULT_SHA="$(git rev-parse HEAD)"
        printf "%s" "${RESULT_SHA}" > "$(results.commit.path)"
        printf "%s" "${PARAM_URL}" > "$(results.url.path)"
        printf "%s" "$(git log -1 --format=%ct)" > "$(results.committer-date.path)"
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
```

### Build and Push Container Image Task

```yaml
# task-buildah.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: buildah
  namespace: tekton-pipelines
spec:
  description: Build and push a container image using Buildah.
  workspaces:
    - name: source
      description: Source code workspace
    - name: dockerconfig
      description: Docker config with registry credentials
      optional: true
  params:
    - name: image
      type: string
      description: Full image reference (registry/repo/name:tag)
    - name: dockerfile
      type: string
      default: "Dockerfile"
    - name: context
      type: string
      default: "."
    - name: build-args
      type: array
      default: []
    - name: storage-driver
      type: string
      default: "vfs"
    - name: format
      type: string
      default: "oci"
  results:
    - name: image-digest
      description: SHA256 digest of the built image
    - name: image-url
      description: Full image URL with digest
  steps:
    - name: build
      image: quay.io/buildah/stable:v1.35.0
      workingDir: $(workspaces.source.path)
      securityContext:
        privileged: false
        capabilities:
          add:
            - SETFCAP
      env:
        - name: DOCKER_CONFIG
          value: $(workspaces.dockerconfig.path)
      args:
        - $(params.build-args[*])
      script: |
        #!/usr/bin/env bash
        set -euo pipefail

        BUILD_ARGS_ARRAY=("$@")
        BUILD_ARGS=""
        for arg in "${BUILD_ARGS_ARRAY[@]}"; do
          BUILD_ARGS+="--build-arg=${arg} "
        done

        buildah --storage-driver=$(params.storage-driver) bud \
          --format=$(params.format) \
          --no-cache \
          ${BUILD_ARGS} \
          -f $(params.dockerfile) \
          -t $(params.image) \
          $(params.context)

        buildah --storage-driver=$(params.storage-driver) push \
          --digestfile /tmp/image-digest \
          $(params.image)

        cat /tmp/image-digest | tee "$(results.image-digest.path)"
        echo -n "$(params.image)@$(cat /tmp/image-digest)" | tee "$(results.image-url.path)"
      resources:
        requests:
          cpu: 500m
          memory: 512Mi
        limits:
          cpu: 2000m
          memory: 2Gi
```

### Kubernetes Deployment Task

```yaml
# task-kubectl-deploy.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: kubectl-deploy
  namespace: tekton-pipelines
spec:
  workspaces:
    - name: kubeconfig
      optional: true
  params:
    - name: deployment-name
      type: string
    - name: image
      type: string
    - name: namespace
      type: string
      default: "default"
    - name: container-name
      type: string
      default: "app"
  results:
    - name: rollout-status
  steps:
    - name: deploy
      image: bitnami/kubectl:1.29
      env:
        - name: KUBECONFIG
          value: $(workspaces.kubeconfig.path)/kubeconfig
      script: |
        #!/usr/bin/env bash
        set -euo pipefail

        echo "Deploying $(params.image) to $(params.deployment-name)"

        kubectl set image deployment/$(params.deployment-name) \
          $(params.container-name)=$(params.image) \
          -n $(params.namespace)

        kubectl rollout status deployment/$(params.deployment-name) \
          -n $(params.namespace) \
          --timeout=5m

        STATUS=$(kubectl rollout status deployment/$(params.deployment-name) \
          -n $(params.namespace) --timeout=1s 2>&1 || true)
        echo -n "${STATUS}" > "$(results.rollout-status.path)"
```

## Section 4: Pipelines — Orchestrating Multiple Tasks

### Full CI/CD Pipeline

```yaml
# pipeline-ci-cd.yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: application-ci-cd
  namespace: tekton-pipelines
spec:
  description: |
    End-to-end CI/CD pipeline: clone, test, build, scan, deploy to staging, promote to production.
  workspaces:
    - name: shared-data
      description: Shared workspace for all tasks
    - name: ssh-credentials
      description: SSH key for git clone
    - name: docker-credentials
      description: Registry credentials for image push
    - name: kubeconfig
      description: Kubernetes access credentials
  params:
    - name: repo-url
      type: string
    - name: revision
      type: string
      default: "main"
    - name: image-registry
      type: string
      default: "gcr.io/corp-registry"
    - name: app-name
      type: string
    - name: staging-namespace
      type: string
      default: "staging"
    - name: production-namespace
      type: string
      default: "production"
  results:
    - name: image-url
      description: Built image reference with digest
      value: $(tasks.build-image.results.image-url)
    - name: commit-sha
      description: Git commit SHA
      value: $(tasks.clone-repo.results.commit)
  tasks:
    # Step 1: Clone repository
    - name: clone-repo
      taskRef:
        name: git-clone
        kind: Task
      workspaces:
        - name: output
          workspace: shared-data
        - name: ssh-directory
          workspace: ssh-credentials
      params:
        - name: url
          value: $(params.repo-url)
        - name: revision
          value: $(params.revision)

    # Step 2: Run tests (parallel with linting)
    - name: run-tests
      taskRef:
        name: golang-test
        kind: Task
      runAfter:
        - clone-repo
      workspaces:
        - name: source
          workspace: shared-data
      params:
        - name: package
          value: ./...
        - name: flags
          value: "-race -coverprofile=coverage.out"

    # Step 3: Run linting (parallel with tests)
    - name: lint-code
      taskRef:
        name: golangci-lint
        kind: Task
      runAfter:
        - clone-repo
      workspaces:
        - name: source
          workspace: shared-data
      params:
        - name: config-path
          value: ".golangci.yaml"

    # Step 4: Security scan of source code (parallel)
    - name: scan-source
      taskRef:
        name: trivy-scanner
        kind: Task
      runAfter:
        - clone-repo
      workspaces:
        - name: source
          workspace: shared-data
      params:
        - name: scan-type
          value: "fs"
        - name: severity
          value: "CRITICAL,HIGH"
        - name: exit-code
          value: "1"

    # Step 5: Build and push image (after tests and lint)
    - name: build-image
      taskRef:
        name: buildah
        kind: Task
      runAfter:
        - run-tests
        - lint-code
        - scan-source
      workspaces:
        - name: source
          workspace: shared-data
        - name: dockerconfig
          workspace: docker-credentials
      params:
        - name: image
          value: $(params.image-registry)/$(params.app-name):$(tasks.clone-repo.results.commit)

    # Step 6: Scan built image for CVEs
    - name: scan-image
      taskRef:
        name: trivy-scanner
        kind: Task
      runAfter:
        - build-image
      params:
        - name: scan-type
          value: "image"
        - name: image-ref
          value: $(tasks.build-image.results.image-url)
        - name: severity
          value: "CRITICAL,HIGH"
        - name: exit-code
          value: "1"

    # Step 7: Deploy to staging
    - name: deploy-staging
      taskRef:
        name: kubectl-deploy
        kind: Task
      runAfter:
        - scan-image
      workspaces:
        - name: kubeconfig
          workspace: kubeconfig
      params:
        - name: deployment-name
          value: $(params.app-name)
        - name: image
          value: $(tasks.build-image.results.image-url)
        - name: namespace
          value: $(params.staging-namespace)

    # Step 8: Integration tests against staging
    - name: integration-tests
      taskRef:
        name: run-integration-tests
        kind: Task
      runAfter:
        - deploy-staging
      params:
        - name: target-url
          value: https://$(params.app-name).$(params.staging-namespace).apps.corp.example.com
        - name: test-suite
          value: "full"

    # Step 9: Manual approval gate (using Tekton's Approval task or Pause task)
    - name: production-approval
      taskRef:
        name: manual-approval
        kind: Task
      runAfter:
        - integration-tests
      params:
        - name: message
          value: "Approve deployment of $(params.app-name)@$(tasks.clone-repo.results.commit) to production?"
        - name: approvers
          value: "platform-team,security-team"

    # Step 10: Deploy to production
    - name: deploy-production
      taskRef:
        name: kubectl-deploy
        kind: Task
      runAfter:
        - production-approval
      workspaces:
        - name: kubeconfig
          workspace: kubeconfig
      params:
        - name: deployment-name
          value: $(params.app-name)
        - name: image
          value: $(tasks.build-image.results.image-url)
        - name: namespace
          value: $(params.production-namespace)

  # Finally tasks always run, even on failure
  finally:
    - name: send-notification
      taskRef:
        name: send-slack-notification
        kind: Task
      params:
        - name: pipeline-name
          value: "$(context.pipeline.name)"
        - name: run-name
          value: "$(context.pipelineRun.name)"
        - name: status
          value: "$(tasks.deploy-production.status)"
```

## Section 5: Triggers — Event-Driven Pipeline Execution

### GitHub Webhook EventListener

```yaml
# eventlistener.yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: EventListener
metadata:
  name: github-listener
  namespace: tekton-pipelines
spec:
  serviceAccountName: tekton-triggers-sa
  triggers:
    # Trigger on push to main branch
    - name: push-to-main
      interceptors:
        - ref:
            name: github
            kind: ClusterInterceptor
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: secretToken
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
                - key: extensions.truncated_sha
                  expression: "body.after.truncate(7)"
                - key: extensions.repo_name
                  expression: "body.repository.name"
      bindings:
        - ref: github-push-binding
      template:
        ref: ci-cd-pipeline-template

    # Trigger on pull request opened/updated
    - name: pull-request
      interceptors:
        - ref:
            name: github
            kind: ClusterInterceptor
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: secretToken
            - name: eventTypes
              value: ["pull_request"]
        - ref:
            name: cel
            kind: ClusterInterceptor
          params:
            - name: filter
              value: >-
                body.action in ['opened', 'synchronize', 'reopened'] &&
                !body.pull_request.draft
      bindings:
        - ref: github-pr-binding
      template:
        ref: ci-pr-pipeline-template
---
# TriggerBinding for push events
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerBinding
metadata:
  name: github-push-binding
  namespace: tekton-pipelines
spec:
  params:
    - name: gitrepositoryurl
      value: $(body.repository.clone_url)
    - name: gitrevision
      value: $(body.after)
    - name: gitrepositoryname
      value: $(extensions.repo_name)
    - name: truncated-sha
      value: $(extensions.truncated_sha)
---
# TriggerTemplate creates the PipelineRun
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerTemplate
metadata:
  name: ci-cd-pipeline-template
  namespace: tekton-pipelines
spec:
  params:
    - name: gitrepositoryurl
    - name: gitrevision
    - name: gitrepositoryname
    - name: truncated-sha
  resourcetemplates:
    - apiVersion: tekton.dev/v1
      kind: PipelineRun
      metadata:
        generateName: $(tt.params.gitrepositoryname)-ci-
        namespace: tekton-pipelines
        labels:
          tekton.dev/pipeline: application-ci-cd
          git-revision: $(tt.params.truncated-sha)
      spec:
        pipelineRef:
          name: application-ci-cd
        params:
          - name: repo-url
            value: $(tt.params.gitrepositoryurl)
          - name: revision
            value: $(tt.params.gitrevision)
          - name: app-name
            value: $(tt.params.gitrepositoryname)
        workspaces:
          - name: shared-data
            volumeClaimTemplate:
              spec:
                accessModes:
                  - ReadWriteOnce
                resources:
                  requests:
                    storage: 2Gi
                storageClassName: fast-ssd
          - name: ssh-credentials
            secret:
              secretName: github-ssh-key
          - name: docker-credentials
            secret:
              secretName: registry-credentials
          - name: kubeconfig
            secret:
              secretName: deploy-kubeconfig
        timeouts:
          pipeline: 2h
          tasks: 90m
          finally: 10m
```

### Expose EventListener via Ingress

```yaml
# eventlistener-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tekton-event-listener
  namespace: tekton-pipelines
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - tekton-webhooks.corp.example.com
      secretName: tekton-webhook-tls
  rules:
    - host: tekton-webhooks.corp.example.com
      http:
        paths:
          - path: /hooks
            pathType: Prefix
            backend:
              service:
                name: el-github-listener
                port:
                  number: 8080
```

## Section 6: Tekton Chains — Supply Chain Security

Tekton Chains automatically captures TaskRun attestations and signs them using Sigstore, producing SLSA provenance that can be verified before deployment.

### Configure Tekton Chains

```bash
# Configure Chains to use Sigstore cosign
kubectl create secret generic signing-secrets \
  --from-literal=cosign.password="" \
  -n tekton-chains

# Generate cosign key pair
cosign generate-key-pair k8s://tekton-chains/signing-secrets

# Configure Chains
kubectl patch configmap chains-config \
  -n tekton-chains \
  --type merge \
  -p '{
    "data": {
      "artifacts.oci.format": "sigstore-bundle",
      "artifacts.oci.storage": "oci",
      "artifacts.oci.signer": "x509",
      "artifacts.taskrun.format": "slsa/v1",
      "artifacts.taskrun.storage": "oci",
      "artifacts.taskrun.signer": "x509",
      "artifacts.pipelinerun.format": "slsa/v1",
      "artifacts.pipelinerun.storage": "oci",
      "artifacts.pipelinerun.signer": "x509",
      "transparency.enabled": "true",
      "transparency.url": "https://rekor.sigstore.dev"
    }
  }'
```

### Verify Image Attestation

```bash
# After pipeline run, verify the image signature
cosign verify \
  --certificate-identity-regexp ".*" \
  --certificate-oidc-issuer-regexp ".*" \
  gcr.io/corp-registry/myapp:v1.2.3

# Verify SLSA provenance attestation
cosign verify-attestation \
  --type slsaprovenance \
  --certificate-identity-regexp ".*" \
  --certificate-oidc-issuer-regexp ".*" \
  gcr.io/corp-registry/myapp:v1.2.3 | jq .

# Extract provenance details
cosign verify-attestation \
  --type slsaprovenance \
  gcr.io/corp-registry/myapp:v1.2.3 | \
  jq '.payload | @base64d | fromjson | .predicate'
```

## Section 7: Workspace Patterns

### Shared Workspace Between All Tasks

```yaml
# pipelinerun-shared-workspace.yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: ci-run-001
  namespace: tekton-pipelines
spec:
  pipelineRef:
    name: application-ci-cd
  workspaces:
    # Single PVC shared across all tasks
    - name: shared-data
      volumeClaimTemplate:
        spec:
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 5Gi
          storageClassName: fast-ssd
    # Existing secret-based workspace
    - name: ssh-credentials
      secret:
        secretName: github-ssh-key
    # ConfigMap workspace (read-only config)
    - name: build-config
      configMap:
        name: build-configuration
    # Empty directory (in-memory for sensitive data)
    - name: temp-secrets
      emptyDir:
        medium: Memory
```

### Workspace Binding in Task Steps

```yaml
# task-with-multiple-workspaces.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: compile-and-test
  namespace: tekton-pipelines
spec:
  workspaces:
    - name: source
      description: Source code (read-write)
    - name: cache
      description: Go module cache
      optional: true
    - name: output
      description: Build artifacts output
  steps:
    - name: download-deps
      image: golang:1.22
      workingDir: $(workspaces.source.path)
      env:
        - name: GOMODCACHE
          value: $(workspaces.cache.path)/mod
        - name: GOCACHE
          value: $(workspaces.cache.path)/build
      script: |
        #!/usr/bin/env bash
        set -euo pipefail
        go mod download

    - name: run-tests
      image: golang:1.22
      workingDir: $(workspaces.source.path)
      env:
        - name: GOMODCACHE
          value: $(workspaces.cache.path)/mod
        - name: GOCACHE
          value: $(workspaces.cache.path)/build
      script: |
        #!/usr/bin/env bash
        set -euo pipefail
        go test -race -coverprofile=$(workspaces.output.path)/coverage.out ./...
        go tool cover -html=$(workspaces.output.path)/coverage.out \
          -o $(workspaces.output.path)/coverage.html

    - name: build-binary
      image: golang:1.22
      workingDir: $(workspaces.source.path)
      script: |
        #!/usr/bin/env bash
        set -euo pipefail
        CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
          -ldflags="-s -w -X main.version=$(cat VERSION)" \
          -o $(workspaces.output.path)/app \
          ./cmd/server/
```

## Section 8: Tekton Results

Tekton Results provides a persistent, queryable store for pipeline execution history, separate from the ephemeral TaskRun/PipelineRun objects in Kubernetes.

```yaml
# results-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tekton-results-api-config
  namespace: tekton-results
data:
  config: |
    DB_PROTOCOL=postgres
    DB_HOST=postgres.tekton-results.svc.cluster.local
    DB_PORT=5432
    DB_NAME=tekton_results
    DB_USER=tektonresults
    GRPC_PORT=50051
    REST_PORT=8080
    TLS_PATH=/etc/tls
    LOG_LEVEL=info
    LOGS_API=true
    LOGS_TYPE=File
    LOGS_FILE_SIZE_LIMIT=1073741824
    STORAGE_EMULATOR_HOST=
```

```bash
# Query pipeline results using tkn-results CLI
tkn-results records list \
  --grpc-addr tekton-results.corp.example.com:443 \
  --namespace tekton-pipelines \
  --filter "data_type == \"tekton.dev/v1.PipelineRun\"" \
  --order-by "create_time desc" \
  --page-size 20

# Get specific pipeline run details
tkn-results records get \
  --grpc-addr tekton-results.corp.example.com:443 \
  tekton-pipelines/results/abc123/records/pipelinerun-456
```

## Section 9: RBAC and Service Accounts

```yaml
# tekton-service-account.yaml
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
    resources: ["pods", "pods/log", "persistentvolumeclaims"]
    verbs: ["create", "get", "list", "watch", "update", "delete"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "update", "patch"]
  - apiGroups: ["tekton.dev"]
    resources: ["tasks", "taskruns", "pipelines", "pipelineruns"]
    verbs: ["get", "list", "create", "update", "patch", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: tekton-pipeline-rb
subjects:
  - kind: ServiceAccount
    name: tekton-pipeline-sa
    namespace: tekton-pipelines
roleRef:
  kind: ClusterRole
  name: tekton-pipeline-role
  apiGroup: rbac.authorization.k8s.io
---
# Triggers RBAC
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: tekton-triggers-role
rules:
  - apiGroups: ["triggers.tekton.dev"]
    resources: ["eventlisteners", "triggerbindings", "triggertemplates", "triggers", "clusterinterceptors"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["tekton.dev"]
    resources: ["pipelineruns", "taskruns"]
    verbs: ["create"]
  - apiGroups: [""]
    resources: ["configmaps", "secrets", "serviceaccounts"]
    verbs: ["get", "list"]
```

## Section 10: Observability and Troubleshooting

### Prometheus Metrics for Tekton

```bash
# Enable metrics in Tekton Pipelines
kubectl patch configmap config-observability \
  -n tekton-pipelines \
  --type merge \
  -p '{"data":{"metrics.backend-destination":"prometheus","metrics.reporting-period-seconds":"30"}}'

# Key Tekton metrics
# tekton_pipelineruns_count — total pipeline runs by status
# tekton_taskruns_count — total task runs by status
# tekton_pipelinerun_duration_seconds — pipeline run duration histogram
# tekton_taskrun_duration_seconds — task run duration histogram
```

### Common Debugging Commands

```bash
# Watch pipeline run progress
tkn pipelinerun logs -f -n tekton-pipelines

# Describe failed pipeline run
tkn pipelinerun describe <run-name> -n tekton-pipelines

# Get logs from specific task in pipeline run
tkn pipelinerun logs <run-name> -t build-image -n tekton-pipelines

# List recent task runs with status
tkn taskrun list -n tekton-pipelines --limit 20

# Debug workspace mount issues
kubectl get pvc -n tekton-pipelines
kubectl describe pvc <pvc-name> -n tekton-pipelines

# Inspect EventListener
tkn eventlistener describe github-listener -n tekton-pipelines
kubectl logs -n tekton-pipelines deployment/el-github-listener | tail -50

# Check Chains signing status
kubectl get taskrun <name> -n tekton-pipelines \
  -o jsonpath='{.metadata.annotations}' | jq . | grep chains
```

This guide establishes the foundational architecture for enterprise Tekton deployments. The combination of reusable Tasks, parameterized Pipelines, event-driven Triggers, and Chains-based supply chain security creates a CI/CD platform that satisfies both operational efficiency and security compliance requirements.
