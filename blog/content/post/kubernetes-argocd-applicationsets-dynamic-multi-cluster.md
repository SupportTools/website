---
title: "Kubernetes ArgoCD ApplicationSets: Dynamic Application Generation for Multi-Cluster GitOps"
date: 2031-05-28T00:00:00-05:00
draft: false
tags: ["ArgoCD", "ApplicationSets", "GitOps", "Multi-Cluster", "Kubernetes", "CI/CD"]
categories: ["Kubernetes", "GitOps", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master ArgoCD ApplicationSets for enterprise multi-cluster GitOps: cluster/git/matrix/merge generators, progressive sync waves, monorepo patterns, PR preview environments, and RBAC hardening."
more_link: "yes"
url: "/kubernetes-argocd-applicationsets-dynamic-multi-cluster/"
---

Managing GitOps deployments across dozens of clusters and hundreds of applications with individual ArgoCD `Application` objects quickly becomes untenable. ApplicationSets solve this by introducing a controller that generates `Application` objects dynamically from templates driven by generators — cluster inventories, Git directory structures, pull request events, or complex matrix products of multiple data sources. This guide covers every production-relevant generator, the full progressive sync wave pattern, RBAC lockdown for the ApplicationSet controller, monorepo app-of-apps patterns, and pull request preview environments that spin up and tear down automatically.

<!--more-->

# Kubernetes ArgoCD ApplicationSets: Dynamic Application Generation for Multi-Cluster GitOps

## Why ApplicationSets Matter at Scale

A single ArgoCD instance managing 50 clusters with 40 applications each means 2,000 `Application` objects. Without ApplicationSets, creating, updating, and maintaining those objects is either a fragile scripted process or a sea of nearly-identical YAML. ApplicationSets replace that with a single controller-managed resource whose template engine handles the combinatorial explosion.

The ApplicationSet controller runs alongside the ArgoCD application controller and watches `ApplicationSet` custom resources. When generator data changes — a new cluster registers, a new directory appears in Git, a pull request opens — the controller reconciles the target set of `Application` objects to match, creating new ones, updating changed ones, and deleting removed ones according to the `syncPolicy.preserveResourcesOnDeletion` flag.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     ArgoCD Namespace                             │
│                                                                  │
│  ┌─────────────────────┐    ┌──────────────────────────────┐    │
│  │  ApplicationSet     │    │  ApplicationSet Controller   │    │
│  │  Controller         │───▶│  watches ApplicationSet CRs  │    │
│  │                     │    │  generates Application CRs   │    │
│  └─────────────────────┘    └──────────────────────────────┘    │
│                                          │                       │
│                              ┌───────────▼────────────┐         │
│                              │  Generated Applications │         │
│                              │  app-dev-us-east-1      │         │
│                              │  app-dev-eu-west-1      │         │
│                              │  app-prod-us-east-1     │         │
│                              │  app-prod-eu-west-1     │         │
│                              └────────────────────────-┘         │
└─────────────────────────────────────────────────────────────────┘

Generators feed data into template:
  ClusterGenerator  ──┐
  GitGenerator      ──┤──▶ Template Engine ──▶ Application objects
  MatrixGenerator   ──┤
  MergeGenerator    ──┘
  PullRequestGenerator
  SCMProviderGenerator
```

## Installing ApplicationSets

ApplicationSets are bundled with ArgoCD 2.3+ but the controller must be enabled. With the official Helm chart:

```yaml
# argocd-values.yaml
applicationSet:
  enabled: true
  replicaCount: 2
  resources:
    limits:
      cpu: 500m
      memory: 512Mi
    requests:
      cpu: 100m
      memory: 128Mi
  metrics:
    enabled: true
    serviceMonitor:
      enabled: true
      namespace: monitoring
  args:
    # Limit concurrent reconciliations to prevent thundering-herd on large fleets
    - --concurrent-reconciliations=10
    # Prevent ApplicationSets from modifying Applications in other namespaces
    - --argocd-repo-server-strict-tls
    - --policy=sync
    # Namespace scoping — only manage ApplicationSets in argocd namespace
    - --namespace=argocd

controller:
  replicas: 2
  env:
    - name: ARGOCD_RECONCILIATION_TIMEOUT
      value: "3m"

server:
  replicas: 2
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 5
```

```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

helm upgrade --install argocd argo/argo-cd \
  --namespace argocd \
  --create-namespace \
  --version 7.x.x \
  --values argocd-values.yaml \
  --wait
```

## Generator Types In Depth

### 1. Cluster Generator

The cluster generator iterates over clusters registered in ArgoCD's `argocd-clusters` secret store. Each cluster secret can carry arbitrary labels that become available as template variables.

First, register clusters with metadata labels:

```bash
# Register clusters with environment and region labels
argocd cluster add k8s-dev-us-east-1 \
  --label env=dev \
  --label region=us-east-1 \
  --label tier=frontend \
  --name dev-us-east-1

argocd cluster add k8s-prod-us-east-1 \
  --label env=prod \
  --label region=us-east-1 \
  --label tier=frontend \
  --name prod-us-east-1

argocd cluster add k8s-prod-eu-west-1 \
  --label env=prod \
  --label region=eu-west-1 \
  --label tier=frontend \
  --name prod-eu-west-1
```

Or via secret labels for clusters added through external tooling:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cluster-prod-eu-west-1
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
    env: prod
    region: eu-west-1
    tier: frontend
type: Opaque
stringData:
  name: prod-eu-west-1
  server: https://k8s-prod-eu-west-1.example.com
  config: |
    {
      "execProviderConfig": {
        "command": "argocd-k8s-auth",
        "args": ["aws", "--cluster-name", "prod-eu-west-1"],
        "apiVersion": "client.authentication.k8s.io/v1beta1"
      },
      "tlsClientConfig": {
        "insecure": false,
        "caData": "<base64-encoded-tls-certificate>"
      }
    }
```

Now the ApplicationSet using the cluster generator:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: frontend-app-all-clusters
  namespace: argocd
spec:
  # Prevent ApplicationSet from deleting generated Applications
  # when the ApplicationSet itself is deleted (safety net for prod)
  preservedFields:
    annotations:
      - kubectl.kubernetes.io/last-applied-configuration

  generators:
    - clusters:
        # Only target clusters labeled with tier=frontend
        selector:
          matchLabels:
            tier: frontend
        # Extra values to inject alongside cluster metadata
        values:
          chartVersion: "2.1.0"
          ingressClass: nginx

  template:
    metadata:
      # Name uses cluster name from the registry
      name: "frontend-{{name}}"
      annotations:
        # Track which generator produced this Application
        applicationset.argoproj.io/generator-type: cluster
    spec:
      project: "{{metadata.labels.env}}"
      source:
        repoURL: https://github.com/example/platform-helm-charts
        targetRevision: HEAD
        path: charts/frontend
        helm:
          valueFiles:
            - values.yaml
            - "values-{{metadata.labels.env}}.yaml"
            - "values-{{metadata.labels.region}}.yaml"
          parameters:
            - name: global.clusterName
              value: "{{name}}"
            - name: global.environment
              value: "{{metadata.labels.env}}"
            - name: global.region
              value: "{{metadata.labels.region}}"
            - name: image.tag
              value: "{{values.chartVersion}}"
            - name: ingress.className
              value: "{{values.ingressClass}}"

      destination:
        server: "{{server}}"
        namespace: frontend

      syncPolicy:
        automated:
          prune: true
          selfHeal: true
          allowEmpty: false
        syncOptions:
          - CreateNamespace=true
          - PrunePropagationPolicy=foreground
          - PruneLast=true
        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m

      ignoreDifferences:
        - group: apps
          kind: Deployment
          jsonPointers:
            - /spec/replicas
```

### 2. Git Generator

The Git generator has two sub-modes: directory-based (one application per subdirectory) and file-based (one application per config file matching a glob).

#### Directory Mode — Microservices Monorepo

```
platform-services/
├── services/
│   ├── api-gateway/
│   │   ├── Chart.yaml
│   │   └── values.yaml
│   ├── auth-service/
│   │   ├── Chart.yaml
│   │   └── values.yaml
│   ├── payment-service/
│   │   ├── Chart.yaml
│   │   └── values.yaml
│   └── notification-service/
│       ├── Chart.yaml
│       └── values.yaml
```

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: platform-services-monorepo
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/example/platform-services
        revision: HEAD
        directories:
          - path: services/*
          # Exclude services under active refactoring
          - path: services/legacy-*
            exclude: true

  template:
    metadata:
      name: "svc-{{path.basename}}"
    spec:
      project: platform
      source:
        repoURL: https://github.com/example/platform-services
        targetRevision: HEAD
        # path.basename is the directory name (api-gateway, auth-service, etc.)
        path: "{{path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

#### File Mode — Environment Config Files

```
clusters/
├── dev-us-east-1.yaml
├── dev-eu-west-1.yaml
├── prod-us-east-1.yaml
└── prod-eu-west-1.yaml
```

```yaml
# prod-us-east-1.yaml
clusterName: prod-us-east-1
environment: prod
region: us-east-1
server: https://k8s-prod-us-east-1.example.com
namespace: frontend
helm:
  valueFile: values-prod-us-east-1.yaml
  replicaCount: 5
  autoscaling:
    enabled: true
    minReplicas: 5
    maxReplicas: 20
monitoring:
  scrapeInterval: 15s
  alerting: true
```

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: frontend-from-config-files
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/example/cluster-config
        revision: HEAD
        files:
          - path: "clusters/prod-*.yaml"  # Only prod clusters

  template:
    metadata:
      name: "frontend-{{clusterName}}"
    spec:
      project: "{{environment}}"
      source:
        repoURL: https://github.com/example/platform-helm-charts
        targetRevision: HEAD
        path: charts/frontend
        helm:
          valueFiles:
            - "{{helm.valueFile}}"
          parameters:
            - name: replicaCount
              value: "{{helm.replicaCount}}"
            - name: autoscaling.enabled
              value: "{{helm.autoscaling.enabled}}"
            - name: autoscaling.minReplicas
              value: "{{helm.autoscaling.minReplicas}}"
            - name: autoscaling.maxReplicas
              value: "{{helm.autoscaling.maxReplicas}}"
      destination:
        server: "{{server}}"
        namespace: "{{namespace}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### 3. Matrix Generator

The Matrix generator combines two generators with a Cartesian product — every combination of elements from generator A and generator B produces one Application.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: services-across-environments
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          # First dimension: environments from a config file
          - git:
              repoURL: https://github.com/example/platform-config
              revision: HEAD
              files:
                - path: "environments/*.yaml"
          # Second dimension: services from directory structure
          - git:
              repoURL: https://github.com/example/platform-services
              revision: HEAD
              directories:
                - path: services/*

  template:
    metadata:
      # Combines environment name with service name
      name: "{{environment}}-{{path.basename}}"
      labels:
        environment: "{{environment}}"
        service: "{{path.basename}}"
    spec:
      project: "{{environment}}"
      source:
        repoURL: https://github.com/example/platform-services
        targetRevision: "{{targetRevision}}"
        path: "{{path}}"
        helm:
          valueFiles:
            - values.yaml
            - "values-{{environment}}.yaml"
      destination:
        server: "{{server}}"
        namespace: "{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

### 4. Merge Generator

The Merge generator allows one generator to provide base values that are overridden by values from a second generator, matched on a key. This is useful for providing cluster-specific overrides on top of service defaults.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: services-with-cluster-overrides
  namespace: argocd
spec:
  generators:
    - merge:
        mergeKeys:
          - clusterName
        generators:
          # Base: all clusters with default values
          - clusters:
              values:
                replicaCount: "2"
                resourceProfile: standard
                monitoringEnabled: "true"
          # Override: cluster-specific overrides from files
          - git:
              repoURL: https://github.com/example/platform-config
              revision: HEAD
              files:
                - path: "cluster-overrides/*.yaml"
              # cluster-overrides/prod-us-east-1.yaml:
              #   clusterName: prod-us-east-1
              #   replicaCount: "5"
              #   resourceProfile: high-memory

  template:
    metadata:
      name: "app-{{clusterName}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/example/charts
        targetRevision: HEAD
        path: charts/app
        helm:
          parameters:
            - name: replicaCount
              value: "{{values.replicaCount}}"
            - name: resources.profile
              value: "{{values.resourceProfile}}"
      destination:
        server: "{{server}}"
        namespace: app
```

### 5. SCM Provider Generator

The SCM Provider generator iterates over repositories in a GitHub org, GitLab group, or Bitbucket workspace, creating one Application per repo (optionally filtered by topic/label).

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: github-org-services
  namespace: argocd
spec:
  generators:
    - scmProvider:
        github:
          organization: example-corp
          # Token stored in a Kubernetes secret
          tokenRef:
            secretName: github-token
            key: token
          # Only repos with the 'k8s-deployable' topic
          allBranches: false
        filters:
          - repositoryMatch: "^service-.*"
            labelMatch: k8s-deployable
            branchMatch: "^main$"
            pathsExist:
              - helm/Chart.yaml

  template:
    metadata:
      name: "{{repository}}-main"
    spec:
      project: services
      source:
        repoURL: "{{url}}"
        targetRevision: "{{branch}}"
        path: helm
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{repository}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

## Pull Request Preview Environments

PR preview environments give developers a full stack deployment for every open pull request, automatically cleaned up when the PR closes. This requires the `PullRequestGenerator`.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: pr-preview-environments
  namespace: argocd
spec:
  generators:
    - pullRequest:
        github:
          owner: example-corp
          repo: frontend-app
          tokenRef:
            secretName: github-token
            key: token
          # Only PRs labeled 'preview'
          labels:
            - preview
        requeueAfterSeconds: 60

  template:
    metadata:
      name: "preview-pr-{{number}}"
      annotations:
        # Used by cleanup automation
        preview.example.com/pr-number: "{{number}}"
        preview.example.com/pr-branch: "{{branch}}"
    spec:
      project: preview
      source:
        repoURL: https://github.com/example-corp/frontend-app
        targetRevision: "{{head_sha}}"
        path: helm
        helm:
          parameters:
            - name: image.tag
              value: "pr-{{number}}-{{head_sha}}"
            - name: ingress.host
              value: "pr-{{number}}.preview.example.com"
            - name: ingress.enabled
              value: "true"
            - name: replicaCount
              value: "1"
            # Disable resource-intensive features in preview
            - name: autoscaling.enabled
              value: "false"
            - name: persistence.enabled
              value: "false"
          valueFiles:
            - values-preview.yaml

      destination:
        server: https://k8s-preview.example.com
        # Each PR gets its own namespace
        namespace: "preview-pr-{{number}}"

      syncPolicy:
        automated:
          prune: true
          selfHeal: true
          allowEmpty: false
        syncOptions:
          - CreateNamespace=true
        # Preserve resources when PR ApplicationSet is paused
        # (but not when the Application itself is deleted)

      # Auto-cleanup: after PR is merged/closed, the Application
      # is deleted and the namespace pruned
      info:
        - name: PR URL
          value: "https://github.com/example-corp/frontend-app/pull/{{number}}"
        - name: Preview URL
          value: "https://pr-{{number}}.preview.example.com"
```

The preview namespace needs resource quotas to prevent runaway costs:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: preview-quota
  namespace: preview-pr-42  # Created by Application syncOptions
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 4Gi
    limits.cpu: "4"
    limits.memory: 8Gi
    count/pods: "20"
    count/services: "10"
    count/persistentvolumeclaims: "5"
```

A GitHub Actions workflow triggers the image build and labels the PR:

```yaml
# .github/workflows/preview.yml
name: PR Preview

on:
  pull_request:
    types: [opened, synchronize, labeled]

jobs:
  build-preview:
    if: contains(github.event.pull_request.labels.*.name, 'preview')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build and push preview image
        uses: docker/build-push-action@v5
        with:
          push: true
          tags: |
            ghcr.io/example-corp/frontend-app:pr-${{ github.event.number }}-${{ github.sha }}
          build-args: |
            BUILD_ENV=preview
            PR_NUMBER=${{ github.event.number }}

      - name: Comment PR with preview URL
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `Preview environment deploying to: https://pr-${context.issue.number}.preview.example.com\n\nDeployment managed by ArgoCD: https://argocd.example.com/applications/preview-pr-${context.issue.number}`
            })
```

## Progressive Sync Waves

Sync waves control the order in which ArgoCD syncs resources within an Application. For ApplicationSets managing fleet-wide rollouts, you can combine waves with Application-level sync windows to implement canary rollouts across clusters.

### Wave Annotations on Resources

```yaml
# Deploy infrastructure dependencies first (wave -1)
apiVersion: v1
kind: Namespace
metadata:
  name: frontend
  annotations:
    argocd.argoproj.io/sync-wave: "-1"
---
# Then CRDs (wave 0 is the default)
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: frontendconfigs.cloud.google.com
  annotations:
    argocd.argoproj.io/sync-wave: "0"
---
# Database migrations before the app (wave 1)
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
  annotations:
    argocd.argoproj.io/sync-wave: "1"
    argocd.argoproj.io/hook: Sync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: migrate/migrate:v4
          command: ["/migrate", "-path", "/migrations", "-database", "$(DB_URL)", "up"]
      restartPolicy: Never
---
# Application deployment (wave 2)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  annotations:
    argocd.argoproj.io/sync-wave: "2"
spec:
  replicas: 3
  # ...
---
# Ingress after pods are ready (wave 3)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: frontend
  annotations:
    argocd.argoproj.io/sync-wave: "3"
```

### Progressive Cluster Rollout with ApplicationSet

For fleet rollouts, use the cluster generator with a wave label on clusters, combined with sync windows:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: frontend-progressive-rollout
  namespace: argocd
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            tier: frontend
        values:
          # Clusters labeled wave=canary deploy first
          syncWave: "{{metadata.labels.wave}}"

  template:
    metadata:
      name: "frontend-{{name}}"
      annotations:
        # Use cluster's wave label as Application sync wave
        # wave=canary clusters get wave 1, prod gets wave 2
        argocd.argoproj.io/sync-wave: "{{values.syncWave}}"
    spec:
      project: production
      source:
        repoURL: https://github.com/example/platform-helm-charts
        targetRevision: HEAD
        path: charts/frontend
      destination:
        server: "{{server}}"
        namespace: frontend
      syncPolicy:
        automated:
          prune: false   # Manual prune in prod during wave rollout
          selfHeal: true
```

Label canary and production clusters accordingly:

```bash
# Canary: 10% of prod traffic, deploys in wave 1
kubectl label secret cluster-prod-canary-us-east-1 \
  -n argocd wave=1

# Full prod: deploys in wave 2 after canary health check
kubectl label secret cluster-prod-us-east-1 \
  -n argocd wave=2

kubectl label secret cluster-prod-eu-west-1 \
  -n argocd wave=2
```

The ApplicationSet controller will process wave 1 Applications first, wait for them to become healthy, then proceed to wave 2.

### Sync Windows for Controlled Rollouts

Restrict when automated syncs can fire in production using AppProject sync windows:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: production
  namespace: argocd
spec:
  description: Production workloads

  sourceRepos:
    - https://github.com/example/*

  destinations:
    - namespace: "*"
      server: "*"

  clusterResourceWhitelist:
    - group: "*"
      kind: "*"

  # Sync windows: automated sync only runs during defined windows
  syncWindows:
    # Allow automated sync on weekdays 2-4 AM UTC
    - kind: allow
      schedule: "0 2 * * 1-5"
      duration: 2h
      applications:
        - "frontend-prod-*"
      manualSync: true   # Manual sync still allowed outside window

    # Deny automated sync on Fridays after 3 PM UTC
    - kind: deny
      schedule: "0 15 * * 5"
      duration: 48h   # Through the weekend
      applications:
        - "*-prod-*"
      manualSync: false  # Block ALL sync during this window
```

## Monorepo App-of-Apps Pattern

For large organizations, a two-tier ApplicationSet structure keeps the monorepo manageable: a root ApplicationSet generates team-scoped ApplicationSets, each of which generates the actual service Applications.

### Repository Structure

```
platform-config/
├── teams/
│   ├── team-payments/
│   │   ├── applicationset.yaml      # Team-level ApplicationSet
│   │   └── apps/
│   │       ├── payment-api.yaml     # App config
│   │       ├── payment-worker.yaml
│   │       └── payment-db.yaml
│   ├── team-identity/
│   │   ├── applicationset.yaml
│   │   └── apps/
│   │       ├── auth-service.yaml
│   │       └── user-service.yaml
│   └── team-platform/
│       ├── applicationset.yaml
│       └── apps/
│           ├── cert-manager.yaml
│           └── external-dns.yaml
├── environments/
│   ├── dev.yaml
│   ├── staging.yaml
│   └── prod.yaml
└── root-applicationset.yaml
```

### Root ApplicationSet

```yaml
# root-applicationset.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: root-team-applicationsets
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/example/platform-config
        revision: HEAD
        files:
          - path: "teams/*/applicationset.yaml"

  template:
    metadata:
      name: "appset-{{path.basenameNormalized}}"
    spec:
      project: platform-ops
      source:
        repoURL: https://github.com/example/platform-config
        targetRevision: HEAD
        # Deploy the team's ApplicationSet YAML
        path: "{{path.dirpath}}"
        directory:
          include: "applicationset.yaml"
      destination:
        server: https://kubernetes.default.svc
        namespace: argocd
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### Team-Level ApplicationSet

```yaml
# teams/team-payments/applicationset.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: team-payments-services
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          # All environments
          - git:
              repoURL: https://github.com/example/platform-config
              revision: HEAD
              files:
                - path: "environments/*.yaml"
          # All services this team owns
          - git:
              repoURL: https://github.com/example/platform-config
              revision: HEAD
              files:
                - path: "teams/team-payments/apps/*.yaml"

  template:
    metadata:
      name: "payments-{{serviceName}}-{{environment}}"
      labels:
        team: payments
        service: "{{serviceName}}"
        environment: "{{environment}}"
    spec:
      project: "team-payments-{{environment}}"
      source:
        repoURL: "{{repoURL}}"
        targetRevision: "{{targetRevision}}"
        path: "{{helmPath}}"
        helm:
          valueFiles:
            - values.yaml
            - "values-{{environment}}.yaml"
          parameters:
            - name: global.environment
              value: "{{environment}}"
            - name: global.region
              value: "{{region}}"
      destination:
        server: "{{clusterServer}}"
        namespace: "team-payments"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

A team app config file:

```yaml
# teams/team-payments/apps/payment-api.yaml
serviceName: payment-api
repoURL: https://github.com/example/payment-api
helmPath: helm
targetRevision: HEAD
port: 8080
healthCheckPath: /healthz
resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

## ApplicationSet RBAC Hardening

The ApplicationSet controller has significant power — it can create and delete Applications across all projects. Harden it with strict RBAC.

### Controller Service Account

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: argocd-applicationset-controller
  namespace: argocd
---
# Minimal ClusterRole — only what ApplicationSet controller needs
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: argocd-applicationset-controller
rules:
  - apiGroups: ["argoproj.io"]
    resources: ["applications", "applicationsets", "applicationsets/status",
                "applicationsets/finalizers"]
    verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]
  - apiGroups: ["argoproj.io"]
    resources: ["appprojects"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create", "get", "list", "patch", "watch"]
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch"]
  # For cluster generator: read cluster secrets
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "watch"]
  # For Git generator webhook processing
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: argocd-applicationset-controller
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: argocd-applicationset-controller
subjects:
  - kind: ServiceAccount
    name: argocd-applicationset-controller
    namespace: argocd
```

### AppProject Scoping

Prevent ApplicationSets from deploying outside authorized namespaces and clusters:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-payments-prod
  namespace: argocd
spec:
  description: Payments team production workloads

  # Only allow source from authorized repos
  sourceRepos:
    - https://github.com/example/payment-api
    - https://github.com/example/payment-worker
    - https://github.com/example/platform-helm-charts

  # Only allow deployment to prod clusters, payments namespace
  destinations:
    - server: https://k8s-prod-us-east-1.example.com
      namespace: team-payments
    - server: https://k8s-prod-eu-west-1.example.com
      namespace: team-payments

  # Restrict which cluster-scoped resources can be managed
  clusterResourceWhitelist:
    - group: ""
      kind: Namespace

  # Only allow namespace-scoped resource types the app needs
  namespaceResourceWhitelist:
    - group: "apps"
      kind: Deployment
    - group: "apps"
      kind: StatefulSet
    - group: ""
      kind: Service
    - group: ""
      kind: ConfigMap
    - group: ""
      kind: ServiceAccount
    - group: "networking.k8s.io"
      kind: Ingress
    - group: "autoscaling"
      kind: HorizontalPodAutoscaler
    - group: "policy"
      kind: PodDisruptionBudget
    - group: "batch"
      kind: Job

  # RBAC roles within this project
  roles:
    - name: payments-deployer
      description: CI/CD automation for payments team
      policies:
        - p, proj:team-payments-prod:payments-deployer, applications, sync, team-payments-prod/*, allow
        - p, proj:team-payments-prod:payments-deployer, applications, get, team-payments-prod/*, allow
      jwtTokens:
        - iat: 1716940800

    - name: payments-viewer
      description: Read-only access for developers
      policies:
        - p, proj:team-payments-prod:payments-viewer, applications, get, team-payments-prod/*, allow

  # Namespace-scoped ApplicationSets: only this project
  permitOnlyProjectScopedClusters: true
```

### Namespace-Scoped ApplicationSets (ArgoCD 2.5+)

For multi-tenant ArgoCD, restrict ApplicationSets to a specific namespace with the `--applicationset-namespaces` flag:

```yaml
# In argocd-cmd-params-cm ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  # Allow teams to manage ApplicationSets in their own namespaces
  applicationsetcontroller.namespaces: "argocd,team-payments,team-identity,team-platform"
  # Require ApplicationSets to reference a project
  applicationsetcontroller.enable-progressive-syncs: "true"
  # Enable SCM provider generators (disabled by default for security)
  applicationsetcontroller.enable-scm-providers: "true"
  # Disable templating of Application metadata labels from generators
  # (prevents RBAC bypass via label injection)
  applicationsetcontroller.policy: sync
```

Teams create ApplicationSets in their own namespace:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: payment-services
  # Namespace-scoped: only manages Applications in this namespace's project
  namespace: team-payments
spec:
  generators:
    - git:
        repoURL: https://github.com/example/payment-api
        revision: HEAD
        directories:
          - path: services/*
  template:
    metadata:
      name: "payments-{{path.basename}}"
      namespace: team-payments   # Generated Applications also in this namespace
    spec:
      project: team-payments-prod  # Must reference authorized project
      # ...
```

## Webhook Integration for Fast Reconciliation

By default, the ApplicationSet controller polls Git repositories every 3 minutes. Configure webhooks for near-instant reconciliation:

```yaml
# argocd-notifications-cm equivalent for ApplicationSet webhooks
apiVersion: v1
kind: Service
metadata:
  name: argocd-applicationset-controller
  namespace: argocd
  labels:
    app.kubernetes.io/name: argocd-applicationset-controller
spec:
  ports:
    - name: webhook
      port: 7000
      targetPort: 7000
    - name: metrics
      port: 8085
      targetPort: 8085
  selector:
    app.kubernetes.io/name: argocd-applicationset-controller
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: argocd-applicationset-webhook
  namespace: argocd
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    # Restrict to GitHub webhook IPs
    nginx.ingress.kubernetes.io/whitelist-source-range: "192.30.252.0/22,185.199.108.0/22,140.82.112.0/20,143.55.64.0/20"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - argocd-webhook.example.com
      secretName: argocd-webhook-tls
  rules:
    - host: argocd-webhook.example.com
      http:
        paths:
          - path: /api/webhook
            pathType: Prefix
            backend:
              service:
                name: argocd-applicationset-controller
                port:
                  name: webhook
```

GitHub repository webhook configuration (via Terraform):

```hcl
resource "github_repository_webhook" "argocd_applicationset" {
  repository = "platform-config"

  configuration {
    url          = "https://argocd-webhook.example.com/api/webhook"
    content_type = "json"
    insecure_ssl = false
    secret       = var.webhook_secret
  }

  active = true

  events = ["push", "pull_request", "create", "delete"]
}
```

## Monitoring ApplicationSet Health

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: argocd-applicationset-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: argocd-applicationset
      interval: 30s
      rules:
        # ApplicationSet controller is down
        - alert: ArgoCDApplicationSetControllerDown
          expr: |
            absent(up{job="argocd-applicationset-controller"} == 1)
          for: 5m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "ArgoCD ApplicationSet controller is down"
            description: "The ApplicationSet controller has been unavailable for {{ $value }} minutes. No ApplicationSets will be reconciled."

        # Too many Applications in degraded state
        - alert: ArgoCDApplicationSetDegradedApplications
          expr: |
            (
              sum by (applicationset_name) (
                argocd_applicationset_info{health_status!="Healthy"}
              )
              /
              sum by (applicationset_name) (
                argocd_applicationset_info
              )
            ) > 0.2
          for: 10m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "More than 20% of Applications in ApplicationSet {{ $labels.applicationset_name }} are not Healthy"
            description: "{{ $value | humanizePercentage }} of Applications are unhealthy. Check ArgoCD UI for details."

        # ApplicationSet reconciliation errors
        - alert: ArgoCDApplicationSetReconcileError
          expr: |
            increase(argocd_applicationset_reconcile_total{outcome="error"}[15m]) > 0
          for: 0m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "ApplicationSet reconciliation errors"
            description: "ApplicationSet controller encountered {{ $value }} reconciliation errors in the last 15 minutes."

        # PR preview environments building up
        - alert: ArgoCDPRPreviewEnvironmentCount
          expr: |
            count(argocd_app_info{name=~"preview-pr-.*"}) > 20
          for: 5m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "High number of PR preview environments"
            description: "{{ $value }} PR preview environments are running. Review and merge/close stale PRs."

        # Application out of sync for too long
        - alert: ArgoCDApplicationOutOfSync
          expr: |
            sum by (name, project) (
              argocd_app_info{sync_status="OutOfSync",
                              operation="none",
                              name!~"preview-pr-.*"}
            ) > 0
          for: 30m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "ArgoCD Application {{ $labels.name }} is OutOfSync"
            description: "Application {{ $labels.name }} in project {{ $labels.project }} has been OutOfSync for more than 30 minutes."
```

## Grafana Dashboard for ApplicationSet Fleet Health

```json
{
  "title": "ArgoCD ApplicationSet Fleet",
  "panels": [
    {
      "title": "Total Applications by Status",
      "type": "stat",
      "targets": [
        {
          "expr": "sum by (health_status) (argocd_app_info)",
          "legendFormat": "{{health_status}}"
        }
      ]
    },
    {
      "title": "Applications per ApplicationSet",
      "type": "bargauge",
      "targets": [
        {
          "expr": "count by (applicationset_name) (argocd_app_info{applicationset_name!=\"\"})",
          "legendFormat": "{{applicationset_name}}"
        }
      ]
    },
    {
      "title": "Sync Lag (minutes since last sync)",
      "type": "heatmap",
      "targets": [
        {
          "expr": "(time() - argocd_app_info{sync_status=\"Synced\"}) / 60",
          "legendFormat": "{{name}}"
        }
      ]
    },
    {
      "title": "ApplicationSet Reconcile Duration",
      "type": "timeseries",
      "targets": [
        {
          "expr": "histogram_quantile(0.99, sum(rate(argocd_applicationset_reconcile_duration_seconds_bucket[5m])) by (le, applicationset_name))",
          "legendFormat": "p99 {{applicationset_name}}"
        }
      ]
    }
  ]
}
```

## Advanced Template Functions

ApplicationSet templates support Go template functions for advanced value manipulation:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: advanced-templating-example
  namespace: argocd
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            tier: backend
        values:
          # Raw cluster name: "prod-us-east-1"
          # We want: "prod", "us-east-1" separately
          environment: "{{index (splitList \"-\" .name) 0}}"
          region: "{{join \"-\" (rest (splitList \"-\" .name))}}"

  template:
    metadata:
      # Normalize name: replace dots and underscores with hyphens, lowercase
      name: "{{lower (replace \"_\" \"-\" (replace \".\" \"-\" .name))}}"
      labels:
        # Truncate to fit Kubernetes label value limits (63 chars)
        cluster: "{{trunc 63 .name}}"
    spec:
      project: "{{.values.environment}}"
      source:
        repoURL: https://github.com/example/charts
        targetRevision: HEAD
        path: charts/backend
        helm:
          parameters:
            - name: global.environment
              value: "{{.values.environment}}"
            - name: global.region
              value: "{{.values.region}}"
            # Conditional: use different image registry per region
            - name: global.imageRegistry
              value: >-
                {{- if eq .values.region "us-east-1" -}}
                  123456789012.dkr.ecr.us-east-1.amazonaws.com
                {{- else if eq .values.region "eu-west-1" -}}
                  123456789012.dkr.ecr.eu-west-1.amazonaws.com
                {{- else -}}
                  ghcr.io/example
                {{- end -}}
      destination:
        server: "{{.server}}"
        namespace: backend
```

## Drift Detection and Automated Remediation

For production ApplicationSets, combine ArgoCD's self-heal with notifications to alert on drift before it causes incidents:

```yaml
# argocd-notifications-cm
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  # Slack notification template for drift
  template.app-out-of-sync: |
    message: |
      :warning: Application *{{.app.metadata.name}}* is out of sync
      *Project:* {{.app.spec.project}}
      *Cluster:* {{.app.spec.destination.server}}
      *Sync Status:* {{.app.status.sync.status}}
      *Health:* {{.app.status.health.status}}
      {{range .app.status.sync.resources -}}
      {{if and (ne .status "Synced") (ne .status "") -}}
      - {{.kind}}/{{.name}}: {{.status}}
      {{end -}}
      {{end}}

  # Trigger: app is out of sync for more than 10 minutes
  trigger.on-out-of-sync: |
    - when: app.status.sync.status == 'OutOfSync' and time.Now().Sub(time.Parse(app.status.operationState.finishedAt)).Minutes() > 10
      send: [app-out-of-sync]

  service.slack: |
    token: $slack-token
    username: ArgoCD
    icon: ":argo:"

---
# Annotate ApplicationSet-generated Applications
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: production-services
  namespace: argocd
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            env: prod
  template:
    metadata:
      name: "prod-svc-{{name}}"
      annotations:
        # Enable notifications for all generated Applications
        notifications.argoproj.io/subscribe.on-out-of-sync.slack: "platform-alerts"
        notifications.argoproj.io/subscribe.on-sync-failed.slack: "platform-alerts"
        notifications.argoproj.io/subscribe.on-health-degraded.slack: "platform-alerts"
    spec:
      project: production
      # ...
```

## Debugging ApplicationSets

Common debugging commands when ApplicationSet generators are not producing expected Applications:

```bash
# List all ApplicationSets and their status
kubectl get applicationsets -n argocd -o wide

# Check the ApplicationSet controller logs for reconcile errors
kubectl logs -n argocd \
  -l app.kubernetes.io/name=argocd-applicationset-controller \
  --tail=100 \
  -f

# Describe an ApplicationSet to see generator output and conditions
kubectl describe applicationset frontend-app-all-clusters -n argocd

# List Applications generated by a specific ApplicationSet
kubectl get applications -n argocd \
  -l applicationset.argoproj.io/applicationset-name=frontend-app-all-clusters

# Check why a cluster generator isn't producing Applications
# (verify cluster secrets have correct labels)
kubectl get secrets -n argocd \
  -l argocd.argoproj.io/secret-type=cluster \
  -o custom-columns='NAME:.metadata.name,LABELS:.metadata.labels'

# Manually trigger reconciliation (force webhook)
kubectl annotate applicationset frontend-app-all-clusters \
  -n argocd \
  argocd.argoproj.io/reconcile="$(date)"

# View rendered template output without creating Applications
# Use --dry-run with the argocd CLI
argocd appset get frontend-app-all-clusters --dry-run

# Check ApplicationSet controller metrics
kubectl port-forward -n argocd \
  svc/argocd-applicationset-controller 8085:8085
curl http://localhost:8085/metrics | grep argocd_applicationset
```

### Common Issues and Fixes

**Generator produces no Applications:**

```bash
# Check that cluster selector labels match actual cluster secret labels
kubectl get secret -n argocd -l argocd.argoproj.io/secret-type=cluster \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels}{"\n"}{end}'

# Verify Git repo is accessible and path exists
argocd repo list
argocd repo get https://github.com/example/platform-config
```

**Application template renders incorrectly:**

```bash
# Use argocd CLI to test template rendering
argocd appset generate frontend-app-all-clusters

# Check for template syntax errors in ApplicationSet events
kubectl describe applicationset frontend-app-all-clusters -n argocd | grep -A 20 Events
```

**Applications stuck in OutOfSync after ApplicationSet update:**

```bash
# Force hard refresh on all Applications in the set
for app in $(kubectl get applications -n argocd \
  -l applicationset.argoproj.io/applicationset-name=production-services \
  -o name); do
  argocd app get "${app##*/}" --hard-refresh
done
```

**PR preview environments not cleaning up:**

```bash
# List all preview Applications
kubectl get applications -n argocd -l "app.kubernetes.io/instance=pr-preview" \
  -o custom-columns='NAME:.metadata.name,CREATED:.metadata.creationTimestamp'

# Check open PRs vs running preview Applications
argocd appset get pr-preview-environments -o json | \
  jq '.status.conditions'

# Manually delete stale preview Application (if PR is already closed)
argocd app delete preview-pr-999 --cascade
```

## Production Checklist

Before deploying ApplicationSets to manage production workloads:

```bash
# 1. Verify ApplicationSet controller HA
kubectl get pods -n argocd -l app.kubernetes.io/name=argocd-applicationset-controller
# Should show 2 running replicas

# 2. Confirm RBAC scoping
kubectl auth can-i create applications \
  --as=system:serviceaccount:argocd:argocd-applicationset-controller \
  -n argocd

# 3. Test sync wave ordering
argocd app sync production-service-wave-test \
  --dry-run \
  --prune

# 4. Verify sync windows are in effect
argocd proj windows list production

# 5. Check ApplicationSet generates the expected Application count
kubectl get applications -n argocd \
  -l applicationset.argoproj.io/applicationset-name=frontend-app-all-clusters \
  --no-headers | wc -l

# 6. Confirm Prometheus is scraping ApplicationSet metrics
kubectl get servicemonitor -n monitoring \
  -l app.kubernetes.io/name=argocd-applicationset-controller

# 7. Validate AppProject destination restrictions
argocd proj get production -o json | \
  jq '.spec.destinations'

# 8. Test webhook delivery (GitHub)
# Check recent webhook deliveries in GitHub repo settings
# Verify 200 response from ArgoCD webhook endpoint

# 9. Review preservedFields configuration
# Ensure critical annotations/labels are not overwritten by ApplicationSet updates
kubectl get applicationset frontend-app-all-clusters -n argocd \
  -o jsonpath='{.spec.preservedFields}'

# 10. Load test the controller with dry-run mass reconciliation
for i in {1..50}; do
  kubectl annotate applicationset frontend-app-all-clusters \
    -n argocd "test-reconcile-$i=$(date +%s)" --overwrite
done
kubectl logs -n argocd \
  -l app.kubernetes.io/name=argocd-applicationset-controller \
  --since=2m | grep "reconcile duration"
```

## Summary

ArgoCD ApplicationSets transform fleet GitOps from a manual, error-prone process into a declarative, self-reconciling system. The key patterns to internalize:

- **Cluster generator** for fleet-wide Application deployment with per-cluster label-driven configuration
- **Git directory generator** for monorepo service discovery with zero per-service configuration overhead
- **Matrix generator** for combinatorial environments-times-services deployments
- **Merge generator** for cluster-specific override injection on top of defaults
- **PullRequest generator** for ephemeral preview environments with full namespace isolation
- **SCM provider generator** for org-wide automatic onboarding of new repositories
- **Progressive sync waves** on both resource and cluster levels for safe rolling deployments
- **AppProject scoping** and namespace-scoped ApplicationSets for multi-tenant RBAC hardening
- **Sync windows** to enforce change freeze periods in production

The two-tier app-of-apps pattern (root ApplicationSet generating team ApplicationSets, team ApplicationSets generating service Applications) provides clean organizational boundaries while keeping the GitOps config DRY and auditable.
