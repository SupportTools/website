---
title: "Kubernetes GitOps Patterns: Mono-Repo vs Poly-Repo and Tenant Isolation"
date: 2031-06-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "GitOps", "ArgoCD", "Flux", "Multi-tenancy", "DevOps", "Platform Engineering"]
categories:
- Kubernetes
- GitOps
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Kubernetes GitOps patterns covering mono-repo vs poly-repo trade-offs, ArgoCD Projects and AppProjects for tenant isolation, RBAC for team-scoped deployments, promotion workflows, and managing drift detection."
more_link: "yes"
url: "/kubernetes-gitops-patterns-mono-repo-poly-repo-tenant-isolation-guide/"
---

GitOps is the practice of using Git as the single source of truth for Kubernetes infrastructure state. The choice between a mono-repo and poly-repo structure, and the mechanisms used to isolate tenants within those repositories, fundamentally shapes how teams operate, how changes propagate, and how access is governed. This guide covers the complete spectrum: repo structure trade-offs, ArgoCD's AppProject-based tenant isolation, RBAC patterns for team-scoped deployments, promotion workflows across environments, and drift detection strategies.

<!--more-->

# Kubernetes GitOps Patterns: Mono-Repo vs Poly-Repo and Tenant Isolation

## Section 1: GitOps Fundamentals

GitOps rests on four principles:
1. The desired system state is described declaratively
2. The desired state is versioned and immutable in Git
3. Approved changes are pulled automatically to the cluster
4. Software agents ensure correctness and alert on divergence

The two dominant tools are ArgoCD (a Kubernetes-native CD platform) and Flux v2 (a GitOps toolkit). This guide uses ArgoCD as the primary example but covers Flux where relevant.

### Why Repository Structure Matters

Repository structure affects:
- **Access control**: Who can modify which application's config
- **Change velocity**: How quickly changes propagate between teams
- **Blast radius**: Whether a bad commit affects one team or all teams
- **Tooling complexity**: How much automation is needed to manage the repo
- **Audit trail**: How easy it is to trace changes to specific deployments

## Section 2: Mono-Repo Structure

A mono-repo contains all application configurations in a single repository. Large organizations like Spotify, Google, and Airbnb use mono-repos for their infrastructure.

### Directory Layout Options

**Option A: Flat Hierarchy**
```
gitops-mono/
├── apps/
│   ├── team-a/
│   │   ├── frontend/
│   │   │   ├── base/
│   │   │   │   ├── deployment.yaml
│   │   │   │   ├── service.yaml
│   │   │   │   └── kustomization.yaml
│   │   │   └── overlays/
│   │   │       ├── dev/
│   │   │       ├── staging/
│   │   │       └── production/
│   │   └── backend/
│   └── team-b/
│       ├── api-service/
│       └── worker/
├── infrastructure/
│   ├── cert-manager/
│   ├── ingress-nginx/
│   └── monitoring/
└── clusters/
    ├── dev/
    ├── staging/
    └── production/
```

**Option B: Environment-First Hierarchy**
```
gitops-mono/
├── environments/
│   ├── dev/
│   │   ├── team-a-frontend/
│   │   ├── team-a-backend/
│   │   └── team-b-api/
│   ├── staging/
│   │   ├── team-a-frontend/
│   │   └── team-a-backend/
│   └── production/
│       ├── team-a-frontend/
│       └── team-a-backend/
└── base/
    ├── team-a-frontend/
    └── team-b-api/
```

### Mono-Repo Trade-offs

**Advantages:**
- Single source of truth for all configs
- Cross-team dependencies are visible and verifiable
- Unified CI pipeline validates all changes together
- Easy to implement global policies (security, resource limits)
- Atomic multi-service deployments
- Simpler ArgoCD setup (fewer repositories to manage)

**Disadvantages:**
- Access control is coarser (CODEOWNERS helps but is imperfect)
- Large repos can become slow to clone and operate
- A single bad commit can block all deployments
- Teams can step on each other's changes
- Review bottlenecks when cross-team changes are needed

## Section 3: Poly-Repo Structure

A poly-repo gives each application or team its own Git repository.

### Poly-Repo Layout

```
# Repository: github.com/myorg/infra-team-a-frontend
team-a-frontend/
├── base/
│   ├── deployment.yaml
│   ├── service.yaml
│   └── kustomization.yaml
└── overlays/
    ├── dev/
    ├── staging/
    └── production/

# Repository: github.com/myorg/infra-team-b-api
team-b-api/
├── base/
│   ├── deployment.yaml
│   └── kustomization.yaml
└── overlays/
    ├── dev/
    └── production/

# Repository: github.com/myorg/infra-platform (platform team)
platform/
├── cert-manager/
├── ingress-nginx/
├── monitoring/
└── namespaces/
```

### Poly-Repo Trade-offs

**Advantages:**
- Fine-grained access control: teams own their repos completely
- Blast radius of a bad commit is limited to one team
- Independent deployment velocity per team
- Smaller repos are faster to clone and search
- Teams have autonomy over their deployment configurations

**Disadvantages:**
- Cross-team coordination requires multiple PRs in multiple repos
- ArgoCD requires more complex setup (many repo references)
- Shared infrastructure changes require coordinated updates
- No global validation across all services simultaneously
- Security policies must be enforced externally (e.g., OPA)

## Section 4: ArgoCD Application and AppProject Setup

ArgoCD's AppProject resource is the primary mechanism for tenant isolation.

### Basic AppProject

```yaml
# appproject-team-a.yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-a
  namespace: argocd
spec:
  description: "Team A applications"

  # Allowed source repositories
  sourceRepos:
    - https://github.com/myorg/gitops-mono.git
    - https://github.com/myorg/team-a-frontend.git

  # Allowed destination clusters and namespaces
  destinations:
    - server: https://kubernetes.default.svc
      namespace: team-a-dev
    - server: https://kubernetes.default.svc
      namespace: team-a-staging
    - server: https://kubernetes.default.svc
      namespace: team-a-production
    - server: https://prod-cluster.example.com
      namespace: team-a-production

  # Resources that Team A is allowed to deploy
  clusterResourceWhitelist:
    # Allow namespace-scoped resources only (no cluster-wide resources)
    []

  namespaceResourceBlacklist:
    # Prevent deploying privileged resources
    - group: ""
      kind: "LimitRange"

  namespaceResourceWhitelist:
    - group: "apps"
      kind: "Deployment"
    - group: "apps"
      kind: "StatefulSet"
    - group: ""
      kind: "Service"
    - group: ""
      kind: "ConfigMap"
    - group: ""
      kind: "ServiceAccount"
    - group: "autoscaling"
      kind: "HorizontalPodAutoscaler"
    - group: "networking.k8s.io"
      kind: "Ingress"
    - group: "batch"
      kind: "CronJob"

  # RBAC roles for this project
  roles:
    - name: developer
      description: "Team A developers: deploy to dev and staging"
      policies:
        - p, proj:team-a:developer, applications, get, team-a/*, allow
        - p, proj:team-a:developer, applications, sync, team-a/*-dev, allow
        - p, proj:team-a:developer, applications, sync, team-a/*-staging, allow
        - p, proj:team-a:developer, applications, create, team-a/*, allow
        - p, proj:team-a:developer, applications, update, team-a/*, allow
      groups:
        - myorg:team-a-developers

    - name: lead
      description: "Team A tech lead: deploy to all environments"
      policies:
        - p, proj:team-a:lead, applications, *, team-a/*, allow
      groups:
        - myorg:team-a-leads

  # Sync windows: restrict deployments to business hours for production
  syncWindows:
    - kind: allow
      schedule: "0 9 * * 1-5"  # 9am weekdays
      duration: 9h              # Until 6pm
      applications:
        - "*-production"
      manualSync: true          # Allow manual syncs outside window
    - kind: deny
      schedule: "0 18 * * 1-5" # Deny after 6pm
      duration: 15h             # Until 9am next day
      applications:
        - "*-production"
```

### ArgoCD Application per Tenant

```yaml
# app-team-a-frontend-production.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: team-a-frontend-production
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
  labels:
    team: team-a
    environment: production
    app: frontend
spec:
  project: team-a

  source:
    repoURL: https://github.com/myorg/gitops-mono.git
    targetRevision: HEAD
    path: apps/team-a/frontend/overlays/production

  destination:
    server: https://kubernetes.default.svc
    namespace: team-a-production

  syncPolicy:
    automated:
      prune: true         # Delete resources removed from Git
      selfHeal: true      # Revert manual changes to cluster
      allowEmpty: false   # Don't prune if source is empty

    syncOptions:
      - CreateNamespace=true
      - PrunePropagationPolicy=foreground
      - PruneLast=true    # Prune after other resources are healthy

    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m

  # Health checks and ignoreDifferences
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas  # Ignore replica count (managed by HPA)
```

### ApplicationSet for Multi-Environment Deployments

ApplicationSet generates multiple Applications from a template, eliminating repetitive configuration:

```yaml
# applicationset-team-a.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: team-a-apps
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          - list:
              elements:
                - app: frontend
                - app: backend
                - app: worker
          - list:
              elements:
                - env: dev
                  cluster: https://kubernetes.default.svc
                  namespace_suffix: "-dev"
                  auto_sync: "true"
                - env: staging
                  cluster: https://kubernetes.default.svc
                  namespace_suffix: "-staging"
                  auto_sync: "true"
                - env: production
                  cluster: https://prod-cluster.example.com
                  namespace_suffix: "-production"
                  auto_sync: "false"  # Manual sync for production

  template:
    metadata:
      name: "team-a-{{app}}-{{env}}"
      labels:
        team: team-a
        environment: "{{env}}"
        app: "{{app}}"
    spec:
      project: team-a
      source:
        repoURL: https://github.com/myorg/gitops-mono.git
        targetRevision: HEAD
        path: "apps/team-a/{{app}}/overlays/{{env}}"
      destination:
        server: "{{cluster}}"
        namespace: "team-a-{{app}}{{namespace_suffix}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: "{{auto_sync}}" == "true"
        syncOptions:
          - CreateNamespace=true
```

### Git Generator for Poly-Repo

```yaml
# applicationset-all-teams-scm.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: all-team-apps
  namespace: argocd
spec:
  generators:
    - scmProvider:
        github:
          organization: myorg
          tokenRef:
            secretName: github-token
            key: token
          # Filter repos matching pattern
          filters:
            - repositoryMatch: "^infra-team-.*$"
        cloneProtocol: https

    - merge:
        mergeKeys: [repoURL]
        generators:
          - scmProvider:
              # As above
          - list:
              elements:
                - env: production
                  cluster: https://prod-cluster.example.com

  template:
    metadata:
      name: "{{repository}}-{{env}}"
    spec:
      project: "{{labels.team}}"  # Uses repo label as project name
      source:
        repoURL: "{{url}}"
        targetRevision: HEAD
        path: "overlays/{{env}}"
      destination:
        server: "{{cluster}}"
        namespace: "{{repository}}-{{env}}"
```

## Section 5: Flux v2 Tenant Isolation

Flux provides tenant isolation through Kustomizations with ServiceAccount-scoped permissions:

```yaml
# flux-system/tenants/team-a.yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: team-a
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: team-a
  namespace: team-a
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: team-a-reconciler
  namespace: team-a
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets"]
    verbs: ["*"]
  - apiGroups: [""]
    resources: ["services", "configmaps", "serviceaccounts"]
    verbs: ["*"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["*"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-a-reconciler
  namespace: team-a
subjects:
  - kind: ServiceAccount
    name: team-a
    namespace: team-a
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: team-a-reconciler
---
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: team-a
  namespace: team-a
spec:
  interval: 1m
  url: https://github.com/myorg/team-a-gitops
  secretRef:
    name: team-a-git-credentials
  ref:
    branch: main
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: team-a-production
  namespace: team-a
spec:
  interval: 10m
  path: ./overlays/production
  prune: true
  sourceRef:
    kind: GitRepository
    name: team-a
  serviceAccountName: team-a  # Flux reconciles with this SA's permissions
  targetNamespace: team-a
  timeout: 5m
  validation: server
  healthChecks:
    - apiVersion: apps/v1
      kind: Deployment
      name: frontend
      namespace: team-a
```

## Section 6: RBAC for Team-Scoped Deployments

### Kubernetes RBAC for Namespace Isolation

```yaml
# team-a-rbac.yaml
---
# Allow team-a developers to manage deployments in team-a namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: team-a-deployer
  namespace: team-a
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["apps"]
    resources: ["deployments/status"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["services", "configmaps"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-a-deployers
  namespace: team-a
subjects:
  - kind: Group
    name: team-a-engineers
    apiGroup: rbac.authorization.k8s.io
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: team-a-deployer
```

### ArgoCD RBAC Policy File

```yaml
# argocd-rbac-cm.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: role:readonly
  policy.csv: |
    # Platform team: full access
    p, role:platform-admin, *, *, */*, allow

    # Team A tech lead: full access to team-a project
    p, role:team-a-lead, applications, *, team-a/*, allow
    p, role:team-a-lead, repositories, *, *, allow
    p, role:team-a-lead, clusters, get, *, allow

    # Team A developer: deploy to dev and staging only
    p, role:team-a-developer, applications, get, team-a/*, allow
    p, role:team-a-developer, applications, sync, team-a/*-dev, allow
    p, role:team-a-developer, applications, sync, team-a/*-staging, allow
    p, role:team-a-developer, applications, override, team-a/*-dev, allow
    p, role:team-a-developer, applications, create, team-a/*, allow
    p, role:team-a-developer, applications, update, team-a/*, allow
    p, role:team-a-developer, logs, get, team-a/*, allow

    # Team B: same structure
    p, role:team-b-lead, applications, *, team-b/*, allow
    p, role:team-b-developer, applications, get, team-b/*, allow
    p, role:team-b-developer, applications, sync, team-b/*-dev, allow
    p, role:team-b-developer, applications, sync, team-b/*-staging, allow

    # OIDC group bindings
    g, myorg:platform-team, role:platform-admin
    g, myorg:team-a-leads, role:team-a-lead
    g, myorg:team-a-developers, role:team-a-developer
    g, myorg:team-b-leads, role:team-b-lead
    g, myorg:team-b-developers, role:team-b-developer

  scopes: "[groups, email]"
```

## Section 7: Promotion Workflows

Promotion is the process of moving a validated change from a lower environment (dev) to a higher one (staging, production).

### Manual Promotion via PR

```yaml
# .github/workflows/promote.yaml
name: Promote to Production

on:
  workflow_dispatch:
    inputs:
      app:
        description: 'Application name'
        required: true
      image_tag:
        description: 'Image tag to promote'
        required: true

jobs:
  promote:
    runs-on: ubuntu-latest
    environment: production  # Requires GitHub environment approval
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITOPS_TOKEN }}

      - name: Update production overlay
        run: |
          cd apps/${{ github.event.inputs.app }}/overlays/production
          kustomize edit set image \
            myapp=${{ secrets.ECR_REGISTRY }}/${{ github.event.inputs.app }}:${{ github.event.inputs.image_tag }}

      - name: Commit and push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add .
          git commit -m "chore: promote ${{ github.event.inputs.app }} to production at ${{ github.event.inputs.image_tag }}"
          git push

      - name: Create PR for visibility
        uses: peter-evans/create-pull-request@v6
        with:
          token: ${{ secrets.GITOPS_TOKEN }}
          title: "chore: promote ${{ github.event.inputs.app }} to production"
          body: |
            Promoting `${{ github.event.inputs.app }}` to production.
            Image tag: `${{ github.event.inputs.image_tag }}`
          labels: promotion,production
```

### Automated Promotion with Image Updater

ArgoCD Image Updater automates the promotion of new container image tags:

```yaml
# Configure Image Updater annotation on Application
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: team-a-frontend-staging
  namespace: argocd
  annotations:
    # Automatically update image when a new tag matching the pattern is pushed
    argocd-image-updater.argoproj.io/image-list: |
      myapp=123456789012.dkr.ecr.us-east-1.amazonaws.com/team-a-frontend
    argocd-image-updater.argoproj.io/myapp.update-strategy: semver
    argocd-image-updater.argoproj.io/myapp.allow-tags: "regexp:^v[0-9]+\\.[0-9]+\\.[0-9]+-rc\\.[0-9]+$"
    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/write-back-target: kustomization
    argocd-image-updater.argoproj.io/git-branch: main
spec:
  project: team-a
  source:
    repoURL: https://github.com/myorg/gitops-mono.git
    targetRevision: HEAD
    path: apps/team-a/frontend/overlays/staging
  destination:
    server: https://kubernetes.default.svc
    namespace: team-a-staging
```

### Environment Gate Policy with OPA

```yaml
# OPA policy: prevent production deployment without staging health check
# promotion-policy.rego
package gitops.promotion

default allow_production = false

# Allow production deployment only if staging is healthy
allow_production {
    input.environment == "production"
    input.staging_health == "Healthy"
    input.staging_sync == "Synced"
    input.staging_age_minutes > 30  # Staging must be stable for 30min
}

allow_production {
    input.environment != "production"  # Non-production always allowed
}
```

## Section 8: Drift Detection and Remediation

Drift occurs when the cluster state diverges from the Git state. This can happen due to:
- Manual kubectl changes
- Admission webhook mutations
- Controller modifications (HPA scaling, Vertical Pod Autoscaler)
- Hardware failures triggering automated recovery

### Detecting Drift with ArgoCD

```bash
# Check for applications with drift (OutOfSync status)
argocd app list --output json | jq '.[] | select(.status.sync.status == "OutOfSync") | {name: .metadata.name, status: .status.sync.status}'

# Get diff for a specific application
argocd app diff team-a-frontend-production

# Example output:
# ===== apps/Deployment team-a-frontend =====
# 39a40
# >     replicas: 5  <- Cluster has 5 replicas
# <     replicas: 3  <- Git has 3 replicas (HPA modified it)
```

### Handling Legitimate Drift (HPA Replicas)

```yaml
# Ignore replica count drift caused by HPA
apiVersion: argoproj.io/v1alpha1
kind: Application
spec:
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas       # HPA manages this
    - group: autoscaling
      kind: HorizontalPodAutoscaler
      jsonPointers:
        - /spec/minReplicas    # VPA may manage this
        - /spec/maxReplicas
```

### Alerting on Drift

```yaml
# PrometheusRule for ArgoCD drift alerts
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: argocd-drift-alerts
  namespace: monitoring
spec:
  groups:
    - name: argocd.drift
      rules:
        - alert: ArgoCDApplicationOutOfSync
          expr: |
            argocd_app_info{sync_status="OutOfSync"} == 1
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "ArgoCD application {{ $labels.name }} is OutOfSync"
            description: |
              Application {{ $labels.name }} in project {{ $labels.project }}
              has been OutOfSync for more than 15 minutes.

        - alert: ArgoCDApplicationDegraded
          expr: |
            argocd_app_info{health_status="Degraded"} == 1
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "ArgoCD application {{ $labels.name }} is Degraded"
```

## Section 9: Repository Strategy Recommendations

### When to Choose Mono-Repo

Choose mono-repo when:
- You are a small to medium team (< 20 engineers on GitOps)
- You have strong cross-team dependencies that need atomic updates
- You want a simple ArgoCD setup
- You have a platform team that needs global visibility
- You are just starting your GitOps journey

Recommended configuration:
```
gitops-mono/
├── platform/           # Platform team manages this
│   ├── cert-manager/
│   ├── ingress-nginx/
│   └── monitoring/
├── teams/              # App teams manage their subdirectory
│   ├── team-a/         # CODEOWNERS: @myorg/team-a
│   │   ├── base/
│   │   └── overlays/
│   └── team-b/
└── clusters/           # Cluster-level config
    ├── dev/
    └── production/
```

### When to Choose Poly-Repo

Choose poly-repo when:
- You have many teams (> 20) deploying independently
- Access control and blast radius isolation are critical
- Teams deploy at very different velocities
- You need separate CI pipelines per application
- Security requirements mandate code/config separation

Recommended configuration:
```
# One repository per application
github.com/myorg/gitops-team-a-frontend
github.com/myorg/gitops-team-a-backend
github.com/myorg/gitops-platform          # Platform team
github.com/myorg/gitops-cluster-config    # Cluster-wide config
```

### Hybrid: App-of-Apps Pattern

The app-of-apps pattern allows you to manage groups of applications through a parent application:

```yaml
# Root application (manages all other applications)
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://github.com/myorg/gitops-root.git
    targetRevision: HEAD
    path: apps
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

```
# gitops-root/apps/ directory contains Application manifests
apps/
├── team-a-frontend.yaml      # Points to team-a-frontend repo
├── team-a-backend.yaml       # Points to team-a-backend repo
├── platform-monitoring.yaml  # Points to platform repo
└── cert-manager.yaml
```

## Section 10: Secrets Management in GitOps

Secrets cannot be stored in Git repositories. The standard patterns are:

### Sealed Secrets

```bash
# Encrypt a secret for storage in Git
kubeseal --format yaml \
    --controller-name=sealed-secrets-controller \
    --controller-namespace=kube-system \
    < my-secret.yaml > sealed-secret.yaml

# The sealed secret is safe to commit to Git
git add sealed-secret.yaml
git commit -m "feat: add sealed database secret"
```

### External Secrets Operator

```yaml
# Reference a secret in AWS Secrets Manager without storing in Git
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: database-credentials
  namespace: team-a
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: database-credentials
    creationPolicy: Owner
  data:
    - secretKey: DATABASE_URL
      remoteRef:
        key: prod/team-a/database
        property: url
    - secretKey: DATABASE_PASSWORD
      remoteRef:
        key: prod/team-a/database
        property: password
```

## Section 11: CI/CD Integration with GitOps

```yaml
# .github/workflows/ci-gitops.yaml
name: CI + GitOps Update

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      image_tag: ${{ steps.meta.outputs.tags }}
    steps:
      - uses: actions/checkout@v4

      - name: Build and push Docker image
        id: meta
        run: |
          TAG="sha-${GITHUB_SHA::8}"
          docker build -t $ECR_REGISTRY/my-app:$TAG .
          docker push $ECR_REGISTRY/my-app:$TAG
          echo "tags=$TAG" >> $GITHUB_OUTPUT

  update-gitops:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          repository: myorg/gitops-mono
          token: ${{ secrets.GITOPS_TOKEN }}

      - name: Update dev overlay
        working-directory: apps/team-a/frontend/overlays/dev
        run: |
          kustomize edit set image \
            myapp=${{ env.ECR_REGISTRY }}/my-app:${{ needs.build.outputs.image_tag }}

      - name: Commit and push
        run: |
          git config user.name "ci-bot"
          git config user.email "ci-bot@myorg.com"
          git add .
          git diff --staged --quiet || git commit -m \
            "ci: update team-a/frontend to ${{ needs.build.outputs.image_tag }}"
          git push

      - name: Wait for ArgoCD sync
        run: |
          argocd login ${{ secrets.ARGOCD_SERVER }} \
            --auth-token ${{ secrets.ARGOCD_TOKEN }} \
            --insecure
          argocd app wait team-a-frontend-dev \
            --health --timeout 300
```

## Conclusion

The choice between mono-repo and poly-repo for GitOps depends more on organizational structure than technical requirements. Small teams benefit from mono-repo simplicity; large organizations with many independent teams benefit from poly-repo isolation. ArgoCD's AppProject provides the correct abstraction for tenant isolation: it enforces which repositories can deploy to which namespaces, which Kubernetes resources can be managed, and which users have access to which operations. Automated promotion through Image Updater reduces human toil while maintaining audit trails. Drift detection with proper ignoreDifferences configuration distinguishes legitimate controller-managed changes from unauthorized manual modifications. The combination of these patterns creates a GitOps system that scales from a single team to a hundred teams on a shared cluster.
