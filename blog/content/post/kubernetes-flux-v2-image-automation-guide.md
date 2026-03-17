---
title: "Flux v2 Image Automation: Automatic Deployment on New Container Releases"
date: 2028-11-10T00:00:00-05:00
draft: false
tags: ["Flux", "GitOps", "Kubernetes", "CI/CD", "Automation"]
categories:
- Flux
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to Flux v2 image automation including ImageRepository, ImagePolicy, and ImageUpdateAutomation resources, semver and regex filtering, GPG commit signing, multi-environment promotion, and Flagger integration."
more_link: "yes"
url: "/kubernetes-flux-v2-image-automation-guide/"
---

Flux v2 image automation closes the loop between your container registry and your Kubernetes cluster. When a new image tag is pushed by CI, Flux detects it, applies your acceptance policy, updates the Git repository, and triggers a reconciliation — all without human intervention. This guide covers every layer of that pipeline, from basic `ImageRepository` configuration through GPG-signed commits, multi-environment branch promotion, and combining image automation with Flagger for canary deployments.

<!--more-->

# Flux v2 Image Automation: Automatic Deployment on New Container Releases

## Why Image Automation Matters

In a pure GitOps workflow, the Git repository is the single source of truth for cluster state. Every change — including image tag bumps — must flow through Git. Manually updating image tags for every CI build is tedious and error-prone. Flux image automation solves this by watching your registry, evaluating a policy (semver range, regex, alphabetical latest), writing the new tag back to the Git manifest, and letting the normal reconciliation loop do the rest.

The three resources that power this feature:

- `ImageRepository` — polls a container registry for available tags
- `ImagePolicy` — selects a single "best" tag from those available
- `ImageUpdateAutomation` — commits the selected tag back into Git

## Prerequisites

```bash
# Flux CLI version >= 2.0
flux version

# Bootstrap if not already done
flux bootstrap github \
  --owner=myorg \
  --repository=fleet-infra \
  --branch=main \
  --path=clusters/production \
  --personal

# Enable image automation controllers (not installed by default)
flux bootstrap github \
  --owner=myorg \
  --repository=fleet-infra \
  --branch=main \
  --path=clusters/production \
  --components-extra=image-reflector-controller,image-automation-controller \
  --personal
```

Verify the controllers are running:

```bash
kubectl -n flux-system get deployments | grep image
# image-automation-controller   1/1     Running
# image-reflector-controller    1/1     Running
```

## ImageRepository: Polling the Registry

An `ImageRepository` resource tells Flux which registry and repository to scan:

```yaml
# infrastructure/image-repositories/myapp.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: myapp
  namespace: flux-system
spec:
  image: ghcr.io/myorg/myapp
  interval: 1m
  # For private registries, reference a Secret
  secretRef:
    name: ghcr-credentials
  # Limit scan to reduce API calls
  exclusionList:
    - "^.*\\.sig$"   # exclude cosign signatures
    - "^sha-.*"      # exclude digest-tagged images
```

Create the registry credentials secret:

```bash
kubectl -n flux-system create secret docker-registry ghcr-credentials \
  --docker-server=ghcr.io \
  --docker-username=myorg \
  --docker-password="${GITHUB_TOKEN}"
```

Check what tags Flux discovered:

```bash
flux get image repository myapp -n flux-system
# NAME    LAST SCAN             TAGS  READY MESSAGE
# myapp   2024-01-15T10:00:00Z  47    True  successful scan

# Detailed tag list
kubectl -n flux-system get imagerepository myapp \
  -o jsonpath='{.status.lastScanResult.tagCount}'
```

## ImagePolicy: Selecting the Right Tag

### Semver Policy (Most Common for Production)

```yaml
# infrastructure/image-policies/myapp-semver.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: myapp
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: myapp
  policy:
    semver:
      range: ">=1.0.0 <2.0.0"
```

This selects the highest tag matching the semver range. A `1.5.3` release would be selected over `1.5.2`, but a `2.0.0` release would be ignored until you intentionally bump the range.

### Semver with Pre-release Channels

```yaml
# Allow release candidates in staging
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: myapp-staging
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: myapp
  filterTags:
    pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+-rc\\.[0-9]+$"
  policy:
    semver:
      range: ">=1.0.0-0 <2.0.0"
```

### Alphabetical Policy (Latest Timestamp Tag)

Many CI systems tag images with timestamps like `20240115-143022`:

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: myapp-latest-build
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: myapp
  filterTags:
    pattern: "^[0-9]{8}-[0-9]{6}$"
    extract: "$0"
  policy:
    alphabetical:
      order: asc
```

### Regex Policy with Capture Groups

For branch-specific tags like `main-abc1234`:

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: myapp-main-branch
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: myapp
  filterTags:
    pattern: "^main-(?P<ts>[0-9]+)-(?P<sha>[a-f0-9]{7})$"
    extract: "$ts"
  policy:
    numerical:
      order: asc
```

Check the current selected image:

```bash
flux get image policy myapp -n flux-system
# NAME   LATEST IMAGE                          READY  MESSAGE
# myapp  ghcr.io/myorg/myapp:1.5.3             True   Latest image tag for 'myapp' resolved to: 1.5.3
```

## Annotating Manifests for Automatic Updates

Flux uses special marker comments in your YAML manifests to know where to write the selected tag. Without these markers, Flux will not modify your files.

```yaml
# apps/production/myapp/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      containers:
      - name: myapp
        image: ghcr.io/myorg/myapp:1.5.2 # {"$imagepolicy": "flux-system:myapp"}
        ports:
        - containerPort: 8080
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "256Mi"
```

The marker format is `# {"$imagepolicy": "<namespace>:<policy-name>"}`.

For tag-only updates (when the image name itself should not change):

```yaml
image: ghcr.io/myorg/myapp:1.5.2 # {"$imagepolicy": "flux-system:myapp:tag"}
```

For digest pinning (not recommended for automation but supported):

```yaml
image: ghcr.io/myorg/myapp:1.5.2@sha256:abc123 # {"$imagepolicy": "flux-system:myapp:digest"}
```

## ImageUpdateAutomation: Writing Back to Git

```yaml
# infrastructure/image-automation/myapp.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: flux-system
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
        email: fluxcdbot@users.noreply.github.com
        name: fluxcdbot
      messageTemplate: |
        Auto-update images

        Updated images:
        {{ range .Updated.Images -}}
        - {{ .Name }}:{{ .NewTag }} (was {{ .OldTag }})
        {{ end -}}

        Triggered by: {{ .Changed.FileCount }} file(s) changed
    push:
      branch: main
  update:
    path: ./apps/production
    strategy: Setters
```

The `update.path` tells Flux which directory tree to scan for marker comments. The `strategy: Setters` means Flux uses the `# {"$imagepolicy": ...}` annotations rather than kustomize-style setters.

## GPG Commit Signing

For compliance and auditability, you can have Flux sign its automated commits with GPG.

### Generate a Signing Key

```bash
# Generate a GPG key pair (non-interactive)
cat > /tmp/gpg-batch.conf <<EOF
%no-protection
Key-Type: RSA
Key-Length: 4096
Subkey-Type: RSA
Subkey-Length: 4096
Name-Real: Flux Image Automation
Name-Email: flux@myorg.com
Expire-Date: 2y
EOF

gpg --batch --gen-key /tmp/gpg-batch.conf

# Export public key to add to GitHub
KEY_ID=$(gpg --list-secret-keys --keyid-format=long flux@myorg.com \
  | grep sec | awk '{print $2}' | cut -d'/' -f2)

gpg --armor --export "${KEY_ID}"

# Export as Kubernetes Secret
gpg --export-secret-keys --armor "${KEY_ID}" | \
  kubectl -n flux-system create secret generic flux-gpg-signing-key \
    --from-file=git.asc=/dev/stdin
```

### Configure ImageUpdateAutomation with Signing

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: flux-system
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
        email: flux@myorg.com
        name: "Flux Image Automation"
      messageTemplate: "Auto-update: {{ range .Updated.Images }}{{ .Name }}:{{ .NewTag }} {{ end }}"
      signingKey:
        secretRef:
          name: flux-gpg-signing-key
    push:
      branch: main
  update:
    path: ./apps/production
    strategy: Setters
```

Add the public key to your GitHub repository as a trusted signing key under Settings > Deploy keys (or to GitHub's Vigilant Mode allowed keys).

## Multi-Environment Promotion via Branch Strategy

A common pattern is to have separate Git branches for each environment, with automated promotion through them:

```
main (production)
  └── staging
        └── dev
```

### Dev Environment (Latest Build)

```yaml
# In branch: dev
# infrastructure/image-automation/dev.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: myapp-dev
  namespace: flux-system
spec:
  interval: 1m
  sourceRef:
    kind: GitRepository
    name: flux-system
  git:
    checkout:
      ref:
        branch: dev
    commit:
      author:
        email: flux@myorg.com
        name: "Flux Automation"
      messageTemplate: "[dev] Auto-update {{ range .Updated.Images }}{{ .Name }}:{{ .NewTag }}{{ end }}"
    push:
      branch: dev
  update:
    path: ./apps/dev
    strategy: Setters
```

### Staging Promotion (Semver RC)

```yaml
# In branch: staging
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: myapp-staging
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: flux-system
  git:
    checkout:
      ref:
        branch: staging
    commit:
      author:
        email: flux@myorg.com
        name: "Flux Automation"
      messageTemplate: "[staging] Promote {{ range .Updated.Images }}{{ .Name }}:{{ .NewTag }}{{ end }}"
    push:
      branch: staging
  update:
    path: ./apps/staging
    strategy: Setters
```

### GitHub Actions Cross-Branch Promotion

```yaml
# .github/workflows/promote-to-staging.yaml
name: Promote to Staging

on:
  push:
    branches:
      - dev
    paths:
      - 'apps/dev/**'

jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.FLUX_BOT_TOKEN }}

      - name: Configure git
        run: |
          git config user.name "Flux Promotion Bot"
          git config user.email "flux@myorg.com"

      - name: Extract new image tag from dev
        id: extract
        run: |
          # Pull the tag that was just updated in dev
          TAG=$(grep -oP '(?<=myapp:)[^\s"]+' apps/dev/deployment.yaml | head -1)
          echo "tag=${TAG}" >> $GITHUB_OUTPUT
          echo "Promoting tag: ${TAG}"

      - name: Update staging branch
        run: |
          git fetch origin staging
          git checkout staging

          # Update the image tag in staging manifest
          sed -i "s|ghcr.io/myorg/myapp:[^ ]*|ghcr.io/myorg/myapp:${{ steps.extract.outputs.tag }}|g" \
            apps/staging/deployment.yaml

          git add apps/staging/deployment.yaml
          git commit -m "[promote] myapp:${{ steps.extract.outputs.tag }} dev -> staging" || exit 0
          git push origin staging
```

## Combining Image Automation with Flagger for Canary Promotion

Instead of immediately rolling out the new image to all replicas, use Flagger to do a canary analysis:

```yaml
# apps/production/myapp/canary.yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: myapp
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  progressDeadlineSeconds: 60
  service:
    port: 8080
    targetPort: 8080
    gateways:
      - public-gateway.istio-system.svc.cluster.local
    hosts:
      - myapp.production.example.com
  analysis:
    interval: 30s
    threshold: 5
    maxWeight: 50
    stepWeight: 10
    metrics:
    - name: request-success-rate
      thresholdRange:
        min: 99
      interval: 1m
    - name: request-duration
      thresholdRange:
        max: 500
      interval: 30s
    webhooks:
    - name: acceptance-test
      type: pre-rollout
      url: http://flagger-loadtester.test/
      timeout: 30s
      metadata:
        type: bash
        cmd: "curl -sd 'test' http://myapp-canary.production/health | grep ok"
    - name: load-test
      url: http://flagger-loadtester.test/
      timeout: 5s
      metadata:
        cmd: "hey -z 1m -q 10 -c 2 http://myapp-canary.production/"
```

With Flagger managing the Canary resource, Flux's image automation still writes the new tag to the `Deployment` manifest. Flagger detects the spec change and begins the canary analysis automatically. If the analysis fails, Flagger rolls back; if it succeeds, it promotes the canary to primary.

## Repository Structure for Image Automation

```
fleet-infra/
├── clusters/
│   └── production/
│       └── flux-system/
│           ├── gotk-components.yaml
│           └── gotk-sync.yaml
├── infrastructure/
│   ├── image-repositories/
│   │   └── myapp.yaml
│   ├── image-policies/
│   │   ├── myapp-production.yaml
│   │   └── myapp-staging.yaml
│   └── image-automation/
│       └── flux-system.yaml
└── apps/
    ├── production/
    │   └── myapp/
    │       ├── deployment.yaml    # contains $imagepolicy markers
    │       ├── service.yaml
    │       └── canary.yaml
    └── staging/
        └── myapp/
            └── deployment.yaml
```

Link the image automation infrastructure into the cluster reconciliation:

```yaml
# clusters/production/flux-system/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - gotk-components.yaml
  - gotk-sync.yaml
  - ../../infrastructure/image-repositories/
  - ../../infrastructure/image-policies/
  - ../../infrastructure/image-automation/
```

## Debugging Image Automation Failures

### Check the ImageRepository Scan Status

```bash
# Is it scanning successfully?
flux get image repository --all-namespaces

# Detailed status
kubectl -n flux-system describe imagerepository myapp

# Common issue: authentication failure
kubectl -n flux-system get events --field-selector reason=Failed | grep image
```

### Check the ImagePolicy Selection

```bash
# Is a tag being selected?
flux get image policy --all-namespaces

# If no tag is selected, check the filter pattern
kubectl -n flux-system get imagepolicy myapp -o yaml | grep -A10 filterTags

# Test your regex manually
echo "1.5.3" | grep -P "^[0-9]+\.[0-9]+\.[0-9]+$"
```

### Check the ImageUpdateAutomation Status

```bash
# Is automation running?
flux get image update --all-namespaces

# Detailed status shows last commit
kubectl -n flux-system describe imageupdateautomation flux-system

# Check if markers are correct in your manifests
grep -r '\$imagepolicy' apps/
```

### Common Error: Marker Not Found

```bash
# Error: no updates made; no setter markers found
# Fix: ensure your deployment.yaml has the correct marker format
grep 'imagepolicy' apps/production/myapp/deployment.yaml
# Should output:
# image: ghcr.io/myorg/myapp:1.5.2 # {"$imagepolicy": "flux-system:myapp"}
```

### Common Error: Git Push Failures

```bash
# Check the automation controller logs
kubectl -n flux-system logs -l app=image-automation-controller --tail=50

# Common cause: SSH key not in deployment keys with write access
# Regenerate if needed:
flux create secret git flux-system \
  --url=ssh://git@github.com/myorg/fleet-infra \
  --ssh-key-algorithm=ecdsa \
  --ssh-ecdsa-curve=p521

# Get the public key to add to GitHub
kubectl -n flux-system get secret flux-system \
  -o jsonpath='{.data.identity\.pub}' | base64 -d
```

### Force a Reconciliation

```bash
# Trigger immediate image scan
flux reconcile image repository myapp -n flux-system

# Trigger immediate policy evaluation
flux reconcile image policy myapp -n flux-system

# Trigger immediate automation run
flux reconcile image update flux-system -n flux-system

# Watch the reconciliation
flux get all -A --watch
```

### Dry-Run Mode for Testing

There is no built-in dry-run for ImageUpdateAutomation, but you can test your policy selection and marker scanning manually:

```bash
# Check what tag would be selected
kubectl -n flux-system get imagepolicy myapp \
  -o jsonpath='{.status.latestImage}'

# Simulate the file update locally using flux-local
pip install flux-local
flux-local diff ks apps/production --path clusters/production
```

## Notification on Image Updates

Configure Flux to send Slack or Teams notifications when images are updated:

```yaml
# infrastructure/notifications/slack.yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: slack
  namespace: flux-system
spec:
  type: slack
  channel: deployments
  secretRef:
    name: slack-url

---
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: image-updates
  namespace: flux-system
spec:
  providerRef:
    name: slack
  eventSeverity: info
  eventSources:
    - kind: ImageUpdateAutomation
      name: '*'
    - kind: ImagePolicy
      name: '*'
  summary: "Image automation event"
```

## Suspend and Resume Automation

During maintenance windows or incident response, you can suspend automation without deleting the resources:

```bash
# Suspend all image automation
flux suspend image update flux-system -n flux-system

# Suspend a specific repository scan
flux suspend image repository myapp -n flux-system

# Resume
flux resume image update flux-system -n flux-system
flux resume image repository myapp -n flux-system
```

## End-to-End Test: Verifying the Full Pipeline

```bash
#!/bin/bash
# test-image-automation.sh
set -euo pipefail

NAMESPACE="flux-system"
APP_NAME="myapp"
REGISTRY="ghcr.io/myorg/myapp"
TEST_TAG="1.99.0-automation-test"

echo "=== Step 1: Push a test image tag ==="
docker pull alpine:3.18
docker tag alpine:3.18 "${REGISTRY}:${TEST_TAG}"
docker push "${REGISTRY}:${TEST_TAG}"

echo "=== Step 2: Update ImagePolicy to allow test tag ==="
kubectl -n "${NAMESPACE}" patch imagepolicy "${APP_NAME}" \
  --type=merge \
  -p "{\"spec\":{\"policy\":{\"semver\":{\"range\":\">=1.0.0 <2.0.0\"}}}}"

echo "=== Step 3: Force image repository scan ==="
flux reconcile image repository "${APP_NAME}" -n "${NAMESPACE}"
sleep 30

echo "=== Step 4: Check selected tag ==="
SELECTED=$(kubectl -n "${NAMESPACE}" get imagepolicy "${APP_NAME}" \
  -o jsonpath='{.status.latestImage}')
echo "Selected: ${SELECTED}"

echo "=== Step 5: Force automation run ==="
flux reconcile image update flux-system -n "${NAMESPACE}"
sleep 30

echo "=== Step 6: Verify Git commit was made ==="
git -C /tmp/fleet-infra pull
LATEST_COMMIT=$(git -C /tmp/fleet-infra log --oneline -1)
echo "Latest commit: ${LATEST_COMMIT}"

echo "=== Step 7: Verify deployment updated ==="
kubectl rollout status deployment/myapp -n production --timeout=120s

echo "=== Test passed ==="
```

## Summary

Flux v2 image automation provides a complete, auditable pipeline from container registry to running cluster:

1. `ImageRepository` polls your registry at a configurable interval
2. `ImagePolicy` applies semver, alphabetical, or numerical policy to select the best tag
3. Marker comments in manifests tell Flux exactly which YAML fields to update
4. `ImageUpdateAutomation` commits the changes back to Git with optional GPG signing
5. Multi-environment promotion flows through branch strategies with CI gate steps
6. Flagger integration enables canary analysis before full rollout
7. Suspension, notifications, and reconciliation commands give operators full control

The result is a GitOps pipeline where every running image version is traceable to a Git commit, every commit is attributable to either a human or the automation bot, and rollbacks are as simple as reverting a commit.
