---
title: "Flux Image Automation: Fully Automated GitOps Deployment Pipeline"
date: 2027-04-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Flux", "GitOps", "Image Automation", "CI/CD"]
categories: ["Kubernetes", "GitOps", "CI/CD"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Flux image automation on Kubernetes covering ImageRepository, ImagePolicy, and ImageUpdateAutomation CRDs, semver/regex tag filtering, automated PR creation, multi-environment promotion workflow, and integration with GitHub Actions CI pipelines."
more_link: "yes"
url: "/flux-image-automation-gitops-pipeline-guide/"
---

The GitOps promise of fully declarative, auditable deployments breaks down the moment a developer has to manually edit a `values.yaml` file to bump an image tag. Flux's image automation controllers close this gap: the image-reflector-controller polls container registries and discovers new tags, the image-automation-controller writes approved tags back to Git, and Flux's reconciliation loop then deploys the change automatically. The result is a pipeline where a passing CI build triggers a production deployment without any human intervention and with a complete Git audit trail.

This guide covers every component of Flux image automation from installation through multi-environment promotion pipelines, registry credentials, notification alerts, and Flagger integration for progressive delivery.

<!--more-->

## Section 1: Flux Image Automation Architecture

### Component Overview

Flux splits image automation across two controllers that must be installed separately from the core Flux source and kustomize controllers:

- **image-reflector-controller**: Connects to container registries, lists available tags, and stores the filtered result in `ImageRepository` and `ImagePolicy` status fields. Does not write to Git.
- **image-automation-controller**: Reads `ImagePolicy` objects to discover the latest approved tag, then updates marker comments in Git files and commits the change to the configured branch.

The separation means that registry polling and Git writes have independent failure domains, separate RBAC, and can be scaled independently.

### Data Flow

```
GitHub Actions CI
  └─ docker build && docker push → registry.example.com/app-payments:1.4.7
         │
         ▼
image-reflector-controller
  polls registry every 5m
  filters tags by ImagePolicy (semver >= 1.0.0)
  stores latestImage: registry.example.com/app-payments:1.4.7
         │
         ▼
image-automation-controller
  reads ImagePolicy.status.latestImage
  finds marker: # {"$imagepolicy": "flux-system:app-payments"}
  updates marker file in Git
  commits: "chore: update app-payments to 1.4.7"
         │
         ▼
Flux source-controller
  detects new commit on watched branch
  reconciles kustomization → kubectl apply
         │
         ▼
Kubernetes cluster
  rolling update: old pods → new pods running 1.4.7
```

## Section 2: Installing the Image Automation Controllers

### Bootstrap with flux CLI

```bash
# Bootstrap Flux with image automation controllers enabled
# Requires GITHUB_TOKEN with repo read/write permissions
export GITHUB_TOKEN="EXAMPLE_GH_TOKEN_REPLACE_ME"

flux bootstrap github \
  --owner=example-org \
  --repository=fleet-infra \
  --branch=main \
  --path=clusters/us-east-1-prod \
  --components-extra=image-reflector-controller,image-automation-controller \
  --read-write-key=true   # generates a deploy key with write access for Git commits

# Verify all controllers are running
flux check
kubectl get pods -n flux-system
```

### Adding Controllers to an Existing Installation

```bash
# If Flux is already bootstrapped without image automation,
# add the controllers by updating the gotk-components.yaml and re-bootstrapping
flux install \
  --components-extra=image-reflector-controller,image-automation-controller \
  --export > /tmp/flux-components-with-image.yaml

# Apply to the management cluster
kubectl apply -f /tmp/flux-components-with-image.yaml

# Or use GitOps: commit the updated components file and let Flux reconcile
cp /tmp/flux-components-with-image.yaml \
  clusters/us-east-1-prod/flux-system/gotk-components.yaml
git commit -am "chore: enable image automation controllers"
git push
```

### Verify Installation

```bash
# Check image automation controllers are healthy
kubectl rollout status deploy/image-reflector-controller -n flux-system
kubectl rollout status deploy/image-automation-controller -n flux-system

# List available Flux CRDs related to image automation
kubectl get crd | grep image
# Expected output:
# imagepolicies.image.toolkit.fluxcd.io
# imagerepositories.image.toolkit.fluxcd.io
# imageupdateautomations.image.toolkit.fluxcd.io
```

## Section 3: ImageRepository CRD

The `ImageRepository` object instructs the image-reflector-controller to scan a container registry and cache the available tags.

### Public Registry

```yaml
# imagerepository-app-payments.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: app-payments
  namespace: flux-system
spec:
  image: registry.example.com/app-payments
  # Poll interval — 5 minutes is a reasonable production default
  interval: 5m
  # Optional: limit the number of tags fetched to avoid memory pressure on large repos
  # timeout: 60s
  # certSecretRef:
  #   name: registry-tls-ca   # for self-signed CA
```

### Private Registry with Credentials

```yaml
# secret-registry-creds.yaml — managed by External Secrets Operator
# stringData fields populated from Vault or AWS Secrets Manager
apiVersion: v1
kind: Secret
metadata:
  name: registry-credentials
  namespace: flux-system
type: kubernetes.io/dockerconfigjson
stringData:
  .dockerconfigjson: |
    {
      "auths": {
        "registry.example.com": {
          "username": "flux-puller",
          "password": "EXAMPLE_REGISTRY_PASSWORD_REPLACE_ME",
          "auth": "EXAMPLE_BASE64_AUTH_REPLACE_ME"
        }
      }
    }
```

```yaml
# imagerepository-app-payments-private.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: app-payments
  namespace: flux-system
spec:
  image: registry.example.com/app-payments
  interval: 5m
  secretRef:
    name: registry-credentials   # references the dockerconfigjson Secret above
```

### ECR with IRSA (AWS)

For AWS Elastic Container Registry, credentials rotate every 12 hours. The `flux-image-reflector-controller` ServiceAccount should use IRSA so that the controller obtains credentials from the instance metadata service automatically.

```yaml
# serviceaccount-patch.yaml — patch the image-reflector ServiceAccount with IRSA annotation
apiVersion: v1
kind: ServiceAccount
metadata:
  name: image-reflector-controller
  namespace: flux-system
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/flux-ecr-read-role
```

```yaml
# imagerepository-ecr.yaml — no secretRef needed when using IRSA
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: app-payments-ecr
  namespace: flux-system
  annotations:
    # Tell reflector to use the ECR credential provider
    image.toolkit.fluxcd.io/aws-ecr-region: us-east-1
spec:
  image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/app-payments
  interval: 5m
  provider: aws    # enables the built-in AWS credential provider
```

### Check Repository Status

```bash
# Confirm tags are being scanned
kubectl get imagerepository app-payments -n flux-system -o yaml

# The status.lastScanResult shows the number of tags found and last scan time
flux get image repository app-payments
```

## Section 4: ImagePolicy CRD

The `ImagePolicy` object selects a single "latest" tag from the tags discovered by an `ImageRepository`. It supports semver ranges, numerical ordering, and regex alphabetical ordering.

### Semver Policy (Most Common)

```yaml
# imagepolicy-app-payments-semver.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: app-payments
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: app-payments           # references the ImageRepository above
  policy:
    semver:
      range: ">=1.0.0 <2.0.0"   # accept 1.x releases, exclude pre-1.0 and 2.x
```

### Semver with Pre-Release Filter

```yaml
# imagepolicy-app-payments-rc.yaml — for staging: accept release candidates
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: app-payments-staging
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: app-payments
  filterTags:
    # Only consider tags matching semver with optional rc suffix
    pattern: '^v(\d+\.\d+\.\d+(-rc\.\d+)?)$'
    extract: '$1'
  policy:
    semver:
      range: ">=1.0.0-rc.0"    # includes rc releases for staging
```

### Regex Policy for Custom Tag Schemes

```yaml
# imagepolicy-app-payments-branch.yaml — for dev: latest commit on main branch
# Tag format: main-<timestamp>-<short-sha> e.g. main-20260315120000-a1b2c3d
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: app-payments-dev
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: app-payments
  filterTags:
    pattern: '^main-\d{14}-[a-f0-9]{7}$'   # filter to main-branch builds
    extract: '$ts'                            # sort by embedded timestamp
  policy:
    alphabetical:
      order: asc    # latest timestamp sorts last alphabetically
```

### Numerical Policy

```yaml
# imagepolicy-app-payments-build.yaml — select highest build number
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: app-payments-build
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: app-payments
  filterTags:
    # Build tags formatted as build-<integer> e.g. build-4521
    pattern: '^build-(\d+)$'
    extract: '$1'
  policy:
    numerical:
      order: asc   # highest number wins
```

### Check Policy Status

```bash
# Show the selected latest image
flux get image policy app-payments

# Example output:
# NAME          LATEST IMAGE                                READY
# app-payments  registry.example.com/app-payments:1.4.7    True
```

## Section 5: Marker Comments in Git Files

The image-automation-controller finds and updates image references using inline marker comments. The markers must be present in the files the controller is configured to update.

### Kustomize Image Reference with Marker

```yaml
# clusters/us-east-1-prod/app-payments/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base/app-payments
images:
  - name: registry.example.com/app-payments
    newTag: "1.4.7" # {"$imagepolicy": "flux-system:app-payments:tag"}
```

### Helm Values File with Marker

```yaml
# clusters/us-east-1-prod/app-payments/values-image.yaml
image:
  repository: registry.example.com/app-payments
  tag: "1.4.7" # {"$imagepolicy": "flux-system:app-payments:tag"}
  pullPolicy: IfNotPresent
```

### Deployment Manifest with Full Image Reference Marker

```yaml
# base/app-payments/deployment.yaml — marker updates the full image reference
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-payments
spec:
  template:
    spec:
      containers:
        - name: payments
          # The full-reference marker updates both repository and tag atomically
          image: registry.example.com/app-payments:1.4.7 # {"$imagepolicy": "flux-system:app-payments"}
          ports:
            - containerPort: 8080
```

## Section 6: ImageUpdateAutomation CRD

The `ImageUpdateAutomation` object ties together the policy selection and the Git write operation.

### Basic Automation

```yaml
# imageupdateautomation-fleet.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: fleet-image-updates
  namespace: flux-system
spec:
  # The GitRepository source that defines the target repo and credentials
  sourceRef:
    kind: GitRepository
    name: fleet-infra

  # Interval at which the controller checks for pending image updates
  interval: 5m

  # Git commit configuration
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        name: Flux Image Automation Bot
        email: flux-bot@example.com
      messageTemplate: |
        chore(automation): update images in {{.AutomationObject.Namespace}}/{{.AutomationObject.Name}}

        {{range .Updated.Images -}}
        - {{.}}
        {{end -}}

        Signed-off-by: Flux Bot <flux-bot@example.com>
    push:
      branch: main     # push directly to main (for dev/staging)

  # Path filter — only update files under this path in the repo
  update:
    strategy: Setters  # uses the $imagepolicy marker comment convention
    path: "./clusters"  # scan all cluster directories
```

### Automation with PR-Based Updates (Production)

For production environments, push image updates to a dedicated branch and create a pull request instead of committing directly to main. This preserves a human approval gate.

```yaml
# imageupdateautomation-prod-pr.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: prod-image-updates
  namespace: flux-system
spec:
  sourceRef:
    kind: GitRepository
    name: fleet-infra-prod
  interval: 10m
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        name: Flux Image Bot
        email: flux-bot@example.com
      messageTemplate: |
        chore(automation): update {{range .Updated.Images}}{{.}}{{end}}

        Auto-generated by Flux image-automation-controller.
        Review and merge to deploy to production.
    push:
      branch: "image-updates/{{.AutomationObject.Name}}"  # dedicated branch
      # GitHub Actions workflow will open a PR from this branch
  update:
    strategy: Setters
    path: "./clusters/us-east-1-prod"  # scope to production path only
```

### Git Commit Signing with GPG

```yaml
# secret-git-gpg.yaml — GPG private key for commit signing
apiVersion: v1
kind: Secret
metadata:
  name: git-gpg-key
  namespace: flux-system
type: Opaque
stringData:
  git.asc: |
    -----BEGIN PGP PRIVATE KEY BLOCK-----
    EXAMPLE_GPG_KEY_REPLACE_ME
    -----END PGP PRIVATE KEY BLOCK-----
```

```yaml
# imageupdateautomation with GPG signing
spec:
  git:
    commit:
      signingKey:
        secretRef:
          name: git-gpg-key    # references the GPG key secret above
      author:
        name: Flux Image Bot
        email: flux-bot@example.com
```

## Section 7: Multi-Environment Promotion Workflow

### Repository Structure for Multi-Environment Promotion

```
fleet-infra/
  clusters/
    us-east-1-dev/
      app-payments/
        kustomization.yaml   # tag marker for dev policy (latest main branch build)
    us-east-1-staging/
      app-payments/
        kustomization.yaml   # tag marker for staging policy (semver rc allowed)
    us-east-1-prod/
      app-payments/
        kustomization.yaml   # tag marker for prod policy (semver stable only)
  policies/
    app-payments-dev.yaml
    app-payments-staging.yaml
    app-payments-prod.yaml
```

### Per-Environment ImagePolicies

```yaml
# policies/app-payments-dev.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: app-payments-dev
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: app-payments
  filterTags:
    pattern: '^main-\d{14}-[a-f0-9]{7}$'
  policy:
    alphabetical:
      order: asc
---
# policies/app-payments-staging.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: app-payments-staging
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: app-payments
  filterTags:
    pattern: '^v\d+\.\d+\.\d+(-rc\.\d+)?$'
    extract: '$1'
  policy:
    semver:
      range: ">=1.0.0-rc.0"
---
# policies/app-payments-prod.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: app-payments-prod
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: app-payments
  filterTags:
    pattern: '^v\d+\.\d+\.\d+$'   # strict semver, no pre-release
  policy:
    semver:
      range: ">=1.0.0 <2.0.0"
```

### Per-Environment Markers

```yaml
# clusters/us-east-1-dev/app-payments/kustomization.yaml
images:
  - name: registry.example.com/app-payments
    newTag: "main-20260315120000-a1b2c3d" # {"$imagepolicy": "flux-system:app-payments-dev:tag"}

# clusters/us-east-1-staging/app-payments/kustomization.yaml
images:
  - name: registry.example.com/app-payments
    newTag: "v1.5.0-rc.2" # {"$imagepolicy": "flux-system:app-payments-staging:tag"}

# clusters/us-east-1-prod/app-payments/kustomization.yaml
images:
  - name: registry.example.com/app-payments
    newTag: "v1.4.7" # {"$imagepolicy": "flux-system:app-payments-prod:tag"}
```

### Per-Environment Automations

```yaml
# imageupdateautomation-dev.yaml — direct push, no approval gate
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: dev-image-updates
  namespace: flux-system
spec:
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  interval: 2m    # frequent updates for dev
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        name: Flux Bot
        email: flux-bot@example.com
      messageTemplate: "chore(dev): update {{range .Updated.Images}}{{.}}{{end}}"
    push:
      branch: main
  update:
    strategy: Setters
    path: "./clusters/us-east-1-dev"
---
# imageupdateautomation-staging.yaml — direct push for staging
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: staging-image-updates
  namespace: flux-system
spec:
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  interval: 5m
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        name: Flux Bot
        email: flux-bot@example.com
      messageTemplate: "chore(staging): update {{range .Updated.Images}}{{.}}{{end}}"
    push:
      branch: main
  update:
    strategy: Setters
    path: "./clusters/us-east-1-staging"
---
# imageupdateautomation-prod.yaml — push to PR branch, not main
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: prod-image-updates
  namespace: flux-system
spec:
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  interval: 10m
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        name: Flux Bot
        email: flux-bot@example.com
      messageTemplate: |
        chore(prod): update app-payments image

        {{range .Updated.Images}}- {{.}}
        {{end}}
    push:
      branch: flux/prod-image-updates  # GitHub Actions opens PR from this branch
  update:
    strategy: Setters
    path: "./clusters/us-east-1-prod"
```

## Section 8: GitHub Actions CI Integration

### CI Workflow: Build, Tag, Push

```yaml
# .github/workflows/build-and-push.yml
name: Build and Push

on:
  push:
    branches:
      - main
      - "release/**"
    tags:
      - "v*"

env:
  REGISTRY: registry.example.com
  IMAGE_NAME: app-payments

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      image_tag: ${{ steps.meta.outputs.tags }}
      image_digest: ${{ steps.build.outputs.digest }}

    steps:
      - uses: actions/checkout@v4

      - name: Generate image metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            # On push to main: main-<timestamp>-<sha> format for dev image policy
            type=raw,value=main-{{date 'YYYYMMDDHHmmss'}}-{{sha}},enable={{is_default_branch}}
            # On release branch: semver rc tag for staging policy
            type=semver,pattern={{version}},enable=${{ startsWith(github.ref, 'refs/heads/release/') }}
            # On git tag: strict semver for prod policy
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}

      - name: Log in to registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ci-builder
          password: ${{ secrets.REGISTRY_PASSWORD }}

      - name: Build and push
        id: build
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          build-args: |
            BUILD_DATE=${{ github.event.head_commit.timestamp }}
            GIT_COMMIT=${{ github.sha }}
            VERSION=${{ steps.meta.outputs.version }}

      - name: Output image digest
        run: |
          echo "Built and pushed: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}"
```

### Workflow to Open Production PR

```yaml
# .github/workflows/open-prod-pr.yml
# Triggered after Flux commits the updated prod image tag to flux/prod-image-updates
name: Open Production Deployment PR

on:
  push:
    branches:
      - "flux/prod-image-updates"

jobs:
  create-pr:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Extract updated image versions
        id: images
        run: |
          # Find which images changed in this commit
          CHANGES=$(git diff HEAD~1 HEAD -- '*.yaml' | grep '^+' | grep 'imagepolicy' | head -20)
          echo "changes=${CHANGES}" >> "$GITHUB_OUTPUT"

      - name: Create or update pull request
        uses: peter-evans/create-pull-request@v6
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          branch: flux/prod-image-updates
          base: main
          title: "chore(prod): deploy updated images to production"
          body: |
            ## Production Image Deployment

            Flux image automation detected new approved images for production.

            ### Changed Images
            ```
            ${{ steps.images.outputs.changes }}
            ```

            ### Checklist
            - [ ] Staging environment validated
            - [ ] Change management ticket created
            - [ ] On-call engineer notified

            Auto-generated by Flux image-automation-controller.
          labels: |
            automated
            production-deploy
          reviewers: |
            platform-oncall
```

## Section 9: Flux Notification Controller for Alerts

### Provider and Alert Configuration

```yaml
# notification-provider-slack.yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: slack-platform
  namespace: flux-system
spec:
  type: slack
  channel: "#platform-flux-alerts"
  secretRef:
    name: slack-url-secret   # contains the Slack webhook URL
---
# notification-provider-pagerduty.yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: pagerduty-platform
  namespace: flux-system
spec:
  type: pagerduty
  secretRef:
    name: pagerduty-key-secret   # contains the PagerDuty integration key
```

```yaml
# secret-slack-url.yaml — managed by External Secrets
apiVersion: v1
kind: Secret
metadata:
  name: slack-url-secret
  namespace: flux-system
type: Opaque
stringData:
  address: "https://hooks.slack.com/services/EXAMPLE/WEBHOOK/REPLACE_ME"
```

```yaml
# alert-image-updates.yaml — notify on image automation events
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: image-automation-alerts
  namespace: flux-system
spec:
  providerRef:
    name: slack-platform
  # Alert on image update automations and policy changes
  eventSources:
    - kind: ImageUpdateAutomation
      name: "*"           # all automations
    - kind: ImagePolicy
      name: "*"           # all policies
    - kind: Kustomization
      name: "*"           # downstream sync events
  eventSeverity: info     # capture info (successful) and error events
  inclusionList:
    - ".*update.*"        # only image update related events
---
# alert-sync-failures.yaml — PagerDuty for sync failures
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: sync-failure-pagerduty
  namespace: flux-system
spec:
  providerRef:
    name: pagerduty-platform
  eventSources:
    - kind: Kustomization
      name: "*"
    - kind: HelmRelease
      name: "*"
  eventSeverity: error   # only fire on errors
```

## Section 10: Flagger Integration for Progressive Delivery

Flagger extends Flux image automation by replacing immediate rollouts with canary or blue/green deployments that automatically validate metrics before proceeding.

### Flagger Canary Resource

```yaml
# canary-app-payments.yaml — manages the rollout strategy for app-payments
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: app-payments
  namespace: payments
spec:
  # Target deployment managed by Flux/kustomize
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: app-payments

  progressDeadlineSeconds: 600  # fail canary if not promoted within 10 minutes

  # Service configuration — Flagger creates primary and canary Services
  service:
    port: 8080
    targetPort: 8080
    gateways:
      - istio-system/gateway-public
    hosts:
      - payments.example.com
    trafficPolicy:
      tls:
        mode: ISTIO_MUTUAL

  # Canary analysis configuration
  analysis:
    # Run analysis every 30 seconds
    interval: 30s
    # Promote after 5 consecutive successful analysis iterations
    threshold: 5
    # Canary receives this percentage of traffic during analysis
    maxWeight: 20
    stepWeight: 5    # increment by 5% per successful iteration (5→10→15→20% then promote)

    # Prometheus metrics that must pass for promotion
    metrics:
      - name: request-success-rate
        # Must maintain >99% success rate
        thresholdRange:
          min: 99
        interval: 1m
      - name: request-duration
        # P99 latency must remain below 500ms
        thresholdRange:
          max: 500
        interval: 30s

    # Load test to generate traffic during canary analysis
    webhooks:
      - name: load-test
        url: http://flagger-loadtester.flagger-system/
        timeout: 5s
        metadata:
          cmd: "hey -z 1m -q 10 -c 2 http://app-payments-canary.payments:8080/health"

    # Automatic rollback on threshold breach
    alerts:
      - name: payments-canary-rollback
        severity: error
        providerRef:
          name: slack-platform
          namespace: flux-system
```

### Health Check Resource with Rollback

```bash
# Manually trigger a rollback if the canary is failing
kubectl annotate canary app-payments -n payments \
  flagger.app/manually-triggered="rollback"

# Check canary analysis progress
kubectl describe canary app-payments -n payments | grep -A 30 "Status:"

# Watch the canary events in real time
kubectl get events -n payments --field-selector reason=Canary --watch
```

## Section 11: Troubleshooting Reference

### Common Issues and Resolutions

```bash
# Check why ImageRepository is not scanning
flux get image repository app-payments -n flux-system
kubectl describe imagerepository app-payments -n flux-system

# Common cause: wrong registry URL or missing Secret
# Fix: verify the image field matches the registry path exactly
# Fix: ensure the secretRef points to a valid dockerconfigjson Secret

# Check why ImagePolicy is not selecting a tag
flux get image policy app-payments -n flux-system
# If READY=False with "no tags matched filter":
# 1. Check the filterTags.pattern regex against actual registry tags
# 2. Run: kubectl get imagerepository app-payments -o jsonpath='{.status.lastScanResult}'
# 3. Verify the semver range covers the available tag versions

# Check if automation is committing changes
flux get image update fleet-image-updates -n flux-system
kubectl logs -n flux-system \
  -l app=image-automation-controller \
  --since=30m | grep -E "(commit|error|warn)"

# Common cause: no markers found in scanned path
# Fix: verify $imagepolicy marker comments match the namespace:name of the policy
# Example correct marker: # {"$imagepolicy": "flux-system:app-payments:tag"}

# Force a reconcile of the image repository scan
flux reconcile image repository app-payments

# Force the automation controller to re-evaluate and commit
flux reconcile image update fleet-image-updates

# View recent commits made by the automation controller
git log --oneline --author="Flux Bot" -10

# Debug marker detection by running the dry-run
kubectl exec -n flux-system \
  -it deploy/image-automation-controller -- \
  /usr/local/bin/image-automation-controller --dry-run
```

### Suspend and Resume Automation

```bash
# Suspend automation during an incident or maintenance window
flux suspend image update fleet-image-updates
flux suspend image update prod-image-updates

# Suspend the image reflector to stop all registry polling
flux suspend image repository app-payments

# Resume after maintenance
flux resume image update fleet-image-updates
flux resume image repository app-payments
```

## Section 12: Security Considerations

### Least-Privilege Git Access

The deploy key created by `flux bootstrap --read-write-key` has push access to the entire repository. Scope access further using GitHub's repository path restrictions or by using separate repositories per environment.

```bash
# Rotate the deploy key if it is compromised
# 1. Delete the old key from GitHub repository settings
# 2. Regenerate via flux reconcile
flux reconcile source git fleet-infra

# Check which service account the automation controller uses
kubectl get pod -n flux-system \
  -l app=image-automation-controller \
  -o jsonpath='{.items[0].spec.serviceAccountName}'
```

### Image Signature Verification

```yaml
# imagepolicy with Cosign signature verification
# Requires the Flux image-reflector-controller to have cosign installed
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: app-payments
  namespace: flux-system
spec:
  image: registry.example.com/app-payments
  interval: 5m
  verify:
    provider: cosign
    secretRef:
      name: cosign-pub-key    # contains the Cosign public key
```

## Summary

Flux image automation replaces the manual image tag bump with a feedback loop that runs entirely within the GitOps control plane. The image-reflector-controller continuously polls registries and filters tags against semver, regex, or numerical policies defined in `ImagePolicy` objects. The image-automation-controller reads those policies, finds marker comments in the repository, updates the tag values, and commits the change. The standard Flux reconciliation loop detects the commit and drives the cluster toward the new desired state.

Layering per-environment `ImagePolicy` objects with different semver ranges implements a multi-stage promotion pipeline where only stable releases reach production. Pushing production updates to a dedicated branch and opening a pull request preserves the human approval gate that change management processes require. Flagger adds the final layer: metric-validated canary rollouts that automatically roll back when error rates or latency budgets are breached. Together, these components form a deployment pipeline where the only manual step is merging a PR.
