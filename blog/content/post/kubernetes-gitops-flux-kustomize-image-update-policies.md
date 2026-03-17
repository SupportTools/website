---
title: "Kubernetes GitOps with Flux: Kustomize Controllers and Image Update Policies"
date: 2029-03-13T00:00:00-05:00
draft: false
tags: ["Flux", "GitOps", "Kubernetes", "Kustomize", "CD", "Automation"]
categories:
- Kubernetes
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Flux v2 GitOps covering Kustomize controllers, image update automation policies, multi-tenancy patterns, and progressive delivery integration for enterprise Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-gitops-flux-kustomize-image-update-policies/"
---

Flux v2 implements the GitOps operating model for Kubernetes through a collection of purpose-built controllers: the Source controller manages Git repositories and Helm chart repositories; the Kustomize controller applies Kustomize overlays and raw manifests; the Helm controller manages Helm releases; and the Image Automation controller closes the loop between container registry pushes and Git repository updates. Together they form a declarative delivery pipeline where every cluster state change flows through a version-controlled source of truth.

This guide focuses on the operational patterns that matter most in enterprise environments: structuring Kustomize overlays for multi-environment management, configuring image update policies with semantic version filtering, implementing multi-tenancy isolation, and integrating progressive delivery with Flagger.

<!--more-->

## Flux Architecture Overview

The Flux controller suite runs as deployments in the `flux-system` namespace:

```
flux-system/
├── source-controller       — Fetches artifacts from Git, Helm repos, OCI registries
├── kustomize-controller    — Applies Kustomize configurations to the cluster
├── helm-controller         — Manages Helm releases via HelmRelease CRDs
├── notification-controller — Routes alerts to Slack, PagerDuty, GitHub commit status
└── image-automation-controller — Updates image tags in Git based on registry policies
    + image-reflector-controller  — Scans registry for available image tags
```

Each controller watches its own CRD group:

```
source.toolkit.fluxcd.io    — GitRepository, HelmRepository, HelmChart, Bucket, OCIRepository
kustomize.toolkit.fluxcd.io — Kustomization
helm.toolkit.fluxcd.io      — HelmRelease
image.toolkit.fluxcd.io     — ImageRepository, ImagePolicy, ImageUpdateAutomation
notification.toolkit.fluxcd.io — Provider, Alert, Receiver
```

## Bootstrap and Repository Structure

### Bootstrapping with the Flux CLI

```bash
# Install the Flux CLI
curl -s https://fluxcd.io/install.sh | sudo bash

# Verify prerequisites
flux check --pre

# Bootstrap Flux onto the cluster using GitHub
flux bootstrap github \
  --owner=my-org \
  --repository=fleet-infra \
  --branch=main \
  --path=clusters/production \
  --personal=false \
  --token-auth=false \
  --ssh-key-algorithm=ecdsa

# Verify the bootstrap completed
flux check
kubectl get pods -n flux-system
```

### Repository Layout for Multi-Cluster Management

```
fleet-infra/
├── clusters/
│   ├── production/
│   │   ├── flux-system/          # Flux controllers (managed by bootstrap)
│   │   │   ├── gotk-components.yaml
│   │   │   └── gotk-sync.yaml
│   │   ├── infrastructure.yaml   # Points to infrastructure/ path
│   │   └── apps.yaml             # Points to apps/ path
│   ├── staging/
│   │   ├── flux-system/
│   │   ├── infrastructure.yaml
│   │   └── apps.yaml
│   └── dev/
│       ├── flux-system/
│       ├── infrastructure.yaml
│       └── apps.yaml
├── infrastructure/
│   ├── base/
│   │   ├── cert-manager/
│   │   ├── ingress-nginx/
│   │   └── monitoring/
│   ├── production/
│   │   ├── kustomization.yaml    # Overlays for production
│   │   └── cert-manager-values.yaml
│   └── staging/
│       └── kustomization.yaml
└── apps/
    ├── base/
    │   ├── payment-api/
    │   ├── order-service/
    │   └── notification-service/
    ├── production/
    │   └── kustomization.yaml
    └── staging/
        └── kustomization.yaml
```

## GitRepository and Kustomization Resources

### GitRepository Source

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: fleet-infra
  namespace: flux-system
spec:
  interval: 1m
  url: ssh://git@github.com/my-org/fleet-infra.git
  ref:
    branch: main
  secretRef:
    name: flux-system  # Contains the deploy key
  ignore: |
    # Ignore documentation and test files — reduces reconciliation noise
    /docs/
    /tests/
    *.md
    .github/
```

### Kustomization for Infrastructure Layer

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: infrastructure
  namespace: flux-system
spec:
  interval: 10m
  retryInterval: 2m
  timeout: 10m
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  path: ./infrastructure/production
  prune: true          # Remove resources deleted from Git
  wait: true           # Wait for all resources to be ready
  healthChecks:
  - apiVersion: apps/v1
    kind: Deployment
    name: ingress-nginx-controller
    namespace: ingress-nginx
  - apiVersion: apps/v1
    kind: Deployment
    name: cert-manager
    namespace: cert-manager
  postBuild:
    substituteFrom:
    - kind: ConfigMap
      name: cluster-vars
    - kind: Secret
      name: cluster-secrets
```

### Kustomization for Application Layer with Dependency

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: apps-production
  namespace: flux-system
spec:
  interval: 5m
  retryInterval: 1m
  timeout: 5m
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  path: ./apps/production
  prune: true
  wait: true
  # Apps depend on infrastructure being healthy first
  dependsOn:
  - name: infrastructure
  # Substitute cluster-level variables into manifests
  postBuild:
    substitute:
      ENVIRONMENT: "production"
      CLUSTER_NAME: "eks-prod-us-east-1"
      REGION: "us-east-1"
    substituteFrom:
    - kind: Secret
      name: app-secrets
      optional: true
```

## Kustomize Overlay Structure

### Base Application Definition

```yaml
# apps/base/payment-api/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
- deployment.yaml
- service.yaml
- serviceaccount.yaml
- hpa.yaml
```

```yaml
# apps/base/payment-api/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: payments
spec:
  replicas: 2
  selector:
    matchLabels:
      app: payment-api
  template:
    metadata:
      labels:
        app: payment-api
    spec:
      serviceAccountName: payment-api
      containers:
      - name: api
        image: registry.example.com/payment-api:v1.0.0  # Flux updates this line
        ports:
        - containerPort: 8080
        resources:
          requests:
            cpu: "200m"
            memory: "256Mi"
          limits:
            cpu: "1000m"
            memory: "512Mi"
        readinessProbe:
          httpGet:
            path: /healthz/ready
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /healthz/live
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 10
```

### Production Overlay

```yaml
# apps/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
- ../../base/payment-api
- ../../base/order-service
- ../../base/notification-service

patches:
# Scale up for production
- target:
    kind: Deployment
    name: payment-api
  patch: |-
    - op: replace
      path: /spec/replicas
      value: 5
- target:
    kind: Deployment
    name: order-service
  patch: |-
    - op: replace
      path: /spec/replicas
      value: 3

# Add production-specific resource limits
- target:
    kind: Deployment
    labelSelector: "tier=api"
  path: production-resources-patch.yaml

commonLabels:
  environment: production
  managed-by: flux

configMapGenerator:
- name: app-config
  literals:
  - LOG_LEVEL=info
  - METRICS_ENABLED=true
  - ENVIRONMENT=production
```

```yaml
# apps/production/production-resources-patch.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: placeholder  # Replaced by target selector
spec:
  template:
    spec:
      containers:
      - name: api
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2000m"
            memory: "1Gi"
```

## Image Update Automation

Image update automation keeps deployment manifests synchronized with the container registry. When a new image tag matches a policy, Flux commits the updated tag back to the Git repository, triggering reconciliation.

### ImageRepository: Registry Scanning

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: payment-api
  namespace: flux-system
spec:
  image: registry.example.com/payment-api
  interval: 5m
  secretRef:
    name: registry-credentials
  # Filter scanned tags to reduce API calls
  exclusionList:
  - "^.*-dev$"       # Exclude dev builds
  - "^.*-alpha.*$"   # Exclude alpha versions
  - "^latest$"       # Never use floating latest tag
```

Create the registry secret:

```bash
kubectl create secret docker-registry registry-credentials \
  --namespace flux-system \
  --docker-server=registry.example.com \
  --docker-username=flux-reader \
  --docker-password="$(vault kv get -field=password secret/registry/flux-reader)"
```

### ImagePolicy: Version Selection Rules

```yaml
# Semantic versioning policy: track latest patch in v1.x.x series
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: payment-api-stable
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: payment-api
  filterTags:
    # Only match semantic version tags in v1 series
    pattern: '^v1\.(?P<minor>[0-9]+)\.(?P<patch>[0-9]+)$'
    extract: '$minor.$patch'
  policy:
    semver:
      range: '>=1.0.0 <2.0.0'
```

```yaml
# Date-based policy: always use the most recent build
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: notification-service-latest-main
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: notification-service
  filterTags:
    # Match tags like: main-20240315-abc1234
    pattern: '^main-(?P<ts>[0-9]{8})-[a-f0-9]{7}$'
    extract: '$ts'
  policy:
    numerical:
      order: asc
```

```yaml
# Digest-pinning policy for maximum reproducibility
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: order-service-pinned
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: order-service
  filterTags:
    pattern: '^v2\.[0-9]+\.[0-9]+-[a-f0-9]{7}$'
  policy:
    semver:
      range: '>=2.0.0 <3.0.0'
```

### ImageUpdateAutomation: Committing Back to Git

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: flux-system
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxcdbot@example.com
        name: Flux CD Bot
      messageTemplate: |
        [flux] Automated image update

        Updated images:
        {{ range .Updated.Images -}}
        - {{ .Repository }}:{{ .Identifier }}
        {{ end -}}

        Policies applied:
        {{ range .Updated.Objects -}}
        - {{ .Kind }} {{ .Namespace }}/{{ .Name }}
        {{ end -}}
    push:
      branch: main
  update:
    path: ./apps/production
    strategy: Setters
```

### Marking Deployment Files for Image Updates

Flux uses YAML comments as markers to identify which fields to update:

```yaml
# apps/base/payment-api/deployment.yaml (with image policy markers)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: payments
spec:
  template:
    spec:
      containers:
      - name: api
        # {"$imagepolicy": "flux-system:payment-api-stable"}
        image: registry.example.com/payment-api:v1.4.2
```

The comment `{"$imagepolicy": "flux-system:payment-api-stable"}` instructs the image automation controller to replace the `image:` field value with whatever tag the `payment-api-stable` policy selects.

Check current image policy status:

```bash
# See which image each policy has selected
flux get images policy --all-namespaces

# Check the ImageRepository scan status
flux get images repository payment-api -n flux-system

# Force an immediate scan
flux reconcile image repository payment-api -n flux-system
```

## Multi-Tenancy with Flux

### Tenant Isolation Pattern

```yaml
# clusters/production/tenants.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: tenants
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  path: ./tenants/production
  prune: true
```

```yaml
# tenants/production/team-alpha.yaml
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
  name: flux-reconciler
  namespace: team-alpha
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: flux-reconciler
  namespace: team-alpha
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin   # In production, use a scoped role
subjects:
- kind: ServiceAccount
  name: flux-reconciler
  namespace: team-alpha
---
# Tenant's GitRepository — points to the team's own repo
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: team-alpha-apps
  namespace: team-alpha
spec:
  interval: 1m
  url: ssh://git@github.com/my-org/team-alpha-apps.git
  ref:
    branch: main
  secretRef:
    name: team-alpha-deploy-key
---
# Tenant's Kustomization — runs with limited service account
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: team-alpha-apps
  namespace: team-alpha
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: team-alpha-apps
    namespace: team-alpha
  path: ./apps
  prune: true
  serviceAccountName: flux-reconciler  # Scoped to team-alpha namespace
  targetNamespace: team-alpha          # Force all resources into this namespace
```

## Notifications and Alerting

```yaml
# Alert to Slack on reconciliation failures
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: slack-production
  namespace: flux-system
spec:
  type: slack
  channel: "#k8s-alerts-production"
  secretRef:
    name: slack-webhook-url
---
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: production-alerts
  namespace: flux-system
spec:
  providerRef:
    name: slack-production
  eventSeverity: error
  eventSources:
  - kind: GitRepository
    name: "*"
  - kind: Kustomization
    name: "*"
  - kind: HelmRelease
    name: "*"
  exclusionList:
  - ".*no new images.*"
  - ".*already applied.*"
---
# GitHub commit status for PRs
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: github-status
  namespace: flux-system
spec:
  type: github
  address: https://github.com/my-org/fleet-infra
  secretRef:
    name: github-token
---
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: github-commit-status
  namespace: flux-system
spec:
  providerRef:
    name: github-status
  eventSources:
  - kind: Kustomization
    name: apps-production
  eventSeverity: info
```

## Troubleshooting Flux Reconciliation

### Common Diagnostic Commands

```bash
# Check overall Flux health
flux check

# Get reconciliation status for all Kustomizations
flux get kustomizations --all-namespaces

# Get detailed status with error messages
flux get kustomizations --all-namespaces -o wide

# Force immediate reconciliation
flux reconcile kustomization apps-production --with-source

# Trace the last reconciliation
flux logs --kind=Kustomization --name=apps-production --namespace=flux-system --since=1h

# Watch reconciliation events in real-time
flux events --watch --for=Kustomization/apps-production

# Suspend reconciliation during incident response
flux suspend kustomization apps-production
flux resume kustomization apps-production

# Export the rendered Kustomize output for debugging
flux build kustomization apps-production \
  --kustomization-file ./apps/production/kustomization.yaml \
  --source GitRepository/fleet-infra
```

### Diff Before Applying

```bash
# Preview what Flux would change without applying
flux diff kustomization apps-production \
  --path ./apps/production
```

### Debugging Image Automation

```bash
# Check which tags are available for an ImageRepository
flux get images repository payment-api -n flux-system -o wide

# Verify the policy is selecting the expected tag
flux get images policy payment-api-stable -n flux-system

# Check if the automation commit was pushed
flux get images update flux-system -n flux-system

# Review automation logs
kubectl logs -n flux-system -l app=image-automation-controller --tail=100
```

## Progressive Delivery with Flagger Integration

Flux integrates with Flagger for canary deployments and A/B testing:

```yaml
# apps/base/payment-api/canary.yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: payment-api
  namespace: payments
spec:
  # Reference to the Deployment managed by Flux
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-api
  progressDeadlineSeconds: 120
  service:
    port: 8080
    targetPort: 8080
    gateways:
    - public-gateway.istio-system.svc.cluster.local
    hosts:
    - api.example.com
  analysis:
    # Canary phase: traffic shift and analysis interval
    interval: 1m
    threshold: 5         # Max failed checks before rollback
    maxWeight: 50        # Max canary traffic percentage
    stepWeight: 10       # Traffic increment per interval
    metrics:
    - name: request-success-rate
      thresholdRange:
        min: 99.5
      interval: 1m
    - name: request-duration
      thresholdRange:
        max: 500         # Max P99 latency in ms
      interval: 1m
    webhooks:
    - name: load-test
      url: http://flagger-loadtester.flagger-system/
      timeout: 5s
      metadata:
        cmd: "hey -z 1m -q 10 -c 2 http://payment-api-canary.payments:8080/api/health"
```

When Flux updates the image tag in the Deployment, Flagger intercepts the change and runs the progressive delivery analysis before fully promoting the new version.
