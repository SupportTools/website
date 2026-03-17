---
title: "Kubernetes Flux v2 Image Automation: Image Repositories, Image Policies, ImageUpdateAutomation, and Helm Releases"
date: 2031-11-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Flux", "GitOps", "Image Automation", "Helm", "CD", "FluxCD"]
categories: ["Kubernetes", "GitOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Flux v2 image automation covering ImageRepository scanning, ImagePolicy selection strategies, ImageUpdateAutomation commit workflows, and automated Helm release updates for fully automated continuous delivery."
more_link: "yes"
url: "/kubernetes-flux-v2-image-automation-repositories-policies-imageupdateautomation-helm-releases/"
---

Flux v2's image automation controllers close the loop in GitOps pipelines: when a new container image is pushed to a registry, Flux can automatically detect it, apply a selection policy, commit the version update to Git, and trigger a reconciliation that deploys it. This guide covers the complete image automation stack including cross-registry support, policy expressions, automated Helm value updates, and the operational practices required to run image automation safely in production.

<!--more-->

# Kubernetes Flux v2 Image Automation: Image Repositories, Image Policies, ImageUpdateAutomation, and Helm Releases

## Architecture of Flux Image Automation

Flux image automation consists of three separate controllers that work in sequence:

```
Registry → ImageRepository (polling) → ImagePolicy (selection) → ImageUpdateAutomation (Git commit) → Reconciler
```

1. **image-reflector-controller**: Periodically scans a container registry and caches available tags in an `ImageRepository` object's status.
2. **image-reflector-controller** (also handles `ImagePolicy`): Evaluates a selection policy against the cached tags to determine the "latest" tag that matches the policy.
3. **image-automation-controller**: Watches `ImageUpdateAutomation` objects, detects when the policy-selected tag differs from what is in Git, commits the update, and pushes to the Git repository.

## Section 1: Prerequisites and Installation

### 1.1 Installing Image Automation Components

The image automation controllers are not installed by default in minimal Flux installations:

```bash
# Bootstrap Flux with image automation enabled
flux bootstrap github \
  --owner=exampleorg \
  --repository=fleet-infra \
  --branch=main \
  --path=clusters/production \
  --components-extra=image-reflector-controller,image-automation-controller \
  --personal

# Or install image automation on an existing Flux installation
flux install \
  --components-extra=image-reflector-controller,image-automation-controller

# Verify components are running
flux check

# Check component versions
kubectl get deployments -n flux-system \
  -l app.kubernetes.io/part-of=flux \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image'
```

## Section 2: ImageRepository Configuration

### 2.1 Public Registry

```yaml
# flux/image-repository-app.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: api-service
  namespace: flux-system
spec:
  image: ghcr.io/exampleorg/api-service
  interval: 1m    # Scan every minute
  timeout: 30s

  # Optional: scan only tags matching this regex
  # Without this, all tags are fetched and cached
  # Matching reduces memory usage in the reflector
  exclusionList:
    - "^.*-SNAPSHOT$"
    - "^latest$"
    - "^main$"
```

### 2.2 Private Registry with Credentials

```bash
# Create image pull secret for the registry
kubectl create secret docker-registry registry-credentials \
  --namespace flux-system \
  --docker-server=registry.example.com \
  --docker-username=flux-scanner \
  --docker-password=scanner-token-placeholder-not-real \
  --docker-email=flux@example.com
```

```yaml
# flux/image-repository-private.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: internal-service
  namespace: flux-system
spec:
  image: registry.example.com/platform/internal-service
  interval: 2m
  secretRef:
    name: registry-credentials

  # For cloud provider registries, use the provider field instead
  # provider: aws   # Uses IRSA/IAM for ECR authentication
  # provider: azure # Uses Managed Identity for ACR
  # provider: gcp   # Uses Workload Identity for Artifact Registry
```

### 2.3 ECR with IAM Authentication

```yaml
# flux/image-repository-ecr.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: ecr-service
  namespace: flux-system
spec:
  image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/my-service
  interval: 5m
  provider: aws    # Flux uses the node's IAM role or IRSA to authenticate
```

```yaml
# IAM policy for the Flux service account (attach to IRSA role)
# flux-ecr-policy.json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:DescribeImages",
        "ecr:DescribeRepositories",
        "ecr:ListImages"
      ],
      "Resource": "arn:aws:ecr:us-east-1:123456789012:repository/my-service"
    },
    {
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    }
  ]
}
```

### 2.4 Verifying ImageRepository Status

```bash
# Check scan results
flux get image repository -A

# NAME             LAST SCAN              TAGS  READY  MESSAGE
# api-service      2031-11-11T10:02:00Z   47    True   successful scan
# internal-service 2031-11-11T10:01:45Z   12    True   successful scan

# Get the full tag list
kubectl describe imagerepository api-service -n flux-system | \
  grep -A 100 "Last Scan Result"

# Or use kubectl get
kubectl get imagerepository api-service -n flux-system \
  -o jsonpath='{.status.lastScanResult.tagCount}'
```

## Section 3: ImagePolicy Configuration

### 3.1 SemVer Policy

```yaml
# flux/image-policy-semver.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: api-service
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: api-service

  policy:
    semver:
      range: ">=1.0.0 <2.0.0"   # Only 1.x.x releases
```

### 3.2 Alphabetical Policy (Latest Timestamp-Based Tags)

```yaml
# flux/image-policy-alphabetical.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: api-service-latest
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: api-service

  policy:
    alphabetical:
      order: asc   # Latest lexicographically = newest timestamp if using ISO8601

  # Filter tags before applying the policy
  filterTags:
    pattern: "^main-[a-f0-9]+-[0-9]{14}$"  # main-<sha>-<YYYYMMDDHHMMSS>
    extract: "$timestamp"    # Extract the timestamp portion for sorting
```

### 3.3 Numerical Policy

```yaml
# flux/image-policy-numerical.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: api-service-build-number
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: api-service

  policy:
    numerical:
      order: asc    # Highest number = latest build

  filterTags:
    pattern: "^build-([0-9]+)$"
    extract: "$buildnum"
```

### 3.4 Environment-Specific Policies

```yaml
# flux/image-policy-production.yaml
# Production: only stable semver releases, no pre-releases
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: api-service-prod
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: api-service
  policy:
    semver:
      range: ">=1.0.0"

  filterTags:
    pattern: "^v?[0-9]+\\.[0-9]+\\.[0-9]+$"  # No -alpha, -beta, -rc

---
# flux/image-policy-staging.yaml
# Staging: stable releases + release candidates
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: api-service-staging
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: api-service
  policy:
    semver:
      range: ">=1.0.0-0"  # Includes pre-releases

---
# flux/image-policy-development.yaml
# Development: any main branch build
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: api-service-dev
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: api-service
  filterTags:
    pattern: "^main-[a-f0-9]{7,40}$"
  policy:
    alphabetical:
      order: asc
```

### 3.5 Checking ImagePolicy Status

```bash
# View current policy-selected image
flux get image policy -A

# NAME               LATEST IMAGE                                          READY
# api-service-prod   ghcr.io/exampleorg/api-service:1.5.2                True
# api-service-staging ghcr.io/exampleorg/api-service:1.6.0-rc.1          True
# api-service-dev    ghcr.io/exampleorg/api-service:main-a1b2c3d          True

# Detailed status
kubectl describe imagepolicy api-service-prod -n flux-system
```

## Section 4: Annotating Resources for Update

### 4.1 Deployment Image Annotation

Flux image automation uses marker comments in YAML files to identify which fields to update:

```yaml
# apps/production/api-service/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-service
  template:
    metadata:
      labels:
        app: api-service
    spec:
      containers:
        - name: api-service
          # {"$imagepolicy": "flux-system:api-service-prod"}
          image: ghcr.io/exampleorg/api-service:1.5.1
          ports:
            - containerPort: 8080
          env:
            - name: VERSION
              # {"$imagepolicy": "flux-system:api-service-prod:tag"}
              value: "1.5.1"
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 512Mi
```

The `# {"$imagepolicy": "flux-system:api-service-prod"}` marker tells the automation controller to replace the `image:` value with the full image reference (including tag) from the named policy.

The `:tag` suffix extracts only the tag portion, useful for environment variables.

### 4.2 Kustomization Image Override Annotation

```yaml
# apps/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
metadata:
  name: api-service-production
namespace: production
resources:
  - deployment.yaml
  - service.yaml
  - hpa.yaml

images:
  - name: ghcr.io/exampleorg/api-service
    # {"$imagepolicy": "flux-system:api-service-prod:tag"}
    newTag: 1.5.1
```

## Section 5: ImageUpdateAutomation

### 5.1 Basic ImageUpdateAutomation

```yaml
# flux/image-update-automation.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: fleet-image-updates
  namespace: flux-system
spec:
  # Git repository reference (must be a Flux GitRepository object)
  sourceRef:
    kind: GitRepository
    name: fleet-infra

  # Git branch to push to
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: flux@example.com
        name: Flux Bot
      messageTemplate: |
        chore(images): automated image update

        Updated images:
        {{ range .Updated.Images -}}
        - {{ .Name }}: {{ .NewTag }}
        {{ end -}}

        Policies used:
        {{ range .Updated.Objects -}}
        - {{ .Namespace }}/{{ .Name }}: {{ .Kind }}
        {{ end }}
      signingKey:
        secretRef:
          name: flux-gpg-signing-key

    push:
      branch: main    # Push directly to main (use a feature branch for PR workflow)

  # How often to check for updates
  interval: 1m

  # Which paths in the repo to update
  update:
    strategy: Setters   # Uses YAML comment markers
    path: ./apps
```

### 5.2 PR-Based Update Workflow

For teams that want code review on automated updates rather than direct commits to main:

```yaml
# flux/image-update-automation-pr.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: fleet-image-updates-pr
  namespace: flux-system
spec:
  sourceRef:
    kind: GitRepository
    name: fleet-infra

  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: flux-bot@example.com
        name: Flux Image Bot
      messageTemplate: |
        chore(images): update {{ range .Updated.Images }}{{ .Name }}:{{ .NewTag }} {{ end }}
    push:
      branch: image-updates/{{.Branch}}-{{.Timestamp}}   # Dynamic branch name

  interval: 5m
  update:
    strategy: Setters
    path: ./apps/production
```

### 5.3 Multi-Environment Update Automation

```yaml
# flux/image-update-staging.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: staging-image-updates
  namespace: flux-system
spec:
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: flux@example.com
        name: Flux Bot
      messageTemplate: "chore(staging): update images to {{ range .Updated.Images }}{{ .NewTag }} {{ end }}"
    push:
      branch: main
  interval: 2m
  update:
    strategy: Setters
    path: ./apps/staging    # Only update staging manifests

---
# flux/image-update-production.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: production-image-updates
  namespace: flux-system
spec:
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: flux@example.com
        name: Flux Bot
      messageTemplate: "chore(prod): update images {{ range .Updated.Images }}{{ .Name }}:{{ .NewTag }} {{ end }}"
    push:
      branch: main
  interval: 5m  # Slower interval for production — less churn
  update:
    strategy: Setters
    path: ./apps/production
```

## Section 6: Helm Release Image Automation

### 6.1 HelmRelease with Image Policy Marker

Flux image automation can update `values` fields in `HelmRelease` objects as well as plain Kubernetes manifests:

```yaml
# apps/production/api-service/helmrelease.yaml
apiVersion: helm.toolkit.fluxcd.io/v2beta2
kind: HelmRelease
metadata:
  name: api-service
  namespace: production
spec:
  interval: 5m
  chart:
    spec:
      chart: api-service
      version: ">=0.1.0"
      sourceRef:
        kind: HelmRepository
        name: internal-charts
        namespace: flux-system

  values:
    image:
      repository: ghcr.io/exampleorg/api-service
      # {"$imagepolicy": "flux-system:api-service-prod:tag"}
      tag: "1.5.1"
      pullPolicy: IfNotPresent

    replicaCount: 3

    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: 1000m
        memory: 512Mi

    podAnnotations:
      # Force pod restart on image update
      # {"$imagepolicy": "flux-system:api-service-prod:digest"}
      imageDigest: "sha256:abc123placeholder"
```

### 6.2 HelmRelease with Multiple Container Images

```yaml
# apps/production/data-pipeline/helmrelease.yaml
apiVersion: helm.toolkit.fluxcd.io/v2beta2
kind: HelmRelease
metadata:
  name: data-pipeline
  namespace: production
spec:
  interval: 5m
  chart:
    spec:
      chart: data-pipeline
      version: ">=0.2.0"
      sourceRef:
        kind: HelmRepository
        name: internal-charts
        namespace: flux-system

  values:
    processor:
      image:
        repository: registry.example.com/platform/processor
        # {"$imagepolicy": "flux-system:processor-prod:tag"}
        tag: "2.3.0"

    enricher:
      image:
        repository: registry.example.com/platform/enricher
        # {"$imagepolicy": "flux-system:enricher-prod:tag"}
        tag: "1.8.5"

    sink:
      image:
        repository: ghcr.io/exampleorg/sink-connector
        # {"$imagepolicy": "flux-system:sink-connector-prod:tag"}
        tag: "0.9.2"
```

### 6.3 HelmRelease Upgrade Control

```yaml
# apps/production/api-service/helmrelease-controlled.yaml
apiVersion: helm.toolkit.fluxcd.io/v2beta2
kind: HelmRelease
metadata:
  name: api-service-controlled
  namespace: production
spec:
  interval: 5m

  # Control how upgrades happen
  upgrade:
    remediation:
      retries: 3
      strategy: rollback      # Auto-rollback on failed upgrade

  # Rollback configuration
  rollback:
    timeout: 10m
    cleanupOnFail: true

  # Test the release after upgrade
  test:
    enable: true
    ignoreFailures: false

  # Maximum time for a release operation
  timeout: 10m

  # Suspend automation temporarily (set to true during incidents)
  suspend: false

  chart:
    spec:
      chart: api-service
      version: ">=1.0.0 <2.0.0"   # Pin chart major version
      sourceRef:
        kind: HelmRepository
        name: internal-charts
        namespace: flux-system
      interval: 5m

  values:
    image:
      repository: ghcr.io/exampleorg/api-service
      # {"$imagepolicy": "flux-system:api-service-prod:tag"}
      tag: "1.5.1"
```

## Section 7: Git Repository Configuration

### 7.1 GitRepository with SSH Deploy Key

```bash
# Generate deploy key
ssh-keygen -t ed25519 -C "flux-image-automation" \
  -f /tmp/flux-deploy-key -N ""

# Add public key to GitHub/GitLab as a deploy key with write access
cat /tmp/flux-deploy-key.pub

# Create the Kubernetes secret
kubectl create secret generic flux-git-deploy-key \
  --namespace flux-system \
  --from-file=identity=/tmp/flux-deploy-key \
  --from-file=identity.pub=/tmp/flux-deploy-key.pub \
  --from-literal=known_hosts="github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"

# Clean up key files
rm /tmp/flux-deploy-key /tmp/flux-deploy-key.pub
```

```yaml
# flux/git-repository.yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: fleet-infra
  namespace: flux-system
spec:
  interval: 1m
  url: ssh://git@github.com/exampleorg/fleet-infra.git
  ref:
    branch: main
  secretRef:
    name: flux-git-deploy-key
```

### 7.2 Commit Signing

```bash
# Generate GPG key for commit signing
gpg --batch --gen-key << 'EOF'
Key-Type: RSA
Key-Length: 4096
Subkey-Type: RSA
Subkey-Length: 4096
Name-Real: Flux Bot
Name-Email: flux@example.com
Expire-Date: 1y
%no-protection
EOF

# Export private key
GPG_KEY_ID=$(gpg --list-secret-keys --with-colons flux@example.com | \
  awk -F: '/^sec/{print $5}' | head -1)
gpg --armor --export-secret-key "$GPG_KEY_ID" > /tmp/flux-signing-key.asc

# Create Kubernetes secret
kubectl create secret generic flux-gpg-signing-key \
  --namespace flux-system \
  --from-file=git.asc=/tmp/flux-signing-key.asc

rm /tmp/flux-signing-key.asc

# Add public key to GitHub for signature verification
gpg --armor --export "$GPG_KEY_ID"
```

## Section 8: Monitoring and Alerting

### 8.1 Flux Image Automation Metrics

```yaml
# prometheusrule-flux-image-automation.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: flux-image-automation-alerts
  namespace: monitoring
spec:
  groups:
    - name: flux.image.automation
      rules:
        - alert: FluxImageRepositoryScanFailing
          expr: |
            gotk_image_repository_ready == 0
          for: 10m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Image repository {{ $labels.name }} scan is failing"
            description: "Flux ImageRepository {{ $labels.name }} in namespace {{ $labels.namespace }} has not had a successful scan in 10 minutes."

        - alert: FluxImageUpdateAutomationFailing
          expr: |
            gotk_image_update_automation_ready == 0
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Image update automation {{ $labels.name }} is failing"

        - alert: FluxImagePolicyStale
          expr: |
            (time() - gotk_image_policy_info) > 3600
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Image policy {{ $labels.name }} has not been evaluated in 1 hour"
```

### 8.2 Image Update Audit Log

```bash
# View recent image update commits
git -C /path/to/fleet-infra log \
  --oneline \
  --author="Flux Bot" \
  --since="7 days ago"

# Watch Flux events for image automation activity
kubectl get events -n flux-system \
  --field-selector reason=UpdateSucceeded \
  --watch

# Flux CLI status
flux get image all -A --watch
```

## Section 9: Emergency Procedures

### 9.1 Suspending Image Automation

```bash
# Suspend all image update automation immediately
flux suspend image update --all -n flux-system

# Suspend a specific automation
flux suspend image update fleet-image-updates -n flux-system

# Suspend image scanning for a repository
flux suspend image repository api-service -n flux-system

# Resume
flux resume image update fleet-image-updates -n flux-system
```

### 9.2 Rolling Back an Automated Update

```bash
# View recent flux-bot commits
git log --oneline --author="Flux Bot" -10

# Revert a specific commit
git revert <commit-sha>
git push origin main

# Force Flux to reconcile immediately
flux reconcile source git fleet-infra

# Verify rollback
flux get helmreleases -n production
kubectl get deployment api-service -n production \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
```

### 9.3 Pinning to a Specific Version

```yaml
# To temporarily pin to a specific version, update the image tag
# and comment out the image policy marker:

# In deployment.yaml:
image: ghcr.io/exampleorg/api-service:1.4.9   # Pinned during incident
# The imagepolicy marker is removed; automation will not update this line
```

## Summary

Flux v2 image automation provides complete GitOps-driven continuous delivery with container image version management:

1. **ImageRepository** provides the tag scanning layer. Set appropriate `interval` values based on release frequency — 1–5 minutes for active development branches, 10–30 minutes for release channels.

2. **ImagePolicy** selection strategies should match your release tagging convention: `semver` for versioned releases, `alphabetical` for timestamp-suffixed tags, `numerical` for build-number tags. Combine with `filterTags.pattern` to limit candidate tags.

3. **ImageUpdateAutomation** closes the loop by committing the policy-selected tag back to Git. The commit message template is the audit trail; make it informative. GPG signing ensures authenticity of automated commits.

4. **HelmRelease integration** allows automated image updates to flow through Helm's upgrade pipeline with rollback, testing, and remediation. Use `# {"$imagepolicy": ...}` markers in the `values:` stanza.

5. **Emergency controls** — `flux suspend image update` — must be rehearsed before they are needed. Combine with Prometheus alerts on automation failures so issues are caught before they cause production drift.

6. **Multi-environment pipelines** use separate `ImagePolicy` objects per environment (production, staging, development) with different policy expressions and separate `ImageUpdateAutomation` objects targeting different directory paths in the Git repository.
