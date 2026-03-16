---
title: "GitOps Multi-Cluster Management: ArgoCD with Cluster Fleet Patterns"
date: 2027-04-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "GitOps", "ArgoCD", "Multi-Cluster", "Fleet Management"]
categories: ["Kubernetes", "GitOps", "Multi-Cluster"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to managing Kubernetes cluster fleets with ArgoCD, covering ApplicationSet generators (cluster, git, matrix, pull request), app-of-apps pattern, cluster secrets management, RBAC for multi-team environments, progressive rollouts with sync waves, and drift detection."
more_link: "yes"
url: "/gitops-multi-cluster-argocd-fleet-guide/"
---

Managing a fleet of Kubernetes clusters at enterprise scale exposes a core set of operational challenges that single-cluster tooling was never designed to solve. Configuration drift accumulates silently across dozens of clusters. Rolling out changes safely requires coordination across environments. Multiple teams need isolated tenancy within the same GitOps control plane. ArgoCD's ApplicationSet controller, combined with disciplined use of the app-of-apps pattern, sync waves, and project-scoped RBAC, provides a coherent answer to each of these problems.

This guide covers every layer of multi-cluster GitOps with ArgoCD: cluster registration, ApplicationSet generators, progressive rollout strategies, multi-tenant RBAC, notifications, and drift remediation — with production-ready manifests throughout.

<!--more-->

## Section 1: Fleet Management Challenges

### Drift at Scale

In a fleet of 40 clusters, configuration drift is not a corner case — it is the default outcome. A manual hotfix applied to one cluster, a ConfigMap that was never propagated, a Helm chart version that lagged behind — each of these is individually harmless and collectively catastrophic. GitOps disciplines the fleet by making the Git repository the single source of truth, but only if the tooling continuously reconciles observed state against desired state and alerts when they diverge.

### Rollout Safety

Pushing a breaking Ingress controller change to all clusters simultaneously guarantees an incident. Fleet management requires canary clusters, staged rollout groups, and the ability to pause or roll back mid-flight. ArgoCD sync waves and ApplicationSet label selectors provide the primitives needed to implement these patterns without external orchestration.

### Team Isolation

A platform team running a shared ArgoCD instance must give application teams enough autonomy to deploy their own workloads without granting them the ability to read secrets in other teams' namespaces or to sync applications in other teams' clusters. The AppProject CRD encodes these boundaries as policy that ArgoCD enforces on every operation.

## Section 2: ArgoCD Cluster Registration

### Hub-Spoke Topology

The canonical multi-cluster ArgoCD deployment uses a single management cluster running the ArgoCD control plane (the hub) with workload clusters registered as remote destinations (the spokes). The in-cluster destination (`https://kubernetes.default.svc`) points at the management cluster itself — useful for bootstrapping platform components.

### Installing ArgoCD on the Hub

```bash
# Create the ArgoCD namespace and install the stable release
kubectl create namespace argocd

kubectl apply -n argocd \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/v2.10.5/manifests/install.yaml

# Wait for all components to become ready
kubectl rollout status deploy/argocd-server -n argocd --timeout=300s
kubectl rollout status deploy/argocd-application-controller -n argocd --timeout=300s
kubectl rollout status deploy/argocd-applicationset-controller -n argocd --timeout=300s
```

### Registering External Clusters via CLI

The `argocd cluster add` command creates a service account in the target cluster and stores the resulting bearer token as a Secret in the ArgoCD namespace on the hub.

```bash
# Authenticate to ArgoCD (use port-forward or the ingress hostname)
argocd login argocd.platform.example.com \
  --username admin \
  --password "$(kubectl get secret argocd-initial-admin-secret \
      -n argocd -o jsonpath='{.data.password}' | base64 -d)" \
  --grpc-web

# Register each workload cluster; KUBECONFIG context names match cluster names
for CTX in us-east-1-prod eu-west-1-prod ap-southeast-1-prod us-east-1-staging; do
  argocd cluster add "${CTX}" \
    --name "${CTX}" \
    --label region="$(echo ${CTX} | cut -d- -f1-3)" \
    --label env="$(echo ${CTX} | cut -d- -f4)" \
    --in-cluster=false
done

# Verify all clusters appear
argocd cluster list
```

### Cluster Secret Structure

ArgoCD stores cluster credentials as Kubernetes Secrets with the label `argocd.argoproj.io/secret-type: cluster`. Understanding this structure is necessary for GitOps-managed cluster registration.

```yaml
# cluster-us-east-1-prod.yaml — committed to the platform Git repo
# The actual token value is managed by External Secrets or Sealed Secrets
apiVersion: v1
kind: Secret
metadata:
  name: cluster-us-east-1-prod
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
    region: us-east-1
    env: prod
    tier: critical          # used by ApplicationSet label selectors
    canary: "false"         # progressive rollout annotation
  annotations:
    managed-by: external-secrets
type: Opaque
stringData:
  name: us-east-1-prod
  server: "https://api.us-east-1-prod.k8s.example.com:6443"
  config: |
    {
      "bearerToken": "EXAMPLE_TOKEN_REPLACE_ME",
      "tlsClientConfig": {
        "insecure": false,
        "caData": "EXAMPLE_BASE64_CA_REPLACE_ME"
      }
    }
```

## Section 3: ApplicationSet Generators

The ApplicationSet controller generates ArgoCD Application objects from templates combined with a data source called a generator. Multiple generators can be composed to cover complex fleet topologies.

### Cluster Generator with Label Selectors

The cluster generator iterates over all registered clusters that match a label selector, producing one Application per cluster.

```yaml
# appset-nginx-ingress.yaml — deploys nginx-ingress to every production cluster
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: nginx-ingress-prod
  namespace: argocd
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            env: prod             # only production clusters
        values:
          helmVersion: "4.10.1"   # shared value injected into all instances
  template:
    metadata:
      name: "nginx-ingress-{{name}}"  # {{name}} is the cluster's registered name
      labels:
        managed-by: applicationset
        app: nginx-ingress
    spec:
      project: platform
      source:
        repoURL: https://kubernetes.github.io/ingress-nginx
        chart: ingress-nginx
        targetRevision: "{{values.helmVersion}}"
        helm:
          values: |
            controller:
              replicaCount: 3
              resources:
                requests:
                  cpu: 200m
                  memory: 256Mi
              metrics:
                enabled: true
                serviceMonitor:
                  enabled: true
      destination:
        server: "{{server}}"     # {{server}} is the cluster API endpoint
        namespace: ingress-nginx
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
        retry:
          limit: 5
          backoff:
            duration: 10s
            factor: 2
            maxDuration: 3m
```

### Git Directory Generator

The git directory generator scans a Git repository directory structure and generates one Application per discovered subdirectory. This pattern decouples application onboarding from ApplicationSet modifications.

```
platform-config/
  clusters/
    us-east-1-prod/
      cluster-addons/
        cert-manager/
          kustomization.yaml
        external-dns/
          kustomization.yaml
      workloads/
        team-payments/
          kustomization.yaml
    eu-west-1-prod/
      cluster-addons/
        cert-manager/
          kustomization.yaml
```

```yaml
# appset-cluster-addons-git.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: cluster-addons-git
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/example-org/platform-config.git
        revision: main
        directories:
          - path: "clusters/*/cluster-addons/*"  # glob matches any cluster + addon
  template:
    metadata:
      # path.basenameNormalized strips the leaf directory name (e.g. cert-manager)
      name: "{{path.basenameNormalized}}-{{path[1]}}"
    spec:
      project: platform
      source:
        repoURL: https://github.com/example-org/platform-config.git
        targetRevision: main
        path: "{{path}}"   # the matched directory path
      destination:
        # Cluster name extracted from path segment; requires matching cluster registration
        name: "{{path[1]}}"
        namespace: "{{path.basenameNormalized}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

### Matrix Generator: Clusters × Environments

The matrix generator takes the Cartesian product of two generators, enabling every combination of clusters and configuration variants to produce an Application.

```yaml
# appset-monitoring-matrix.yaml — deploy monitoring stack to all clusters
# with per-environment configuration overrides
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: monitoring-stack
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          # First generator: all registered clusters
          - clusters:
              selector:
                matchExpressions:
                  - key: env
                    operator: In
                    values: [prod, staging]
          # Second generator: per-environment Helm value files from Git
          - git:
              repoURL: https://github.com/example-org/platform-config.git
              revision: main
              files:
                - path: "monitoring/environments/{{metadata.labels.env}}.json"
  template:
    metadata:
      name: "monitoring-{{name}}"
    spec:
      project: platform
      source:
        repoURL: https://github.com/example-org/platform-config.git
        targetRevision: main
        path: monitoring/base
        helm:
          valueFiles:
            - "../../environments/{{metadata.labels.env}}.yaml"
          parameters:
            - name: clusterName
              value: "{{name}}"
            - name: region
              value: "{{metadata.labels.region}}"
      destination:
        server: "{{server}}"
        namespace: monitoring
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
```

### Pull Request Generator

The pull request generator creates ephemeral preview environments for every open pull request against a target branch. This enables PR-based development workflows with full environment parity.

```yaml
# appset-pr-preview.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: pr-preview-environments
  namespace: argocd
spec:
  generators:
    - pullRequest:
        github:
          owner: example-org
          repo: app-payments
          # tokenRef points to a Secret containing a GitHub PAT
          tokenRef:
            secretName: github-pr-token
            key: token
          labels:
            - preview           # only PRs with this label get an environment
        requeueAfterSeconds: 120  # poll interval for new/closed PRs
  template:
    metadata:
      name: "pr-preview-{{number}}"
      labels:
        preview: "true"
        pr-number: "{{number}}"
    spec:
      project: preview-environments
      source:
        repoURL: https://github.com/example-org/app-payments.git
        targetRevision: "{{head_sha}}"
        path: deploy/helm/app-payments
        helm:
          parameters:
            - name: image.tag
              value: "pr-{{number}}-{{head_short_sha}}"
            - name: ingress.host
              value: "pr-{{number}}.preview.example.com"
      destination:
        server: https://api.us-east-1-staging.k8s.example.com:6443
        namespace: "preview-pr-{{number}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
  # Automatically delete preview Applications when the PR is closed/merged
  syncPolicy:
    preserveResourcesOnDeletion: false
```

## Section 4: App-of-Apps Pattern and Cluster Bootstrapping

The app-of-apps pattern uses a root Application that manages other Application objects in Git. It is the standard approach for bootstrapping a cluster from scratch — a single `kubectl apply` creates the root app, which then pulls in all cluster-level components.

### Repository Structure

```
platform-config/
  bootstrap/
    root-app.yaml               # the single manifest applied manually
  apps/
    cluster-addons.yaml         # ApplicationSet for all cluster add-ons
    team-namespaces.yaml        # ApplicationSet for team namespace setup
    monitoring.yaml             # ApplicationSet for monitoring stack
  clusters/
    us-east-1-prod/
      values.yaml               # per-cluster overrides
```

### Root Application Manifest

```yaml
# bootstrap/root-app.yaml — applied once per hub cluster via kubectl
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/example-org/platform-config.git
    targetRevision: main
    path: apps           # all Application/ApplicationSet manifests live here
  destination:
    server: https://kubernetes.default.svc   # deploy to the hub itself
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

### Cluster Bootstrap Script

```bash
#!/usr/bin/env bash
# bootstrap-cluster.sh — run once after hub ArgoCD is installed
set -euo pipefail

ARGOCD_NS="argocd"
ROOT_APP_PATH="bootstrap/root-app.yaml"
PLATFORM_REPO="https://github.com/example-org/platform-config.git"

echo "Applying root application..."
kubectl apply -f "${ROOT_APP_PATH}" -n "${ARGOCD_NS}"

echo "Waiting for root application to sync..."
argocd app wait root \
  --sync \
  --health \
  --timeout 300

echo "Bootstrap complete. ArgoCD will now manage all cluster add-ons."
argocd app list
```

## Section 5: Sync Waves for Deployment Ordering

Sync waves allow precise ordering within a single sync operation. Resources with lower wave numbers are applied and must become healthy before resources with higher wave numbers begin.

```yaml
# cert-manager-crds.yaml — wave -1 ensures CRDs exist before the operator
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cert-manager-crds
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "-1"  # applied first
spec:
  project: platform
  source:
    repoURL: https://github.com/example-org/platform-config.git
    targetRevision: main
    path: cluster-addons/cert-manager/crds
  destination:
    server: https://kubernetes.default.svc
    namespace: cert-manager
  syncPolicy:
    automated:
      prune: false   # never prune CRDs automatically
      selfHeal: true
```

```yaml
# cert-manager-operator.yaml — wave 0: operator after CRDs
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cert-manager
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  project: platform
  source:
    repoURL: https://charts.jetstack.io
    chart: cert-manager
    targetRevision: v1.14.4
    helm:
      parameters:
        - name: installCRDs
          value: "false"   # CRDs already applied in wave -1
        - name: replicaCount
          value: "2"
  destination:
    server: https://kubernetes.default.svc
    namespace: cert-manager
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

```yaml
# cluster-issuers.yaml — wave 1: ClusterIssuers after cert-manager is ready
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cluster-issuers
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "1"
spec:
  project: platform
  source:
    repoURL: https://github.com/example-org/platform-config.git
    targetRevision: main
    path: cluster-addons/cert-manager/issuers
  destination:
    server: https://kubernetes.default.svc
    namespace: cert-manager
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

### Resource-Level Sync Wave Annotation

Wave annotations also work on individual Kubernetes resources inside an Application's source, not just on Application objects themselves.

```yaml
# kustomization.yaml base — annotate individual resources
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespace.yaml
  - rbac.yaml
  - deployment.yaml
  - service.yaml
  - ingress.yaml
```

```yaml
# namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: payments
  annotations:
    argocd.argoproj.io/sync-wave: "-2"   # namespace first
```

```yaml
# rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payments-deployer
  namespace: payments
  annotations:
    argocd.argoproj.io/sync-wave: "-1"  # RBAC before workloads
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: edit
subjects:
  - kind: ServiceAccount
    name: payments-deployer
    namespace: payments
```

## Section 6: Sync Windows for Maintenance Control

Sync windows define time-based policies that allow or deny sync operations for matching Applications. They prevent automated deploys during peak traffic windows or enforce change-freeze periods.

```yaml
# argocd-cm patch — add sync windows to the ArgoCD ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  # Sync windows are defined at the AppProject level (preferred) or globally
  # See AppProject section for project-scoped windows
```

```yaml
# appproject-platform.yaml — sync windows defined on the AppProject
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: platform
  namespace: argocd
spec:
  description: Platform team project for cluster add-ons
  sourceRepos:
    - "https://github.com/example-org/platform-config.git"
    - "https://charts.jetstack.io"
    - "https://kubernetes.github.io/ingress-nginx"
  destinations:
    - server: "*"        # all registered clusters
      namespace: "*"     # all namespaces — scoped further by RBAC
  clusterResourceWhitelist:
    - group: "*"
      kind: "*"          # platform team can manage cluster-scoped resources
  syncWindows:
    # Allow automated syncs only during business hours on weekdays
    - kind: allow
      schedule: "0 8 * * 1-5"    # Monday–Friday 08:00 UTC
      duration: 10h
      applications:
        - "*"
      namespaces:
        - "*"
      clusters:
        - us-east-1-prod
        - eu-west-1-prod
      manualSync: true           # manual syncs always allowed even outside window
    # Deny syncs during end-of-quarter freeze — 3 days before quarter end
    - kind: deny
      schedule: "0 0 29 3,6,9,12 *"
      duration: 72h
      applications:
        - "*"
      manualSync: false          # block even manual syncs during freeze
```

## Section 7: Multi-Tenant RBAC with AppProject

### AppProject for Application Teams

Each team gets an AppProject that restricts which Git repositories, destination clusters, and Kubernetes resources it can manage.

```yaml
# appproject-team-payments.yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-payments
  namespace: argocd
spec:
  description: Payments team — owns the payments namespace on production clusters
  sourceRepos:
    - "https://github.com/example-org/app-payments.git"
    - "https://github.com/example-org/app-payments-*"   # wildcard for sub-repos
  destinations:
    - server: "https://api.us-east-1-prod.k8s.example.com:6443"
      namespace: payments
    - server: "https://api.us-east-1-prod.k8s.example.com:6443"
      namespace: payments-*      # wildcard allows payments-canary, payments-blue, etc.
    - server: "https://api.us-east-1-staging.k8s.example.com:6443"
      namespace: "*"             # full access on staging
  # Namespace-scoped resources only; no ClusterRole or PersistentVolume
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
    - group: "batch"
      kind: CronJob
  roles:
    # Developer role — can sync and view, cannot delete
    - name: developer
      description: Read and sync access for payments team developers
      policies:
        - p, proj:team-payments:developer, applications, get, team-payments/*, allow
        - p, proj:team-payments:developer, applications, sync, team-payments/*, allow
        - p, proj:team-payments:developer, applications, create, team-payments/*, allow
        - p, proj:team-payments:developer, applications, update, team-payments/*, allow
      groups:
        - payments-developers          # maps to OIDC/SSO group
    # On-call role — can also delete and override sync windows
    - name: oncall
      description: On-call engineers with break-glass access
      policies:
        - p, proj:team-payments:oncall, applications, *, team-payments/*, allow
        - p, proj:team-payments:oncall, applications, override, team-payments/*, allow
      groups:
        - payments-oncall
  orphanedResources:
    warn: true     # alert on resources in the namespace not managed by ArgoCD
```

### ArgoCD RBAC ConfigMap

```yaml
# argocd-rbac-cm patch — global RBAC policies
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: role:readonly    # default to read-only for unauthenticated / unknown groups
  policy.csv: |
    # Platform team has full admin access
    g, platform-engineers, role:admin

    # SRE team can sync all projects but not modify RBAC
    p, role:sre, applications, sync, */*, allow
    p, role:sre, applications, get, */*, allow
    p, role:sre, clusters, get, *, allow
    g, sre-team, role:sre

    # Read-only access for management and auditors
    g, auditors, role:readonly

  # OIDC group claim to use from the identity provider
  oidc.config: |
    name: Okta
    issuer: https://example.okta.com/oauth2/default
    clientID: EXAMPLE_OIDC_CLIENT_ID_REPLACE_ME
    clientSecret: $oidc.okta.clientSecret   # reference to argocd-secret key
    requestedScopes:
      - openid
      - profile
      - email
      - groups
    requestedIDTokenClaims:
      groups:
        essential: true
```

## Section 8: Progressive Cluster Rollouts

### Canary Cluster Annotation Strategy

Label clusters with a `canary: "true"` annotation and use a two-phase ApplicationSet rollout: deploy to canary clusters first, validate, then roll to the full fleet.

```yaml
# appset-ingress-canary.yaml — phase 1: canary clusters only
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: nginx-ingress-canary
  namespace: argocd
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            env: prod
            canary: "true"        # only the single designated canary cluster
        values:
          chartVersion: "4.11.0"  # new version under test
  template:
    metadata:
      name: "nginx-ingress-{{name}}-canary"
    spec:
      project: platform
      source:
        repoURL: https://kubernetes.github.io/ingress-nginx
        chart: ingress-nginx
        targetRevision: "{{values.chartVersion}}"
        helm:
          values: |
            controller:
              replicaCount: 3
      destination:
        server: "{{server}}"
        namespace: ingress-nginx
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

```yaml
# appset-ingress-fleet.yaml — phase 2: remaining production clusters
# Applied after canary validation; excludes canary clusters
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: nginx-ingress-fleet
  namespace: argocd
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            env: prod
            canary: "false"       # all non-canary production clusters
        values:
          chartVersion: "4.11.0"
  template:
    metadata:
      name: "nginx-ingress-{{name}}"
    spec:
      project: platform
      source:
        repoURL: https://kubernetes.github.io/ingress-nginx
        chart: ingress-nginx
        targetRevision: "{{values.chartVersion}}"
        helm:
          values: |
            controller:
              replicaCount: 3
      destination:
        server: "{{server}}"
        namespace: ingress-nginx
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

### Rollout Automation Script

```bash
#!/usr/bin/env bash
# progressive-rollout.sh — orchestrates canary then fleet rollout
set -euo pipefail

NEW_VERSION="${1:?Usage: $0 <chart-version>}"
CANARY_APP="nginx-ingress-us-east-1-prod-canary"
VALIDATE_WAIT_SECONDS=600   # 10 minutes of canary soak time

echo "Step 1: Update canary ApplicationSet to version ${NEW_VERSION}"
# Patch the ApplicationSet values.chartVersion via kubectl patch
kubectl patch applicationset nginx-ingress-canary -n argocd \
  --type=json \
  -p "[{\"op\":\"replace\",\"path\":\"/spec/generators/0/clusters/values/chartVersion\",\"value\":\"${NEW_VERSION}\"}]"

echo "Waiting for canary sync..."
argocd app wait "${CANARY_APP}" --sync --health --timeout 300

echo "Step 2: Soak period — ${VALIDATE_WAIT_SECONDS}s"
echo "Monitor: kubectl get pods -n ingress-nginx --context us-east-1-prod-canary"
sleep "${VALIDATE_WAIT_SECONDS}"

# Check error rate via Prometheus query (requires promtool or curl)
ERROR_RATE=$(curl -s "http://prometheus.monitoring.svc.cluster.local:9090/api/v1/query" \
  --data-urlencode 'query=rate(nginx_ingress_controller_requests{status=~"5.."}[5m]) / rate(nginx_ingress_controller_requests[5m]) > 0.01' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['data']['result']))")

if [[ "${ERROR_RATE}" -gt 0 ]]; then
  echo "ERROR: Canary shows elevated error rate. Aborting fleet rollout."
  exit 1
fi

echo "Step 3: Canary healthy — rolling out to fleet"
kubectl patch applicationset nginx-ingress-fleet -n argocd \
  --type=json \
  -p "[{\"op\":\"replace\",\"path\":\"/spec/generators/0/clusters/values/chartVersion\",\"value\":\"${NEW_VERSION}\"}]"

echo "Waiting for fleet sync..."
argocd app wait -l "managed-by=applicationset,app=nginx-ingress" \
  --sync --health --timeout 600

echo "Rollout complete: nginx-ingress ${NEW_VERSION} deployed to all production clusters."
```

## Section 9: Notifications for Slack and PagerDuty

ArgoCD Notifications trigger alerts when Application sync or health status changes. The notification controller reads templates and triggers from a ConfigMap.

```yaml
# argocd-notifications-cm.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  # --- Service definitions ---
  service.slack: |
    token: $slack-token    # references argocd-notifications-secret

  service.pagerduty: |
    serviceKeys:
      platform-critical: $pagerduty-platform-key
      team-payments: $pagerduty-payments-key

  # --- Templates ---
  template.app-sync-failed: |
    slack:
      attachments: |
        [{
          "color": "#E96D76",
          "title": "Sync FAILED: {{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "fields": [
            {"title": "Cluster", "value": "{{.app.spec.destination.name}}", "short": true},
            {"title": "Project", "value": "{{.app.spec.project}}", "short": true},
            {"title": "Sync Status", "value": "{{.app.status.sync.status}}", "short": true},
            {"title": "Health", "value": "{{.app.status.health.status}}", "short": true},
            {"title": "Message", "value": "{{range .app.status.conditions}}{{.message}}{{end}}", "short": false}
          ]
        }]

  template.app-health-degraded: |
    slack:
      attachments: |
        [{
          "color": "#F4C030",
          "title": "Health DEGRADED: {{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "fields": [
            {"title": "Cluster", "value": "{{.app.spec.destination.name}}", "short": true},
            {"title": "Health", "value": "{{.app.status.health.status}}", "short": true}
          ]
        }]
    pagerduty:
      summary: "ArgoCD health degraded: {{.app.metadata.name}} on {{.app.spec.destination.name}}"
      severity: warning
      source: argocd
      component: "{{.app.metadata.name}}"
      group: "{{.app.spec.project}}"

  template.app-sync-succeeded: |
    slack:
      attachments: |
        [{
          "color": "#18BE52",
          "title": "Sync OK: {{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "fields": [
            {"title": "Cluster", "value": "{{.app.spec.destination.name}}", "short": true},
            {"title": "Revision", "value": "{{.app.status.sync.revision}}", "short": true}
          ]
        }]

  # --- Triggers ---
  trigger.on-sync-failed: |
    - when: app.status.operationState.phase in ['Error', 'Failed']
      send: [app-sync-failed]

  trigger.on-health-degraded: |
    - when: app.status.health.status == 'Degraded'
      send: [app-health-degraded]

  trigger.on-sync-succeeded: |
    - when: app.status.operationState.phase in ['Succeeded'] and app.status.health.status == 'Healthy'
      send: [app-sync-succeeded]

  # --- Default subscriptions ---
  subscriptions: |
    - recipients:
        - slack:#platform-argocd-alerts
      triggers:
        - on-sync-failed
        - on-health-degraded
    - recipients:
        - slack:#platform-argocd-deploys
      triggers:
        - on-sync-succeeded
```

```yaml
# argocd-notifications-secret.yaml — managed by External Secrets
apiVersion: v1
kind: Secret
metadata:
  name: argocd-notifications-secret
  namespace: argocd
type: Opaque
stringData:
  slack-token: "EXAMPLE_SLACK_TOKEN_REPLACE_ME"
  pagerduty-platform-key: "EXAMPLE_PD_KEY_REPLACE_ME"
  pagerduty-payments-key: "EXAMPLE_PD_KEY_REPLACE_ME"
```

### Application-Level Notification Subscription

Individual Applications can opt into additional notification channels:

```yaml
# application-payments.yaml metadata annotations
metadata:
  annotations:
    notifications.argoproj.io/subscribe.on-sync-failed.slack: "#payments-incidents"
    notifications.argoproj.io/subscribe.on-health-degraded.pagerduty: "team-payments"
    notifications.argoproj.io/subscribe.on-sync-succeeded.slack: "#payments-deploys"
```

## Section 10: Drift Detection and Auto-Sync Policies

### Understanding OutOfSync State

ArgoCD continuously compares the live cluster state against the desired state in Git. When they diverge, the Application enters `OutOfSync` status. The `selfHeal: true` flag in the sync policy triggers automatic remediation — but this should be used with caution for stateful workloads.

### Selective Auto-Sync Configuration

```yaml
# Per-Application sync policy tuning
spec:
  syncPolicy:
    automated:
      prune: true        # delete resources removed from Git
      selfHeal: true     # re-apply resources that were manually changed
      allowEmpty: false  # never sync an empty application (protects against accidental deletion)
    retry:
      limit: 10          # retry up to 10 times before marking as failed
      backoff:
        duration: 30s    # initial wait
        factor: 2        # exponential backoff multiplier
        maxDuration: 10m # cap retry wait at 10 minutes
    syncOptions:
      - Validate=true              # run kubectl --dry-run=server before applying
      - PruneLast=true             # prune resources after all others are synced
      - RespectIgnoreDifferences=true  # honor ignoreDifferences rules
      - ApplyOutOfSyncOnly=true    # only touch out-of-sync resources (faster, less disruptive)
      - ServerSideApply=true       # use server-side apply (conflict detection, field management)
```

### ignoreDifferences for Managed Fields

Certain fields (HPA-managed replicas, operator-managed annotations) cause constant OutOfSync noise. The `ignoreDifferences` block silences them.

```yaml
spec:
  ignoreDifferences:
    # Ignore replica count — managed by HPA
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas
    # Ignore injected sidecar containers added by Istio/Linkerd
    - group: apps
      kind: Deployment
      jqPathExpressions:
        - .spec.template.spec.containers[] | select(.name == "istio-proxy")
        - .spec.template.spec.initContainers[] | select(.name == "istio-init")
    # Ignore dynamic annotations added by cert-manager
    - group: ""
      kind: Secret
      jsonPointers:
        - /metadata/annotations/cert-manager.io~1certificate-name
        - /metadata/annotations/cert-manager.io~1issuer-name
```

### Drift Detection Dashboard Query

```promql
# Prometheus query — count OutOfSync applications by cluster destination
sum by (dest_server) (
  argocd_app_info{sync_status="OutOfSync"}
)
```

```promql
# Alert rule — fire if more than 3 applications are OutOfSync for 15 minutes
groups:
  - name: argocd.drift
    rules:
      - alert: ArgoCDHighDriftCount
        expr: |
          sum by (dest_server) (
            argocd_app_info{sync_status="OutOfSync", project!="preview-environments"}
          ) > 3
        for: 15m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "High drift count on {{ $labels.dest_server }}"
          description: "{{ $value }} applications are OutOfSync for more than 15 minutes on {{ $labels.dest_server }}"
          runbook: "https://wiki.example.com/runbooks/argocd-drift"
```

## Section 11: Operational Runbook

### Common CLI Operations

```bash
# List all applications with their sync and health status
argocd app list --output wide

# Force sync a specific application (override sync windows)
argocd app sync payments-us-east-1-prod \
  --force \
  --prune \
  --timeout 300

# Roll back an application to a previous revision
argocd app rollback payments-us-east-1-prod --to-revision 42

# Terminate an in-progress sync operation
argocd app terminate-op payments-us-east-1-prod

# Manually trigger hard refresh (bypasses cache, re-evaluates Git)
argocd app get payments-us-east-1-prod --hard-refresh

# Show diff between live cluster state and Git desired state
argocd app diff payments-us-east-1-prod --server-side

# View sync history with timestamps and commit SHAs
argocd app history payments-us-east-1-prod

# Add a cluster label for progressive rollout targeting
kubectl label secret cluster-us-east-1-prod \
  -n argocd \
  canary="true" \
  --overwrite

# Remove the canary label to graduate a cluster to the main fleet
kubectl label secret cluster-us-east-1-prod \
  -n argocd \
  canary="false" \
  --overwrite

# Export all Application manifests for audit or migration
argocd app list -o name | xargs -I{} argocd app get {} -o yaml > all-apps.yaml

# Check ApplicationSet controller logs for generator errors
kubectl logs -n argocd \
  -l app.kubernetes.io/name=argocd-applicationset-controller \
  --since=1h \
  --tail=200
```

### Health Assessment Checklist

```bash
#!/usr/bin/env bash
# fleet-health-check.sh — run as a daily cron or pre-deployment gate
set -euo pipefail

echo "=== ArgoCD Fleet Health Check ==="

# Count applications by status
echo "--- Application Status Summary ---"
argocd app list --output json \
  | python3 -c "
import json, sys
from collections import Counter
apps = json.load(sys.stdin)
sync_counts = Counter(a['status']['sync']['status'] for a in apps)
health_counts = Counter(a['status']['health']['status'] for a in apps)
print('Sync status:', dict(sync_counts))
print('Health status:', dict(health_counts))
out_of_sync = [a['metadata']['name'] for a in apps if a['status']['sync']['status'] != 'Synced']
if out_of_sync:
    print('OutOfSync applications:', out_of_sync)
"

# Check for degraded applications
DEGRADED_COUNT=$(argocd app list --output json \
  | python3 -c "import json,sys; apps=json.load(sys.stdin); print(sum(1 for a in apps if a['status']['health']['status']=='Degraded'))")

if [[ "${DEGRADED_COUNT}" -gt 0 ]]; then
  echo "WARNING: ${DEGRADED_COUNT} degraded applications detected"
  exit 1
fi

echo "All applications healthy and synced."
```

## Summary

ArgoCD's ApplicationSet generators — cluster, git, matrix, and pull request — provide a declarative engine for managing application workloads across a fleet of Kubernetes clusters without per-cluster manual configuration. The app-of-apps pattern bootstraps clusters consistently from a single Git commit. Sync waves enforce deployment ordering within a sync operation, while sync windows enforce time-based change control. AppProject CRDs encode team isolation boundaries that ArgoCD enforces on every API call. Notification templates deliver rich sync and health events to Slack and PagerDuty. Progressive rollouts using canary cluster labels, validated by Prometheus error-rate queries before graduating to the full fleet, reduce the blast radius of platform changes. Together, these patterns transform a collection of independently operated clusters into a coherent, auditable, and self-healing fleet.
