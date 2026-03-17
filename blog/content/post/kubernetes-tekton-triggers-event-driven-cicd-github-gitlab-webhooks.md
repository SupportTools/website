---
title: "Kubernetes Tekton Triggers: Event-Driven CI/CD with GitHub and GitLab Webhooks"
date: 2031-02-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Tekton", "CI/CD", "GitHub", "GitLab", "Webhooks", "GitOps", "DevOps"]
categories:
- Kubernetes
- CI/CD
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Tekton Triggers: designing TriggerTemplates and TriggerBindings, deploying EventListeners, writing CEL filter expressions, configuring GitHub and GitLab webhooks, chaining interceptors, and building a complete PR-triggered pipeline."
more_link: "yes"
url: "/kubernetes-tekton-triggers-event-driven-cicd-github-gitlab-webhooks/"
---

Tekton Triggers transforms Tekton Pipelines from manually-invoked workflows into a fully event-driven CI/CD system. When a developer opens a pull request, the GitHub webhook fires, the EventListener processes the payload, CEL expressions filter for the relevant events, and a new PipelineRun materializes in your cluster within seconds. This guide builds a production-ready Tekton Triggers implementation from first principles.

<!--more-->

# Kubernetes Tekton Triggers: Event-Driven CI/CD with GitHub and GitLab Webhooks

## Section 1: Tekton Triggers Architecture

Tekton Triggers introduces four core CRDs on top of the base Tekton Pipelines installation:

- **TriggerTemplate** — a parameterized template that defines what Kubernetes resources to create when triggered (PipelineRun, TaskRun, etc.)
- **TriggerBinding** — extracts values from the incoming event payload and maps them to TriggerTemplate parameters
- **ClusterTriggerBinding** — same as TriggerBinding but cluster-scoped (reusable across namespaces)
- **EventListener** — the HTTP endpoint that receives webhook events, applies interceptors, and invokes Trigger bindings
- **Trigger** — combines a TriggerBinding + TriggerTemplate into a reusable unit
- **Interceptor** — processes the incoming request (authentication, filtering, transformation) before the binding runs

```
GitHub/GitLab Webhook
        │
        ▼
┌─────────────────────────────────────────┐
│           EventListener Pod             │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │   Interceptor Chain              │   │
│  │   1. GitHub Webhook Auth (HMAC)  │   │
│  │   2. CEL Filter Expression       │   │
│  │   3. CEL Overlay (transform)     │   │
│  └──────────────────┬───────────────┘   │
│                     │ filtered payload  │
│  ┌──────────────────▼───────────────┐   │
│  │   TriggerBinding                 │   │
│  │   Extracts: repo, branch, SHA    │   │
│  └──────────────────┬───────────────┘   │
│                     │ parameters        │
│  ┌──────────────────▼───────────────┐   │
│  │   TriggerTemplate                │   │
│  │   Creates: PipelineRun resource  │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
        │
        ▼
  PipelineRun created in cluster
```

## Section 2: Installing Tekton Pipelines and Triggers

```bash
# Install Tekton Pipelines
kubectl apply -f https://storage.googleapis.com/tekton-releases/pipeline/previous/v0.62.0/release.yaml

# Install Tekton Triggers
kubectl apply -f https://storage.googleapis.com/tekton-releases/triggers/previous/v0.28.0/release.yaml
kubectl apply -f https://storage.googleapis.com/tekton-releases/triggers/previous/v0.28.0/interceptors.yaml

# Install Tekton Dashboard (optional but useful)
kubectl apply -f https://storage.googleapis.com/tekton-releases/dashboard/previous/v0.50.0/release.yaml

# Verify installation
kubectl get pods -n tekton-pipelines
# NAME                                           READY   STATUS
# tekton-pipelines-controller-xxx                1/1     Running
# tekton-pipelines-webhook-xxx                   1/1     Running

kubectl get pods -n tekton-pipelines-resolvers
# NAME                                   READY   STATUS
# tekton-pipelines-remote-resolvers-xxx  1/1     Running

# Wait for all components
kubectl wait --for=condition=Ready pods --all -n tekton-pipelines --timeout=300s
kubectl wait --for=condition=Ready pods --all -n tekton-pipelines-resolvers --timeout=300s
```

## Section 3: Building the CI Pipeline

Before building the trigger infrastructure, define the pipeline itself.

### Build and Test Pipeline

```yaml
# pipeline-build-test.yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: build-test-push
  namespace: tekton-ci
spec:
  description: "Build, test, and push a container image"

  params:
    - name: repo-url
      type: string
      description: Git repository URL
    - name: revision
      type: string
      description: Git revision (commit SHA or branch)
    - name: image-registry
      type: string
      description: Container registry prefix
      default: registry.company.com
    - name: image-name
      type: string
      description: Container image name (without tag)
    - name: context-dir
      type: string
      description: Docker build context directory
      default: "."
    - name: pr-number
      type: string
      description: Pull request number (empty for branch builds)
      default: ""

  workspaces:
    - name: source
      description: Workspace for cloned source code
    - name: docker-credentials
      description: Docker registry credentials

  results:
    - name: image-digest
      description: Digest of the built image
      value: $(tasks.build-image.results.IMAGE_DIGEST)
    - name: image-url
      description: Full image URL with tag
      value: $(tasks.build-image.results.IMAGE_URL)

  tasks:
    - name: clone
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: task
          - name: name
            value: git-clone
          - name: namespace
            value: tekton-ci
      params:
        - name: url
          value: $(params.repo-url)
        - name: revision
          value: $(params.revision)
        - name: depth
          value: "0"  # Full clone for accurate git log
      workspaces:
        - name: output
          workspace: source

    - name: lint
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: task
          - name: name
            value: golangci-lint
          - name: namespace
            value: tekton-ci
      runAfter: [clone]
      params:
        - name: context-dir
          value: $(params.context-dir)
      workspaces:
        - name: source
          workspace: source

    - name: unit-test
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: task
          - name: name
            value: golang-test
          - name: namespace
            value: tekton-ci
      runAfter: [clone]
      params:
        - name: context-dir
          value: $(params.context-dir)
        - name: test-flags
          value: "-race -coverprofile=coverage.out ./..."
      workspaces:
        - name: source
          workspace: source

    - name: build-image
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: task
          - name: name
            value: kaniko
          - name: namespace
            value: tekton-ci
      runAfter: [lint, unit-test]
      params:
        - name: IMAGE
          value: "$(params.image-registry)/$(params.image-name):$(params.revision)"
        - name: CONTEXT
          value: $(params.context-dir)
        - name: EXTRA_ARGS
          value: ["--cache=true", "--cache-ttl=24h"]
      workspaces:
        - name: source
          workspace: source
        - name: dockerconfig
          workspace: docker-credentials

    - name: scan-image
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: task
          - name: name
            value: trivy-scanner
          - name: namespace
            value: tekton-ci
      runAfter: [build-image]
      params:
        - name: IMAGE
          value: "$(tasks.build-image.results.IMAGE_URL)"
        - name: SEVERITY
          value: "CRITICAL,HIGH"

  finally:
    - name: notify-github
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: task
          - name: name
            value: github-set-status
          - name: namespace
            value: tekton-ci
      params:
        - name: repo-url
          value: $(params.repo-url)
        - name: sha
          value: $(params.revision)
        - name: state
          value: $(tasks.build-image.status)
        - name: description
          value: "Tekton Build"
        - name: context
          value: "tekton/build"
```

### Custom Tasks

```yaml
# task-golang-test.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: golang-test
  namespace: tekton-ci
spec:
  params:
    - name: context-dir
      type: string
      default: "."
    - name: test-flags
      type: string
      default: "./..."
    - name: go-version
      type: string
      default: "1.24"

  workspaces:
    - name: source

  steps:
    - name: test
      image: golang:$(params.go-version)-alpine
      workingDir: $(workspaces.source.path)/$(params.context-dir)
      env:
        - name: GOFLAGS
          value: "-mod=vendor"
        - name: CGO_ENABLED
          value: "0"
        - name: GOCACHE
          value: /tmp/go-cache
        - name: GOMODCACHE
          value: /tmp/go-mod-cache
      script: |
        #!/bin/sh
        set -ex

        go version
        go vet ./...
        go test $(params.test-flags)

        if [ -f coverage.out ]; then
          COVERAGE=$(go tool cover -func=coverage.out | tail -1 | awk '{print $3}')
          echo "Total coverage: ${COVERAGE}"
        fi
```

## Section 4: TriggerBinding Design

TriggerBindings extract values from the incoming JSON payload.

### GitHub TriggerBinding

```yaml
# triggerbinding-github-pr.yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerBinding
metadata:
  name: github-pr-binding
  namespace: tekton-ci
spec:
  params:
    # Repository information
    - name: git-repo-url
      value: $(body.repository.clone_url)
    - name: git-repo-name
      value: $(body.repository.name)
    - name: git-repo-full-name
      value: $(body.repository.full_name)

    # PR-specific fields
    - name: git-revision
      value: $(body.pull_request.head.sha)
    - name: git-branch
      value: $(body.pull_request.head.ref)
    - name: git-base-branch
      value: $(body.pull_request.base.ref)
    - name: pr-number
      value: $(body.number)
    - name: pr-action
      value: $(body.action)
    - name: pr-title
      value: $(body.pull_request.title)

    # Sender information
    - name: git-sender
      value: $(body.sender.login)
    - name: git-sender-type
      value: $(body.sender.type)  # User vs Bot

    # Headers
    - name: event-type
      value: $(header.X-Github-Event)
    - name: delivery-id
      value: $(header.X-Github-Delivery)
```

```yaml
# triggerbinding-github-push.yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerBinding
metadata:
  name: github-push-binding
  namespace: tekton-ci
spec:
  params:
    - name: git-repo-url
      value: $(body.repository.clone_url)
    - name: git-repo-name
      value: $(body.repository.name)
    - name: git-revision
      value: $(body.head_commit.id)
    - name: git-branch
      # body.ref is "refs/heads/main" — strip prefix
      value: $(body.ref)
    - name: git-sender
      value: $(body.pusher.name)
    - name: commits-count
      value: $(body.commits | length)
```

### GitLab TriggerBinding

```yaml
# triggerbinding-gitlab-mr.yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerBinding
metadata:
  name: gitlab-mr-binding
  namespace: tekton-ci
spec:
  params:
    - name: git-repo-url
      value: $(body.project.git_http_url)
    - name: git-repo-name
      value: $(body.project.name)
    - name: git-revision
      value: $(body.object_attributes.last_commit.id)
    - name: git-branch
      value: $(body.object_attributes.source_branch)
    - name: git-base-branch
      value: $(body.object_attributes.target_branch)
    - name: pr-number
      value: $(body.object_attributes.iid)
    - name: pr-action
      value: $(body.object_attributes.action)
    - name: git-sender
      value: $(body.user.username)
```

### ClusterTriggerBinding for Reusable Defaults

```yaml
# clustertriggerbinding-defaults.yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: ClusterTriggerBinding
metadata:
  name: ci-defaults
spec:
  params:
    - name: image-registry
      value: registry.company.com
    - name: tekton-namespace
      value: tekton-ci
```

## Section 5: TriggerTemplate Design

TriggerTemplates define the resources to create. Use `tt.params` to access the extracted values.

```yaml
# triggertemplate-pr-pipeline.yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerTemplate
metadata:
  name: pr-pipeline-template
  namespace: tekton-ci
spec:
  params:
    - name: git-repo-url
      description: Git repository URL
    - name: git-repo-name
      description: Short repository name
    - name: git-revision
      description: Git commit SHA (full)
    - name: git-branch
      description: Source branch name
    - name: pr-number
      description: Pull request number
      default: ""
    - name: git-sender
      description: Username who triggered the event
    - name: image-registry
      default: registry.company.com
    - name: context-dir
      default: "."

  resourcetemplates:
    - apiVersion: tekton.dev/v1
      kind: PipelineRun
      metadata:
        # generateName ensures unique PipelineRun per trigger
        generateName: pr-$(tt.params.git-repo-name)-$(tt.params.pr-number)-
        namespace: tekton-ci
        labels:
          tekton.dev/pipeline: build-test-push
          app.kubernetes.io/managed-by: tekton-triggers
          git/repo: $(tt.params.git-repo-name)
          git/branch: $(tt.params.git-branch)
          git/revision: $(tt.params.git-revision)
          ci/pr-number: $(tt.params.pr-number)
        annotations:
          git/sender: $(tt.params.git-sender)
          git/repo-url: $(tt.params.git-repo-url)
      spec:
        pipelineRef:
          name: build-test-push
        params:
          - name: repo-url
            value: $(tt.params.git-repo-url)
          - name: revision
            value: $(tt.params.git-revision)
          - name: image-name
            value: $(tt.params.git-repo-name)
          - name: image-registry
            value: $(tt.params.image-registry)
          - name: context-dir
            value: $(tt.params.context-dir)
          - name: pr-number
            value: $(tt.params.pr-number)
        workspaces:
          - name: source
            volumeClaimTemplate:
              spec:
                accessModes: [ReadWriteOnce]
                storageClassName: fast-ssd
                resources:
                  requests:
                    storage: 2Gi
          - name: docker-credentials
            secret:
              secretName: registry-credentials
        # Timeout for the entire pipeline
        timeouts:
          pipeline: 1h
          tasks: 45m
          finally: 10m
        # Retry failed tasks once
        taskRunSpecs:
          - pipelineTaskName: unit-test
            computeResources:
              requests:
                cpu: "2"
                memory: "4Gi"
              limits:
                cpu: "4"
                memory: "8Gi"
```

### TriggerTemplate for Mainline Pushes

```yaml
# triggertemplate-push-pipeline.yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerTemplate
metadata:
  name: push-pipeline-template
  namespace: tekton-ci
spec:
  params:
    - name: git-repo-url
    - name: git-repo-name
    - name: git-revision
    - name: git-branch
    - name: image-registry
      default: registry.company.com

  resourcetemplates:
    - apiVersion: tekton.dev/v1
      kind: PipelineRun
      metadata:
        generateName: push-$(tt.params.git-repo-name)-
        namespace: tekton-ci
        labels:
          ci/trigger-type: push
          git/repo: $(tt.params.git-repo-name)
          git/branch: $(tt.params.git-branch)
      spec:
        pipelineRef:
          name: build-test-push
        params:
          - name: repo-url
            value: $(tt.params.git-repo-url)
          - name: revision
            value: $(tt.params.git-revision)
          - name: image-name
            value: $(tt.params.git-repo-name)
          - name: image-registry
            value: $(tt.params.image-registry)
        workspaces:
          - name: source
            volumeClaimTemplate:
              spec:
                accessModes: [ReadWriteOnce]
                resources:
                  requests:
                    storage: 2Gi
          - name: docker-credentials
            secret:
              secretName: registry-credentials
```

## Section 6: CEL Filter Expressions

CEL (Common Expression Language) interceptors allow sophisticated filtering of webhook events before they trigger pipeline runs.

### Filtering PR Events

```yaml
# CEL interceptor examples within an EventListener trigger

# Filter 1: Only trigger on PR opened, reopened, or synchronize events
# (synchronize = new commits pushed to an existing PR)
- ref:
    name: cel
  params:
    - name: filter
      value: >-
        header.match("X-Github-Event", "pull_request") &&
        (body.action == "opened" ||
         body.action == "reopened" ||
         body.action == "synchronize")

# Filter 2: Only trigger for specific base branches
- ref:
    name: cel
  params:
    - name: filter
      value: >-
        body.pull_request.base.ref.matches("^(main|master|release/.+)$")

# Filter 3: Exclude PRs from bots
- ref:
    name: cel
  params:
    - name: filter
      value: >-
        body.sender.type != "Bot" &&
        !body.sender.login.matches("^(dependabot|renovate|github-actions).*")

# Filter 4: Only trigger if specific files changed
# Requires the GitHub Files Changed API or push event
- ref:
    name: cel
  params:
    - name: filter
      value: >-
        body.commits.exists(c,
          c.modified.exists(f, f.startsWith("src/")) ||
          c.added.exists(f, f.startsWith("src/"))
        )

# Filter 5: Skip if commit message contains [skip ci]
- ref:
    name: cel
  params:
    - name: filter
      value: >-
        !body.head_commit.message.contains("[skip ci]") &&
        !body.head_commit.message.contains("[ci skip]")
```

### CEL Overlays for Payload Transformation

Overlays add computed fields to the body before TriggerBinding extraction:

```yaml
- ref:
    name: cel
  params:
    - name: filter
      value: "header.match('X-Github-Event', 'push')"
    - name: overlays
      value:
        - key: extensions.image_tag
          expression: >-
            body.ref.replace("refs/heads/", "").replace("/", "-")
        - key: extensions.short_sha
          expression: "body.head_commit.id.substring(0, 8)"
        - key: extensions.is_main_branch
          expression: "body.ref == 'refs/heads/main'"
        - key: extensions.repo_slug
          expression: >-
            body.repository.full_name.replace("/", "-").lowerAscii()
```

Then reference the overlaid fields in the TriggerBinding:

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerBinding
metadata:
  name: github-push-with-overlays
  namespace: tekton-ci
spec:
  params:
    - name: image-tag
      value: $(body.extensions.image_tag)
    - name: short-sha
      value: $(body.extensions.short_sha)
    - name: is-main-branch
      value: $(body.extensions.is_main_branch)
```

## Section 7: EventListener Configuration

The EventListener is the Kubernetes Deployment that hosts the webhook endpoint.

### Complete EventListener with Interceptor Chain

```yaml
# eventlistener-github.yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: EventListener
metadata:
  name: github-listener
  namespace: tekton-ci
spec:
  serviceAccountName: tekton-triggers-sa

  resources:
    kubernetesResource:
      replicas: 2
      spec:
        template:
          spec:
            containers:
              - resources:
                  requests:
                    cpu: 100m
                    memory: 64Mi
                  limits:
                    cpu: 500m
                    memory: 256Mi

  triggers:
    # Trigger 1: PR events (opened, synchronized, reopened)
    - name: github-pr-trigger
      interceptors:
        # Step 1: Verify GitHub webhook signature
        - ref:
            name: github
            kind: ClusterInterceptor
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: token
            - name: eventTypes
              value: ["pull_request"]

        # Step 2: CEL filter — only actionable PR events, not drafts
        - ref:
            name: cel
            kind: ClusterInterceptor
          params:
            - name: filter
              value: >-
                (body.action in ["opened", "reopened", "synchronize"]) &&
                body.pull_request.draft == false &&
                body.sender.type != "Bot"
            - name: overlays
              value:
                - key: extensions.short_sha
                  expression: "body.pull_request.head.sha.substring(0, 8)"
                - key: extensions.image_tag
                  expression: >-
                    "pr-" + string(body.number) + "-" +
                    body.pull_request.head.sha.substring(0, 8)

      bindings:
        - ref: github-pr-binding
        - ref: ci-defaults
          kind: ClusterTriggerBinding
      template:
        ref: pr-pipeline-template

    # Trigger 2: Push to main/release branches
    - name: github-push-trigger
      interceptors:
        - ref:
            name: github
            kind: ClusterInterceptor
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: token
            - name: eventTypes
              value: ["push"]

        - ref:
            name: cel
            kind: ClusterInterceptor
          params:
            - name: filter
              value: >-
                body.ref.matches("^refs/heads/(main|master|release/.+)$") &&
                body.deleted == false &&
                !body.head_commit.message.contains("[skip ci]")
            - name: overlays
              value:
                - key: extensions.image_tag
                  expression: >-
                    body.ref.replace("refs/heads/", "").replace("/", "-") +
                    "-" + body.head_commit.id.substring(0, 8)

      bindings:
        - ref: github-push-binding
        - ref: ci-defaults
          kind: ClusterTriggerBinding
      template:
        ref: push-pipeline-template

    # Trigger 3: Tag push (release builds)
    - name: github-tag-trigger
      interceptors:
        - ref:
            name: github
            kind: ClusterInterceptor
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: token
            - name: eventTypes
              value: ["push"]

        - ref:
            name: cel
            kind: ClusterInterceptor
          params:
            - name: filter
              value: >-
                body.ref.startsWith("refs/tags/v") &&
                body.deleted == false
            - name: overlays
              value:
                - key: extensions.tag_name
                  expression: "body.ref.replace(\"refs/tags/\", \"\")"

      bindings:
        - ref: github-tag-binding
        - ref: ci-defaults
          kind: ClusterTriggerBinding
      template:
        ref: release-pipeline-template
```

### Exposing the EventListener

```yaml
# Service for EventListener
apiVersion: v1
kind: Service
metadata:
  name: el-github-listener
  namespace: tekton-ci
spec:
  selector:
    app.kubernetes.io/managed-by: EventListener
    app.kubernetes.io/part-of: Triggers
    eventlistener: github-listener
  ports:
    - protocol: TCP
      port: 8080
      targetPort: 8080
---
# Ingress to expose webhook endpoint
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tekton-github-webhook
  namespace: tekton-ci
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    # Rate limiting to prevent webhook spam
    nginx.ingress.kubernetes.io/limit-rps: "10"
    nginx.ingress.kubernetes.io/limit-connections: "5"
spec:
  ingressClassName: nginx
  tls:
    - hosts: [tekton-webhooks.company.com]
      secretName: tekton-webhook-tls
  rules:
    - host: tekton-webhooks.company.com
      http:
        paths:
          - path: /github
            pathType: Prefix
            backend:
              service:
                name: el-github-listener
                port:
                  number: 8080
```

## Section 8: RBAC and Service Account Configuration

```yaml
# rbac.yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: tekton-triggers-sa
  namespace: tekton-ci

---
# Role for creating PipelineRuns
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: tekton-triggers-role
  namespace: tekton-ci
rules:
  - apiGroups: ["tekton.dev"]
    resources:
      - pipelineruns
      - taskruns
    verbs: ["create", "get", "list", "watch", "patch", "update"]
  - apiGroups: [""]
    resources:
      - configmaps
      - secrets
      - serviceaccounts
    verbs: ["get", "list", "watch"]
  - apiGroups: ["triggers.tekton.dev"]
    resources:
      - triggertemplates
      - triggerbindings
      - clustertriggerbindings
      - eventlisteners
      - triggers
      - interceptors
    verbs: ["get", "list", "watch"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: tekton-triggers-rb
  namespace: tekton-ci
subjects:
  - kind: ServiceAccount
    name: tekton-triggers-sa
    namespace: tekton-ci
roleRef:
  kind: Role
  name: tekton-triggers-role
  apiGroup: rbac.authorization.k8s.io

---
# ClusterRole needed for ClusterInterceptors
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: tekton-triggers-clusterrole
rules:
  - apiGroups: ["triggers.tekton.dev"]
    resources:
      - clusterinterceptors
      - clustertriggerbindings
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources:
      - namespaces
    verbs: ["get", "list", "watch"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: tekton-triggers-clusterrb
subjects:
  - kind: ServiceAccount
    name: tekton-triggers-sa
    namespace: tekton-ci
roleRef:
  kind: ClusterRole
  name: tekton-triggers-clusterrole
  apiGroup: rbac.authorization.k8s.io
```

## Section 9: GitHub and GitLab Webhook Configuration

### GitHub Webhook Setup

```bash
# Create the webhook secret
WEBHOOK_SECRET=$(openssl rand -hex 32)
kubectl create secret generic github-webhook-secret \
  --from-literal=token="$WEBHOOK_SECRET" \
  -n tekton-ci

echo "Webhook secret: $WEBHOOK_SECRET"
# Copy this value to the GitHub webhook configuration

# Get the webhook URL
kubectl get ingress tekton-github-webhook -n tekton-ci \
  -o jsonpath='{.spec.rules[0].host}'
# tekton-webhooks.company.com
```

GitHub webhook settings:
- **Payload URL**: `https://tekton-webhooks.company.com/github`
- **Content type**: `application/json`
- **Secret**: The value of `$WEBHOOK_SECRET`
- **Events**: Select "Pull requests" and "Pushes"
- **Active**: Checked

### GitLab EventListener

```yaml
# eventlistener-gitlab.yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: EventListener
metadata:
  name: gitlab-listener
  namespace: tekton-ci
spec:
  serviceAccountName: tekton-triggers-sa

  triggers:
    - name: gitlab-mr-trigger
      interceptors:
        # GitLab uses a token header, not HMAC signature
        - ref:
            name: gitlab
            kind: ClusterInterceptor
          params:
            - name: secretRef
              value:
                secretName: gitlab-webhook-secret
                secretKey: token
            - name: eventTypes
              value: ["Merge Request Hook"]

        - ref:
            name: cel
            kind: ClusterInterceptor
          params:
            - name: filter
              value: >-
                body.object_attributes.action in
                ["open", "reopen", "update"] &&
                body.object_attributes.draft == false

      bindings:
        - ref: gitlab-mr-binding
        - ref: ci-defaults
          kind: ClusterTriggerBinding
      template:
        ref: pr-pipeline-template
```

### GitLab Webhook Setup

```bash
# Create GitLab webhook token
GITLAB_TOKEN=$(openssl rand -hex 20)
kubectl create secret generic gitlab-webhook-secret \
  --from-literal=token="$GITLAB_TOKEN" \
  -n tekton-ci

# In GitLab: Settings > Webhooks
# URL: https://tekton-webhooks.company.com/gitlab
# Secret token: $GITLAB_TOKEN
# Trigger: Merge request events, Push events
# SSL verification: Enabled
```

## Section 10: Custom Webhook Interceptor

For advanced use cases, implement a custom interceptor:

```go
// cmd/interceptor/main.go
package main

import (
    "encoding/json"
    "log"
    "net/http"
    "strings"
)

// InterceptorRequest is the payload sent to our interceptor
type InterceptorRequest struct {
    Body    map[string]interface{} `json:"body"`
    Header  map[string][]string    `json:"header"`
    Extensions map[string]interface{} `json:"extensions"`
    Context InterceptorContext      `json:"context"`
}

type InterceptorContext struct {
    EventURL  string `json:"eventURL"`
    EventID   string `json:"eventID"`
    TriggerID string `json:"triggerID"`
}

// InterceptorResponse is what we return
type InterceptorResponse struct {
    Continue   bool                   `json:"continue"`
    Status     InterceptorStatus      `json:"status"`
    Extensions map[string]interface{} `json:"extensions,omitempty"`
}

type InterceptorStatus struct {
    Code    int32  `json:"code"`
    Message string `json:"message"`
}

func handle(w http.ResponseWriter, r *http.Request) {
    var req InterceptorRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    resp := InterceptorResponse{
        Continue: true,
        Status: InterceptorStatus{Code: 0, Message: "OK"},
        Extensions: map[string]interface{}{},
    }

    // Custom logic: check if author is in allowed list
    sender, _ := getNestedString(req.Body, "sender", "login")
    if isRestrictedAuthor(sender) {
        resp.Continue = false
        resp.Status = Code = 9  // PermissionDenied
        resp.Status.Message = "Author not in allowed list"
    } else {
        // Add extensions for downstream use
        resp.Extensions["validated"] = true
        resp.Extensions["author_tier"] = getAuthorTier(sender)
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(resp)
}

func isRestrictedAuthor(login string) bool {
    restricted := []string{"external-contractor", "temp-user"}
    for _, r := range restricted {
        if strings.EqualFold(login, r) {
            return true
        }
    }
    return false
}

func getAuthorTier(login string) string {
    // Query LDAP/SCIM or a configmap for author tier
    // This is a simplified example
    if strings.HasSuffix(login, "-bot") {
        return "automation"
    }
    return "human"
}

func getNestedString(m map[string]interface{}, keys ...string) (string, bool) {
    var current interface{} = m
    for _, key := range keys {
        mp, ok := current.(map[string]interface{})
        if !ok {
            return "", false
        }
        current, ok = mp[key]
        if !ok {
            return "", false
        }
    }
    s, ok := current.(string)
    return s, ok
}

func main() {
    http.HandleFunc("/", handle)
    log.Println("Custom interceptor listening on :8080")
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

```yaml
# clustered-interceptor.yaml
apiVersion: triggers.tekton.dev/v1alpha1
kind: ClusterInterceptor
metadata:
  name: author-validator
spec:
  clientConfig:
    service:
      name: author-validator
      namespace: tekton-ci
      path: /
      port: 8080
```

## Section 11: Troubleshooting Tekton Triggers

### Webhook Not Firing PipelineRun

```bash
# 1. Check EventListener pod logs
kubectl logs -n tekton-ci -l eventlistener=github-listener --tail=100

# Expected on successful trigger:
# {"level":"info","msg":"Generating response","eventID":"abc123","status":201}

# 2. Check interceptor response
# Look for CEL filter failing
# {"level":"info","msg":"Interceptor stopped trigger processing",
#  "trigger":"github-pr-trigger","reason":"filter expression false"}

# 3. Manually test the webhook endpoint
curl -X POST http://localhost:8080 \
  -H "X-GitHub-Event: pull_request" \
  -H "X-Hub-Signature-256: sha256=<signature>" \
  -H "Content-Type: application/json" \
  -d @test-payload.json

# 4. Check RBAC errors preventing PipelineRun creation
kubectl get events -n tekton-ci --field-selector reason=FailedCreate \
  --sort-by='.lastTimestamp' | tail -20
```

### PipelineRun Created but Immediately Failed

```bash
# List recent PipelineRuns
kubectl get pipelineruns -n tekton-ci --sort-by='.metadata.creationTimestamp' | tail -10

# Check status of a specific run
kubectl describe pipelinerun pr-myrepo-42-abc12345 -n tekton-ci

# Check individual task logs
tkn pipelinerun logs pr-myrepo-42-abc12345 -n tekton-ci

# List TaskRuns for a PipelineRun
kubectl get taskruns -n tekton-ci \
  -l tekton.dev/pipelineRun=pr-myrepo-42-abc12345
```

### Cleaning Up Old PipelineRuns

```bash
# Delete PipelineRuns older than 7 days
kubectl get pipelineruns -n tekton-ci -o json | \
  jq -r --arg cutoff "$(date -d '-7 days' -u +%Y-%m-%dT%H:%M:%SZ)" \
  '.items[] | select(.metadata.creationTimestamp < $cutoff) | .metadata.name' | \
  xargs -I{} kubectl delete pipelinerun {} -n tekton-ci

# Or use the Tekton pruner (experimental)
apiVersion: tekton.dev/v1alpha1
kind: TektonResult
metadata:
  name: tekton-results
spec:
  ...
```

## Section 12: Multi-Repository EventListener Pattern

For enterprises managing many repositories, use a single EventListener with dynamic routing based on repository name:

```yaml
# eventlistener-multi-repo.yaml — handles multiple repos with repo-specific configs
apiVersion: triggers.tekton.dev/v1beta1
kind: EventListener
metadata:
  name: multi-repo-listener
  namespace: tekton-ci
spec:
  serviceAccountName: tekton-triggers-sa

  triggers:
    # Frontend repositories — React/Node builds
    - name: frontend-pr-trigger
      interceptors:
        - ref:
            name: github
            kind: ClusterInterceptor
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: token
            - name: eventTypes
              value: ["pull_request"]
        - ref:
            name: cel
            kind: ClusterInterceptor
          params:
            - name: filter
              value: >-
                body.action in ["opened", "synchronize", "reopened"] &&
                body.repository.name.matches("^(web-|ui-|frontend-).*")
            - name: overlays
              value:
                - key: extensions.pipeline_type
                  expression: "'nodejs'"
      bindings:
        - ref: github-pr-binding
        - ref: ci-defaults
          kind: ClusterTriggerBinding
      template:
        ref: nodejs-pr-pipeline-template

    # Backend repositories — Go builds
    - name: backend-pr-trigger
      interceptors:
        - ref:
            name: github
            kind: ClusterInterceptor
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: token
            - name: eventTypes
              value: ["pull_request"]
        - ref:
            name: cel
            kind: ClusterInterceptor
          params:
            - name: filter
              value: >-
                body.action in ["opened", "synchronize", "reopened"] &&
                body.repository.name.matches("^(api-|svc-|backend-).*")
            - name: overlays
              value:
                - key: extensions.pipeline_type
                  expression: "'golang'"
      bindings:
        - ref: github-pr-binding
        - ref: ci-defaults
          kind: ClusterTriggerBinding
      template:
        ref: golang-pr-pipeline-template
```

Tekton Triggers provides a powerful, Kubernetes-native event processing system that eliminates the need for external CI orchestrators while integrating cleanly with GitOps workflows. The combination of CEL filtering, interceptor chains, and parameterized TriggerTemplates gives enterprise teams the flexibility to handle diverse repository types and event patterns from a single, scalable EventListener deployment.
