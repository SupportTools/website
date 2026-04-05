---
title: "Kubernetes Flux v2 Image Automation: ImageRepository, ImagePolicy, and Automated PR Workflows"
date: 2032-04-04T00:00:00-05:00
draft: false
tags: ["Flux", "GitOps", "Kubernetes", "Image Automation", "CI/CD", "Continuous Delivery"]
categories:
- Kubernetes
- GitOps
- CI/CD
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Flux v2 Image Automation Controller covering ImageRepository, ImagePolicy, ImageUpdateAutomation resources, and automated pull request workflows for production Kubernetes environments."
more_link: "yes"
url: "/kubernetes-flux-v2-image-automation-imagerepository-imagepolicy/"
---

Flux v2's Image Automation Controller closes the loop between container image publishing and Kubernetes deployment by automatically updating Git repositories when new images become available. Rather than relying on CI pipelines to push deployment changes, the image automation controller continuously polls container registries and creates commits or pull requests when images matching defined policies are published.

This guide covers the complete image automation stack: ImageRepository for registry polling, ImagePolicy for semver and tag filtering, ImageUpdateAutomation for Git write-back, and the patterns needed to implement automated pull request workflows that maintain change traceability for compliance-conscious environments.

<!--more-->

## Architecture Overview

Flux v2's image automation stack consists of three custom resource types and one controller:

```
Container Registry
      │
      │ poll (ImageRepository)
      ▼
┌──────────────────────────────────────────────┐
│           Image Reflector Controller          │
│  ImageRepository → scans registry tags       │
│  ImagePolicy     → selects latest tag        │
└──────────────────────┬───────────────────────┘
                       │ latest image ref
                       ▼
┌──────────────────────────────────────────────┐
│        Image Automation Controller            │
│  ImageUpdateAutomation → updates Git         │
│  - commits changes to manifests              │
│  - optionally opens pull requests            │
└──────────────────────┬───────────────────────┘
                       │ git push / PR
                       ▼
                  Git Repository
                       │
                       │ Flux source controller
                       ▼
                Kubernetes Cluster
```

The image reflector controller (handles ImageRepository and ImagePolicy) and the image automation controller are deployed separately and can be managed independently.

## Prerequisites and Installation

### Flux v2 Bootstrap with Image Automation

```bash
# Bootstrap Flux with image automation components enabled
flux bootstrap github \
  --owner=my-org \
  --repository=my-cluster-config \
  --branch=main \
  --path=clusters/production \
  --personal \
  --components-extra=image-reflector-controller,image-automation-controller

# Verify all components are running
kubectl get pods -n flux-system
# NAME                                           READY   STATUS    RESTARTS   AGE
# helm-controller-6b8d9b4b5c-x9zqp              1/1     Running   0          5m
# image-automation-controller-5f7b9c8d4-kj2mn   1/1     Running   0          5m
# image-reflector-controller-7c9d8f6b5-p4qrs    1/1     Running   0          5m
# kustomize-controller-7b8c9d5f6-mn3op          1/1     Running   0          5m
# notification-controller-6d9f8c7b4-rs5tu       1/1     Running   0          5m
# source-controller-5c8d7f9b6-vw7xy             1/1     Running   0          5m

# Check CRDs are installed
kubectl get crd | grep toolkit.fluxcd.io | grep -E "image"
# imagepolicies.image.toolkit.fluxcd.io
# imagerepositories.image.toolkit.fluxcd.io
# imageupdateautomations.image.toolkit.fluxcd.io
```

### Adding Image Automation to Existing Flux Installation

```yaml
# flux-system/gotk-components.yaml — add image automation components
# If Flux was bootstrapped without image automation, patch the HelmRelease
---
apiVersion: helm.toolkit.fluxcd.io/v2beta1
kind: HelmRelease
metadata:
  name: flux
  namespace: flux-system
spec:
  chart:
    spec:
      chart: flux2
      version: ">=2.0.0 <3.0.0"
      sourceRef:
        kind: HelmRepository
        name: fluxcd
  values:
    imageReflectionController:
      create: true
    imageAutomationController:
      create: true
```

```bash
# Or install via flux CLI upgrade
flux install \
  --components-extra=image-reflector-controller,image-automation-controller

# Verify image automation controller version
kubectl get deployment -n flux-system image-automation-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
```

## ImageRepository: Registry Polling Configuration

### Basic ImageRepository Setup

```yaml
# image-repositories/app-image-repo.yaml
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: my-app
  namespace: flux-system
spec:
  # Container registry image (without tag)
  image: registry.example.com/my-org/my-app

  # How frequently to check for new tags
  interval: 5m

  # Timeout for registry operations
  timeout: 30s

  # TLS configuration for private registries
  # secretRef points to a Secret with .dockerconfigjson or username/password
  secretRef:
    name: registry-credentials

  # Access mode: Registry or Cluster
  # Registry = authenticate with registry directly
  # Cluster = use cluster service account (ECR, GCR with Workload Identity)
  accessFrom:
    namespaceSelectors:
      - matchLabels:
          kubernetes.io/metadata.name: flux-system
```

### Registry Authentication Secrets

```bash
# Docker registry secret (for Docker Hub, custom registries)
kubectl create secret docker-registry registry-credentials \
  --namespace flux-system \
  --docker-server=registry.example.com \
  --docker-username=<registry-username> \
  --docker-password=<registry-password>

# For AWS ECR - create a secret with ECR token
# ECR tokens expire, so use a periodic refresh job
```

```yaml
# aws-ecr-credentials-refresh.yaml — refresh ECR tokens periodically
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ecr-credentials-refresh
  namespace: flux-system
spec:
  schedule: "*/6 * * * *"  # Every 6 hours (ECR tokens valid 12h)
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: ecr-credentials-refresher
          restartPolicy: OnFailure
          containers:
          - name: ecr-credentials-refresh
            image: amazon/aws-cli:latest
            command:
            - /bin/sh
            - -c
            - |
              ECR_TOKEN=$(aws ecr get-login-password --region us-east-1)
              kubectl create secret docker-registry ecr-registry-credentials \
                --namespace flux-system \
                --docker-server=<aws-account-id>.dkr.ecr.us-east-1.amazonaws.com \
                --docker-username=AWS \
                --docker-password="${ECR_TOKEN}" \
                --dry-run=client -o yaml | kubectl apply -f -
```

```yaml
# AWS ECR ImageRepository with IRSA
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: my-app-ecr
  namespace: flux-system
  annotations:
    # IRSA annotation for AWS ECR access
    eks.amazonaws.com/role-arn: arn:aws:iam::<aws-account-id>:role/flux-ecr-access
spec:
  image: <aws-account-id>.dkr.ecr.us-east-1.amazonaws.com/my-app
  interval: 5m
  secretRef:
    name: ecr-registry-credentials
```

### GCR and Artifact Registry Configuration

```yaml
# gcr-image-repository.yaml — Google Container Registry
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: my-app-gcr
  namespace: flux-system
spec:
  image: gcr.io/my-project/my-app
  interval: 5m
  # Use Workload Identity on GKE - no secret needed
  # Just ensure the KSA is bound to a GSA with artifactregistry.reader role
```

```bash
# Create Workload Identity binding for image reflector controller
gcloud iam service-accounts create flux-image-reflector \
  --project=my-project

gcloud projects add-iam-policy-binding my-project \
  --member="serviceAccount:flux-image-reflector@my-project.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.reader"

gcloud iam service-accounts add-iam-policy-binding \
  flux-image-reflector@my-project.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:my-project.svc.id.goog[flux-system/image-reflector-controller]"

kubectl annotate serviceaccount image-reflector-controller \
  --namespace flux-system \
  iam.gke.io/gcp-service-account=flux-image-reflector@my-project.iam.gserviceaccount.com
```

### Checking ImageRepository Status

```bash
# Get ImageRepository status
kubectl get imagerepository -n flux-system

# Detailed status output
kubectl describe imagerepository my-app -n flux-system

# Get last scanned tags
kubectl get imagerepository my-app -n flux-system \
  -o jsonpath='{.status.lastScanResult}'

# List all tags discovered
kubectl get imagerepository my-app -n flux-system \
  -o jsonpath='{.status.lastScanResult.tagCount}'

# Force an immediate rescan
flux reconcile image repository my-app
```

## ImagePolicy: Tag Selection and Filtering

### SemVer Policies

```yaml
# image-policies/semver-stable.yaml — track stable releases only
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: my-app-stable
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: my-app
    namespace: flux-system
  policy:
    semver:
      # Track latest stable release (no pre-releases)
      range: ">=1.0.0"
```

```yaml
# image-policies/semver-minor.yaml — track latest patch in current minor
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: my-app-minor-updates
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: my-app
  policy:
    semver:
      # Stay on 2.x.x series, track latest patch
      range: ">=2.0.0 <3.0.0"
```

```yaml
# image-policies/semver-prerelease.yaml — staging: include pre-releases
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: my-app-staging
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: my-app
  policy:
    semver:
      # Include rc, beta, alpha tags for staging
      range: ">=1.0.0-0"
```

### Alphabetical and Numerical Policies

```yaml
# image-policies/alphabetical-latest.yaml — for date-based or commit SHA tags
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: my-app-latest-build
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: my-app
  filterTags:
    # Match tags like: 20240315-abc1234f
    pattern: '^(?P<ts>\d{8})-(?P<commit>[a-f0-9]{8})$'
    extract: '$ts'
  policy:
    alphabetical:
      # Latest date string is lexicographically greatest
      order: asc
```

```yaml
# image-policies/numerical-build.yaml — for sequential build numbers
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: my-app-build-number
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: my-app
  filterTags:
    # Match tags like: build-1234
    pattern: '^build-(?P<num>\d+)$'
    extract: '$num'
  policy:
    numerical:
      order: asc
```

### Environment-Specific Policies

```yaml
# image-policies/production-policy.yaml — production: only release tags
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: my-app-production
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: my-app
  filterTags:
    # Only match v1.2.3 format (no pre-release suffix)
    pattern: '^v\d+\.\d+\.\d+$'
  policy:
    semver:
      range: ">=1.0.0"

---
# image-policies/development-policy.yaml — development: any main branch build
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: my-app-development
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: my-app
  filterTags:
    # Match main branch builds: main-abc1234f-1234567890
    pattern: '^main-[a-f0-9]+-(?P<ts>\d+)$'
    extract: '$ts'
  policy:
    numerical:
      order: asc
```

```bash
# Check what image an ImagePolicy has selected
kubectl get imagepolicy -n flux-system
# NAME                  LATESTIMAGE
# my-app-stable         registry.example.com/my-org/my-app:v2.4.1
# my-app-production     registry.example.com/my-org/my-app:v2.4.1
# my-app-staging        registry.example.com/my-org/my-app:v2.5.0-rc.2

# Get details
kubectl describe imagepolicy my-app-stable -n flux-system
```

## ImageUpdateAutomation: Git Write-Back

### Basic Deployment Manifest with Markers

For image automation to work, deployment manifests need special marker comments that tell the automation controller which fields to update.

```yaml
# apps/production/my-app/deployment.yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: my-app
        # {"$imagepolicy": "flux-system:my-app-production"}
        image: registry.example.com/my-org/my-app:v2.4.1
        ports:
        - containerPort: 8080
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "256Mi"
            cpu: "500m"
```

The marker comment `{"$imagepolicy": "flux-system:my-app-production"}` tells the image automation controller to replace the image tag with the latest image selected by the `my-app-production` ImagePolicy in the `flux-system` namespace.

### Marker Variations

```yaml
# Update entire image reference (registry + name + tag)
image: registry.example.com/my-org/my-app:v2.4.1 # {"$imagepolicy": "flux-system:my-app"}

# Update tag only (preserve image name from manifest)
image: registry.example.com/my-org/my-app:v2.4.1 # {"$imagepolicy": "flux-system:my-app:tag"}

# Update name only (preserve tag)
image: registry.example.com/my-org/my-app:v2.4.1 # {"$imagepolicy": "flux-system:my-app:name"}

# In Helm values files
image:
  repository: registry.example.com/my-org/my-app # {"$imagepolicy": "flux-system:my-app:name"}
  tag: v2.4.1 # {"$imagepolicy": "flux-system:my-app:tag"}
```

### ImageUpdateAutomation Configuration

```yaml
# image-automation/my-app-automation.yaml
---
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: my-app
  namespace: flux-system
spec:
  # Source repository to update
  sourceRef:
    kind: GitRepository
    name: my-cluster-config

  # Git operations configuration
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxbot@example.com
        name: Flux Bot
      messageTemplate: |
        feat(auto): update {{range .Updated.Images}}{{.}}{{end}} to latest

        Updated images:
        {{range .Updated.Images -}}
        - {{.}}
        {{end -}}

        Signed-off-by: Flux Bot <fluxbot@example.com>
    push:
      branch: main

  # Which files to scan for image markers
  update:
    strategy: Setters
    path: ./clusters/production
```

### Push to Feature Branch (PR Workflow)

```yaml
# image-automation/pr-workflow-automation.yaml
---
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: my-app-pr-workflow
  namespace: flux-system
spec:
  sourceRef:
    kind: GitRepository
    name: my-cluster-config

  # Run every 10 minutes
  interval: 10m

  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxbot@example.com
        name: Flux Bot
      messageTemplate: |
        chore(images): update {{range .Updated.Images}}{{imageTagOf .}}{{end}}

        Automated image update by Flux image automation.

        Images updated:
        {{range .Updated.Images -}}
        - {{.Repository}}:{{imageTagOf .}} (was {{.OldTag}})
        {{end}}
    # Push to a separate branch for PR review
    push:
      branch: flux/image-updates

  update:
    strategy: Setters
    path: ./clusters/production
```

## Automated Pull Request Workflows

Pushing directly to `main` bypasses change review. Enterprise environments typically require PRs for all changes. Flux can be combined with GitHub Actions or GitLab CI to create automated PRs from the update branches.

### GitHub Actions PR Creation

```yaml
# .github/workflows/flux-image-update-pr.yaml
---
name: Flux Image Update PR

on:
  push:
    branches:
      - flux/image-updates

jobs:
  create-pr:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Get changed images from commit message
        id: parse-commits
        run: |
          # Extract image updates from the most recent commit
          COMMIT_MSG=$(git log -1 --format="%B" origin/flux/image-updates)
          echo "commit_message<<EOF" >> $GITHUB_OUTPUT
          echo "$COMMIT_MSG" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT

      - name: Create Pull Request
        uses: peter-evans/create-pull-request@v5
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          branch: flux/image-updates
          base: main
          title: "chore(images): automated image updates"
          body: |
            ## Automated Image Updates

            This PR was automatically created by Flux image automation.

            ### Changes
            ${{ steps.parse-commits.outputs.commit_message }}

            ### Review Checklist
            - [ ] Verify image tags are expected releases
            - [ ] Check for any breaking changes in release notes
            - [ ] Confirm staging has been validated with these images

            ---
            *Created by Flux image automation controller*
          labels: |
            automated
            image-update
          reviewers: |
            platform-team
          assignees: |
            on-call-engineer
          draft: false
          delete-branch: false
```

### GitLab CI Pipeline for PR Creation

```yaml
# .gitlab-ci.yml snippet for Flux image update MR creation
---
stages:
  - create-mr

create-image-update-mr:
  stage: create-mr
  rules:
    - if: $CI_COMMIT_BRANCH == "flux/image-updates"
  image: registry.gitlab.com/gitlab-org/cli:latest
  script:
    - |
      # Get the list of updated images from commit
      COMMIT_MSG=$(git log -1 --format="%B")

      # Create MR using GitLab CLI
      glab mr create \
        --title "chore(images): automated image updates" \
        --description "## Automated Image Updates

      ${COMMIT_MSG}

      Created automatically by Flux image automation." \
        --target-branch main \
        --source-branch flux/image-updates \
        --label "automated,image-update" \
        --assignee "@platform-team" \
        --no-editor \
        --yes
```

### Notification on Image Updates

```yaml
# flux-system/image-update-alert.yaml — send Slack notifications
---
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: slack-platform-team
  namespace: flux-system
spec:
  type: slack
  channel: "#platform-alerts"
  secretRef:
    name: slack-webhook

---
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: image-update-alert
  namespace: flux-system
spec:
  summary: "Image automation update"
  providerRef:
    name: slack-platform-team
  eventSeverity: info
  eventSources:
    - kind: ImageUpdateAutomation
      name: "*"
    - kind: ImagePolicy
      name: "*"
  inclusion:
    - ".*"
```

```bash
# Create Slack webhook secret
kubectl create secret generic slack-webhook \
  --namespace flux-system \
  --from-literal=address=<slack-webhook-url>
```

## Multi-Environment Image Promotion

A common pattern is to auto-deploy to staging when new images are published, then require manual promotion (or automated promotion after tests pass) to production.

### Directory Structure for Multi-Environment

```
clusters/
├── staging/
│   ├── apps/
│   │   └── my-app/
│   │       └── deployment.yaml    # auto-updated
│   └── flux-system/
│       └── image-update-automation.yaml
└── production/
    ├── apps/
    │   └── my-app/
    │       └── deployment.yaml    # PR-based updates
    └── flux-system/
        └── image-update-automation.yaml
```

```yaml
# clusters/staging/flux-system/image-update-automation.yaml
---
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: staging-auto-deploy
  namespace: flux-system
spec:
  sourceRef:
    kind: GitRepository
    name: my-cluster-config
  interval: 5m
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxbot@example.com
        name: Flux Bot
      messageTemplate: "chore(staging): auto-update images"
    push:
      # Direct push to main for staging
      branch: main
  update:
    strategy: Setters
    path: ./clusters/staging

---
# clusters/production/flux-system/image-update-automation.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: production-pr-workflow
  namespace: flux-system
spec:
  sourceRef:
    kind: GitRepository
    name: my-cluster-config
  interval: 30m
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxbot@example.com
        name: Flux Bot
      messageTemplate: "chore(production): promote images from staging"
    push:
      # Push to PR branch for review
      branch: flux/production-image-updates
  update:
    strategy: Setters
    path: ./clusters/production
```

### Promotion Gate with Image Digest Verification

```yaml
# image-policies/production-verified.yaml — only promote when staging is stable
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: my-app-production-verified
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: my-app
  filterTags:
    # Only promote tags that have been in staging for at least 1 day
    # Convention: production tags are re-tagged with -verified suffix
    pattern: '^v\d+\.\d+\.\d+-verified$'
  policy:
    semver:
      range: ">=1.0.0"
```

```bash
# Promotion script — re-tag after staging validation
#!/bin/bash
# promote-to-production.sh

set -euo pipefail

IMAGE="registry.example.com/my-org/my-app"
VERSION="${1:?Usage: $0 <version>}"

echo "Promoting ${IMAGE}:${VERSION} to production..."

# Verify image exists in staging
DIGEST=$(crane digest "${IMAGE}:${VERSION}")
echo "Image digest: ${DIGEST}"

# Re-tag with -verified suffix
crane tag "${IMAGE}:${VERSION}" "${VERSION}-verified"

echo "Tagged as ${IMAGE}:${VERSION}-verified"
echo "Flux will detect this tag and create a production PR"
```

## Troubleshooting Image Automation

### Common Issues and Diagnostics

```bash
# Check image automation controller logs
kubectl logs -n flux-system deployment/image-automation-controller -f

# Check image reflector controller logs
kubectl logs -n flux-system deployment/image-reflector-controller -f

# Verify ImageRepository is scanning successfully
kubectl get imagerepository -n flux-system -o wide
# NAME      LAST SCAN             TAGS
# my-app    2024-03-15T10:05:00Z  42

# ImageRepository not scanning
kubectl describe imagerepository my-app -n flux-system
# Look for:
# - "failed to scan: unauthorized" → check registry credentials
# - "no tags found" → check image path is correct
# - "context deadline exceeded" → network/timeout issue

# ImagePolicy not selecting an image
kubectl describe imagepolicy my-app-production -n flux-system
# Look for:
# - latestImage field being empty → no tags match the policy
# - "no update" in events → policy is working, image unchanged

# ImageUpdateAutomation not committing
kubectl describe imageupdateautomation my-app -n flux-system
# Look for:
# - "no changes" → markers not found or image already up to date
# - "failed to push" → Git credentials or permissions issue
# - "conflict" → concurrent updates, will retry

# Check for marker syntax issues
flux debug image policy my-app-production
```

### Debugging Registry Connectivity

```bash
# Test registry access from a pod in the cluster
kubectl run registry-test --rm -it --image=curlimages/curl -- \
  curl -H "Authorization: Bearer <token>" \
  https://registry.example.com/v2/my-org/my-app/tags/list

# Verify secret format
kubectl get secret registry-credentials -n flux-system \
  -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d | jq .

# Test with crane (registry client)
kubectl run crane-test --rm -it \
  --image=gcr.io/go-containerregistry/crane:latest \
  --env="REGISTRY_AUTH_FILE=/config/auth.json" \
  -- ls registry.example.com/my-org/my-app
```

### Reconciliation Forcing

```bash
# Force immediate reconciliation
flux reconcile image repository my-app
flux reconcile image policy my-app-stable
flux reconcile image update my-app

# Suspend automation temporarily (maintenance window)
flux suspend image update my-app
# ... perform maintenance ...
flux resume image update my-app

# Suspend all image automation
kubectl patch imageupdateautomations.image.toolkit.fluxcd.io \
  -n flux-system --all \
  --type='merge' \
  -p '{"spec":{"suspend":true}}'
```

## Security Considerations

### Least Privilege Git Access

```yaml
# flux-system/git-repository.yaml — use deploy key with minimal permissions
---
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: my-cluster-config
  namespace: flux-system
spec:
  interval: 1m
  url: ssh://git@github.com/my-org/my-cluster-config
  ref:
    branch: main
  secretRef:
    name: flux-git-deploy-key
```

```bash
# Generate deploy key for Git write access
ssh-keygen -t ed25519 -C "flux-image-automation" \
  -f /tmp/flux-deploy-key -N ""

# Create secret in cluster
kubectl create secret generic flux-git-deploy-key \
  --namespace flux-system \
  --from-file=identity=/tmp/flux-deploy-key \
  --from-file=identity.pub=/tmp/flux-deploy-key.pub \
  --from-literal=known_hosts="$(ssh-keyscan github.com)"

# Add public key to GitHub as deploy key with write access
cat /tmp/flux-deploy-key.pub
# Add this to GitHub > Settings > Deploy Keys > Add deploy key
# Check "Allow write access"

# Clean up local key files
rm /tmp/flux-deploy-key /tmp/flux-deploy-key.pub
```

### Image Signature Verification Policy

```yaml
# Combine with Cosign for signature verification before automation
# policy-controller/verify-before-update.yaml
---
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: require-signed-images
spec:
  images:
    - glob: "registry.example.com/my-org/**"
  authorities:
    - keyless:
        url: https://fulcio.sigstore.dev
        identities:
          - issuerRegExp: "https://token.actions.githubusercontent.com"
            subjectRegExp: "https://github.com/my-org/.*/.github/workflows/.*"
```

## Monitoring and Alerting

### Prometheus Metrics

```bash
# Image automation exposes Prometheus metrics
# Key metrics to monitor:
# - gotk_reconcile_duration_seconds — reconciliation latency
# - gotk_reconcile_total — reconciliation count by result
# - gotk_suspend_status — suspension state

# Create ServiceMonitor for Prometheus scraping
```

```yaml
# monitoring/image-automation-servicemonitor.yaml
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: flux-image-automation
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
      - flux-system
  selector:
    matchLabels:
      app: image-automation-controller
  endpoints:
    - port: http-prom
      interval: 30s
      path: /metrics
```

```yaml
# monitoring/flux-image-alerts.yaml — Prometheus alerting rules
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: flux-image-automation-alerts
  namespace: monitoring
spec:
  groups:
  - name: flux-image-automation
    rules:
    - alert: FluxImageAutomationReconcileFailure
      expr: |
        gotk_reconcile_total{
          kind="ImageUpdateAutomation",
          success="false"
        } > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Flux image automation reconcile failure"
        description: "ImageUpdateAutomation {{ $labels.name }} has been failing for 5 minutes"

    - alert: FluxImageRepositoryScanFailure
      expr: |
        gotk_reconcile_total{
          kind="ImageRepository",
          success="false"
        } > 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Flux image repository scan failure"
        description: "ImageRepository {{ $labels.name }} has not scanned successfully for 10 minutes"
```

## Conclusion

Flux v2 image automation represents a mature, declarative approach to continuous delivery where infrastructure concerns are code. The three-layer architecture of ImageRepository (discovery), ImagePolicy (selection), and ImageUpdateAutomation (delivery) provides clean separation of concerns and fine-grained control over what gets deployed where and when.

The PR workflow pattern is particularly valuable for production environments where change traceability and peer review are required. By combining direct push for lower environments with PR-based promotion for production, teams achieve both deployment velocity and the governance controls that compliance frameworks require.

Investment in proper marker placement, policy configuration, and monitoring setup pays dividends through reduced toil: image updates that previously required manual PRs or CI pipeline changes become fully automated, and the Git repository remains the authoritative source of truth for what is actually running in each environment.
