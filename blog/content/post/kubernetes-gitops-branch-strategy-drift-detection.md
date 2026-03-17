---
title: "Kubernetes GitOps Patterns: Branch Strategy, Environment Promotion, and Drift Detection"
date: 2030-01-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "GitOps", "ArgoCD", "Flux", "Environment Promotion", "Drift Detection", "Multi-tenancy"]
categories: ["Kubernetes", "GitOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise GitOps repository structure, environment promotion workflows with Flux and ArgoCD, automated drift detection and remediation, and multi-tenancy patterns for large engineering organizations."
more_link: "yes"
url: "/kubernetes-gitops-branch-strategy-drift-detection/"
---

GitOps is not a tool — it is a set of operational practices where Git is the single source of truth for all cluster state. The gap between knowing this principle and implementing it at enterprise scale is substantial. A 50-team organization with 8 clusters, multiple promotion tiers, shared platform services, and strict audit requirements needs careful repository structure, automated promotion gates, and continuous drift detection. This guide presents production-proven patterns built on Flux v2 and ArgoCD that scale from a handful of services to hundreds.

<!--more-->

# Kubernetes GitOps Patterns: Branch Strategy, Environment Promotion, and Drift Detection

## Repository Structure

The most consequential decision in a GitOps implementation is how to organize repositories. There are three dominant patterns:

### Pattern 1: Monorepo (All Environments, All Apps)

```
gitops/
├── clusters/
│   ├── dev/
│   │   └── flux-system/
│   ├── staging/
│   │   └── flux-system/
│   └── production/
│       └── flux-system/
├── apps/
│   ├── payment-service/
│   │   ├── base/
│   │   └── overlays/
│   │       ├── dev/
│   │       ├── staging/
│   │       └── production/
│   └── inventory-service/
│       ├── base/
│       └── overlays/
└── infrastructure/
    ├── controllers/
    ├── monitoring/
    └── networking/
```

**When to use**: Small to medium organizations (< 20 services), tight environment coupling, strong GitOps newcomers.

### Pattern 2: App-of-Apps with Separate Environment Repos (Recommended for Enterprise)

```
# Three repository types:

# 1. App source code repos (owned by dev teams)
payment-service/          <- team repo
  src/
  Dockerfile
  helm/
    payment-service/
      Chart.yaml
      values.yaml

# 2. Environment configuration repos (owned by platform team)
gitops-environments/
├── dev/
│   ├── kustomization.yaml
│   └── apps/
│       ├── payment-service.yaml
│       └── inventory-service.yaml
├── staging/
│   ├── kustomization.yaml
│   └── apps/
└── production/
    ├── kustomization.yaml
    └── apps/

# 3. Infrastructure repo (owned by platform team)
gitops-infrastructure/
├── controllers/
├── monitoring/
├── networking/
└── security/
```

**When to use**: Large organizations with separate dev/platform teams, different promotion cadences per environment.

### Pattern 3: Per-Cluster Config Repos

This pattern creates one config repo per cluster, with a registry repo as the source of truth:

```
# Registry repo (maps app versions to environments)
app-registry/
├── payment-service/
│   ├── dev.yaml       # image: v1.2.4
│   ├── staging.yaml   # image: v1.2.3
│   └── production.yaml # image: v1.2.2
└── inventory-service/
    ├── dev.yaml
    ├── staging.yaml
    └── production.yaml

# Cluster repos (generated from registry)
cluster-dev/
cluster-staging/
cluster-production/
```

**When to use**: Organizations with strict environment separation, compliance requirements, or multiple cloud providers.

## Implementing the Enterprise Pattern

### Repository Layout

```
gitops-config/
├── README.md
├── .github/
│   └── workflows/
│       ├── validate.yml
│       ├── promote-to-staging.yml
│       └── promote-to-production.yml
├── clusters/
│   ├── dev/
│   │   ├── flux-system/
│   │   │   ├── gotk-components.yaml
│   │   │   └── gotk-sync.yaml
│   │   ├── infrastructure.yaml
│   │   └── apps.yaml
│   ├── staging/
│   │   ├── flux-system/
│   │   ├── infrastructure.yaml
│   │   └── apps.yaml
│   └── production/
│       ├── flux-system/
│       ├── infrastructure.yaml
│       └── apps.yaml
├── infrastructure/
│   ├── base/
│   │   ├── cert-manager/
│   │   ├── ingress-nginx/
│   │   ├── monitoring/
│   │   └── external-secrets/
│   └── overlays/
│       ├── dev/
│       ├── staging/
│       └── production/
└── apps/
    ├── base/
    │   ├── payment-service/
    │   │   ├── kustomization.yaml
    │   │   ├── helmrelease.yaml
    │   │   └── namespace.yaml
    │   └── inventory-service/
    └── overlays/
        ├── dev/
        │   ├── kustomization.yaml
        │   └── payment-service-values.yaml
        ├── staging/
        └── production/
```

### Flux Cluster Bootstrap

```bash
# Bootstrap the production cluster
flux bootstrap github \
  --owner=company \
  --repository=gitops-config \
  --branch=main \
  --path=clusters/production \
  --personal=false \
  --network-policy=true \
  --components-extra=image-reflector-controller,image-automation-controller

# Verify flux is running
flux get all -A
```

### Flux Kustomization Hierarchy

```yaml
# clusters/production/infrastructure.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: infrastructure
  namespace: flux-system
spec:
  interval: 10m
  retryInterval: 1m
  timeout: 5m
  sourceRef:
    kind: GitRepository
    name: flux-system
  path: ./infrastructure/overlays/production
  prune: true
  wait: true
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
    substitute:
      CLUSTER_NAME: production
      CLUSTER_REGION: us-east-1
      ALERT_WEBHOOK: ""  # Set in cluster-level secret
---
# clusters/production/apps.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: apps
  namespace: flux-system
spec:
  interval: 5m
  retryInterval: 30s
  timeout: 5m
  sourceRef:
    kind: GitRepository
    name: flux-system
  path: ./apps/overlays/production
  prune: true
  dependsOn:
    - name: infrastructure
  postBuild:
    substituteFrom:
      - kind: ConfigMap
        name: cluster-vars
      - kind: Secret
        name: cluster-secrets
```

### HelmRelease with Progressive Delivery

```yaml
# apps/base/payment-service/helmrelease.yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: payment-service
  namespace: production
spec:
  interval: 5m
  chart:
    spec:
      chart: payment-service
      version: ">=1.0.0 <2.0.0"
      sourceRef:
        kind: HelmRepository
        name: company-charts
        namespace: flux-system
      interval: 1m

  # Upgrade strategy with rollback
  upgrade:
    remediation:
      retries: 3
      strategy: rollback
      remediateLastFailure: true
  rollback:
    cleanupOnFail: true
    recreate: false
    timeout: 10m
  install:
    remediation:
      retries: 3

  # Values from the base chart
  values:
    replicaCount: 2
    resources:
      requests:
        cpu: "100m"
        memory: "256Mi"

  # Environment-specific values are patched in overlays
  valuesFrom:
    - kind: ConfigMap
      name: payment-service-values
      valuesKey: values.yaml
    - kind: Secret
      name: payment-service-secrets
      valuesKey: values.yaml
      optional: true

  # Pod disruption budget
  postRenderers:
    - kustomize:
        patches:
          - target:
              group: policy
              version: v1
              kind: PodDisruptionBudget
            patch: |
              - op: replace
                path: /spec/minAvailable
                value: 1
```

## Environment Promotion Workflows

### Automated Image Updates with Flux

```yaml
# Flux ImageRepository - polls container registry for new tags
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: payment-service
  namespace: flux-system
spec:
  image: registry.company.com/payment-service
  interval: 1m
  secretRef:
    name: registry-credentials
---
# ImagePolicy - selects which tag to use
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: payment-service-dev
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: payment-service
  # In dev: always use the latest image tagged with the PR/branch
  filterTags:
    pattern: '^pr-\d+-.+$'
    extract: '$branch'
  policy:
    semver:
      range: '*'
---
# For staging: semver pre-release tags only
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: payment-service-staging
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: payment-service
  filterTags:
    pattern: '^v\d+\.\d+\.\d+-rc\.\d+$'
    extract: '$version'
  policy:
    semver:
      range: '>=1.0.0-rc.0 <2.0.0'
---
# For production: stable semver releases only
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: payment-service-production
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: payment-service
  filterTags:
    pattern: '^v\d+\.\d+\.\d+$'
    extract: '$version'
  policy:
    semver:
      range: '>=1.0.0 <2.0.0'
---
# ImageUpdateAutomation - commits image changes to Git
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: flux-image-updates
  namespace: flux-system
spec:
  interval: 10m
  sourceRef:
    kind: GitRepository
    name: flux-system
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxcdbot@company.com
        name: Flux Image Updater
      messageTemplate: |
        chore: Update {{ .Updated.Image }} to {{ .Updated.NewValue }}

        Updated by: Flux Image Update Automation
        Repository: {{ .Updated.Repository }}
    push:
      branch: main
  update:
    strategy: Setters
    path: ./apps/overlays
```

### Promotion Pipeline with GitHub Actions

```yaml
# .github/workflows/promote-to-staging.yml
name: Promote to Staging

on:
  workflow_dispatch:
    inputs:
      service:
        description: 'Service to promote'
        required: true
        type: string
      version:
        description: 'Version tag to promote (e.g. v1.2.3-rc.1)'
        required: true
        type: string

  # Auto-trigger when dev stabilizes
  push:
    branches:
      - main
    paths:
      - 'apps/overlays/dev/**'

jobs:
  validate-dev-health:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install flux CLI
        run: |
          curl -s https://fluxcd.io/install.sh | sudo bash

      - name: Check dev cluster health
        env:
          KUBECONFIG_DEV: ${{ secrets.KUBECONFIG_DEV }}
        run: |
          echo "$KUBECONFIG_DEV" > /tmp/kubeconfig-dev
          export KUBECONFIG=/tmp/kubeconfig-dev

          # Check all Flux kustomizations are ready
          flux get kustomizations --all-namespaces | \
            awk '/False/ {failed++} END {if (failed > 0) exit 1}'

          # Check all HelmReleases are deployed
          flux get helmreleases --all-namespaces | \
            awk '/False/ {failed++} END {if (failed > 0) exit 1}'

  run-integration-tests:
    needs: validate-dev-health
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run integration tests against dev
        env:
          TEST_ENDPOINT: ${{ secrets.DEV_API_ENDPOINT }}
          TEST_TOKEN: ${{ secrets.DEV_TEST_TOKEN }}
        run: |
          cd tests/integration
          go test -v -timeout 10m ./...

  check-slo-budget:
    needs: run-integration-tests
    runs-on: ubuntu-latest
    steps:
      - name: Check error budget before promotion
        env:
          PROMETHEUS_URL: ${{ secrets.PROMETHEUS_URL }}
        run: |
          BUDGET=$(curl -s -G \
            --data-urlencode 'query=slo:error_budget_remaining_percent{env="dev",service="${{ github.event.inputs.service }}"}' \
            "$PROMETHEUS_URL/api/v1/query" | \
            jq -r '.data.result[0].value[1] // "100"')

          echo "Error budget remaining: $BUDGET%"
          if (( $(echo "$BUDGET < 25" | bc -l) )); then
            echo "Insufficient error budget ($BUDGET%), blocking promotion"
            exit 1
          fi

  promote-to-staging:
    needs: [check-slo-budget]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITHUB_PAT }}

      - name: Update staging image version
        run: |
          SERVICE="${{ github.event.inputs.service }}"
          VERSION="${{ github.event.inputs.version }}"

          # Update the image tag in the staging overlay
          OVERLAY_FILE="apps/overlays/staging/${SERVICE}/kustomization.yaml"
          yq -i ".images[0].newTag = \"$VERSION\"" "$OVERLAY_FILE"

          git config user.email "promotion-bot@company.com"
          git config user.name "Promotion Bot"
          git add "$OVERLAY_FILE"
          git commit -m "chore: promote $SERVICE to staging at $VERSION"
          git push

      - name: Wait for Flux reconciliation
        env:
          KUBECONFIG_STAGING: ${{ secrets.KUBECONFIG_STAGING }}
        run: |
          echo "$KUBECONFIG_STAGING" > /tmp/kubeconfig-staging
          export KUBECONFIG=/tmp/kubeconfig-staging

          flux reconcile kustomization apps --timeout=5m
          kubectl rollout status deployment/${{ github.event.inputs.service }} \
            -n staging --timeout=10m

      - name: Create promotion record
        run: |
          curl -s -X POST \
            -H "Content-Type: application/json" \
            -d "{
              \"service\": \"${{ github.event.inputs.service }}\",
              \"version\": \"${{ github.event.inputs.version }}\",
              \"environment\": \"staging\",
              \"promoted_by\": \"${{ github.actor }}\",
              \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
            }" \
            "${{ secrets.AUDIT_WEBHOOK_URL }}"
```

## Drift Detection

### Flux Drift Detection

Flux's `prune: true` setting handles the most common form of drift — resources applied outside of Git. But detecting drift without immediate remediation requires a monitoring approach:

```go
// pkg/driftdetector/detector.go
package driftdetector

import (
    "context"
    "fmt"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/dynamic"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

var (
    driftedResources = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "gitops_drift_resources_count",
            Help: "Number of resources that have drifted from desired state",
        },
        []string{"namespace", "kind", "source"},
    )

    lastDriftCheck = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "gitops_drift_last_check_timestamp",
            Help: "Timestamp of last drift detection check",
        },
        []string{"cluster"},
    )
)

// DriftReport describes the current drift state
type DriftReport struct {
    ClusterName    string
    CheckedAt      time.Time
    DriftedItems   []DriftItem
    TotalManaged   int
    TotalDrifted   int
}

type DriftItem struct {
    Kind        string
    Namespace   string
    Name        string
    DriftType   string
    Details     string
}

// FluxDriftDetector checks for drift by examining Flux Kustomization status
type FluxDriftDetector struct {
    client      client.Client
    clusterName string
    interval    time.Duration
}

func NewFluxDriftDetector(c client.Client, cluster string) *FluxDriftDetector {
    return &FluxDriftDetector{
        client:      c,
        clusterName: cluster,
        interval:    5 * time.Minute,
    }
}

func (d *FluxDriftDetector) Start(ctx context.Context) {
    ticker := time.NewTicker(d.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            report, err := d.Check(ctx)
            if err != nil {
                fmt.Printf("drift check error: %v\n", err)
                continue
            }
            d.recordMetrics(report)
        }
    }
}

func (d *FluxDriftDetector) Check(ctx context.Context) (*DriftReport, error) {
    report := &DriftReport{
        ClusterName: d.clusterName,
        CheckedAt:   time.Now(),
    }

    // Check Flux Kustomization drift markers
    kustomizations, err := d.getKustomizations(ctx)
    if err != nil {
        return nil, err
    }

    for _, k := range kustomizations {
        report.TotalManaged++

        // Check for OutOfSync condition
        for _, cond := range k.Status.Conditions {
            if cond.Type == "Ready" && cond.Status == "False" {
                if cond.Reason == "ReconciliationFailed" ||
                   cond.Reason == "ArtifactFailed" {
                    report.DriftedItems = append(report.DriftedItems, DriftItem{
                        Kind:      "Kustomization",
                        Namespace: k.Namespace,
                        Name:      k.Name,
                        DriftType: cond.Reason,
                        Details:   cond.Message,
                    })
                }
            }
        }
    }

    report.TotalDrifted = len(report.DriftedItems)
    return report, nil
}

func (d *FluxDriftDetector) recordMetrics(report *DriftReport) {
    lastDriftCheck.WithLabelValues(d.clusterName).
        Set(float64(report.CheckedAt.Unix()))

    // Reset counters before setting new values
    driftedResources.Reset()

    for _, item := range report.DriftedItems {
        driftedResources.WithLabelValues(
            item.Namespace, item.Kind, d.clusterName,
        ).Inc()
    }

    if report.TotalDrifted > 0 {
        fmt.Printf("[Drift] %d/%d resources drifted in %s\n",
            report.TotalDrifted, report.TotalManaged, d.clusterName)
        for _, item := range report.DriftedItems {
            fmt.Printf("  - %s/%s (%s): %s\n",
                item.Namespace, item.Name, item.DriftType, item.Details)
        }
    }
}
```

### ArgoCD Drift Detection and Auto-Remediation

```yaml
# ArgoCD Application with sync policies
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payment-service
  namespace: argocd
  annotations:
    notifications.argoproj.io/subscribe.on-sync-failed.slack: platform-alerts
    notifications.argoproj.io/subscribe.on-deployed.slack: deployments
    notifications.argoproj.io/subscribe.on-health-degraded.slack: platform-alerts
spec:
  project: production
  source:
    repoURL: https://github.com/company/gitops-config
    targetRevision: main
    path: apps/overlays/production/payment-service
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true          # Remove resources not in Git
      selfHeal: true       # Re-apply when resources are mutated
      allowEmpty: false    # Prevent accidental deletion of all resources
    syncOptions:
      - Validate=true
      - CreateNamespace=false  # Namespace must be pre-created by platform
      - PrunePropagationPolicy=foreground
      - PruneLast=true
      - RespectIgnoreDifferences=true
      - ApplyOutOfSyncOnly=true  # Only sync changed resources
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m

  # Ignore fields that change legitimately outside of Git
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas  # HPA manages this
    - group: ""
      kind: ConfigMap
      name: kube-root-ca.crt
      jsonPointers:
        - /data
    - group: autoscaling
      kind: HorizontalPodAutoscaler
      jsonPointers:
        - /spec/metrics  # VPA can modify this
```

### ArgoCD Drift Notifications

```yaml
# ArgoCD Notification ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  trigger.on-out-of-sync: |
    - send: [app-out-of-sync]
      when: app.status.sync.status == 'OutOfSync'
  trigger.on-degraded: |
    - send: [app-degraded]
      when: app.status.health.status == 'Degraded'

  template.app-out-of-sync: |
    message: |
      Application *{{.app.metadata.name}}* is out of sync.
      Sync Status: `{{.app.status.sync.status}}`
      Environment: `{{.app.spec.destination.server}}`
      Revision: `{{.app.status.sync.revision | trunc 7}}`
    slack:
      attachments: |
        [{
          "color": "warning",
          "title": "{{.app.metadata.name}} - Sync Failed",
          "fields": [
            {"title": "Application", "value": "{{.app.metadata.name}}", "short": true},
            {"title": "Namespace", "value": "{{.app.spec.destination.namespace}}", "short": true},
            {"title": "Sync Status", "value": "{{.app.status.sync.status}}", "short": true},
            {"title": "Author", "value": "{{(call .repo.GetCommitMetadata .app.status.sync.revision).Author}}", "short": true}
          ]
        }]

  template.app-degraded: |
    message: |
      Application *{{.app.metadata.name}}* health is *{{.app.status.health.status}}*
    slack:
      attachments: |
        [{
          "color": "danger",
          "title": "{{.app.metadata.name}} - Degraded Health",
          "text": "{{.app.status.health.message}}"
        }]
```

## Multi-Tenancy Patterns

### Namespace-per-Team with Shared Platform

```yaml
# ArgoCD AppProject for payment team
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: payment-team
  namespace: argocd
spec:
  description: Payment team applications
  sourceRepos:
    - 'https://github.com/company/payment-service'
    - 'https://github.com/company/gitops-config'
  destinations:
    - namespace: payment-*
      server: https://kubernetes.default.svc
  # Payment team cannot touch shared infrastructure namespaces
  clusterResourceWhitelist: []  # No cluster-scoped resources
  namespaceResourceBlacklist:
    - group: ""
      kind: ResourceQuota  # Platform team manages quotas
    - group: networking.k8s.io
      kind: NetworkPolicy  # Platform team manages network policies
  roles:
    - name: payment-deployer
      description: CI/CD service account for payment team
      policies:
        - p, proj:payment-team:payment-deployer, applications, sync, payment-team/*, allow
        - p, proj:payment-team:payment-deployer, applications, get, payment-team/*, allow
      groups:
        - payment-team-leads
    - name: payment-readonly
      policies:
        - p, proj:payment-team:payment-readonly, applications, get, payment-team/*, allow
      groups:
        - payment-team
```

### Resource Quotas via GitOps

```yaml
# infrastructure/base/namespaces/payment-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: payment
  labels:
    team: payment
    environment: production
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: payment-quota
  namespace: payment
spec:
  hard:
    requests.cpu: "8"
    requests.memory: "16Gi"
    limits.cpu: "16"
    limits.memory: "32Gi"
    persistentvolumeclaims: "20"
    count/deployments.apps: "20"
    count/services: "20"
    pods: "50"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: payment-limits
  namespace: payment
spec:
  limits:
    - type: Container
      default:
        cpu: "500m"
        memory: "512Mi"
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
      max:
        cpu: "4"
        memory: "8Gi"
    - type: PersistentVolumeClaim
      max:
        storage: "100Gi"
```

### Platform Team Umbrella Application

```yaml
# ArgoCD App-of-Apps for platform team
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: platform-apps
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/company/gitops-config
        revision: main
        directories:
          - path: "apps/platform/*"
  template:
    metadata:
      name: '{{path.basename}}'
      annotations:
        notifications.argoproj.io/subscribe.on-health-degraded.slack: platform-alerts
    spec:
      project: platform
      source:
        repoURL: https://github.com/company/gitops-config
        targetRevision: main
        path: '{{path}}'
      destination:
        server: https://kubernetes.default.svc
        namespace: '{{path.basename}}'
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

## Audit and Compliance

### GitOps Audit Trail

Every change to cluster state should be traceable to a Git commit. This configuration enforces that:

```yaml
# Flux Kustomization with source tracking
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: apps
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: flux-system
  path: ./apps/overlays/production
  prune: true
  # Add Git metadata as labels/annotations to all deployed resources
  postBuild:
    substitute:
      GIT_COMMIT: "${FLUX_REVISION}"
      GIT_REPO: "gitops-config"
  patches:
    - patch: |
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: not-used
          annotations:
            gitops.company.com/source-revision: "${FLUX_REVISION}"
            gitops.company.com/source-repo: "${GIT_REPO}"
            gitops.company.com/last-applied: "${FLUX_TIMESTAMP}"
      target:
        kind: Deployment
```

### Change Approval Gates

```yaml
# GitHub branch protection rules (via Terraform)
resource "github_branch_protection" "production" {
  repository_id = github_repository.gitops_config.node_id
  pattern       = "main"

  required_status_checks {
    strict   = true
    contexts = [
      "validate-manifests",
      "check-slo-budget",
      "security-scan"
    ]
  }

  required_pull_request_reviews {
    required_approving_review_count = 2
    require_code_owner_reviews      = true
    dismiss_stale_reviews           = true
  }

  restrict_pushes {
    push_allowances = [
      # Only the Flux image updater bot can push directly
      "company/flux-image-updater"
    ]
  }
}
```

## Monitoring the GitOps System

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: gitops-alerts
  namespace: monitoring
spec:
  groups:
    - name: gitops.alerts
      rules:
        - alert: FluxKustomizationNotReady
          expr: |
            gotk_reconcile_condition{
              type="Ready",
              status="False",
              kind="Kustomization"
            } == 1
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Flux Kustomization {{ $labels.name }} is not ready"
            description: "Kustomization {{ $labels.name }} in {{ $labels.namespace }} has been failing for 10 minutes."

        - alert: FluxReconciliationLag
          expr: |
            time() - gotk_reconcile_duration_seconds_sum{kind="Kustomization"}
            / gotk_reconcile_duration_seconds_count{kind="Kustomization"} > 600
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Flux reconciliation is slow"

        - alert: ArgoCDApplicationOutOfSync
          expr: |
            argocd_app_info{sync_status="OutOfSync"} == 1
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "ArgoCD application {{ $labels.name }} is out of sync"

        - alert: GitOpsDriftDetected
          expr: |
            gitops_drift_resources_count > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "GitOps drift detected in {{ $labels.cluster }}"
            description: "{{ $value }} resources have drifted from desired state."
```

## Conclusion

A production-ready GitOps implementation requires solving problems at multiple levels simultaneously:

- **Repository structure** determines how changes flow, who can approve what, and how environment boundaries are enforced — choose based on team topology and compliance requirements
- **Promotion gates** (SLO budget checks, integration tests, manual approvals for production) prevent bad changes from cascading across environments
- **Drift detection** is a continuous monitoring concern, not a one-time setup — the alerts must page on-call before users experience the impact
- **Multi-tenancy** through ArgoCD AppProjects and Flux tenant configurations allows platform teams to enforce guardrails while giving development teams self-service access
- **Audit trails** embedded in resource annotations ensure every cluster state change is traceable to a specific Git commit and pull request

The key cultural shift: Git pull requests become change requests with automated validation, peer review, and an immutable audit log. Every incident response starts with `git log` rather than `kubectl get events`.
