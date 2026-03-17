---
title: "Kubernetes Flux CD v2: Source Controller, Kustomize Controller, and Helm Controller"
date: 2031-03-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Flux", "GitOps", "CD", "Kustomize", "Helm", "ArgoCD"]
categories:
- Kubernetes
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Flux CD v2: source types, Kustomization reconciliation, HelmRelease lifecycle, image automation, multi-tenancy with RBAC, and Flux bootstrap vs install."
more_link: "yes"
url: "/kubernetes-flux-cd-v2-source-kustomize-helm-controllers/"
---

Flux CD v2 is a GitOps toolkit for Kubernetes consisting of a set of composable controllers, each responsible for a specific aspect of the continuous delivery pipeline. Unlike monolithic CD tools, Flux's controller-per-concern design means each component is independently upgradeable, configurable, and observable. This guide covers every Flux controller in production depth, from source management through Helm release lifecycle to image automation.

<!--more-->

# Kubernetes Flux CD v2: Source Controller, Kustomize Controller, and Helm Controller

## Section 1: Flux Architecture Overview

### Controller Responsibilities

Flux v2 consists of these core controllers:

**Source Controller** (`source-controller`):
- Watches `GitRepository`, `HelmRepository`, `OCIRepository`, `Bucket`, `HelmChart` objects.
- Fetches and stores source artifacts (Git commits, Helm charts, OCI images) in local storage.
- Exposes artifact download URLs to other controllers.
- Handles authentication to private sources.

**Kustomize Controller** (`kustomize-controller`):
- Watches `Kustomization` objects.
- Downloads artifacts from Source Controller.
- Renders Kustomize overlays and plain YAML.
- Applies rendered manifests to the cluster via server-side apply.
- Handles health checks and dependency ordering.

**Helm Controller** (`helm-controller`):
- Watches `HelmRelease` objects.
- Downloads charts from Source Controller.
- Manages Helm release lifecycle: install, upgrade, test, rollback, uninstall.
- Handles reconciliation of drift from desired state.

**Notification Controller** (`notification-controller`):
- Watches `Provider` and `Alert` objects.
- Sends notifications to Slack, Teams, PagerDuty, GitHub commit status, etc.
- Receives external events (GitHub webhooks) to trigger immediate reconciliation.

**Image Automation Controller** (`image-automation-controller`):
- Watches `ImageRepository` and `ImagePolicy` objects.
- Scans container registries for new image tags.
- Updates image references in Git automatically based on policy.

**Image Reflector Controller** (`image-reflector-controller`):
- Reflects image metadata from registries into the cluster.
- Works with Image Automation Controller for automated updates.

### Reconciliation Model

Every Flux object has:
- `spec.interval`: How often to reconcile (re-fetch source, re-apply manifests).
- `spec.timeout`: Maximum time for a reconciliation attempt.
- `status.conditions`: Current condition (Ready, Stalled, Reconciling).
- `status.lastAppliedRevision`: The last successfully applied revision.

```
GitRepository (polls git every 1m)
    │  artifact: sha=abc123
    ▼
Kustomization (reconciles every 5m)
    │  renders and applies manifests from sha=abc123
    ▼
Deployed Kubernetes Resources
    │  health check: all pods ready?
    ▼
Ready condition: True / False
    │  notify
    ▼
Notification Controller → Slack/PagerDuty
```

## Section 2: Flux Bootstrap vs Flux Install

### Bootstrap (Recommended for Production)

`flux bootstrap` installs Flux AND commits its own manifests to a Git repository. This means Flux manages itself via GitOps — if you want to upgrade Flux, you update the version in Git.

```bash
# Bootstrap with GitHub
flux bootstrap github \
  --owner=myorg \
  --repository=fleet-infra \
  --branch=main \
  --path=clusters/production \
  --personal=false \
  --private=true

# Bootstrap with GitLab
flux bootstrap gitlab \
  --owner=myorg \
  --repository=fleet-infra \
  --branch=main \
  --path=clusters/production \
  --token-auth

# Bootstrap with generic Git server (Gitea, Bitbucket, etc.)
flux bootstrap git \
  --url=https://git.example.com/myorg/fleet-infra \
  --branch=main \
  --path=clusters/production \
  --username=flux \
  --password=<token>
```

What bootstrap does:
1. Installs Flux controllers as Kubernetes deployments.
2. Creates a `GitRepository` pointing to the specified repository/branch.
3. Creates a `Kustomization` that reconciles the `clusters/production` path.
4. Creates a deploy key (SSH) or personal access token for Git access.
5. Commits all the above as YAML files to the Git repository.

After bootstrap, the repository structure:

```
fleet-infra/
└── clusters/
    └── production/
        └── flux-system/
            ├── gotk-components.yaml      ← Flux controllers
            ├── gotk-sync.yaml            ← GitRepository + Kustomization
            └── kustomization.yaml        ← Kustomize root
```

### Flux Install (For Airgapped or Custom Deployments)

For environments where you can't run `flux bootstrap` directly:

```bash
# Generate Flux manifests without applying them
flux install \
  --components=source-controller,kustomize-controller,helm-controller,notification-controller \
  --export > flux-system.yaml

# Apply manually
kubectl apply -f flux-system.yaml

# Verify
flux check
```

### Multi-Cluster Bootstrap

For managing multiple clusters from a single repository:

```bash
# Bootstrap cluster-a
KUBECONFIG=/path/to/cluster-a.kubeconfig \
flux bootstrap github \
  --owner=myorg \
  --repository=fleet-infra \
  --path=clusters/cluster-a

# Bootstrap cluster-b
KUBECONFIG=/path/to/cluster-b.kubeconfig \
flux bootstrap github \
  --owner=myorg \
  --repository=fleet-infra \
  --path=clusters/cluster-b
```

Repository structure for multi-cluster:

```
fleet-infra/
├── clusters/
│   ├── cluster-a/
│   │   └── flux-system/
│   └── cluster-b/
│       └── flux-system/
├── infrastructure/
│   ├── base/
│   │   ├── nginx-ingress/
│   │   └── cert-manager/
│   └── overlays/
│       ├── cluster-a/
│       └── cluster-b/
└── apps/
    ├── base/
    │   ├── podinfo/
    │   └── my-app/
    └── overlays/
        ├── staging/
        └── production/
```

## Section 3: Source Types in Detail

### GitRepository

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: flux-system
  namespace: flux-system
spec:
  interval: 1m0s
  url: https://github.com/myorg/fleet-infra
  ref:
    branch: main
    # OR:
    # tag: v1.2.3
    # semver: ">=1.0.0 <2.0.0"  (semantic version range)
    # commit: abc1234              (specific commit)
    # name: refs/heads/feature/x  (full ref)

  # Authentication
  secretRef:
    name: flux-system  # Secret with SSH key or username/password

  # Include/exclude paths (reduce artifact size)
  include:
  - fromPath: "clusters/production"
    toPath: "."
  ignore: |
    # Ignore CI files
    .github/
    .gitlab-ci.yml
    docs/

  # Verification (GPG or cosign)
  verify:
    provider: cosign
    secretRef:
      name: cosign-public-key

  # Proxy settings
  timeout: 60s
```

### HelmRepository

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: nginx-stable
  namespace: flux-system
spec:
  interval: 12h0m0s
  url: https://helm.nginx.com/stable
  # For OCI-based Helm registries (Helm 3.8+):
  # type: oci
  # url: oci://registry-1.docker.io/bitnamicharts

  # Authentication for private repos
  secretRef:
    name: helm-repo-auth

  # Cache settings
  timeout: 60s
  suspend: false
```

### OCIRepository

For OCI artifacts (manifests bundled as OCI images):

```yaml
apiVersion: source.toolkit.fluxcd.io/v1beta2
kind: OCIRepository
metadata:
  name: podinfo
  namespace: flux-system
spec:
  interval: 5m0s
  url: oci://ghcr.io/stefanprodan/manifests/podinfo
  ref:
    tag: latest
    # OR semver: ">=6.0.0"
    # OR digest: sha256:<hash>

  provider: generic   # or aws, azure, gcp for cloud registry auth
  secretRef:
    name: ghcr-auth

  verify:
    provider: cosign
    secretRef:
      name: cosign-key
```

### Bucket (S3-Compatible)

```yaml
apiVersion: source.toolkit.fluxcd.io/v1beta2
kind: Bucket
metadata:
  name: manifests-bucket
  namespace: flux-system
spec:
  interval: 5m0s
  provider: aws   # or generic, gcp, azure
  bucketName: my-flux-manifests
  endpoint: s3.amazonaws.com
  region: us-east-1
  secretRef:
    name: aws-credentials
  ignore: |
    *.tmp
    .DS_Store
```

## Section 4: Kustomization Controller

### Basic Kustomization

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: apps
  namespace: flux-system
spec:
  interval: 10m0s
  path: ./apps/overlays/production
  prune: true            # Delete resources removed from Git
  sourceRef:
    kind: GitRepository
    name: flux-system
  timeout: 5m0s

  # Wait for all deployed resources to become ready
  wait: true

  # Server-side apply (recommended for large manifests)
  force: false

  # Target cluster (for multi-cluster with Cluster API)
  kubeConfig:
    secretRef:
      name: cluster-a-kubeconfig
```

### Kustomization with Variable Substitution

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: apps-production
  namespace: flux-system
spec:
  interval: 10m0s
  path: ./apps/base
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system

  # Substitute variables in manifests
  postBuild:
    substitute:
      cluster_name: "production-us-east"
      region: "us-east-1"
      environment: "production"
    substituteFrom:
    - kind: ConfigMap
      name: cluster-vars          # Variables from ConfigMap
    - kind: Secret
      name: cluster-secrets       # Sensitive variables from Secret
      optional: true              # Don't fail if secret doesn't exist
```

In manifests, use `${variable_name}` syntax:

```yaml
# apps/base/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: production
  labels:
    cluster: ${cluster_name}
    region: ${region}
spec:
  template:
    spec:
      containers:
      - name: myapp
        env:
        - name: CLUSTER_NAME
          value: ${cluster_name}
        - name: ENVIRONMENT
          value: ${environment}
```

### Kustomization Dependency Ordering

Use `dependsOn` to sequence reconciliation — critical for ensuring infrastructure is ready before applications:

```yaml
# 1. Infrastructure Kustomization
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: infrastructure
  namespace: flux-system
spec:
  interval: 10m0s
  path: ./infrastructure
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
  wait: true
  timeout: 10m0s

---
# 2. Applications depend on infrastructure being ready
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: apps
  namespace: flux-system
spec:
  interval: 10m0s
  path: ./apps
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
  # Only reconcile after infrastructure is Ready
  dependsOn:
  - name: infrastructure

---
# 3. Database migrations depend on apps
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: database-migrations
  namespace: flux-system
spec:
  interval: 10m0s
  path: ./migrations
  prune: false            # Don't delete completed Jobs
  sourceRef:
    kind: GitRepository
    name: flux-system
  dependsOn:
  - name: infrastructure
  - name: apps
```

### Health Checks

Flux Kustomization can wait for specific resources to become healthy before declaring success:

```yaml
spec:
  healthChecks:
  - apiVersion: apps/v1
    kind: Deployment
    name: nginx
    namespace: production
  - apiVersion: apps/v1
    kind: StatefulSet
    name: postgresql
    namespace: production
  - apiVersion: helm.toolkit.fluxcd.io/v2
    kind: HelmRelease
    name: ingress-nginx
    namespace: ingress-nginx
```

### Drift Detection and Correction

By default, Flux Kustomizations use server-side apply, which means if someone manually changes a resource (kubectl edit), Flux will overwrite it on the next reconciliation. This is correct GitOps behavior.

To exclude specific fields from reconciliation (prevent Flux from overriding them):

```yaml
# kustomization.yaml in the app directory
patches:
- target:
    kind: Deployment
    name: myapp
  patch: |-
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: myapp
      annotations:
        # Exclude replica count from reconciliation (managed by HPA)
        kustomize.toolkit.fluxcd.io/ssa-ignore: "spec.replicas"
```

## Section 5: Helm Controller

### HelmRelease Lifecycle

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: ingress-nginx
  namespace: ingress-nginx
spec:
  interval: 30m

  # Reference to the chart
  chart:
    spec:
      chart: ingress-nginx
      version: ">=4.0.0 <5.0.0"   # SemVer range
      sourceRef:
        kind: HelmRepository
        name: ingress-nginx
        namespace: flux-system
      interval: 12h                 # How often to check for chart updates

  # Helm values
  values:
    controller:
      replicaCount: 2
      service:
        type: LoadBalancer
      metrics:
        enabled: true
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 1000m
          memory: 1Gi

  # Values from ConfigMaps and Secrets (merged with inline values)
  valuesFrom:
  - kind: ConfigMap
    name: ingress-nginx-values
    valuesKey: values.yaml       # Key in ConfigMap
    optional: false
  - kind: Secret
    name: ingress-nginx-secrets
    optional: true

  # Install configuration
  install:
    remediation:
      retries: 3               # Retry failed installs 3 times
    createNamespace: true

  # Upgrade configuration
  upgrade:
    remediation:
      retries: 3
      strategy: rollback        # Rollback on upgrade failure
    cleanupOnFail: true         # Delete new resources on failure
    force: false

  # Rollback configuration
  rollback:
    timeout: 5m0s
    cleanupOnFail: true

  # Uninstall configuration
  uninstall:
    keepHistory: false

  # Test configuration (run helm test after install/upgrade)
  test:
    enable: true
    ignoreFailures: false

  # Drift correction
  driftDetection:
    mode: enabled               # or 'warn' to detect but not correct
    ignore:
    - target:
        kind: ConfigMap
        name: ingress-nginx-leader
      paths:
      - /data

  # Dependencies
  dependsOn:
  - name: cert-manager
    namespace: cert-manager
```

### HelmRelease with OCI Chart

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: podinfo
  namespace: default
spec:
  interval: 5m
  chart:
    spec:
      chart: podinfo
      version: ">=6.0.0"
      sourceRef:
        kind: HelmRepository
        name: podinfo-oci
        namespace: flux-system
      # For OCI charts, sourceRef points to an OCI HelmRepository
```

The OCI HelmRepository:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: podinfo-oci
  namespace: flux-system
spec:
  type: oci
  url: oci://ghcr.io/stefanprodan/charts
  interval: 5m
```

### Monitoring HelmRelease Status

```bash
# Get all HelmReleases
flux get helmreleases --all-namespaces

# Watch a specific HelmRelease
flux get helmrelease ingress-nginx -n ingress-nginx --watch

# Get detailed status
kubectl describe helmrelease ingress-nginx -n ingress-nginx

# Force reconciliation
flux reconcile helmrelease ingress-nginx -n ingress-nginx

# Suspend a HelmRelease (stop Flux from managing it)
flux suspend helmrelease ingress-nginx -n ingress-nginx

# Resume
flux resume helmrelease ingress-nginx -n ingress-nginx
```

## Section 6: Image Automation Controller

### Automated Image Updates

The image automation workflow:
1. `ImageRepository`: Scans a registry for available tags.
2. `ImagePolicy`: Selects the "latest" tag matching a policy.
3. `ImageUpdateAutomation`: Commits image updates back to Git.

```yaml
# Step 1: ImageRepository — scan for new tags
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: myapp
  namespace: flux-system
spec:
  image: registry.example.com/myorg/myapp
  interval: 5m0s
  secretRef:
    name: registry-credentials

---
# Step 2: ImagePolicy — define tag selection policy
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: myapp
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: myapp
  policy:
    # Semantic versioning: always use the latest stable version
    semver:
      range: ">=1.0.0"
    # OR alphabetical ordering
    # alphabetical:
    #   order: asc
    # OR numerical ordering
    # numerical:
    #   order: asc
  # Optional: filter tags before applying policy
  filterTags:
    pattern: '^main-[a-f0-9]+-(?P<ts>[0-9]+)'  # Match branch-sha-timestamp
    extract: '$ts'   # Sort by the extracted timestamp group

---
# Step 3: ImageUpdateAutomation — commit updates to Git
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: flux-system
  namespace: flux-system
spec:
  interval: 30m0s
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
        name: Flux
      messageTemplate: |
        Automated image update by Flux

        Automation name: {{ .AutomationObject }}

        Files:
        {{ range $filename, $_ := .Updated.Files -}}
        - {{ $filename }}
        {{ end -}}

        Objects:
        {{ range $resource, $_ := .Updated.Objects -}}
        - {{ $resource.Kind }} {{ $resource.Name }}
        {{ end -}}

        Images:
        {{ range .Updated.Images -}}
        - {{.}}
        {{ end -}}
    push:
      branch: main
  update:
    path: ./apps
    strategy: Setters
```

### Marking Image References for Update

In deployment manifests, mark which images should be updated:

```yaml
# apps/production/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
spec:
  template:
    spec:
      containers:
      - name: myapp
        image: registry.example.com/myorg/myapp:main-abc123-1234567890 # {"$imagepolicy": "flux-system:myapp"}
```

The comment `# {"$imagepolicy": "flux-system:myapp"}` tells the image automation controller to update this image tag to the latest tag selected by the `myapp` ImagePolicy in the `flux-system` namespace.

## Section 7: Multi-Tenancy with RBAC

### Tenant Isolation Architecture

For multi-tenant clusters, Flux supports per-tenant service accounts with limited permissions:

```yaml
# Create a tenant namespace and service account
apiVersion: v1
kind: Namespace
metadata:
  name: team-alpha
  labels:
    toolkit.fluxcd.io/tenant: team-alpha
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: team-alpha
  namespace: team-alpha
---
# Grant team-alpha service account limited permissions
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-alpha-reconciler
  namespace: team-alpha
subjects:
- kind: ServiceAccount
  name: team-alpha
  namespace: team-alpha
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin   # Or a more restricted role
---
# Kustomization that runs as the tenant service account
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: team-alpha-apps
  namespace: flux-system
spec:
  interval: 5m0s
  path: ./tenants/team-alpha
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
  # Run with tenant service account (not flux-system SA)
  serviceAccountName: team-alpha
  targetNamespace: team-alpha   # Scope all resources to this namespace
```

### Tenant Onboarding Template

A standard template for onboarding a new tenant:

```yaml
# tenants/team-alpha/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: team-alpha
resources:
- namespace.yaml
- rbac.yaml
- source.yaml        # GitRepository for team's own repo
- apps.yaml          # Kustomization for team's apps

---
# tenants/team-alpha/source.yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: team-alpha
  namespace: team-alpha
spec:
  interval: 1m0s
  url: https://github.com/myorg/team-alpha-apps
  ref:
    branch: main
  secretRef:
    name: team-alpha-git-credentials

---
# tenants/team-alpha/apps.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: team-alpha-apps
  namespace: team-alpha
spec:
  interval: 5m0s
  path: ./
  prune: true
  sourceRef:
    kind: GitRepository
    name: team-alpha
  targetNamespace: team-alpha
```

## Section 8: Notifications and Alerts

### Slack Notifications

```yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: slack
  namespace: flux-system
spec:
  type: slack
  channel: "#flux-alerts"
  secretRef:
    name: slack-url   # Secret with address key containing Slack webhook URL

---
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: on-call-alert
  namespace: flux-system
spec:
  providerRef:
    name: slack
  eventSeverity: info   # or error
  eventSources:
  - kind: GitRepository
    name: "*"           # All GitRepositories
  - kind: Kustomization
    name: "*"           # All Kustomizations
  - kind: HelmRelease
    name: "*"           # All HelmReleases
  exclusionList:
  - ".*no new images.*"  # Filter out noisy messages
```

### GitHub Commit Status

```yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: github-status
  namespace: flux-system
spec:
  type: github
  address: https://github.com/myorg/fleet-infra
  secretRef:
    name: github-token   # Secret with token key

---
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: github-commit-status
  namespace: flux-system
spec:
  providerRef:
    name: github-status
  eventSeverity: info
  eventSources:
  - kind: Kustomization
    name: apps
```

### Webhook Receiver (Incoming)

To trigger immediate reconciliation from GitHub/GitLab webhooks:

```yaml
apiVersion: notification.toolkit.fluxcd.io/v1
kind: Receiver
metadata:
  name: github-receiver
  namespace: flux-system
spec:
  type: github
  events:
  - "ping"
  - "push"
  secretRef:
    name: webhook-token   # Token for HMAC verification
  resources:
  - apiVersion: source.toolkit.fluxcd.io/v1
    kind: GitRepository
    name: flux-system
    namespace: flux-system
```

The receiver creates a webhook endpoint. Expose it via Ingress:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: flux-receiver
  namespace: flux-system
spec:
  rules:
  - host: flux.example.com
    http:
      paths:
      - path: /hook/
        pathType: Prefix
        backend:
          service:
            name: webhook-receiver
            port:
              number: 80
```

Configure the webhook URL in GitHub: `https://flux.example.com/hook/<token-hash>`

## Section 9: Operational Commands

### Essential CLI Commands

```bash
# Install Flux CLI
curl -s https://fluxcd.io/install.sh | bash

# Check cluster readiness
flux check --pre

# After bootstrap, check all components
flux check

# Get all Flux resources
flux get all --all-namespaces

# Get reconciliation status
flux get sources all --all-namespaces
flux get kustomizations --all-namespaces
flux get helmreleases --all-namespaces

# Force immediate reconciliation of everything
flux reconcile source git flux-system
flux reconcile kustomization flux-system

# View logs from Flux controllers
flux logs --follow --tail 100
flux logs --kind=HelmRelease --name=ingress-nginx -n ingress-nginx

# Export all Flux resources as YAML
flux export source git --all
flux export kustomization --all
flux export helmrelease --all

# Suspend/resume all Kustomizations (for maintenance)
flux suspend kustomization --all
flux resume kustomization --all

# Tree view of reconciliation dependencies
flux tree kustomization flux-system

# Diff what would change on next reconciliation
flux diff kustomization apps
```

### Debugging Failed Reconciliations

```bash
# Check a specific Kustomization
kubectl describe kustomization apps -n flux-system

# Key fields to examine:
# Status.Conditions:
#   Ready: False
#   Reason: ArtifactFailed
#   Message: kustomize build failed: ...

# Check source controller logs
kubectl -n flux-system logs deploy/source-controller | tail -50

# Check kustomize-controller logs
kubectl -n flux-system logs deploy/kustomize-controller | tail -50

# Check helm-controller logs
kubectl -n flux-system logs deploy/helm-controller | tail -50

# For HelmRelease failures
kubectl describe helmrelease <name> -n <namespace>
# Look at:
# Status.History: Previous releases
# Status.Failures: Current failure count
# Status.Conditions[*].Message: Detailed error

# Debug Helm release manually
helm list -n <namespace>
helm history <release-name> -n <namespace>
helm status <release-name> -n <namespace>
```

## Section 10: Flux Best Practices

### Repository Structure Recommendations

```
fleet-infra/
├── clusters/
│   ├── production/
│   │   ├── flux-system/          ← Flux self-management
│   │   ├── infrastructure.yaml   ← Points to infrastructure/production
│   │   └── apps.yaml             ← Points to apps/production
│   └── staging/
│       ├── flux-system/
│       ├── infrastructure.yaml
│       └── apps.yaml
├── infrastructure/
│   ├── base/
│   │   ├── cert-manager/
│   │   │   ├── namespace.yaml
│   │   │   ├── helmrelease.yaml
│   │   │   └── kustomization.yaml
│   │   ├── ingress-nginx/
│   │   └── monitoring/
│   ├── staging/
│   │   └── kustomization.yaml    ← Override values for staging
│   └── production/
│       └── kustomization.yaml    ← Override values for production
└── apps/
    ├── base/
    │   └── my-app/
    │       ├── deployment.yaml
    │       ├── service.yaml
    │       └── kustomization.yaml
    ├── staging/
    │   └── my-app/
    │       └── kustomization.yaml  ← Patch: replicas=1, image=:staging
    └── production/
        └── my-app/
            └── kustomization.yaml  ← Patch: replicas=5, image=:v1.2.3
```

### Key Operational Principles

1. **Never `kubectl apply` directly in a Flux-managed cluster** — Flux will overwrite manual changes on next reconciliation.

2. **Use `flux suspend` for emergency manual interventions** — This safely stops reconciliation without breaking the Git state.

3. **Always set `prune: true` for application Kustomizations** — Resources removed from Git should be removed from the cluster.

4. **Set appropriate intervals** — Git polling every 1 minute is reasonable for development; 5-10 minutes for production reduces API server load.

5. **Use `dependsOn` for infrastructure dependencies** — CRDs must be applied before resources that use them.

6. **Encrypt secrets in Git** — Never commit plaintext secrets. Use Sealed Secrets, SOPS, or External Secrets Operator.

7. **Pin chart versions in HelmReleases** — Avoid `*` or `latest` for production. Use semantic version ranges (`>=4.0.0 <5.0.0`).

## Summary

Flux CD v2's modular controller architecture provides:

- **Source Controller**: Reliable artifact fetching from Git, Helm, and OCI registries with authentication and verification.
- **Kustomize Controller**: Declarative cluster state management with dependency ordering, variable substitution, and drift correction.
- **Helm Controller**: Full Helm release lifecycle management with automated rollback and drift detection.
- **Image Automation**: Automated image tag updates committed back to Git.
- **Multi-tenancy**: Per-tenant service accounts and namespace scoping for isolation.

The result is a genuine GitOps platform where every cluster state change is traceable to a Git commit, every failure is visible in reconciliation conditions, and self-healing from manual drift is automatic.
