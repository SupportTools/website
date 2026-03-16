---
title: "Kargo Progressive Delivery: GitOps-Driven Promotion Workflows Across Environments"
date: 2027-07-12T00:00:00-05:00
draft: false
tags: ["Kargo", "Progressive Delivery", "GitOps", "Kubernetes", "CI/CD"]
categories: ["DevOps", "Kubernetes", "CI/CD"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kargo progressive delivery covering promotion pipelines, Stage and Freight concepts, warehouse subscriptions, multi-environment promotion chains, ArgoCD integration, automated verification, and rollback automation."
more_link: "yes"
url: "/kargo-progressive-delivery-kubernetes-guide/"
---

Kargo addresses a critical gap in the GitOps ecosystem: the automated, policy-governed promotion of software changes across a chain of environments. While ArgoCD excels at synchronizing Git state to Kubernetes clusters, it provides no native mechanism for promoting a verified image tag or Git revision from development to staging to production with automated verification gates, approval workflows, and rollback capabilities. Kargo fills this gap with a purpose-built promotion engine that integrates tightly with ArgoCD while remaining tool-agnostic at the artifact layer.

<!--more-->

## Executive Summary

Progressive delivery extends continuous delivery by adding fine-grained control over the exposure of new software versions across environments and user populations. Kargo implements this paradigm through a first-class model of Warehouses (artifact sources), Freight (versioned artifact bundles), and Stages (promotion targets with verification gates). This guide demonstrates a complete Kargo deployment on Kubernetes: installation, ArgoCD integration, a three-stage promotion pipeline (dev → staging → production), automated verification using Kubernetes jobs and Argo Rollouts, manual approval gates, and rollback procedures.

## Kargo Architecture

### Core Concepts

```
Concept      Description
──────────────────────────────────────────────────────────────────────
Warehouse    Subscribes to artifact sources (image registries, Git repos,
             Helm repos) and produces Freight when new artifacts arrive
Freight      An immutable, versioned bundle of artifact references
             (image tags, Git SHAs, Helm chart versions)
Stage        A deployment target (e.g., dev, staging, production) with
             promotion policies and verification steps
Promotion    An operation that moves a specific Freight through a Stage,
             updating Git repositories and triggering ArgoCD sync
FreightRequest  A developer or automated request to promote Freight to a Stage
Analysis     A verification step that runs after promotion and gates
             advancement to the next Stage
```

### Promotion Flow

```
OCI Registry → new image tag
Git Repository → new commit
Helm Repo → new chart version
         ↓
    Warehouse detects change
         ↓
    Freight created (immutable artifact bundle)
         ↓
    Auto-promotion to Dev Stage
         ↓
    Verification (smoke tests, readiness checks)
         ↓
    Auto-promotion to Staging Stage
         ↓
    Analysis (integration tests, canary metrics)
         ↓
    Manual approval gate for Production
         ↓
    Production promotion with rollback on failure
```

### Component Architecture

```
kargo/
├── api-server          # REST/gRPC API + web UI
├── controller          # Stage reconciler, Promotion executor
├── webhooks            # Admission webhooks
├── garbage-collector   # Freight retention policy enforcement
└── management-controller # Kargo project lifecycle
```

## Installation

### Prerequisites

```bash
# Kargo requires cert-manager for webhook TLS
helm repo add jetstack https://charts.jetstack.io
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true \
  --wait

# ArgoCD (Kargo integrates natively)
helm repo add argo https://argoproj.github.io/argo-helm
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd \
  --create-namespace \
  --wait
```

### Kargo Installation

```bash
helm repo add kargo https://charts.kargo.akuity.io
helm repo update

helm upgrade --install kargo kargo/kargo \
  --namespace kargo \
  --create-namespace \
  --set api.adminAccount.enabled=true \
  --set api.adminAccount.passwordHash='$2a$10$Zrhhie4vLz5ygtVSaIF6UuIDcLXUW6YBB7TjJpFX/jxthUYyFRihu' \
  --set api.adminAccount.tokenSigningKey="replace-with-random-secret" \
  --set argocd.namespace=argocd \
  --wait

# Install Kargo CLI
curl -L https://github.com/akuity/kargo/releases/latest/download/kargo-linux-amd64 \
  -o /usr/local/bin/kargo
chmod +x /usr/local/bin/kargo

# Login
kargo login https://kargo.acme.internal \
  --admin \
  --password admin
```

### Verify Installation

```bash
kubectl get pods -n kargo
# NAME                                   READY   STATUS
# kargo-api-7d8b9f4c6-xvp2q             1/1     Running
# kargo-controller-5c8b9f4d8-kzl9m      1/1     Running
# kargo-garbage-collector-6d7f8c9b-jk4n  1/1     Running
# kargo-webhooks-server-4b5c6d7e-mn3p   1/1     Running

kargo version
# Client: v0.8.0
# Server: v0.8.0
```

## Project Setup

### Kargo Project

```yaml
# kargo/projects/payment-service.yaml
apiVersion: kargo.akuity.io/v1alpha1
kind: Project
metadata:
  name: payment-service
spec:
  promotionPolicies:
    - stage: dev
      autoPromotionEnabled: true
    - stage: staging
      autoPromotionEnabled: true
    - stage: production
      autoPromotionEnabled: false  # Requires manual approval
```

```bash
kubectl apply -f kargo/projects/payment-service.yaml
kargo get projects
```

### ArgoCD AppProject Integration

```yaml
# argocd/projects/payment-service.yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: payment-service
  namespace: argocd
spec:
  description: Payment service application project
  sourceRepos:
    - https://github.com/acme/payment-service-gitops
  destinations:
    - namespace: payments-dev
      server: https://kubernetes.default.svc
    - namespace: payments-staging
      server: https://kubernetes.default.svc
    - namespace: payments-production
      server: https://kubernetes.default.svc
  clusterResourceWhitelist:
    - group: ''
      kind: Namespace
  roles:
    - name: kargo-promoter
      description: Role for Kargo promotions
      policies:
        - p, proj:payment-service:kargo-promoter, applications, get, payment-service/*, allow
        - p, proj:payment-service:kargo-promoter, applications, sync, payment-service/*, allow
        - p, proj:payment-service:kargo-promoter, applications, update, payment-service/*, allow
```

## Warehouse Configuration

### Image Warehouse

```yaml
# kargo/warehouses/payment-service-warehouse.yaml
apiVersion: kargo.akuity.io/v1alpha1
kind: Warehouse
metadata:
  name: payment-service
  namespace: payment-service
spec:
  subscriptions:
    - image:
        repoURL: ghcr.io/acme/payment-service
        semverConstraint: ^1.0.0
        discoveryLimit: 10
    - git:
        repoURL: https://github.com/acme/payment-service-gitops
        branch: main
        includePaths:
          - helm/**
          - kustomize/**
```

### Helm Chart Warehouse

```yaml
# kargo/warehouses/platform-charts-warehouse.yaml
apiVersion: kargo.akuity.io/v1alpha1
kind: Warehouse
metadata:
  name: platform-charts
  namespace: payment-service
spec:
  subscriptions:
    - chart:
        repoURL: https://charts.acme.internal
        name: payment-service
        semverConstraint: ^2.0.0
```

### Viewing Freight

```bash
# List freight in warehouse
kargo get freight \
  --project payment-service

# Describe a specific freight
kargo get freight \
  --project payment-service \
  --name abc123def456

# Output:
# NAME            IMAGES                              COMMITS  CHARTS  AGE
# abc123def456   ghcr.io/acme/payment-service:1.2.3   1        0      5m
```

## Stage Configuration

### Development Stage

```yaml
# kargo/stages/dev-stage.yaml
apiVersion: kargo.akuity.io/v1alpha1
kind: Stage
metadata:
  name: dev
  namespace: payment-service
spec:
  requestedFreight:
    - origin:
        kind: Warehouse
        name: payment-service
      sources:
        direct: true  # Pull directly from warehouse

  promotionTemplate:
    spec:
      steps:
        - uses: git-clone
          config:
            repoURL: https://github.com/acme/payment-service-gitops
            checkout:
              - branch: main
                path: ./src

        - uses: git-open-pr
          as: open-pr
          config:
            repoURL: https://github.com/acme/payment-service-gitops
            targetBranch: env/dev
            title: "chore(dev): promote ${{ commitFrom('https://github.com/acme/payment-service-gitops', 'main').ShortID }}"

        - uses: yaml-update
          config:
            path: ./src/helm/values-dev.yaml
            updates:
              - key: image.tag
                value: ${{ imageFrom('ghcr.io/acme/payment-service').Tag }}

        - uses: git-commit
          config:
            path: ./src
            message: "chore(dev): promote payment-service to ${{ imageFrom('ghcr.io/acme/payment-service').Tag }}"

        - uses: git-push
          config:
            path: ./src
            targetBranch: env/dev

        - uses: argocd-update
          config:
            apps:
              - name: payment-service-dev
                namespace: argocd
                sources:
                  - repoURL: https://github.com/acme/payment-service-gitops
                    desiredRevision: ${{ commitFrom('https://github.com/acme/payment-service-gitops', 'main').ID }}

  verification:
    analysisTemplates:
      - name: smoke-tests

  # Auto-promote if verification passes
  promotionPolicy:
    autoPromoteWhenFreightAvailable: true
```

### Staging Stage

```yaml
# kargo/stages/staging-stage.yaml
apiVersion: kargo.akuity.io/v1alpha1
kind: Stage
metadata:
  name: staging
  namespace: payment-service
spec:
  requestedFreight:
    - origin:
        kind: Warehouse
        name: payment-service
      sources:
        stages:
          - dev  # Only promote freight that has passed dev

  promotionTemplate:
    spec:
      steps:
        - uses: git-clone
          config:
            repoURL: https://github.com/acme/payment-service-gitops
            checkout:
              - branch: main
                path: ./src

        - uses: yaml-update
          config:
            path: ./src/helm/values-staging.yaml
            updates:
              - key: image.tag
                value: ${{ imageFrom('ghcr.io/acme/payment-service').Tag }}
              - key: image.repository
                value: ghcr.io/acme/payment-service

        - uses: git-commit
          config:
            path: ./src
            message: "chore(staging): promote payment-service to ${{ imageFrom('ghcr.io/acme/payment-service').Tag }}"

        - uses: git-push
          config:
            path: ./src
            targetBranch: env/staging

        - uses: argocd-update
          config:
            apps:
              - name: payment-service-staging
                namespace: argocd
                sources:
                  - repoURL: https://github.com/acme/payment-service-gitops
                    desiredRevision: ${{ commitFrom('https://github.com/acme/payment-service-gitops', 'main').ID }}

  verification:
    analysisTemplates:
      - name: integration-tests
      - name: performance-baseline
    args:
      - name: minSuccessRate
        value: "99.5"

  promotionPolicy:
    autoPromoteWhenFreightAvailable: true
```

### Production Stage

```yaml
# kargo/stages/production-stage.yaml
apiVersion: kargo.akuity.io/v1alpha1
kind: Stage
metadata:
  name: production
  namespace: payment-service
spec:
  requestedFreight:
    - origin:
        kind: Warehouse
        name: payment-service
      sources:
        stages:
          - staging  # Only promote freight verified in staging

  promotionTemplate:
    spec:
      steps:
        - uses: git-clone
          config:
            repoURL: https://github.com/acme/payment-service-gitops
            checkout:
              - branch: main
                path: ./src

        - uses: yaml-update
          config:
            path: ./src/helm/values-production.yaml
            updates:
              - key: image.tag
                value: ${{ imageFrom('ghcr.io/acme/payment-service').Tag }}

        - uses: git-commit
          config:
            path: ./src
            message: "chore(production): promote payment-service to ${{ imageFrom('ghcr.io/acme/payment-service').Tag }}"

        - uses: git-push
          config:
            path: ./src
            targetBranch: env/production

        - uses: argocd-update
          config:
            apps:
              - name: payment-service-production
                namespace: argocd
                sources:
                  - repoURL: https://github.com/acme/payment-service-gitops
                    desiredRevision: ${{ commitFrom('https://github.com/acme/payment-service-gitops', 'main').ID }}

  verification:
    analysisTemplates:
      - name: production-smoke-test
      - name: error-rate-check
    args:
      - name: errorRateThreshold
        value: "0.5"

  # Production requires manual approval
  promotionPolicy:
    autoPromoteWhenFreightAvailable: false
```

## Verification Steps

### Smoke Test AnalysisTemplate

```yaml
# kargo/analysis/smoke-tests.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: smoke-tests
  namespace: payment-service
spec:
  args:
    - name: stage
      default: dev
    - name: namespace
      default: payments-dev
  metrics:
    - name: run-smoke-tests
      provider:
        job:
          metadata:
            labels:
              app: smoke-tests
          spec:
            backoffLimit: 2
            template:
              spec:
                restartPolicy: Never
                containers:
                  - name: smoke-tester
                    image: acme/platform-tools:latest
                    command: ["/bin/sh", "-c"]
                    args:
                      - |
                        set -e
                        BASE_URL="http://payment-service.{{args.namespace}}.svc.cluster.local"

                        echo "Testing health endpoint..."
                        curl -sf "$BASE_URL/healthz" || exit 1

                        echo "Testing readiness endpoint..."
                        curl -sf "$BASE_URL/readyz" || exit 1

                        echo "Testing API liveness..."
                        STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
                          "$BASE_URL/api/v1/payments/ping")
                        [ "$STATUS" = "200" ] || exit 1

                        echo "All smoke tests passed"
```

### Prometheus-Based Analysis

```yaml
# kargo/analysis/error-rate-check.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: error-rate-check
  namespace: payment-service
spec:
  args:
    - name: errorRateThreshold
      default: "1.0"
    - name: serviceName
      default: payment-service
  metrics:
    - name: error-rate
      interval: 1m
      count: 10
      successCondition: result < {{args.errorRateThreshold}}
      failureLimit: 3
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            sum(rate(http_requests_total{
              service="{{args.serviceName}}",
              status=~"5.."
            }[5m])) /
            sum(rate(http_requests_total{
              service="{{args.serviceName}}"
            }[5m])) * 100

    - name: p99-latency
      interval: 1m
      count: 10
      successCondition: result < 500
      failureLimit: 3
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            histogram_quantile(0.99,
              sum(rate(http_request_duration_seconds_bucket{
                service="{{args.serviceName}}"
              }[5m])) by (le)
            ) * 1000
```

### Performance Baseline Analysis

```yaml
# kargo/analysis/performance-baseline.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: performance-baseline
  namespace: payment-service
spec:
  args:
    - name: minSuccessRate
      default: "99.5"
    - name: maxP95LatencyMs
      default: "200"
  metrics:
    - name: success-rate
      interval: 2m
      count: 15
      successCondition: result >= {{args.minSuccessRate}}
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            sum(rate(http_requests_total{
              service="payment-service",
              status!~"5.."
            }[5m])) /
            sum(rate(http_requests_total{
              service="payment-service"
            }[5m])) * 100

    - name: p95-latency
      interval: 2m
      count: 15
      successCondition: result <= {{args.maxP95LatencyMs}}
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            histogram_quantile(0.95,
              sum(rate(http_request_duration_seconds_bucket{
                service="payment-service"
              }[5m])) by (le)
            ) * 1000
```

## Promotion Operations

### Manual Promotion Request

```bash
# Request promotion to production (manual approval required)
kargo promote \
  --project payment-service \
  --freight abc123def456 \
  --stage production

# Check promotion status
kargo get promotions \
  --project payment-service \
  --stage production

# NAME                          STAGE        FREIGHT        STATUS    AGE
# payment-service-prod-xyz789   production   abc123def456   Running   2m

# Watch promotion progress
kargo get promotions \
  --project payment-service \
  --stage production \
  --watch
```

### Approving Freight for Promotion

```bash
# Approve freight for production promotion
kargo approve \
  --project payment-service \
  --freight abc123def456 \
  --stage production

# View approval status
kubectl get freight abc123def456 \
  -n payment-service \
  -o jsonpath='{.status.approvals}'
```

### Freight Verification Status

```bash
# Check which stages a freight has been verified in
kubectl get freight abc123def456 \
  -n payment-service \
  -o yaml

# status:
#   verifiedIn:
#     dev: {}
#     staging: {}
#   approvedFor:
#     production: {}
```

## Promotion Policies

### Promotion Policy for Production Safety

```yaml
# Enforce staging verification before production promotion
apiVersion: kargo.akuity.io/v1alpha1
kind: Project
metadata:
  name: payment-service
spec:
  promotionPolicies:
    - stage: dev
      autoPromotionEnabled: true
    - stage: staging
      autoPromotionEnabled: true
    - stage: production
      autoPromotionEnabled: false
      # Freight must be verified in staging before production
```

### Freight Retention Policy

```yaml
# Keep last 10 freight objects per warehouse
apiVersion: kargo.akuity.io/v1alpha1
kind: Project
metadata:
  name: payment-service
spec:
  promotionPolicies:
    - stage: production
      autoPromotionEnabled: false
  freightRetentionPolicy:
    stages:
      - name: dev
        keepRecentFreight: 5
      - name: staging
        keepRecentFreight: 10
      - name: production
        keepRecentFreight: 20  # Keep more in production for rollback
```

## Rollback Automation

### Rolling Back a Stage

```bash
# List available freight for rollback
kargo get freight \
  --project payment-service \
  --verified-in production \
  --limit 10

# Promote a previous freight to roll back
kargo promote \
  --project payment-service \
  --freight previous-good-freight-sha \
  --stage production

# Monitor rollback
kargo get promotions \
  --project payment-service \
  --stage production \
  --watch
```

### Automated Rollback on Analysis Failure

```yaml
# Stage configuration with automatic rollback on verification failure
apiVersion: kargo.akuity.io/v1alpha1
kind: Stage
metadata:
  name: production
  namespace: payment-service
spec:
  verification:
    analysisTemplates:
      - name: error-rate-check
    # Rollback to previous Freight if verification fails
    rollback:
      disabled: false
  # ... rest of spec
```

### Rollback Notification

```yaml
# kargo/notifications/rollback-alert.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kargo-notifications-config
  namespace: kargo
data:
  trigger.on-promotion-failed: |
    - when: promotion.status.phase == 'Failed'
      send: [slack-on-failure]
  template.slack-on-failure: |
    message:
      text: |
        :red_circle: Promotion FAILED in {{ .app.metadata.namespace }}
        Stage: {{ .promotion.spec.stage }}
        Freight: {{ .promotion.spec.freight }}
        Error: {{ .promotion.status.message }}
        Rollback initiated automatically.
  service.slack: |
    token: $SLACK_TOKEN
    channels:
      - platform-alerts
```

## Monitoring Promotion Health

### Kargo Prometheus Metrics

```yaml
# monitoring/kargo-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kargo
  namespace: kargo
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: kargo
      app.kubernetes.io/component: controller
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

### PrometheusRule for Promotion Alerts

```yaml
# monitoring/kargo-prometheusrule.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kargo-alerts
  namespace: kargo
spec:
  groups:
    - name: kargo.promotions
      rules:
        - alert: KargoPromotionFailed
          expr: increase(kargo_promotion_failed_total[10m]) > 0
          labels:
            severity: warning
          annotations:
            summary: "Kargo promotion failed"
            description: "A promotion has failed in project {{ $labels.project }}, stage {{ $labels.stage }}"

        - alert: KargoPromotionStuck
          expr: |
            (time() - kargo_promotion_start_timestamp_seconds) > 1800
            and kargo_promotion_phase == 1
          labels:
            severity: warning
          annotations:
            summary: "Kargo promotion stuck for > 30 minutes"
            description: "Promotion {{ $labels.name }} in project {{ $labels.project }} has been running for over 30 minutes"

        - alert: KargoVerificationFailed
          expr: increase(kargo_verification_failed_total[10m]) > 0
          labels:
            severity: critical
          annotations:
            summary: "Kargo verification failed"
            description: "Verification failed for freight in project {{ $labels.project }}, stage {{ $labels.stage }}"

        - alert: KargoFreightStuck
          expr: |
            sum by (project) (kargo_freight_pending_count) > 5
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Large number of pending Freight in Kargo project"
```

### Grafana Dashboard Queries

```promql
# Promotion success rate over time
sum(rate(kargo_promotion_succeeded_total[1d])) by (project, stage) /
sum(rate(kargo_promotion_total[1d])) by (project, stage) * 100

# Average promotion duration by stage
avg by (project, stage) (kargo_promotion_duration_seconds)

# Freight age before promotion (deployment lead time component)
avg by (project, stage) (
  kargo_promotion_start_timestamp_seconds - kargo_freight_created_timestamp_seconds
)
```

## Multi-Cluster Promotion

### Cross-Cluster Stage Configuration

```yaml
# kargo/stages/production-multi-cluster.yaml
apiVersion: kargo.akuity.io/v1alpha1
kind: Stage
metadata:
  name: production-us-east
  namespace: payment-service
spec:
  requestedFreight:
    - origin:
        kind: Warehouse
        name: payment-service
      sources:
        stages:
          - staging

  promotionTemplate:
    spec:
      steps:
        - uses: argocd-update
          config:
            apps:
              - name: payment-service-prod-us-east
                namespace: argocd
                # ArgoCD managing remote cluster
                sources:
                  - repoURL: https://github.com/acme/payment-service-gitops
                    desiredRevision: ${{ commitFrom('https://github.com/acme/payment-service-gitops', 'main').ID }}
---
apiVersion: kargo.akuity.io/v1alpha1
kind: Stage
metadata:
  name: production-eu-west
  namespace: payment-service
spec:
  requestedFreight:
    - origin:
        kind: Warehouse
        name: payment-service
      sources:
        stages:
          - production-us-east  # EU follows US production
```

## ArgoCD Integration Deep Dive

### ArgoCD Application Definitions

```yaml
# argocd/applications/payment-service-dev.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payment-service-dev
  namespace: argocd
  annotations:
    kargo.akuity.io/authorized-stage: payment-service:dev
spec:
  project: payment-service
  source:
    repoURL: https://github.com/acme/payment-service-gitops
    targetRevision: env/dev
    path: helm
    helm:
      valueFiles:
        - values.yaml
        - values-dev.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: payments-dev
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payment-service-staging
  namespace: argocd
  annotations:
    kargo.akuity.io/authorized-stage: payment-service:staging
spec:
  project: payment-service
  source:
    repoURL: https://github.com/acme/payment-service-gitops
    targetRevision: env/staging
    path: helm
    helm:
      valueFiles:
        - values.yaml
        - values-staging.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: payments-staging
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payment-service-production
  namespace: argocd
  annotations:
    kargo.akuity.io/authorized-stage: payment-service:production
spec:
  project: payment-service
  source:
    repoURL: https://github.com/acme/payment-service-gitops
    targetRevision: env/production
    path: helm
    helm:
      valueFiles:
        - values.yaml
        - values-production.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: payments-production
  syncPolicy:
    syncOptions:
      - CreateNamespace=true
    # No auto-sync for production — Kargo controls timing
```

## GitOps Repository Structure for Kargo

### Multi-Environment Repository Layout

```
payment-service-gitops/
├── helm/
│   ├── Chart.yaml
│   ├── values.yaml            # Base values (no image tag)
│   ├── values-dev.yaml        # ← Updated by Kargo dev stage
│   ├── values-staging.yaml    # ← Updated by Kargo staging stage
│   └── values-production.yaml # ← Updated by Kargo prod stage
├── kustomize/
│   ├── base/
│   └── overlays/
│       ├── dev/
│       ├── staging/
│       └── production/
└── kargo/
    ├── project.yaml
    ├── warehouse.yaml
    └── stages/
        ├── dev.yaml
        ├── staging.yaml
        └── production.yaml
```

### Values Files Pattern

```yaml
# helm/values.yaml (base - no image tag)
replicaCount: 1
image:
  repository: ghcr.io/acme/payment-service
  pullPolicy: IfNotPresent
  tag: ""  # Always set by Kargo

service:
  type: ClusterIP
  port: 8080

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi
---
# helm/values-dev.yaml (updated by Kargo)
image:
  tag: "1.2.3"  # ← Kargo writes here

replicaCount: 1
resources:
  requests:
    cpu: 50m
    memory: 64Mi
---
# helm/values-production.yaml (updated by Kargo)
image:
  tag: "1.2.3"  # ← Kargo writes here

replicaCount: 5
resources:
  requests:
    cpu: 500m
    memory: 512Mi
  limits:
    cpu: 2000m
    memory: 2Gi

podDisruptionBudget:
  enabled: true
  minAvailable: 2
```

## Operational Troubleshooting

### Common Issues and Resolutions

```bash
# Freight not being discovered
# Check warehouse logs
kubectl logs -n kargo \
  -l app.kubernetes.io/component=controller \
  --since=30m | grep -i "warehouse\|freight\|discover"

# Check warehouse status
kubectl describe warehouse payment-service \
  -n payment-service

# Promotion stuck in Running
# Check promotion details
kubectl describe promotion \
  payment-service-prod-xyz789 \
  -n payment-service

# View promotion steps
kubectl get promotion payment-service-prod-xyz789 \
  -n payment-service \
  -o jsonpath='{.status.steps}' | jq .

# ArgoCD sync not triggered
# Verify ArgoCD credentials in Kargo
kubectl get secret argocd-creds \
  -n kargo \
  -o jsonpath='{.data}' | base64 -d

# Check ArgoCD application annotation
kubectl get application payment-service-production \
  -n argocd \
  -o jsonpath='{.metadata.annotations}'

# Force re-reconcile a stage
kubectl annotate stage production \
  -n payment-service \
  kargo.akuity.io/reconcile="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

### Kargo Audit Log

```bash
# View all promotion events for audit
kubectl get events \
  -n payment-service \
  --field-selector reason=Promoted \
  --sort-by='.lastTimestamp'

# Export promotion history to CSV
kubectl get promotions \
  -n payment-service \
  -o json | jq -r \
  '.items[] | [.metadata.name, .spec.stage, .spec.freight, .status.phase, .metadata.creationTimestamp] | @csv'
```

## Summary

Kargo provides the missing orchestration layer between artifact production and multi-environment delivery that pure GitOps tools like ArgoCD cannot address natively. By modeling Warehouses, Freight, and Stages as first-class Kubernetes resources, Kargo creates a declarative promotion pipeline where every state transition is auditable, every verification step is automated, and every approval decision is explicit. The integration with ArgoCD ensures that actual Kubernetes state always reflects Git state, while Kargo controls which Git state gets applied when and under what conditions. Organizations adopting Kargo consistently reduce deployment-related incidents through mandatory verification gates and gain audit trails that satisfy compliance requirements without imposing manual overhead on engineering teams.
