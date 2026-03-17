---
title: "ArgoCD Image Updater: Automated Container Image Promotion in GitOps"
date: 2030-12-01T00:00:00-05:00
draft: false
tags: ["ArgoCD", "GitOps", "Kubernetes", "CI/CD", "Container Images", "Automation"]
categories:
- Kubernetes
- GitOps
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to ArgoCD Image Updater installation, annotation-based update strategies including semver, digest, and latest policies, write-back methods, registry authentication, and integration with multi-environment GitOps pipelines."
more_link: "yes"
url: "/argocd-image-updater-automated-container-image-promotion-gitops/"
---

Keeping container images current across multiple environments is one of the most tedious parts of operating a GitOps pipeline. Engineers manually update image tags, open pull requests, and wait for merge cycles — all for a change that could be automated safely and reproducibly. ArgoCD Image Updater solves this problem by watching container registries and automatically updating ArgoCD Application resources when new images are available, following the promotion policies you define through annotations.

This guide covers every aspect of a production-grade ArgoCD Image Updater deployment: installation and configuration, annotation-based update strategies for semver, digest, and latest policies, write-back methods that keep your Git repository as the source of truth, registry authentication against private registries, and integration patterns for multi-environment promotion pipelines.

<!--more-->

# ArgoCD Image Updater: Automated Container Image Promotion in GitOps

## The Problem with Manual Image Promotion

In a mature GitOps organization, every environment has an ArgoCD Application pointing to a Git repository that contains the desired state. When a new container image is built in CI, a human or script must update the image tag in Git, which triggers a synchronization. This loop works but creates toil:

- Engineers are interrupted to approve or merge tag-bump PRs
- Promotion from dev to staging to production requires coordinated manual steps
- Image digest tracking for immutable deployments adds complexity
- Hotfixes require bypassing normal review processes to ship quickly

ArgoCD Image Updater monitors registries continuously and writes updated image references back to Git automatically, following configurable policies that enforce your promotion rules.

## Architecture Overview

ArgoCD Image Updater runs as a Kubernetes Deployment in the `argocd` namespace alongside the ArgoCD components. Its control loop:

1. Enumerates all ArgoCD Applications with Image Updater annotations
2. Fetches the list of available tags from the configured container registry
3. Evaluates the update policy (semver constraint, latest, digest) against the current image
4. When an update is warranted, writes the new image reference back to Git or directly to the Application
5. Triggers an ArgoCD sync if using direct write-back

The updater supports two write-back mechanisms:

- **Git write-back**: Commits the updated image reference to your Git repository as a Kustomize image override or Helm values update, preserving full GitOps auditability
- **Direct write-back**: Updates the ArgoCD Application resource in-cluster without touching Git — simpler but reduces auditability

## Installation

### Prerequisites

- ArgoCD 2.0 or later installed in the cluster
- A container registry the cluster can reach
- Git credentials if using Git write-back

### Installing via Helm

The Helm chart is the recommended installation path for production:

```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

helm upgrade --install argocd-image-updater argo/argocd-image-updater \
  --namespace argocd \
  --create-namespace \
  --values image-updater-values.yaml
```

Create `image-updater-values.yaml`:

```yaml
# image-updater-values.yaml
replicaCount: 1

config:
  # Log level: trace, debug, info, warn, error
  logLevel: info

  # How often to check for updates (default: 2m)
  checkInterval: 2m

  # ArgoCD server connection
  argocd:
    grpcWeb: true
    serverAddress: argocd-server.argocd.svc.cluster.local:443
    insecure: false
    plaintext: false

  # Registries configuration
  registries:
    - name: Docker Hub
      prefix: docker.io
      api_url: https://registry-1.docker.io
      credentials: pullsecret:argocd/dockerhub-credentials
      defaultns: library
      default: true

    - name: GitHub Container Registry
      prefix: ghcr.io
      api_url: https://ghcr.io
      credentials: pullsecret:argocd/ghcr-credentials

    - name: AWS ECR
      prefix: 123456789012.dkr.ecr.us-east-1.amazonaws.com
      api_url: https://123456789012.dkr.ecr.us-east-1.amazonaws.com
      credentials: ext:/scripts/aws-ecr-get-token.sh
      credsexpire: 10h

serviceAccount:
  create: true
  annotations:
    # For AWS ECR IRSA authentication
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/argocd-image-updater-role

metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    namespace: monitoring

rbac:
  # Needed for reading Application resources
  enabled: true

resources:
  requests:
    cpu: 50m
    memory: 64Mi
  limits:
    cpu: 200m
    memory: 256Mi
```

### Installing via Manifests

For clusters without Helm:

```bash
kubectl apply -n argocd -f \
  https://raw.githubusercontent.com/argoproj-labs/argocd-image-updater/stable/manifests/install.yaml
```

### Verifying Installation

```bash
kubectl get pods -n argocd -l app.kubernetes.io/name=argocd-image-updater
kubectl logs -n argocd -l app.kubernetes.io/name=argocd-image-updater --tail=50
```

Expected log output:
```
time="2030-12-01T10:00:00Z" level=info msg="ArgoCD Image Updater starting" version=v0.14.0
time="2030-12-01T10:00:01Z" level=info msg="Loaded 2 registries from configuration"
time="2030-12-01T10:00:02Z" level=info msg="Starting image update cycle"
```

## Registry Authentication

### Docker Hub Credentials

Create a Secret with Docker Hub credentials:

```bash
kubectl create secret docker-registry dockerhub-credentials \
  --namespace argocd \
  --docker-server=https://index.docker.io/v1/ \
  --docker-username=<your-dockerhub-username> \
  --docker-password=<your-dockerhub-token>
```

### GitHub Container Registry

```bash
kubectl create secret docker-registry ghcr-credentials \
  --namespace argocd \
  --docker-server=ghcr.io \
  --docker-username=<github-username> \
  --docker-password=<github-personal-access-token>
```

### AWS ECR with IRSA

For ECR, the recommended approach uses IAM Roles for Service Accounts (IRSA). The image updater needs `ecr:GetAuthorizationToken`, `ecr:DescribeRepositories`, `ecr:ListImages`, and `ecr:DescribeImages` permissions.

IAM policy document:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:DescribeRepositories",
        "ecr:ListImages",
        "ecr:DescribeImages",
        "ecr:BatchGetImage"
      ],
      "Resource": "arn:aws:ecr:us-east-1:123456789012:repository/*"
    }
  ]
}
```

Configure the registry in the Image Updater ConfigMap to use the `ecr` credential type:

```yaml
registries:
  - name: AWS ECR
    prefix: 123456789012.dkr.ecr.us-east-1.amazonaws.com
    api_url: https://123456789012.dkr.ecr.us-east-1.amazonaws.com
    credentials: ext:/scripts/ecr-login.sh
    credsexpire: 11h
```

### Google Artifact Registry

```bash
# Create a service account key secret
kubectl create secret generic gar-credentials \
  --namespace argocd \
  --from-file=.dockerconfigjson=<(
    echo '{"auths":{"us-central1-docker.pkg.dev":{"auth":"'$(echo -n "_json_key:$(cat sa-key.json)" | base64 -w0)'"}}}'
  ) \
  --type=kubernetes.io/dockerconfigjson
```

### Private Registry with Username/Password

For generic private registries:

```bash
kubectl create secret generic my-registry-creds \
  --namespace argocd \
  --from-literal=username=<registry-username> \
  --from-literal=password=<registry-password>
```

Reference in the registry configuration:

```yaml
registries:
  - name: My Private Registry
    prefix: registry.company.internal
    api_url: https://registry.company.internal
    credentials: secret:argocd/my-registry-creds#username:password
```

## Update Strategies and Annotations

ArgoCD Image Updater is controlled entirely through Kubernetes annotations on ArgoCD Application resources. This annotation-driven approach means you can configure update behavior per application without modifying any central configuration.

### Annotation Reference

| Annotation | Description |
|-----------|-------------|
| `argocd-image-updater.argoproj.io/image-list` | Comma-separated list of images to track |
| `argocd-image-updater.argoproj.io/<alias>.update-strategy` | Update strategy for a given image alias |
| `argocd-image-updater.argoproj.io/<alias>.allow-tags` | Tag filter expression |
| `argocd-image-updater.argoproj.io/<alias>.ignore-tags` | Tags to exclude |
| `argocd-image-updater.argoproj.io/<alias>.helm.image-name` | Helm values key for image name |
| `argocd-image-updater.argoproj.io/<alias>.helm.image-tag` | Helm values key for image tag |
| `argocd-image-updater.argoproj.io/write-back-method` | `git` or `argocd` |
| `argocd-image-updater.argoproj.io/git-branch` | Target branch for Git write-back |

### Semver Strategy

The semver strategy is the safest for production environments. It only updates images when a new version satisfies a semantic version constraint, preventing accidental major version upgrades.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app-production
  namespace: argocd
  annotations:
    # Track the 'myapp' image
    argocd-image-updater.argoproj.io/image-list: myapp=ghcr.io/myorg/myapp

    # Only update within the same major version
    argocd-image-updater.argoproj.io/myapp.update-strategy: semver

    # Constraint: only accept patches and minor updates within 1.x.x
    argocd-image-updater.argoproj.io/myapp.allow-tags: regexp:^1\.\d+\.\d+$

    # Use Git write-back to maintain GitOps auditability
    argocd-image-updater.argoproj.io/write-back-method: git

    # Write to the production branch
    argocd-image-updater.argoproj.io/git-branch: main

spec:
  project: production
  source:
    repoURL: https://github.com/myorg/k8s-configs
    targetRevision: main
    path: apps/my-app/production
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

For Helm-based applications, specify which Helm values keys hold the image reference:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-helm-app-production
  namespace: argocd
  annotations:
    argocd-image-updater.argoproj.io/image-list: myapp=ghcr.io/myorg/myapp

    argocd-image-updater.argoproj.io/myapp.update-strategy: semver

    # Tell the updater which Helm values keys to modify
    argocd-image-updater.argoproj.io/myapp.helm.image-name: image.repository
    argocd-image-updater.argoproj.io/myapp.helm.image-tag: image.tag

    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/git-branch: main

spec:
  project: production
  source:
    repoURL: https://github.com/myorg/k8s-configs
    targetRevision: main
    path: apps/my-helm-app/production
    helm:
      valueFiles:
        - values.yaml
        - values-production.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: production
```

### Digest Strategy

The digest strategy tracks a specific image tag (like `stable` or `main`) and updates the deployment when the digest behind that tag changes. This enables immutable image references while still getting updates when the logical tag is rebuilt.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app-staging
  namespace: argocd
  annotations:
    # Track by digest — always deploy the latest content behind the 'stable' tag
    argocd-image-updater.argoproj.io/image-list: myapp=ghcr.io/myorg/myapp:stable

    argocd-image-updater.argoproj.io/myapp.update-strategy: digest

    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/git-branch: staging
```

When the digest strategy is used, the image reference written to Git will look like:

```
ghcr.io/myorg/myapp@sha256:a7b9c3d4e5f6789012345678901234567890123456789012345678901234567890ab
```

This is the gold standard for immutable deployments: the tag `stable` may move, but your deployment spec always pins a specific, immutable digest.

### Latest Strategy

The latest strategy selects the most recently pushed tag matching an optional filter. Use this for development and staging environments where you always want the newest build:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app-development
  namespace: argocd
  annotations:
    argocd-image-updater.argoproj.io/image-list: myapp=ghcr.io/myorg/myapp

    argocd-image-updater.argoproj.io/myapp.update-strategy: latest

    # Only consider tags matching the main branch pattern
    argocd-image-updater.argoproj.io/myapp.allow-tags: regexp:^main-[a-f0-9]{8}$

    # Ignore any tags that look like release tags
    argocd-image-updater.argoproj.io/myapp.ignore-tags: regexp:^v\d+

    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/git-branch: development
```

### Name Strategy

The name strategy selects the alphabetically last tag, which works well for date-based or sequential build numbering:

```yaml
annotations:
  argocd-image-updater.argoproj.io/image-list: myapp=ghcr.io/myorg/myapp
  argocd-image-updater.argoproj.io/myapp.update-strategy: name
  # Match tags like 20301201-abcdef12
  argocd-image-updater.argoproj.io/myapp.allow-tags: regexp:^\d{8}-[a-f0-9]{8}$
```

## Write-Back Methods

### Git Write-Back (Recommended)

Git write-back is the GitOps-native approach. When Image Updater determines an update is needed, it:

1. Clones the target branch of your GitOps repository
2. Updates the image reference in the appropriate manifest file
3. Commits the change with a descriptive commit message
4. Pushes the commit back to the repository
5. ArgoCD detects the commit and synchronizes

This preserves complete Git history of all image promotions, which is invaluable for audits and rollbacks.

#### Configuring Git Credentials

Create a Secret with Git credentials:

```bash
# For SSH key authentication
kubectl create secret generic git-credentials \
  --namespace argocd \
  --from-file=sshPrivateKey=<path-to-private-key>

# For HTTPS token authentication
kubectl create secret generic git-credentials \
  --namespace argocd \
  --from-literal=username=<git-username> \
  --from-literal=password=<github-personal-access-token>
```

Reference the secret in the Image Updater configuration:

```yaml
# argocd-image-updater-config ConfigMap
data:
  git.credentials-secret: argocd/git-credentials
  git.email: image-updater@support.tools
  git.user: ArgoCD Image Updater
```

#### Write-Back Branch Strategy

For multi-environment pipelines, each environment's Application should write back to its own branch:

```yaml
# Development environment — auto-update to dev branch
argocd-image-updater.argoproj.io/write-back-method: git
argocd-image-updater.argoproj.io/git-branch: dev

# Staging — create PRs for human review
argocd-image-updater.argoproj.io/write-back-method: git
argocd-image-updater.argoproj.io/git-branch: staging:[feature/image-update-{{range .Images}}{{.Name}}{{end}}]

# Production — write to a specific release branch
argocd-image-updater.argoproj.io/write-back-method: git
argocd-image-updater.argoproj.io/git-branch: production
```

The `staging:[branch-name-template]` syntax tells Image Updater to create a new branch with the generated name and push to it, which you can then use to create a pull request in your Git hosting provider via a webhook or CI job.

#### Kustomize Write-Back

For Kustomize-based applications, Image Updater writes image overrides to a special `.argocd-source-<app-name>.yaml` file in the application directory:

```yaml
# .argocd-source-my-app.yaml (auto-generated by Image Updater)
kustomize:
  images:
    - ghcr.io/myorg/myapp:1.4.2
```

ArgoCD reads this file when calculating the desired state, merging it with the base `kustomization.yaml`.

#### Helm Write-Back

For Helm applications, Image Updater writes to a `.argocd-source-<app-name>.yaml` file:

```yaml
# .argocd-source-my-helm-app.yaml (auto-generated)
helm:
  parameters:
    - name: image.tag
      value: 1.4.2
    - name: image.repository
      value: ghcr.io/myorg/myapp
```

### Direct Write-Back

Direct write-back modifies the ArgoCD Application resource in-cluster. It is simpler to configure but means image references are not tracked in Git:

```yaml
annotations:
  argocd-image-updater.argoproj.io/write-back-method: argocd
```

When using direct write-back, Image Updater sets `spec.source.helm.parameters` or `spec.source.kustomize.images` directly on the Application resource. ArgoCD treats these as overrides on top of whatever is in Git.

This mode is appropriate for ephemeral preview environments where Git history is not needed.

## Multi-Environment Promotion Pipeline

A common enterprise pattern has three environments with progressive promotion:

1. **Development**: Auto-update on every commit to `main`, using the `latest` strategy
2. **Staging**: Auto-update to the latest semver pre-release, using the `semver` strategy with a pre-release constraint
3. **Production**: Manual promotion, but Image Updater creates a PR for review

### Development Environment

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app-dev
  namespace: argocd
  annotations:
    argocd-image-updater.argoproj.io/image-list: app=ghcr.io/myorg/myapp
    argocd-image-updater.argoproj.io/app.update-strategy: latest
    argocd-image-updater.argoproj.io/app.allow-tags: regexp:^main-
    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/git-branch: dev
spec:
  project: development
  source:
    repoURL: https://github.com/myorg/k8s-configs
    targetRevision: dev
    path: apps/my-app/dev
  destination:
    server: https://dev-cluster.internal
    namespace: development
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

### Staging Environment

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app-staging
  namespace: argocd
  annotations:
    argocd-image-updater.argoproj.io/image-list: app=ghcr.io/myorg/myapp
    argocd-image-updater.argoproj.io/app.update-strategy: semver
    # Accept release candidates and minor/patch releases within 1.x
    argocd-image-updater.argoproj.io/app.allow-tags: regexp:^1\.\d+\.\d+(-rc\.\d+)?$
    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/git-branch: staging
spec:
  project: staging
  source:
    repoURL: https://github.com/myorg/k8s-configs
    targetRevision: staging
    path: apps/my-app/staging
  destination:
    server: https://staging-cluster.internal
    namespace: staging
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

### Production Environment with PR-Based Promotion

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app-production
  namespace: argocd
  annotations:
    argocd-image-updater.argoproj.io/image-list: app=ghcr.io/myorg/myapp
    argocd-image-updater.argoproj.io/app.update-strategy: semver
    # Only stable releases
    argocd-image-updater.argoproj.io/app.allow-tags: regexp:^1\.\d+\.\d+$
    # Write to a new branch for PR creation
    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/git-branch: production:[chore/image-update-{{.AppName}}]
spec:
  project: production
  source:
    repoURL: https://github.com/myorg/k8s-configs
    targetRevision: production
    path: apps/my-app/production
  destination:
    server: https://production-cluster.internal
    namespace: production
  syncPolicy:
    # No auto-sync for production — requires manual approval
    {}
```

With this configuration, Image Updater creates a branch `chore/image-update-my-app-production` for each update. A GitHub Actions workflow can automatically create a pull request from this branch:

```yaml
# .github/workflows/image-update-pr.yaml
name: Create Image Update PR

on:
  push:
    branches:
      - 'chore/image-update-*'

jobs:
  create-pr:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create Pull Request
        uses: peter-evans/create-pull-request@v6
        with:
          token: <github-personal-access-token>
          base: production
          title: "chore: automated image update"
          body: |
            Automated image update created by ArgoCD Image Updater.

            Please review the image changes and merge if approved.
          labels: |
            automated
            image-update
          reviewers: |
            platform-team
```

## Monitoring and Alerting

### Prometheus Metrics

Image Updater exposes metrics at `/metrics` on port 8081:

```
# Key metrics to monitor
argocd_image_updater_applications_watched_total    # Applications being monitored
argocd_image_updater_images_checked_total          # Registry checks performed
argocd_image_updater_images_updated_total          # Successful updates applied
argocd_image_updater_images_errors_total           # Failed updates
argocd_image_updater_registry_lookup_duration_seconds  # Registry query latency
```

### Alert Rules

```yaml
# prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: argocd-image-updater-alerts
  namespace: monitoring
spec:
  groups:
    - name: argocd-image-updater
      rules:
        - alert: ImageUpdaterHighErrorRate
          expr: |
            rate(argocd_image_updater_images_errors_total[5m]) > 0.1
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "ArgoCD Image Updater has high error rate"
            description: "Image update errors: {{ $value }} errors/sec"

        - alert: ImageUpdaterNotRunning
          expr: |
            up{job="argocd-image-updater"} == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "ArgoCD Image Updater is not running"
```

## Troubleshooting

### Image Updater Not Processing Applications

Check that the Application has the correct annotations and that the updater can reach the ArgoCD API:

```bash
# Check updater logs
kubectl logs -n argocd -l app.kubernetes.io/name=argocd-image-updater --tail=100

# Verify the updater can connect to ArgoCD
kubectl exec -n argocd deployment/argocd-image-updater -- \
  argocd-image-updater test \
    --argocd-server-addr argocd-server.argocd.svc.cluster.local:443 \
    ghcr.io/myorg/myapp \
    --update-strategy semver
```

### Registry Authentication Failures

```bash
# Test registry connectivity manually
kubectl exec -n argocd deployment/argocd-image-updater -- \
  argocd-image-updater test \
    --registries-conf-path /app/config/registries.conf \
    ghcr.io/myorg/myapp \
    --credentials pullsecret:argocd/ghcr-credentials
```

### Git Write-Back Failures

Common causes:
- SSH key does not have write access to the repository
- The target branch is protected and requires PR review
- The committer email is not in the Git provider's allowed list

```bash
# Check Git credentials are accessible
kubectl get secret -n argocd git-credentials
kubectl describe secret -n argocd git-credentials

# Test Git write manually
kubectl exec -n argocd deployment/argocd-image-updater -- \
  git clone --depth=1 https://github.com/myorg/k8s-configs /tmp/test-clone
```

### Debugging with Dry-Run Mode

Enable dry-run mode to see what changes would be made without applying them:

```bash
# Set DRY_RUN environment variable on the deployment
kubectl set env deployment/argocd-image-updater \
  -n argocd \
  DRY_RUN=true
```

With dry-run enabled, log output will show the planned updates:

```
time="2030-12-01T12:00:00Z" level=info msg="[DRY RUN] Would update image ghcr.io/myorg/myapp from 1.3.0 to 1.4.2"
```

## Advanced Configuration

### Commit Message Templates

Customize the Git commit message template:

```yaml
# argocd-image-updater-config ConfigMap
data:
  git.commit-message-template: |
    chore(image): update {{.AppName}} to {{range .AppChanges}}{{.Image}} {{.NewTag}}{{end}}

    Updated by ArgoCD Image Updater
    Application: {{.AppName}}
    Changes:
    {{range .AppChanges}}- {{.Image}}: {{.OldTag}} -> {{.NewTag}}
    {{end}}
```

### Rate Limiting Registry Requests

For high-cardinality environments with many applications, rate limit registry API calls to avoid hitting rate limits:

```yaml
config:
  registries:
    - name: Docker Hub
      prefix: docker.io
      api_url: https://registry-1.docker.io
      credentials: pullsecret:argocd/dockerhub-credentials
      # Maximum concurrent requests to this registry
      ratelimit: 20
      # Maximum requests per hour
      limit: 100
```

### Multiple Images per Application

Applications with multiple containers can track multiple images simultaneously:

```yaml
annotations:
  # Track two images with aliases 'backend' and 'frontend'
  argocd-image-updater.argoproj.io/image-list: >-
    backend=ghcr.io/myorg/backend,
    frontend=ghcr.io/myorg/frontend

  argocd-image-updater.argoproj.io/backend.update-strategy: semver
  argocd-image-updater.argoproj.io/backend.helm.image-name: backend.image.repository
  argocd-image-updater.argoproj.io/backend.helm.image-tag: backend.image.tag

  argocd-image-updater.argoproj.io/frontend.update-strategy: semver
  argocd-image-updater.argoproj.io/frontend.helm.image-name: frontend.image.repository
  argocd-image-updater.argoproj.io/frontend.helm.image-tag: frontend.image.tag

  argocd-image-updater.argoproj.io/write-back-method: git
  argocd-image-updater.argoproj.io/git-branch: production
```

## Security Considerations

### Least-Privilege Git Access

Create a dedicated machine user account with write access only to the GitOps repository. Avoid using personal accounts or accounts with broad organizational access.

### Image Tag Signing Verification

Image Updater does not natively verify Cosign signatures, but you can combine it with OPA Gatekeeper or Kyverno policies that reject deployments where the image digest is not signed:

```yaml
# Kyverno policy to verify Cosign signatures
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signatures
spec:
  validationFailureAction: Enforce
  rules:
    - name: verify-cosign-signature
      match:
        resources:
          kinds: [Pod]
          namespaces: [production]
      verifyImages:
        - imageReferences:
            - "ghcr.io/myorg/*"
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/myorg/*"
                    issuer: "https://token.actions.githubusercontent.com"
```

### Restricting Update Scope with Projects

Use ArgoCD Projects to limit which registries Image Updater can reference for each application:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: production
  namespace: argocd
spec:
  # Only allow images from the organization registry
  sourceRepos:
    - https://github.com/myorg/k8s-configs
  # No restriction needed here — image registry filtering is in annotations
```

## Summary

ArgoCD Image Updater brings full automation to image promotion in GitOps pipelines. The annotation-driven configuration is non-intrusive and highly flexible: semver constraints enforce safe production updates, digest tracking delivers immutable references, and Git write-back preserves the audit trail that GitOps promises. Combined with multi-environment Application structures and PR-based promotion for production, you get a promotion pipeline that is both automated and safe — eliminating the toil of manual tag bumps while maintaining the control your organization requires.
