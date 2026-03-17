---
title: "Kubernetes Flux v2 Image Automation: GitOps with Automated Image Updates"
date: 2029-07-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Flux", "GitOps", "Image Automation", "Harbor", "ECR", "Continuous Delivery"]
categories: ["Kubernetes", "GitOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Flux v2 image automation covering ImageRepository, ImagePolicy, ImageUpdateAutomation, commit author configuration, semver and digest policies, and integration with Harbor and Amazon ECR."
more_link: "yes"
url: "/kubernetes-flux-v2-image-automation-gitops-guide/"
---

Flux v2's image automation feature closes the final gap in a fully automated GitOps pipeline: automatically updating your Git repository when new container images are published, triggering a Flux reconciliation that deploys the new image to your cluster. Without image automation, engineers must manually update image tags in Git — a toil-heavy step that also creates a mismatch between what is deployed and what is in Git. This guide covers every component of the Flux image automation subsystem, from ImageRepository scanning to ECR and Harbor integration, including production-grade policies for semver promotion gates and digest-pinned immutable deployments.

<!--more-->

# Kubernetes Flux v2 Image Automation: GitOps with Automated Image Updates

## Section 1: Image Automation Architecture

```
Container Registry (Harbor/ECR/GCR)
        │
        │ new tag pushed
        ▼
┌────────────────────┐
│  ImageRepository    │  Scans registry, lists available tags
│  (flux-system)      │  refreshInterval: 1m
└─────────┬──────────┘
          │ tags list
          ▼
┌────────────────────┐
│  ImagePolicy        │  Selects LATEST tag matching policy
│  (semver/digest)    │  e.g. ^1.0.x → 1.0.7
└─────────┬──────────┘
          │ selected tag
          ▼
┌────────────────────┐
│  ImageUpdateAuto   │  Writes selected tag into YAML files
│  -mation            │  Commits + pushes to Git
└─────────┬──────────┘
          │ git push
          ▼
┌────────────────────┐
│  Git Repository     │  Updated YAML: image: app:1.0.7
│  (GitOps source)    │
└─────────┬──────────┘
          │ git pull
          ▼
┌────────────────────┐
│  Flux Kustomize/    │  Reconciles deployment with new image
│  HelmRelease        │
└─────────┬──────────┘
          │ applies
          ▼
┌────────────────────┐
│  Kubernetes Cluster │  Running pod: app:1.0.7
└────────────────────┘
```

## Section 2: Prerequisites and Installation

```bash
# Install Flux CLI
curl -s https://fluxcd.io/install.sh | sudo bash
flux --version

# Bootstrap Flux with image automation controllers enabled
flux bootstrap github \
    --owner=myorg \
    --repository=cluster-gitops \
    --branch=main \
    --path=clusters/production \
    --components-extra=image-reflector-controller,image-automation-controller

# Or install image automation components on existing Flux installation
flux install \
    --components-extra=image-reflector-controller,image-automation-controller

# Verify all Flux components are running
kubectl get pods -n flux-system
# NAME                                           READY   STATUS    RESTARTS
# helm-controller-xxx                            1/1     Running   0
# image-automation-controller-xxx                1/1     Running   0
# image-reflector-controller-xxx                 1/1     Running   0
# kustomize-controller-xxx                       1/1     Running   0
# notification-controller-xxx                    1/1     Running   0
# source-controller-xxx                          1/1     Running   0

# Check image automation CRDs are installed
kubectl get crd | grep -E "imagerepositories|imagepolicies|imageupdateautomations"
```

## Section 3: ImageRepository

The ImageRepository resource tells Flux to scan a container registry for available tags.

### Public Registry (Docker Hub)

```yaml
# imagerepository-dockerhub.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: my-app
  namespace: flux-system
spec:
  image: docker.io/myorg/my-app
  interval: 5m          # How often to scan for new tags
  timeout: 1m           # Scan timeout
  # No secretRef needed for public images
```

### Private Registry with Authentication Secret

```yaml
# imagerepository-private.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: my-app-private
  namespace: flux-system
spec:
  image: registry.example.com/myorg/my-app
  interval: 2m
  secretRef:
    name: registry-credentials
  # Exclude tags matching pattern (e.g., skip latest and debug tags)
  exclusionList:
  - "^latest$"
  - ".*-debug$"
  - ".*-dev$"
```

```bash
# Create registry credentials secret
kubectl create secret docker-registry registry-credentials \
    --namespace=flux-system \
    --docker-server=registry.example.com \
    --docker-username=myuser \
    --docker-password='<TOKEN>'

# Or use sealed-secrets for GitOps-friendly secret management
echo -n '<TOKEN>' | \
    kubeseal \
    --controller-name=sealed-secrets \
    --controller-namespace=kube-system \
    --raw --from-file=/dev/stdin \
    --scope=strict \
    --name=registry-credentials \
    --namespace=flux-system
```

### Check ImageRepository Status

```bash
# Check scan status
kubectl get imagerepository -n flux-system
# NAME       LAST SCAN              TAGS
# my-app     2029-07-26T15:04:05Z   47

# Detailed status
kubectl describe imagerepository my-app -n flux-system
# Status:
#   Canonical Image Name: docker.io/myorg/my-app
#   Last Scan Result:
#     Scan Time:  2029-07-26T15:04:05Z
#     Tag Count:  47

# Get the full tag list
kubectl get imagerepository my-app -n flux-system \
    -o jsonpath='{.status.lastScanResult}' | jq .

# Force an immediate rescan
flux reconcile image repository my-app --namespace=flux-system
```

## Section 4: ImagePolicy

ImagePolicy selects a single "latest" tag from the scanned tags based on a policy.

### SemVer Policy

```yaml
# imagepolicy-semver.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: my-app-semver
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: my-app
    namespace: flux-system
  # Select highest semver tag matching ^1.x
  policy:
    semver:
      range: ">=1.0.0 <2.0.0"
```

```yaml
# Patch-only updates: only take 1.2.x upgrades
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: my-app-patch-only
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: my-app
  policy:
    semver:
      range: "~1.2.0"    # >= 1.2.0, < 1.3.0
```

### Alphabetical/Numerical Policy

```yaml
# imagepolicy-alphabetical.yaml
# Useful for date-tagged images: 2029-07-26, 20290726, etc.
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: my-app-datebased
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: my-app
  filterTags:
    # Only consider tags matching YYYYMMDD format
    pattern: '^\d{8}$'
    extract: '$0'
  policy:
    alphabetical:
      order: asc  # Latest date = alphabetically last
```

### Digest Policy (Immutable Pinning)

```yaml
# imagepolicy-digest.yaml
# Always use the latest digest for a specific tag
# Useful for images that use mutable tags (like 'stable')
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: my-app-digest
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: my-app
  filterTags:
    pattern: '^stable$'
  policy:
    alphabetical:
      order: asc
```

### Numeric Policy with Prefix Filtering

```yaml
# imagepolicy-numeric-filtered.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: my-app-build
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: my-app
  filterTags:
    # Filter to tags like: build-12345, build-12346
    pattern: '^build-(?P<build>\d+)$'
    extract: '$build'    # Extract the build number
  policy:
    numerical:
      order: asc   # Highest build number wins
```

### Check ImagePolicy Status

```bash
# View current selected image
kubectl get imagepolicy -n flux-system
# NAME              LATESTIMAGE
# my-app-semver     docker.io/myorg/my-app:1.0.7

# Detailed policy evaluation
kubectl describe imagepolicy my-app-semver -n flux-system
# Status:
#   Latest Image:  docker.io/myorg/my-app:1.0.7
#   Observed Previous Image: docker.io/myorg/my-app:1.0.6
#   Conditions:
#     Type:    Ready
#     Status:  True
#     Reason:  Succeeded
#     Message: Latest image tag for 'myorg/my-app' resolved to 1.0.7
```

## Section 5: ImageUpdateAutomation

ImageUpdateAutomation monitors ImagePolicy changes and updates YAML files in Git.

```yaml
# imageupdateautomation.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: flux-system
  namespace: flux-system
spec:
  # How often to check for policy changes
  interval: 30s

  # Source repository to update
  sourceRef:
    kind: GitRepository
    name: flux-system

  # Git commit configuration
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxbot@support.tools
        name: Flux Image Updater
      messageTemplate: |
        chore(images): update {{ range .Updated.Images -}}
          {{ .Name }} to {{ .NewTag }}
        {{ end -}}

        Updated by Flux image automation.
        PolicyRef: {{ range .Updated.Images -}}{{ .ImageRef.Policy.Name }}{{ end }}
    push:
      branch: main

  # Which files to update
  update:
    strategy: Setters
    path: ./apps    # Directory containing YAML files with setter markers
```

### Multi-Branch Push Strategy

```yaml
# Push updates to a PR branch instead of directly to main
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: image-update-staging
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: flux-system
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxbot@support.tools
        name: Flux Image Updater
      messageTemplate: |
        chore(images): automated update to {{ range .Updated.Images }}{{ .NewTag }} {{ end }}

        Triggered by: {{ range .Updated.Images -}}
          {{ .Name }}:{{ .NewTag }} (policy: {{ .ImageRef.Policy.Name }})
        {{ end -}}
    push:
      branch: image-updates/{{ .AutomationObject.Namespace }}-{{ .AutomationObject.Name }}
      # Creates a PR-ready branch; merge manually or via GitHub Actions
```

## Section 6: YAML Setter Markers

The "Setters" strategy updates YAML files that contain special marker comments.

### Deployment Annotation Markers

```yaml
# apps/production/my-app-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: production
spec:
  template:
    spec:
      containers:
      - name: my-app
        # Flux will update the tag portion of this image reference
        # The marker: # {"$imagepolicy": "flux-system:my-app-semver"}
        image: docker.io/myorg/my-app:1.0.5 # {"$imagepolicy": "flux-system:my-app-semver"}
        ports:
        - containerPort: 8080
```

```yaml
# Marker format options:
# 1. Update entire image reference (registry/repo:tag)
image: docker.io/myorg/my-app:1.0.5 # {"$imagepolicy": "flux-system:my-app"}

# 2. Update tag only (preserves registry/repo prefix)
image: docker.io/myorg/my-app:1.0.5 # {"$imagepolicy": "flux-system:my-app:tag"}

# 3. Update name only (preserves tag — useful for digest updates)
image: docker.io/myorg/my-app@sha256:abc123 # {"$imagepolicy": "flux-system:my-app:name"}
```

### HelmRelease Value Markers

```yaml
# apps/production/my-app-helmrelease.yaml
apiVersion: helm.toolkit.fluxcd.io/v2beta2
kind: HelmRelease
metadata:
  name: my-app
  namespace: production
spec:
  chart:
    spec:
      chart: my-app
      sourceRef:
        kind: HelmRepository
        name: my-charts
  values:
    image:
      repository: docker.io/myorg/my-app
      tag: 1.0.5 # {"$imagepolicy": "flux-system:my-app-semver:tag"}
      pullPolicy: IfNotPresent
```

### Kustomize Image Transformer Markers

```yaml
# apps/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- deployment.yaml

images:
- name: docker.io/myorg/my-app
  newTag: 1.0.5 # {"$imagepolicy": "flux-system:my-app-semver:tag"}
```

## Section 7: ECR Integration

Amazon ECR requires token refresh since ECR tokens expire every 12 hours.

```bash
# Install ECR credentials provider for Flux
# Method 1: Use ECR token refresh CronJob

cat > ecr-token-refresh.yaml << 'EOF'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ecr-token-refresh
  namespace: flux-system
  annotations:
    # IAM role with ECR read permissions
    eks.amazonaws.com/role-arn: arn:aws:iam::<ACCOUNT_ID>:role/FluxECRReader
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ecr-token-refresh
  namespace: flux-system
spec:
  # ECR tokens expire after 12 hours — refresh every 6 hours
  schedule: "0 */6 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: ecr-token-refresh
          containers:
          - name: ecr-token-refresher
            image: amazon/aws-cli:latest
            command:
            - /bin/sh
            - -c
            - |
              TOKEN=$(aws ecr get-login-password --region us-east-1)
              REGISTRY=<ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com

              kubectl create secret docker-registry ecr-registry-credentials \
                --namespace=flux-system \
                --docker-server=${REGISTRY} \
                --docker-username=AWS \
                --docker-password=${TOKEN} \
                --dry-run=client \
                -o yaml | kubectl apply -f -

              echo "ECR token refreshed at $(date)"
          restartPolicy: OnFailure
EOF
kubectl apply -f ecr-token-refresh.yaml
```

```yaml
# IAM policy for ECR read access
# Attach to the FluxECRReader IAM role
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:BatchCheckLayerAvailability",
        "ecr:DescribeRepositories",
        "ecr:DescribeImages",
        "ecr:ListImages",
        "ecr:GetAuthorizationToken"
      ],
      "Resource": "*"
    }
  ]
}
```

```yaml
# ImageRepository pointing to ECR
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: my-app-ecr
  namespace: flux-system
spec:
  image: <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/myorg/my-app
  interval: 5m
  secretRef:
    name: ecr-registry-credentials
  # ECR image tags often include commit SHA
  filterTags:
    pattern: '^[0-9a-f]{40}$'  # 40-char git SHA tags
```

### ECR Cross-Account Access

```yaml
# For cross-account ECR access, create a pull-through cache
# or use cross-account IAM role

# Cross-account ImageRepository
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: my-app-cross-account
  namespace: flux-system
spec:
  image: <PROD_ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/myorg/my-app
  interval: 5m
  provider: aws   # Flux uses IRSA directly for ECR (flux-system >= 2.3.0)
```

## Section 8: Harbor Integration

```yaml
# Harbor with username/password authentication
apiVersion: v1
kind: Secret
metadata:
  name: harbor-credentials
  namespace: flux-system
type: kubernetes.io/dockerconfigjson
stringData:
  .dockerconfigjson: |
    {
      "auths": {
        "harbor.company.com": {
          "username": "robot$flux-reader",
          "password": "<HARBOR_ROBOT_TOKEN>",
          "auth": ""
        }
      }
    }
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: my-app-harbor
  namespace: flux-system
spec:
  image: harbor.company.com/production/my-app
  interval: 2m
  secretRef:
    name: harbor-credentials
  # Harbor-specific: exclude chart artifacts (cosign, sbom)
  exclusionList:
  - "sha256-.*\\.sig$"     # Cosign signatures
  - "sha256-.*\\.att$"     # Cosign attestations
  - "sha256-.*\\.sbom$"    # SBOM artifacts
```

```bash
# Create Harbor robot account for Flux
# In Harbor: Projects → Production → Robot Accounts
# Permissions: Registry → Pull

# Create the secret from Harbor robot token
kubectl create secret docker-registry harbor-credentials \
    --namespace=flux-system \
    --docker-server=harbor.company.com \
    --docker-username='robot$flux-reader' \
    --docker-password='<HARBOR_ROBOT_TOKEN>'
```

## Section 9: Multi-Environment Promotion

```yaml
# Promotion workflow: staging → production
# staging tracks prerelease tags, production tracks stable semver

# Staging ImagePolicy: latest pre-release
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: my-app-staging
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: my-app
  filterTags:
    pattern: '^v\d+\.\d+\.\d+-rc\.\d+$'  # v1.2.3-rc.4
    extract: '$0'
  policy:
    semver:
      range: ">=0.0.0-0"  # Any prerelease

---
# Production ImagePolicy: stable semver only
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: my-app-production
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: my-app
  filterTags:
    pattern: '^v\d+\.\d+\.\d+$'  # v1.2.3 (no prerelease suffix)
  policy:
    semver:
      range: ">=1.0.0"
```

```yaml
# Directory structure for multi-environment automation
# clusters/
#   staging/
#     apps/
#       my-app-deployment.yaml  # image: myapp:v1.2.3-rc.4 # {"$imagepolicy": "flux-system:my-app-staging"}
#   production/
#     apps/
#       my-app-deployment.yaml  # image: myapp:v1.2.3 # {"$imagepolicy": "flux-system:my-app-production"}

# Two separate ImageUpdateAutomation resources
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: update-staging
  namespace: flux-system
spec:
  interval: 1m
  sourceRef:
    kind: GitRepository
    name: flux-system
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxbot@support.tools
        name: Flux Staging Updater
      messageTemplate: "ci(staging): update {{ range .Updated.Images }}{{ .NewTag }} {{ end }}"
    push:
      branch: main
  update:
    strategy: Setters
    path: ./clusters/staging/apps

---
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: update-production
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: flux-system
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxbot@support.tools
        name: Flux Production Updater
      messageTemplate: |
        chore(prod): promote {{ range .Updated.Images -}}
          {{ .Name }}:{{ .NewTag }}
        {{ end -}}

        [skip ci]
    push:
      branch: main
  update:
    strategy: Setters
    path: ./clusters/production/apps
```

## Section 10: Notifications on Image Updates

```yaml
# Slack notification when Flux updates an image
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: slack-flux
  namespace: flux-system
spec:
  type: slack
  channel: "#deployments"
  secretRef:
    name: slack-webhook-secret
---
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: image-update-alert
  namespace: flux-system
spec:
  providerRef:
    name: slack-flux
  summary: "Image update applied"
  eventSeverity: info
  eventSources:
  - kind: ImageUpdateAutomation
    namespace: flux-system
  - kind: ImagePolicy
    namespace: flux-system
  inclusionList:
  - ".*"
```

```bash
# Create slack webhook secret
kubectl create secret generic slack-webhook-secret \
    --namespace=flux-system \
    --from-literal=address='https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>'
```

## Section 11: Troubleshooting

```bash
# Check ImageRepository scanning
flux get image repository --all-namespaces
# NAME       NAMESPACE    LAST SCAN   TAGS  READY  MESSAGE
# my-app     flux-system  10s ago     47    True   successful scan

# Check ImagePolicy selection
flux get image policy --all-namespaces
# NAME              NAMESPACE    LATEST IMAGE                READY
# my-app-semver     flux-system  docker.io/myorg/my-app:1.0.7   True

# Check ImageUpdateAutomation last run
flux get image update --all-namespaces
# NAME         NAMESPACE    LAST RUN   READY  MESSAGE
# flux-system  flux-system  5s ago     True   no updates

# View automation controller logs
kubectl logs -n flux-system deploy/image-automation-controller --tail=50 | grep -E "INFO|WARN|ERROR"

# View reflector controller logs (tag scanning)
kubectl logs -n flux-system deploy/image-reflector-controller --tail=50

# Debug: Check if markers are being found
# The automation controller scans for the # {"$imagepolicy": ...} comment pattern
# If no files are updated, verify:
# 1. The path in ImageUpdateAutomation matches the directory containing YAML files
# 2. The namespace and policy name in the marker match an existing ImagePolicy
# 3. The GitRepository secret has write access to the repo

# Force immediate update check
flux reconcile image update flux-system --namespace=flux-system

# Check if the policy namespace matches the marker
# WRONG: # {"$imagepolicy": "my-app"}  ← missing namespace
# RIGHT: # {"$imagepolicy": "flux-system:my-app"} ← namespace:name

# Check ImagePolicy is selecting a different image than what's in Git
kubectl get imagepolicy my-app -n flux-system \
    -o jsonpath='{.status.latestImage}'
# Should differ from what's currently in your YAML file

# Verify the ImageRepository is finding your tags
kubectl get imagerepository my-app -n flux-system \
    -o jsonpath='{.status.lastScanResult}' | python3 -m json.tool
```

### Common Issues

```bash
# Issue: ImageRepository stuck in "Not Ready" state
kubectl describe imagerepository my-app -n flux-system | tail -30
# Look for: authentication errors, network timeouts, certificate issues

# Fix: Check secret format
kubectl get secret registry-credentials -n flux-system \
    -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d | jq .

# Issue: ImageUpdateAutomation says "no updates" but policy has a new image
# Cause: Marker format incorrect or path does not match
# Debug: Check what files the automation controller is finding
kubectl logs -n flux-system deploy/image-automation-controller --tail=100 | \
    grep -E "found|marker|update"

# Issue: Push permission denied
# Cause: The GitRepository secret lacks write access
# Fix for GitHub: ensure the token has 'contents: write' permission
# Check secret:
kubectl get secret flux-system -n flux-system \
    -o jsonpath='{.data.identity}' | base64 -d  # Should be SSH private key

# Issue: Multiple policies updating same file
# When you have multiple image policies in the same file, each needs its own marker
# Example with two containers:
# - name: app
#   image: myorg/app:1.0.5 # {"$imagepolicy": "flux-system:app-policy"}
# - name: sidecar
#   image: myorg/sidecar:2.1.0 # {"$imagepolicy": "flux-system:sidecar-policy"}
```

## Section 12: Production Checklist

```
Flux Image Automation Production Checklist:

Setup:
  [ ] image-reflector-controller and image-automation-controller deployed
  [ ] ImageRepository created for each application image
  [ ] Appropriate filterTags and exclusionList to prevent unwanted updates
  [ ] Registry authentication secret with minimal permissions (read-only)

Policies:
  [ ] ImagePolicy uses semver range appropriate for environment (staging: >=0.0.0-0, prod: ^1.x)
  [ ] Date-based tags use alphabetical policy with pattern filter
  [ ] SHA tags use numerical policy with extract pattern
  [ ] Production policies exclude prerelease tags

Automation:
  [ ] ImageUpdateAutomation configured with correct commit author
  [ ] Message template includes policy name for traceability
  [ ] Path matches directory containing YAML files with markers
  [ ] All YAML files with image references have correct markers

Markers:
  [ ] Every container image with automated updates has a marker comment
  [ ] Marker namespace:name matches existing ImagePolicy
  [ ] Marker tag variant (:tag) used when only tag should be updated
  [ ] HelmRelease values.image.tag updated via :tag marker

ECR/Harbor:
  [ ] Token refresh CronJob running (ECR tokens expire in 12h)
  [ ] Harbor robot account with pull-only permissions
  [ ] Cosign signature tags excluded from ImageRepository
  [ ] Cross-account ECR uses IRSA (not static credentials)

Notifications:
  [ ] Slack/Teams alert on successful image updates
  [ ] Alert on ImageRepository scan failures
  [ ] Alert on ImageUpdateAutomation errors
  [ ] PagerDuty on repeated update failures

Gitops Hygiene:
  [ ] Flux bot commit messages include [skip ci] to avoid CI loop
  [ ] Signed commits from Flux bot (GPG key configured)
  [ ] Branch protection allows Flux bot to push to main
  [ ] Image update PRs reviewable via push to separate branch

Monitoring:
  [ ] Monitor image update frequency (alert if stale > N days)
  [ ] Monitor number of tags in ImageRepository (alert if 0)
  [ ] Track image age: time from tag creation to deployment
```
