---
title: "GitLab CI/CD for Kubernetes: Self-Hosted Runners, Docker-in-Docker, and GitOps Integration"
date: 2030-08-25T00:00:00-05:00
draft: false
tags: ["GitLab", "CI/CD", "Kubernetes", "GitOps", "ArgoCD", "Docker", "DevOps"]
categories:
- CI/CD
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise GitLab CI guide covering Kubernetes executor configuration, autoscaling runners, Docker-in-Docker security, pipeline caching strategies, GitLab Container Registry integration, and ArgoCD deployment triggers."
more_link: "yes"
url: "/gitlab-cicd-kubernetes-self-hosted-runners-docker-in-docker-gitops/"
---

GitLab CI/CD running on Kubernetes provides elastic, cost-efficient pipeline execution that scales to zero between builds. However, the default documentation leaves significant gaps around security hardening for Docker-in-Docker, cache distribution across autoscaled runner pods, GitLab Container Registry authentication in Kubernetes, and the handoff from a CI build to ArgoCD's declarative deployment model. This post builds a production-ready GitLab CI architecture from runner installation through a full GitOps deployment loop.

<!--more-->

## GitLab Runner Kubernetes Executor Architecture

The GitLab Runner Kubernetes executor creates a new pod in the cluster for each CI job. The runner manager pod watches for pending jobs from the GitLab API and spawns job pods that execute pipeline stages. When the job completes, the pod is deleted.

This architecture provides several advantages over shell or Docker executors:
- Native resource isolation per job via Kubernetes limits
- Automatic cleanup of job artifacts on pod deletion
- Horizontal scaling of the runner manager without state
- Integration with Kubernetes RBAC and PodSecurityAdmission

### Installing GitLab Runner with Helm

```bash
helm repo add gitlab https://charts.gitlab.io
helm repo update

# Create namespace and ServiceAccount
kubectl create namespace gitlab-runners

# Create runner registration token secret
kubectl create secret generic gitlab-runner-token \
  --from-literal=runner-registration-token="<runner-registration-token>" \
  --from-literal=runner-token="" \
  -n gitlab-runners
```

### Runner Helm Values for Production

```yaml
# runner-values.yaml
gitlabUrl: https://gitlab.example.com
runnerRegistrationToken: ""  # loaded from secret

# Override to use the secret created above
existingEnvVarSecret: gitlab-runner-token

# Number of concurrent jobs per runner manager pod
concurrent: 20

# Polling interval for new jobs (seconds)
checkInterval: 3

# Enable metrics for Prometheus
metrics:
  enabled: true
  portName: metrics
  port: 9252
  serviceMonitor:
    enabled: true

rbac:
  create: true
  rules:
    - resources: ["pods", "pods/exec", "pods/attach", "secrets", "configmaps"]
      verbs: ["get", "list", "watch", "create", "patch", "delete", "update"]
    - resources: ["pods/log"]
      verbs: ["get", "list", "watch"]

runners:
  config: |
    [[runners]]
      name = "kubernetes-runner"
      executor = "kubernetes"
      [runners.kubernetes]
        namespace = "gitlab-runners"
        image = "ubuntu:22.04"
        privileged = false
        cpu_limit = "2"
        memory_limit = "4Gi"
        cpu_request = "100m"
        memory_request = "256Mi"
        service_cpu_limit = "1"
        service_memory_limit = "2Gi"
        service_cpu_request = "50m"
        service_memory_request = "128Mi"
        helper_cpu_limit = "200m"
        helper_memory_limit = "256Mi"
        helper_cpu_request = "10m"
        helper_memory_request = "32Mi"
        poll_interval = 5
        poll_timeout = 3600

        # Node selection for runner pods
        [runners.kubernetes.node_selector]
          "workload-type" = "ci"

        [runners.kubernetes.node_tolerations]
          "ci-workload" = "true:NoSchedule"

        # Pod security context
        [runners.kubernetes.pod_security_context]
          run_as_non_root = true
          run_as_user = 1000
          fs_group = 1000

        # Labels applied to runner pods
        [runners.kubernetes.pod_labels]
          "app.kubernetes.io/managed-by" = "gitlab-runner"

resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 100m
    memory: 128Mi

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 999

affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchExpressions:
              - key: app
                operator: In
                values:
                  - gitlab-runner
          topologyKey: kubernetes.io/hostname
```

```bash
helm install gitlab-runner gitlab/gitlab-runner \
  -n gitlab-runners \
  -f runner-values.yaml \
  --set gitlabUrl=https://gitlab.example.com
```

## Kubernetes Executor Advanced Configuration

### Per-Job Resource Overrides

GitLab allows per-job resource requests via variables:

```yaml
# .gitlab-ci.yml
build:
  stage: build
  variables:
    KUBERNETES_CPU_REQUEST: "500m"
    KUBERNETES_CPU_LIMIT: "2"
    KUBERNETES_MEMORY_REQUEST: "1Gi"
    KUBERNETES_MEMORY_LIMIT: "4Gi"
    # Override the job image
    KUBERNETES_IMAGE: "golang:1.22-alpine"
  script:
    - go build ./...

integration-tests:
  stage: test
  variables:
    KUBERNETES_CPU_REQUEST: "1"
    KUBERNETES_MEMORY_REQUEST: "2Gi"
    # Run additional service containers alongside the job pod
    KUBERNETES_SERVICE_ACCOUNT: "test-runner-sa"
  services:
    - name: postgres:16
      alias: postgres
    - name: redis:7
      alias: redis
  script:
    - go test -v -tags integration ./...
```

### Attaching Persistent Cache Volumes

```yaml
# runner-values.yaml additions for persistent cache
runners:
  config: |
    [[runners]]
      executor = "kubernetes"
      [runners.cache]
        Type = "s3"
        Shared = true
        [runners.cache.s3]
          ServerAddress = "minio.minio-system.svc.cluster.local:9000"
          BucketName = "gitlab-runner-cache"
          BucketLocation = "us-east-1"
          Insecure = false
          AuthenticationType = "iam"
```

For in-cluster S3-compatible cache with Minio:

```yaml
# minio-cache.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: runner-cache-config
  namespace: gitlab-runners
data:
  CACHE_TYPE: "s3"
  CACHE_S3_SERVER_ADDRESS: "minio.minio-system.svc.cluster.local:9000"
  CACHE_S3_BUCKET_NAME: "gitlab-runner-cache"
  CACHE_S3_INSECURE: "false"
```

## Docker-in-Docker: Security Considerations and Alternatives

Docker-in-Docker (DinD) enables building container images inside CI jobs. The standard implementation runs a privileged `docker:dind` service container, which has significant security implications.

### The Privileged DinD Problem

Running a container with `--privileged` grants it nearly unrestricted access to the host kernel, including:
- Loading kernel modules
- Accessing host devices
- Bypassing namespace isolation
- Potential container escape to the host node

In a shared cluster, this is unacceptable. Any CI job from any project could potentially escape the container boundary.

### Option 1: Rootless DinD

Docker has supported rootless mode since 20.10, which runs the Docker daemon without `root` privileges using user namespaces:

```yaml
# .gitlab-ci.yml - Rootless DinD
build-image:
  stage: build
  image: docker:24.0
  variables:
    # Use rootless Docker daemon
    DOCKER_HOST: tcp://docker:2375
    DOCKER_TLS_CERTDIR: ""
    DOCKER_DRIVER: overlay2
  services:
    - name: docker:24.0-dind-rootless
      alias: docker
      variables:
        DOCKER_TLS_CERTDIR: ""
  before_script:
    - docker info
  script:
    - docker build -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA .
    - docker push $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA
```

The `docker:dind-rootless` image runs without `--privileged`, though it does require `--security-opt seccomp=unconfined` and `--security-opt apparmor=unconfined` which the GitLab runner Kubernetes executor sets automatically via pod security context.

### Option 2: Kaniko (Recommended for Kubernetes)

Kaniko builds container images from a Dockerfile without requiring Docker daemon access. It executes each RUN command directly as the current user and pushes to registries:

```yaml
# .gitlab-ci.yml - Kaniko image build
build-image-kaniko:
  stage: build
  image:
    name: gcr.io/kaniko-project/executor:v1.23.0-debug
    entrypoint: [""]
  script:
    - mkdir -p /kaniko/.docker
    - echo "{\"auths\":{\"$CI_REGISTRY\":{\"auth\":\"$(echo -n $CI_REGISTRY_USER:$CI_REGISTRY_PASSWORD | base64)\"}}}" \
        > /kaniko/.docker/config.json
    - /kaniko/executor
        --context "${CI_PROJECT_DIR}"
        --dockerfile "${CI_PROJECT_DIR}/Dockerfile"
        --destination "${CI_REGISTRY_IMAGE}:${CI_COMMIT_SHA}"
        --destination "${CI_REGISTRY_IMAGE}:latest"
        --cache=true
        --cache-repo="${CI_REGISTRY_IMAGE}/cache"
        --snapshot-mode=redo
        --use-new-run
        --compressed-caching=false
```

Kaniko runs as a non-privileged container, making it safe for shared cluster environments.

### Option 3: Buildah

Buildah provides OCI-compliant image building without a daemon, similar to Kaniko but with full Dockerfile compatibility:

```yaml
build-image-buildah:
  stage: build
  image: quay.io/buildah/stable:v1.35
  variables:
    STORAGE_DRIVER: vfs
    BUILDAH_FORMAT: docker
  script:
    - buildah login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"
    - buildah build
        --layers
        --cache-from "${CI_REGISTRY_IMAGE}/cache"
        --cache-to "${CI_REGISTRY_IMAGE}/cache"
        -t "${CI_REGISTRY_IMAGE}:${CI_COMMIT_SHA}"
        -t "${CI_REGISTRY_IMAGE}:${CI_COMMIT_BRANCH}"
        .
    - buildah push "${CI_REGISTRY_IMAGE}:${CI_COMMIT_SHA}"
    - buildah push "${CI_REGISTRY_IMAGE}:${CI_COMMIT_BRANCH}"
```

## Pipeline Caching Strategies

Effective caching dramatically reduces pipeline execution time. GitLab supports multiple cache backends.

### Go Module Cache

```yaml
# .gitlab-ci.yml
variables:
  GOPATH: $CI_PROJECT_DIR/.go
  GOCACHE: $CI_PROJECT_DIR/.go-cache

# Cache Go modules and build cache
.go-cache:
  cache:
    key:
      files:
        - go.sum
      prefix: go-modules
    paths:
      - .go/pkg/mod/
      - .go-cache/
    policy: pull-push

build:
  extends: .go-cache
  image: golang:1.22-alpine
  script:
    - mkdir -p .go .go-cache
    - go build -v ./...
    - go vet ./...

test:
  extends: .go-cache
  image: golang:1.22-alpine
  script:
    - go test -count=1 -coverprofile=coverage.out ./...
  cache:
    policy: pull  # test stage reads but does not write
  artifacts:
    reports:
      coverage_report:
        coverage_format: cobertura
        path: coverage.out
```

### Node.js Cache

```yaml
.node-cache:
  cache:
    key:
      files:
        - package-lock.json
      prefix: node-modules
    paths:
      - node_modules/
      - .npm/
    policy: pull-push

build-frontend:
  extends: .node-cache
  image: node:20-alpine
  variables:
    npm_config_cache: $CI_PROJECT_DIR/.npm
  script:
    - npm ci --prefer-offline
    - npm run build
  artifacts:
    paths:
      - dist/
    expire_in: 1 day
```

### Distributed Cache with S3

For autoscaled runners across nodes, local filesystem caching is unreliable. Use the S3 cache backend:

```toml
# config.toml embedded in runner values
[[runners]]
  [runners.cache]
    Type = "s3"
    Shared = true
    MaxUploadedArchiveSize = 0
    [runners.cache.s3]
      ServerAddress = "s3.amazonaws.com"
      BucketName = "company-gitlab-runner-cache"
      BucketLocation = "us-east-1"
      # Use IRSA (IAM Roles for Service Accounts) for authentication
      AuthenticationType = "iam"
```

## GitLab Container Registry Integration

### Kubernetes ImagePullSecret from GitLab Registry

```bash
# Create registry credentials in the CI namespace
kubectl create secret docker-registry gitlab-registry \
  --docker-server=registry.gitlab.example.com \
  --docker-username=deploy-token \
  --docker-password="<deploy-token-value>" \
  -n production
```

### Deploy Token Rotation via GitLab API

```bash
#!/bin/bash
# rotate-registry-deploy-token.sh

GITLAB_URL="https://gitlab.example.com"
PROJECT_ID="123"
OLD_TOKEN_ID="456"

# Create new deploy token
NEW_TOKEN=$(curl -s \
  --header "PRIVATE-TOKEN: <gitlab-api-token>" \
  --request POST \
  --data "name=k8s-registry-reader&username=k8s-deploy&scopes[]=read_registry" \
  "$GITLAB_URL/api/v4/projects/$PROJECT_ID/deploy_tokens" | jq -r '.token')

# Update Kubernetes secret
kubectl create secret docker-registry gitlab-registry \
  --docker-server=registry.gitlab.example.com \
  --docker-username=k8s-deploy \
  --docker-password="$NEW_TOKEN" \
  -n production \
  --dry-run=client -o yaml | kubectl apply -f -

# Revoke old token
curl -s \
  --header "PRIVATE-TOKEN: <gitlab-api-token>" \
  --request DELETE \
  "$GITLAB_URL/api/v4/projects/$PROJECT_ID/deploy_tokens/$OLD_TOKEN_ID"

echo "Deploy token rotated successfully"
```

### CI/CD Integration with GitLab Container Registry

```yaml
# .gitlab-ci.yml
variables:
  CI_REGISTRY_IMAGE: registry.gitlab.example.com/mygroup/myproject
  DOCKER_BUILDKIT: "1"

stages:
  - build
  - test
  - publish
  - deploy

# Build image with layer caching
build:
  stage: build
  image:
    name: gcr.io/kaniko-project/executor:v1.23.0-debug
    entrypoint: [""]
  before_script:
    - mkdir -p /kaniko/.docker
    - echo "{\"auths\":{\"$CI_REGISTRY\":{\"auth\":\"$(echo -n $CI_REGISTRY_USER:$CI_REGISTRY_PASSWORD | base64)\"}}}" \
        > /kaniko/.docker/config.json
  script:
    - /kaniko/executor
        --context "${CI_PROJECT_DIR}"
        --dockerfile "${CI_PROJECT_DIR}/Dockerfile"
        --destination "${CI_REGISTRY_IMAGE}:${CI_COMMIT_SHA}"
        --cache=true
        --cache-repo="${CI_REGISTRY_IMAGE}/cache"
  rules:
    - if: $CI_COMMIT_BRANCH

# Publish a release tag
publish-release:
  stage: publish
  image:
    name: gcr.io/go-containerregistry/crane:latest
    entrypoint: [""]
  before_script:
    - crane auth login $CI_REGISTRY -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD
  script:
    # Tag the SHA-based image with the version tag
    - crane tag ${CI_REGISTRY_IMAGE}:${CI_COMMIT_SHA} ${CI_COMMIT_TAG}
    - crane tag ${CI_REGISTRY_IMAGE}:${CI_COMMIT_SHA} latest
  rules:
    - if: $CI_COMMIT_TAG
```

## Triggering ArgoCD Deployments from GitLab CI

The standard GitOps pattern separates application code repositories (where CI builds images) from deployment configuration repositories (where ArgoCD watches for changes). CI updates the image tag in the config repo; ArgoCD detects the change and syncs to the cluster.

### Strategy 1: Update the Helm Values File

```yaml
# .gitlab-ci.yml
stages:
  - build
  - deploy

update-deployment-config:
  stage: deploy
  image: alpine/git:2.43.0
  variables:
    CONFIG_REPO: "https://deploy-token:${DEPLOY_TOKEN}@gitlab.example.com/ops/k8s-configs.git"
    APP_NAME: "api-server"
    ENVIRONMENT: "production"
  script:
    # Clone the config repo
    - git clone "$CONFIG_REPO" config-repo
    - cd config-repo
    - git config user.email "ci@example.com"
    - git config user.name "GitLab CI"

    # Update the image tag in Helm values
    - |
      sed -i "s|tag: .*|tag: \"${CI_COMMIT_SHA}\"|" \
        "environments/${ENVIRONMENT}/${APP_NAME}/values.yaml"

    # Commit and push
    - git add "environments/${ENVIRONMENT}/${APP_NAME}/values.yaml"
    - git commit -m "ci: update ${APP_NAME} to ${CI_COMMIT_SHA} [skip ci]"
    - git push origin main
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
```

### Strategy 2: ArgoCD Application-Level Image Updater

The ArgoCD Image Updater automatically detects new images in registries and updates Helm values or Kustomize overlays. Configure it with GitLab registry credentials:

```yaml
# argocd-image-updater-config.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: api-server
  namespace: argocd
  annotations:
    # Tell Image Updater which images to watch
    argocd-image-updater.argoproj.io/image-list: >-
      api-server=registry.gitlab.example.com/mygroup/api-server
    argocd-image-updater.argoproj.io/api-server.update-strategy: digest
    argocd-image-updater.argoproj.io/api-server.helm.image-name: image.repository
    argocd-image-updater.argoproj.io/api-server.helm.image-tag: image.tag
    # Allow only tags from the main branch
    argocd-image-updater.argoproj.io/api-server.allow-tags: regexp:^main-
    # Write changes back to the config repo
    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/git-branch: main
spec:
  project: production
  source:
    repoURL: https://gitlab.example.com/ops/k8s-configs.git
    targetRevision: main
    path: environments/production/api-server
    helm:
      releaseName: api-server
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

### Strategy 3: Direct ArgoCD Sync via API

For immediate sync after a CI build completes, trigger ArgoCD sync directly from the pipeline:

```yaml
# .gitlab-ci.yml
sync-argocd:
  stage: deploy
  image: registry.example.com/tools/argocd-cli:v2.10.0
  variables:
    ARGOCD_SERVER: "argocd.example.com"
    ARGOCD_APP: "api-server"
  before_script:
    - argocd login "$ARGOCD_SERVER"
        --username ci-user
        --password "$ARGOCD_PASSWORD"
        --grpc-web
  script:
    # Update the image in the Application's Helm parameters
    - argocd app set "$ARGOCD_APP"
        --helm-set "image.tag=${CI_COMMIT_SHA}"
    # Trigger sync and wait for healthy status
    - argocd app sync "$ARGOCD_APP" --prune
    - argocd app wait "$ARGOCD_APP"
        --health
        --timeout 300
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
```

## Complete Enterprise Pipeline

```yaml
# .gitlab-ci.yml - Complete pipeline with security scanning and GitOps
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == "main"
    - if: $CI_COMMIT_TAG

variables:
  CI_REGISTRY_IMAGE: registry.gitlab.example.com/${CI_PROJECT_PATH}
  DOCKER_BUILDKIT: "1"
  TRIVY_VERSION: "0.50.1"

stages:
  - lint
  - test
  - build
  - scan
  - publish
  - deploy

# ===== Lint Stage =====
lint-go:
  stage: lint
  image: golangci/golangci-lint:v1.57-alpine
  cache:
    key: golangci-cache
    paths:
      - .golangci-cache/
  script:
    - golangci-lint run --timeout 5m ./...

# ===== Test Stage =====
test:
  stage: test
  image: golang:1.22-alpine
  variables:
    GOPATH: $CI_PROJECT_DIR/.go
    GOCACHE: $CI_PROJECT_DIR/.go-cache
    CGO_ENABLED: "0"
  cache:
    key:
      files:
        - go.sum
    paths:
      - .go/pkg/mod/
      - .go-cache/
    policy: pull
  services:
    - name: postgres:16-alpine
      alias: postgres
      variables:
        POSTGRES_DB: testdb
        POSTGRES_USER: testuser
        POSTGRES_PASSWORD: testpass
  variables:
    DATABASE_URL: "postgres://testuser:testpass@postgres:5432/testdb?sslmode=disable"
  script:
    - apk add --no-cache gcc musl-dev
    - go test -race -coverprofile=coverage.out -covermode=atomic ./...
  coverage: '/^total:\s+\(statements\)\s+(\d+\.\d+)%$/'
  artifacts:
    reports:
      coverage_report:
        coverage_format: cobertura
        path: coverage.out
    expire_in: 7 days

# ===== Build Stage =====
build:
  stage: build
  image:
    name: gcr.io/kaniko-project/executor:v1.23.0-debug
    entrypoint: [""]
  before_script:
    - mkdir -p /kaniko/.docker
    - echo "{\"auths\":{\"${CI_REGISTRY}\":{\"auth\":\"$(echo -n ${CI_REGISTRY_USER}:${CI_REGISTRY_PASSWORD} | base64)\"}}}" \
        > /kaniko/.docker/config.json
  script:
    - /kaniko/executor
        --context "${CI_PROJECT_DIR}"
        --dockerfile "${CI_PROJECT_DIR}/Dockerfile"
        --destination "${CI_REGISTRY_IMAGE}:${CI_COMMIT_SHA}"
        --cache=true
        --cache-repo="${CI_REGISTRY_IMAGE}/cache"
        --build-arg "BUILD_VERSION=${CI_COMMIT_SHA}"
        --build-arg "BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        --label "org.opencontainers.image.revision=${CI_COMMIT_SHA}"
        --label "org.opencontainers.image.source=${CI_PROJECT_URL}"

# ===== Scan Stage =====
container-scan:
  stage: scan
  image:
    name: aquasec/trivy:${TRIVY_VERSION}
    entrypoint: [""]
  variables:
    # Use GitLab's dependency scanning results for caching
    TRIVY_NO_PROGRESS: "true"
    TRIVY_CACHE_DIR: ".trivycache"
    # Fail on HIGH or CRITICAL vulnerabilities
    TRIVY_EXIT_CODE: "1"
    TRIVY_SEVERITY: "HIGH,CRITICAL"
    TRIVY_IGNORE_UNFIXED: "true"
  cache:
    key: trivy-db
    paths:
      - .trivycache/
  before_script:
    - trivy --version
    # Authenticate to pull the image for scanning
    - echo "${CI_REGISTRY_PASSWORD}" | trivy registry login --username "${CI_REGISTRY_USER}" \
        --password-stdin "${CI_REGISTRY}"
  script:
    - trivy image
        --format sarif
        --output trivy-results.sarif
        "${CI_REGISTRY_IMAGE}:${CI_COMMIT_SHA}"
    - trivy image
        --format template
        --template "@/contrib/html.tpl"
        --output trivy-report.html
        "${CI_REGISTRY_IMAGE}:${CI_COMMIT_SHA}"
  artifacts:
    reports:
      sast: trivy-results.sarif
    paths:
      - trivy-report.html
    expire_in: 7 days
  allow_failure: false

# ===== Publish Stage =====
publish-tag:
  stage: publish
  image:
    name: gcr.io/go-containerregistry/crane:latest
    entrypoint: [""]
  before_script:
    - crane auth login $CI_REGISTRY -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD
  script:
    - crane tag ${CI_REGISTRY_IMAGE}:${CI_COMMIT_SHA} ${CI_COMMIT_TAG}
    - crane tag ${CI_REGISTRY_IMAGE}:${CI_COMMIT_SHA} latest
  rules:
    - if: $CI_COMMIT_TAG

# ===== Deploy Stage =====
deploy-staging:
  stage: deploy
  image: alpine/git:2.43.0
  variables:
    CONFIG_REPO: "https://ci-deploy:${CONFIG_REPO_TOKEN}@gitlab.example.com/ops/k8s-configs.git"
  script:
    - git clone "$CONFIG_REPO" config-repo
    - cd config-repo
    - git config user.email "ci@example.com"
    - git config user.name "GitLab CI"
    - sed -i "s|tag:.*|tag: \"${CI_COMMIT_SHA}\"|"
        environments/staging/api-server/values.yaml
    - git add .
    - git commit -m "ci: deploy api-server=${CI_COMMIT_SHA} to staging [skip ci]"
    - git push origin main
  environment:
    name: staging
    url: https://api.staging.example.com
  rules:
    - if: $CI_COMMIT_BRANCH == "main"

deploy-production:
  stage: deploy
  image: alpine/git:2.43.0
  variables:
    CONFIG_REPO: "https://ci-deploy:${CONFIG_REPO_TOKEN}@gitlab.example.com/ops/k8s-configs.git"
  script:
    - git clone "$CONFIG_REPO" config-repo
    - cd config-repo
    - git config user.email "ci@example.com"
    - git config user.name "GitLab CI"
    - sed -i "s|tag:.*|tag: \"${CI_COMMIT_TAG}\"|"
        environments/production/api-server/values.yaml
    - git add .
    - git commit -m "ci: deploy api-server=${CI_COMMIT_TAG} to production [skip ci]"
    - git push origin main
  environment:
    name: production
    url: https://api.example.com
  rules:
    - if: $CI_COMMIT_TAG
  when: manual
```

## Runner Autoscaling with Kubernetes HPA

GitLab runner manager pods can be autoscaled based on pending job queue depth via custom metrics:

```yaml
# runner-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: gitlab-runner-hpa
  namespace: gitlab-runners
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: gitlab-runner
  minReplicas: 1
  maxReplicas: 10
  metrics:
    - type: External
      external:
        metric:
          name: gitlab_runner_jobs_total
          selector:
            matchLabels:
              runner_state: "running"
        target:
          type: AverageValue
          averageValue: "5"
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
        - type: Pods
          value: 2
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120
```

## Troubleshooting Common Issues

### Job Pod Stuck in Pending

```bash
# Check pending pods
kubectl get pods -n gitlab-runners | grep Pending

# Describe the pod for scheduling events
kubectl describe pod <runner-job-pod> -n gitlab-runners

# Common causes:
# 1. Insufficient resources — increase node capacity or reduce job limits
# 2. Node selector mismatch — verify workload-type label on nodes
# 3. PVC bound to wrong zone — use local storage or zone-aware volumes
```

### Docker Registry Authentication Failures

```bash
# Verify CI_REGISTRY variables are set
# In GitLab: Settings → CI/CD → Variables
# CI_REGISTRY, CI_REGISTRY_USER, CI_REGISTRY_PASSWORD are auto-populated for GitLab Registry

# Test registry authentication from a runner pod
kubectl run test-registry --rm -it \
  -n gitlab-runners \
  --image=alpine \
  --restart=Never \
  -- sh -c "apk add curl && curl -u user:pass https://registry.gitlab.example.com/v2/"
```

### Cache Not Being Reused Across Jobs

```bash
# Verify cache key is deterministic
# go.sum and package-lock.json are file-based keys — good
# Using $CI_PIPELINE_ID as key will never hit cache from a different pipeline

# Check S3 cache bucket
aws s3 ls s3://company-gitlab-runner-cache/runner/ --recursive | head -20

# Enable verbose cache logging
CACHE_DEBUG: "true"
```

### ArgoCD Sync Failing After Tag Update

```bash
# Check ArgoCD application status
argocd app get api-server

# Check if the image tag exists in the registry
crane ls registry.gitlab.example.com/mygroup/api-server

# Verify ArgoCD can pull from the registry
kubectl get secret argocd-registry-creds -n argocd -o yaml

# Check sync history
argocd app history api-server
```

## Summary

A production GitLab CI/CD architecture on Kubernetes requires careful attention to four layers: runner security (Kaniko or rootless DinD instead of privileged DinD), cache distribution (S3-backed shared cache for autoscaled pods), registry authentication (deploy tokens with least privilege, rotated regularly), and the CI-to-GitOps handoff (committing image tags to the config repo and triggering ArgoCD sync). The complete pipeline shown here enforces security scanning with Trivy before any image reaches staging, separates staging and production promotions, and integrates with ArgoCD's declarative model to maintain audit trails of every deployment through git commit history.
