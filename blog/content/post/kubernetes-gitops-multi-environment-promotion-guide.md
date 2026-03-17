---
title: "GitOps Multi-Environment Promotion: From Dev to Production Safely"
date: 2028-11-17T00:00:00-05:00
draft: false
tags: ["GitOps", "Kubernetes", "CI/CD", "ArgoCD", "Flux"]
categories:
- GitOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to GitOps multi-environment promotion covering environment branching vs directory strategies, automated promotion pipelines, manual approval gates with GitHub Environments and ArgoCD sync windows, Kustomize and Helm per-environment configuration, drift detection, and rollback procedures."
more_link: "yes"
url: "/kubernetes-gitops-multi-environment-promotion-guide/"
---

A GitOps promotion pipeline defines how a change moves from a developer's commit through development, staging, and production environments. Done well, it automates the routine (dev promotion), enforces manual gates for production, provides a clear audit trail, and makes rollbacks as simple as reverting a Git commit. Done poorly, it becomes a tangled web of branches and manual steps that slows teams down. This guide covers both the structural decisions and the implementation details.

<!--more-->

# GitOps Multi-Environment Promotion: From Dev to Production Safely

## Repository Strategy: Branches vs Directories

The first decision is how to represent multiple environments in your Git repository.

### Branch Strategy

```
main          ← production environment tracks this branch
├── staging   ← staging environment tracks this branch
└── dev       ← development environment tracks this branch
```

**Pros**: Environment state is immediately visible from branch history. Promotion is a merge from one branch to another. Protected branches enforce approval requirements at the Git level.

**Cons**: Divergence between branches is hard to resolve without rebases. Shared infrastructure changes must be merged to all branches. Cherry-picking hotfixes requires manual effort on each branch.

### Directory Strategy

```
fleet-infra/
├── apps/
│   ├── dev/
│   │   └── myapp/
│   │       └── deployment.yaml   # image: myapp:dev-abc1234
│   ├── staging/
│   │   └── myapp/
│   │       └── deployment.yaml   # image: myapp:1.5.0-rc.2
│   └── production/
│       └── myapp/
│           └── deployment.yaml   # image: myapp:1.4.3
```

**Pros**: Single branch for all environments — no merge conflicts. Atomic changes visible in one commit. Easier to see environment differences with `diff`.

**Cons**: A single broken commit can affect all environments if not carefully partitioned. Requires tooling to ensure changes to `dev/` don't accidentally modify `production/`.

**Recommendation**: Use the **directory strategy** for most teams. The branch strategy is appropriate when teams want strong isolation between environment configurations and the Git branch permissions model is sufficient enforcement.

## Repository Layout (Directory Strategy)

```
fleet-infra/
├── clusters/
│   ├── dev/
│   │   └── flux-system/
│   │       └── kustomization.yaml    # points to apps/dev/
│   ├── staging/
│   │   └── flux-system/
│   │       └── kustomization.yaml    # points to apps/staging/
│   └── production/
│       └── flux-system/
│           └── kustomization.yaml    # points to apps/production/
├── apps/
│   ├── base/
│   │   └── myapp/
│   │       ├── deployment.yaml       # base configuration (no image tag)
│   │       ├── service.yaml
│   │       ├── hpa.yaml
│   │       └── kustomization.yaml
│   ├── dev/
│   │   └── myapp/
│   │       └── kustomization.yaml    # overlays with dev-specific values
│   ├── staging/
│   │   └── myapp/
│   │       └── kustomization.yaml
│   └── production/
│       └── myapp/
│           └── kustomization.yaml
└── infrastructure/
    ├── base/
    │   └── ingress-nginx/
    ├── dev/
    ├── staging/
    └── production/
```

## Kustomize Overlays per Environment

```yaml
# apps/base/myapp/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: myapp
spec:
  replicas: 1   # overridden per environment
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
        image: ghcr.io/myorg/myapp:latest  # overridden per environment
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "256Mi"
        env:
        - name: LOG_LEVEL
          value: "info"  # overridden per environment
```

```yaml
# apps/base/myapp/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
  - hpa.yaml
```

```yaml
# apps/dev/myapp/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: myapp-dev
resources:
  - ../../base/myapp

patches:
  - patch: |-
      - op: replace
        path: /spec/replicas
        value: 1
      - op: replace
        path: /spec/template/spec/containers/0/env/0/value
        value: "debug"
    target:
      kind: Deployment
      name: myapp

images:
  - name: ghcr.io/myorg/myapp
    newTag: "dev-abc1234"  # updated by CI/Flux automation
```

```yaml
# apps/production/myapp/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: myapp-prod
resources:
  - ../../base/myapp

patches:
  - patch: |-
      - op: replace
        path: /spec/replicas
        value: 5
    target:
      kind: Deployment
      name: myapp

# Production PodDisruptionBudget
patchesStrategicMerge:
  - |-
    apiVersion: policy/v1
    kind: PodDisruptionBudget
    metadata:
      name: myapp
    spec:
      minAvailable: 4
      selector:
        matchLabels:
          app: myapp

images:
  - name: ghcr.io/myorg/myapp
    newTag: "1.4.3"  # only updated after explicit promotion approval
```

## Helm Values Files per Environment

For teams using Helm charts:

```
charts/
└── myapp/
    ├── Chart.yaml
    ├── values.yaml              # base values
    ├── values.dev.yaml          # dev overrides
    ├── values.staging.yaml      # staging overrides
    └── values.production.yaml   # production overrides
```

```yaml
# values.yaml (base)
replicaCount: 1
image:
  repository: ghcr.io/myorg/myapp
  tag: latest
  pullPolicy: IfNotPresent

resources:
  requests:
    cpu: "100m"
    memory: "128Mi"

autoscaling:
  enabled: false
  minReplicas: 1
  maxReplicas: 5
  targetCPUUtilizationPercentage: 70

ingress:
  enabled: true
  host: myapp.example.com
```

```yaml
# values.production.yaml (production overrides)
replicaCount: 5
image:
  tag: "1.4.3"
  pullPolicy: Always

resources:
  requests:
    cpu: "500m"
    memory: "512Mi"
  limits:
    cpu: "2"
    memory: "2Gi"

autoscaling:
  enabled: true
  minReplicas: 5
  maxReplicas: 20

podDisruptionBudget:
  enabled: true
  minAvailable: 4

topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: myapp
```

## Automated Promotion Pipeline

### GitHub Actions: Dev to Staging Promotion

```yaml
# .github/workflows/promote-dev-to-staging.yaml
name: Promote Dev to Staging

on:
  push:
    branches:
      - main
    paths:
      - 'apps/dev/**'

jobs:
  check-deployment:
    runs-on: ubuntu-latest
    outputs:
      is_healthy: ${{ steps.health.outputs.healthy }}
      new_tag: ${{ steps.extract.outputs.tag }}
    steps:
      - uses: actions/checkout@v4

      - name: Extract image tag from dev overlay
        id: extract
        run: |
          TAG=$(grep -oP '(?<=newTag: ")[\w.-]+' apps/dev/myapp/kustomization.yaml)
          echo "tag=${TAG}" >> $GITHUB_OUTPUT
          echo "Detected new tag: ${TAG}"

      - name: Wait for dev deployment to be healthy
        id: health
        run: |
          # Configure kubectl for dev cluster
          echo "${{ secrets.DEV_KUBECONFIG }}" | base64 -d > /tmp/kubeconfig
          export KUBECONFIG=/tmp/kubeconfig

          for i in $(seq 1 12); do
            READY=$(kubectl -n myapp-dev get deployment myapp \
              -o jsonpath='{.status.readyReplicas}')
            DESIRED=$(kubectl -n myapp-dev get deployment myapp \
              -o jsonpath='{.spec.replicas}')
            if [ "${READY}" = "${DESIRED}" ] && [ -n "${READY}" ]; then
              echo "healthy=true" >> $GITHUB_OUTPUT
              echo "Deployment healthy: ${READY}/${DESIRED} replicas"
              exit 0
            fi
            echo "Waiting for deployment... ${READY}/${DESIRED} (attempt $i/12)"
            sleep 30
          done

          echo "healthy=false" >> $GITHUB_OUTPUT
          echo "Deployment not healthy after 6 minutes"

  promote-to-staging:
    needs: check-deployment
    if: needs.check-deployment.outputs.is_healthy == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITOPS_BOT_TOKEN }}

      - name: Configure git
        run: |
          git config user.name "GitOps Promotion Bot"
          git config user.email "gitops@myorg.com"

      - name: Update staging image tag
        run: |
          TAG="${{ needs.check-deployment.outputs.new_tag }}"

          # Update kustomization.yaml for staging
          sed -i "s/newTag: .*/newTag: \"${TAG}\"/" \
            apps/staging/myapp/kustomization.yaml

          git add apps/staging/myapp/kustomization.yaml
          git commit -m "chore(promote): myapp ${TAG} dev->staging

          Automatic promotion after successful deployment in dev.
          Dev deployment healthy at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
          Source: ${{ github.sha }}"
          git push origin main

      - name: Create promotion PR comment
        uses: actions/github-script@v7
        with:
          script: |
            const { data: commits } = await github.rest.repos.listCommits({
              owner: context.repo.owner,
              repo: context.repo.repo,
              per_page: 1,
            });
            console.log(`Promoted tag ${{ needs.check-deployment.outputs.new_tag }} to staging`);
```

### GitHub Environments for Manual Production Gate

Configure a GitHub Environment named `production` with required reviewers in Settings > Environments.

```yaml
# .github/workflows/promote-staging-to-production.yaml
name: Promote Staging to Production

on:
  workflow_dispatch:
    inputs:
      image_tag:
        description: 'Image tag to promote to production'
        required: true
      reason:
        description: 'Reason for promotion'
        required: true

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Verify tag exists in staging
        run: |
          STAGING_TAG=$(grep -oP '(?<=newTag: ")[\w.-]+' \
            apps/staging/myapp/kustomization.yaml)
          if [ "${STAGING_TAG}" != "${{ github.event.inputs.image_tag }}" ]; then
            echo "ERROR: Tag ${{ github.event.inputs.image_tag }} is not deployed in staging"
            echo "Current staging tag: ${STAGING_TAG}"
            exit 1
          fi
          echo "Tag verified in staging: ${STAGING_TAG}"

      - name: Run pre-promotion checks
        run: |
          echo "${{ secrets.STAGING_KUBECONFIG }}" | base64 -d > /tmp/kubeconfig
          export KUBECONFIG=/tmp/kubeconfig

          # Check error rate in staging over last hour
          ERROR_RATE=$(kubectl exec -n monitoring deploy/prometheus -- \
            curl -s 'http://localhost:9090/api/v1/query?query=rate(http_requests_total{status=~"5..",namespace="myapp-staging"}[1h])/rate(http_requests_total{namespace="myapp-staging"}[1h])' \
            | jq -r '.data.result[0].value[1]')

          echo "Error rate in staging: ${ERROR_RATE}"
          if (( $(echo "${ERROR_RATE} > 0.01" | bc -l) )); then
            echo "ERROR: Staging error rate ${ERROR_RATE} exceeds 1% threshold"
            exit 1
          fi

  promote-to-production:
    needs: validate
    runs-on: ubuntu-latest
    environment:
      name: production          # This triggers the required reviewer gate
      url: https://myapp.example.com
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITOPS_BOT_TOKEN }}

      - name: Configure git
        run: |
          git config user.name "GitOps Promotion Bot"
          git config user.email "gitops@myorg.com"

      - name: Update production image tag
        run: |
          TAG="${{ github.event.inputs.image_tag }}"
          REASON="${{ github.event.inputs.reason }}"
          APPROVER="${{ github.actor }}"

          sed -i "s/newTag: .*/newTag: \"${TAG}\"/" \
            apps/production/myapp/kustomization.yaml

          git add apps/production/myapp/kustomization.yaml
          git commit -m "feat(promote): myapp ${TAG} staging->production

          Approved by: ${APPROVER}
          Reason: ${REASON}
          Promoted at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
          Workflow run: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
          git push origin main

      - name: Post Slack notification
        uses: slackapi/slack-github-action@v1.26.0
        with:
          payload: |
            {
              "text": "Production deployment: myapp ${{ github.event.inputs.image_tag }}",
              "attachments": [{
                "color": "good",
                "fields": [
                  {"title": "Approver", "value": "${{ github.actor }}", "short": true},
                  {"title": "Reason", "value": "${{ github.event.inputs.reason }}", "short": false}
                ]
              }]
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

## ArgoCD Sync Windows for Production Protection

ArgoCD sync windows prevent ArgoCD from syncing to production outside of allowed maintenance windows:

```yaml
# argocd-appproject.yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: myapp
  namespace: argocd
spec:
  description: "MyApp production application"
  sourceRepos:
    - 'https://github.com/myorg/fleet-infra'
  destinations:
    - namespace: myapp-prod
      server: https://kubernetes.default.svc

  # Only allow syncs during business hours on weekdays
  # and never during on-call transition periods
  syncWindows:
  - kind: allow
    schedule: "0 9 * * 1-5"    # 9 AM weekdays
    duration: 8h                # until 5 PM
    applications:
    - myapp-production
  - kind: deny
    schedule: "0 17 * * 5"     # Friday 5 PM
    duration: 64h               # deny all weekend
    applications:
    - myapp-production
    manualSync: false           # block even manual syncs

  # Emergency override: specific users can bypass sync windows
  roles:
  - name: release-engineer
    description: Can sync production outside maintenance windows
    policies:
    - p, proj:myapp:release-engineer, applications, sync, myapp/myapp-production, allow
    groups:
    - myorg:release-engineers
```

## ArgoCD Application Configuration

```yaml
# argocd-app-production.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: myapp-production
  namespace: argocd
  annotations:
    # Prevent automated sync in production — require manual sync or workflow
    argocd.argoproj.io/sync-wave: "10"
spec:
  project: myapp
  source:
    repoURL: https://github.com/myorg/fleet-infra
    targetRevision: main
    path: apps/production/myapp
  destination:
    server: https://kubernetes.default.svc
    namespace: myapp-prod
  syncPolicy:
    automated: null   # NO automated sync in production
    syncOptions:
    - CreateNamespace=true
    - PrunePropagationPolicy=foreground
    - RespectIgnoreDifferences=true
    retry:
      limit: 3
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
  ignoreDifferences:
  - group: apps
    kind: Deployment
    jsonPointers:
    - /spec/replicas  # HPA manages this, ignore drift
```

```yaml
# argocd-app-dev.yaml — dev has automated sync
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: myapp-dev
  namespace: argocd
spec:
  project: myapp
  source:
    repoURL: https://github.com/myorg/fleet-infra
    targetRevision: main
    path: apps/dev/myapp
  destination:
    server: https://dev-cluster.example.com
    namespace: myapp-dev
  syncPolicy:
    automated:
      prune: true       # remove resources deleted from Git
      selfHeal: true    # revert manual changes that drift from Git
    syncOptions:
    - CreateNamespace=true
```

## Drift Detection and Remediation

Drift occurs when the cluster state diverges from Git (manual `kubectl apply`, HPA scaling, etc.). Handle it explicitly:

```bash
# Check for drift in all environments
argocd app list --output json | \
  jq '.[] | select(.status.sync.status != "Synced") | {name:.metadata.name, status:.status.sync.status}'

# For Flux-managed clusters
flux get all --all-namespaces | grep -v "True"

# Configure Flux to alert on drift without auto-remediating in production
```

```yaml
# flux-kustomization-production.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: myapp-production
  namespace: flux-system
spec:
  interval: 5m
  path: ./apps/production/myapp
  prune: false      # DO NOT auto-delete resources in production
  force: false      # DO NOT force-replace resources
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  # Do not auto-apply in production — notify instead
  suspend: false
  # Drift detection only (no auto-remediation)
  postBuild:
    substituteFrom: []
```

Production drift alert:

```yaml
# flux-alert-drift.yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: production-drift
  namespace: flux-system
spec:
  providerRef:
    name: slack-ops
  eventSeverity: warning
  eventSources:
    - kind: Kustomization
      name: myapp-production
  eventMetadata:
    summary: "Production drift detected"
  exclusionList:
    - "Reconciliation succeeded"  # only alert on failures/drift
```

## Rollback Procedures

### Rollback via Git Revert (Recommended)

```bash
# Find the commit that changed production
git log --oneline apps/production/myapp/kustomization.yaml | head -5
# 8f4a2b1 feat(promote): myapp 1.5.0 staging->production
# 3c8e1a0 feat(promote): myapp 1.4.3 staging->production

# Revert the bad promotion
git revert 8f4a2b1 --no-edit
git push origin main

# ArgoCD/Flux detects the revert and applies the previous image tag
```

### Emergency Rollback via ArgoCD

```bash
# List available history for the app
argocd app history myapp-production

# Rollback to specific revision
argocd app rollback myapp-production --revision 5

# This creates a one-time sync from a previous git SHA
# NOTE: this is a temporary state — the next sync will re-apply current Git
# Always follow up with a git revert for permanent rollback
```

### Rollback with Validation

```bash
#!/bin/bash
# emergency-rollback.sh
set -euo pipefail

APP_NAME="${1:?usage: $0 <argocd-app-name> <target-tag>}"
TARGET_TAG="${2:?usage: $0 <argocd-app-name> <target-tag>}"

echo "=== Emergency Rollback: ${APP_NAME} to ${TARGET_TAG} ==="

# Update Git immediately (authoritative record)
sed -i "s/newTag: .*/newTag: \"${TARGET_TAG}\"/" \
  apps/production/myapp/kustomization.yaml

git add apps/production/myapp/kustomization.yaml
git commit -m "fix(rollback): emergency rollback to ${TARGET_TAG}

Triggered by: $(git config user.name)
Reason: Emergency rollback
Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push origin main

# Force ArgoCD sync immediately (don't wait for interval)
argocd app sync "${APP_NAME}" --force --prune

# Wait for rollout
echo "Waiting for rollout..."
kubectl -n myapp-prod rollout status deployment/myapp --timeout=300s

# Verify
READY=$(kubectl -n myapp-prod get deployment myapp \
  -o jsonpath='{.status.readyReplicas}')
echo "Rollback complete: ${READY} replicas ready with tag ${TARGET_TAG}"
```

## Promotion Summary Matrix

| Stage | Trigger | Approval Required | Auto-Sync | Rollback Method |
|---|---|---|---|---|
| Dev | PR merge to main | None | Yes (Flux/ArgoCD) | git push, auto-resyncs |
| Staging | Dev deployment healthy | None (automated) | Yes | git push, auto-resyncs |
| Production | Manual dispatch | Yes (GitHub Env reviewer) | No | git revert + ArgoCD sync |

## Summary

Multi-environment GitOps promotion is a balance between automation speed and safety gates. The directory strategy in a single Git repository is the most maintainable for most teams. Kustomize overlays or Helm values files handle environment-specific configuration cleanly.

The automation layer promotes to dev and staging automatically after health checks pass. The production gate requires a human approval through GitHub Environments before any workflow can update the production manifests. ArgoCD sync windows add an additional time-based safety layer. Flux can manage drift detection without auto-remediation in production.

Every deployment action — including rollbacks — must go through Git so the audit trail is complete and any state can be reproduced by checking out the relevant commit.
