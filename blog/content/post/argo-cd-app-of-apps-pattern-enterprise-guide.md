---
title: "ArgoCD App-of-Apps Pattern: Managing Large-Scale GitOps Deployments"
date: 2027-04-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ArgoCD", "GitOps", "App-of-Apps", "ApplicationSet"]
categories: ["Kubernetes", "GitOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to ArgoCD App-of-Apps and ApplicationSet patterns for managing hundreds of applications across multiple clusters, including bootstrapping, environment promotion, and GitOps fleet management."
more_link: "yes"
url: "/argo-cd-app-of-apps-pattern-enterprise-guide/"
---

Managing a handful of ArgoCD applications is straightforward. Managing hundreds of applications deployed across dozens of clusters in multiple environments is a fundamentally different operational problem. The App-of-Apps pattern and its evolution into ApplicationSets address this scaling challenge by making the definition of ArgoCD applications declarative and version-controlled — just like the applications themselves.

This guide covers the full spectrum from basic App-of-Apps bootstrapping through production-grade ApplicationSet fleet management, multi-tenant ArgoCD, promotion workflows, and GitOps security hardening.

<!--more-->

# Understanding the App-of-Apps Architecture

## The Problem with Individual Application Resources

When every ArgoCD `Application` resource is created manually — through the UI, CLI, or applied directly — the management layer itself falls outside the GitOps paradigm. Applications become configuration drift, engineers create applications by hand and forget to document them, and cluster rebuilds require reconstructing application state from memory or runbooks.

The App-of-Apps pattern solves this by treating `Application` resources as Kubernetes objects that ArgoCD should reconcile, just like Deployments or ConfigMaps. A root application syncs a Git directory full of child `Application` manifests. Every application in the cluster has a corresponding file in Git, making the desired state of the ArgoCD control plane fully reproducible.

```
┌────────────────────────────────────────────────────────────────────────┐
│                  App-of-Apps Architecture                             │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Git Repository: gitops-fleet                                          │
│  ├── apps/                           ◄── Root App syncs this dir       │
│  │   ├── cluster-addons/                                               │
│  │   │   ├── cert-manager.yaml       ◄── Child Application             │
│  │   │   ├── ingress-nginx.yaml      ◄── Child Application             │
│  │   │   ├── external-secrets.yaml   ◄── Child Application             │
│  │   │   └── metrics-server.yaml     ◄── Child Application             │
│  │   ├── platform-services/                                            │
│  │   │   ├── monitoring.yaml         ◄── Child Application             │
│  │   │   └── logging.yaml            ◄── Child Application             │
│  │   └── workloads/                                                    │
│  │       ├── team-alpha/                                               │
│  │       │   ├── app-frontend.yaml   ◄── Child Application             │
│  │       │   └── app-backend.yaml    ◄── Child Application             │
│  │       └── team-beta/                                                │
│  │           └── app-payments.yaml   ◄── Child Application             │
│  └── values/                                                           │
│      ├── production/                                                   │
│      └── staging/                                                      │
│                                                                        │
│  ArgoCD Control Plane                                                  │
│  ┌──────────────┐   syncs   ┌──────────────────────────────────────┐  │
│  │  Root App    │ ─────────► │  Child Application Resources         │  │
│  │  (cluster-   │            │  cert-manager, nginx, monitoring...  │  │
│  │   bootstrap) │            └──────────────────────────────────────┘  │
│  └──────────────┘                        │                             │
│                                          │ each child app syncs        │
│                                          ▼                             │
│                               Target Cluster Namespaces                │
└────────────────────────────────────────────────────────────────────────┘
```

## Bootstrap: Installing ArgoCD and the Root App

```bash
# Bootstrap ArgoCD on a new cluster
kubectl create namespace argocd

kubectl apply -n argocd \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Wait for ArgoCD to be ready
kubectl -n argocd rollout status deployment/argocd-server

# Apply the root application (the App-of-Apps)
kubectl apply -f - <<'EOF'
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cluster-bootstrap
  namespace: argocd
  # Finalizer ensures ArgoCD cleans up child apps when this is deleted
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://git.my-org.io/gitops-fleet.git
    targetRevision: main
    path: clusters/production/apps
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
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
EOF
```

# Building the Child Application Library

## Cluster Add-on Applications

Each file in the `apps/` directory is a standard ArgoCD `Application` resource. The key design choices at this level are: which project to assign the app to, whether sync should be automated, and what pruning behavior to use.

```yaml
# clusters/production/apps/cluster-addons/cert-manager.yaml
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cert-manager
  namespace: argocd
  labels:
    app.kubernetes.io/managed-by: cluster-bootstrap
    tier: cluster-addon
  annotations:
    # Link to runbook in the UI
    link.argocd.argoproj.io/external-link: https://wiki.my-org.io/cert-manager
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: cluster-addons
  source:
    repoURL: https://charts.jetstack.io
    chart: cert-manager
    targetRevision: v1.14.4
    helm:
      releaseName: cert-manager
      values: |
        installCRDs: true
        prometheus:
          enabled: true
          servicemonitor:
            enabled: true
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 500m
            memory: 256Mi
  destination:
    server: https://kubernetes.default.svc
    namespace: cert-manager
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
    retry:
      limit: 3
      backoff:
        duration: 10s
        factor: 2
        maxDuration: 1m
  ignoreDifferences:
    # cert-manager webhooks inject caBundle - ignore drift here
    - group: admissionregistration.k8s.io
      kind: ValidatingWebhookConfiguration
      jsonPointers:
        - /webhooks/0/clientConfig/caBundle
    - group: admissionregistration.k8s.io
      kind: MutatingWebhookConfiguration
      jsonPointers:
        - /webhooks/0/clientConfig/caBundle
```

```yaml
# clusters/production/apps/cluster-addons/ingress-nginx.yaml
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ingress-nginx
  namespace: argocd
  labels:
    app.kubernetes.io/managed-by: cluster-bootstrap
    tier: cluster-addon
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: cluster-addons
  source:
    repoURL: https://kubernetes.github.io/ingress-nginx
    chart: ingress-nginx
    targetRevision: 4.10.0
    helm:
      releaseName: ingress-nginx
      # Reference a values file from a separate path in the same repo
      valueFiles:
        - values-production.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: ingress-nginx
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

```yaml
# clusters/production/apps/platform/kube-prometheus-stack.yaml
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: kube-prometheus-stack
  namespace: argocd
  labels:
    app.kubernetes.io/managed-by: cluster-bootstrap
    tier: platform
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: platform
  sources:
    # Multi-source: chart from Helm repo, values from Git repo
    - repoURL: https://prometheus-community.github.io/helm-charts
      chart: kube-prometheus-stack
      targetRevision: 58.1.3
      helm:
        releaseName: kube-prometheus-stack
        valueFiles:
          - $values/clusters/production/values/kube-prometheus-stack.yaml
    - repoURL: https://git.my-org.io/gitops-fleet.git
      targetRevision: main
      ref: values
  destination:
    server: https://kubernetes.default.svc
    namespace: monitoring
  syncPolicy:
    automated:
      prune: false    # Prometheus data is stateful - manual prune
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
  ignoreDifferences:
    - group: ""
      kind: Secret
      name: kube-prometheus-stack-admission
      jsonPointers:
        - /data
```

# ApplicationSets: Scaling to Fleet Management

## ApplicationSet Architecture

ApplicationSets extend the App-of-Apps concept with template-driven generation. Instead of writing one `Application` YAML per application per environment, ApplicationSets use generators to produce `Application` resources programmatically. This is the difference between managing 50 YAML files and managing 500.

```
┌──────────────────────────────────────────────────────────────────────┐
│                  ApplicationSet Generation Flow                     │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ApplicationSet Generators                                           │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────────────┐ │
│  │  List     │  │  Cluster  │  │  Git      │  │  Matrix / Merge   │ │
│  │ generator │  │ generator │  │ generator │  │  (combinations)   │ │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └────────┬──────────┘ │
│        │              │              │                  │            │
│        └──────────────┴──────────────┴──────────────────┘            │
│                                  │                                   │
│                          generates params                            │
│                                  │                                   │
│                                  ▼                                   │
│  ApplicationSet Template  ─── rendered ──► Application resources    │
│  {{ cluster }}, {{ env }}              cert-manager-prod             │
│  {{ app }}, {{ namespace }}            cert-manager-staging          │
│                                        ingress-nginx-prod            │
│                                        ingress-nginx-staging         │
│                                        ...N applications             │
└──────────────────────────────────────────────────────────────────────┘
```

## Git Generator: App-per-Directory Pattern

The Git directory generator scans a repository path and creates one Application per matching directory. This is the most common pattern for application teams — each team owns a directory, and any new subdirectory they add is automatically deployed.

```yaml
# applicationsets/app-per-directory.yaml
---
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: workload-apps
  namespace: argocd
spec:
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]
  generators:
    - git:
        repoURL: https://git.my-org.io/gitops-fleet.git
        revision: main
        directories:
          - path: workloads/*/
          # Exclude template directories
          - path: workloads/_template
            exclude: true
  template:
    metadata:
      # Extract app name from directory path: workloads/team-alpha/frontend -> team-alpha-frontend
      name: "{{ .path.basenameNormalized }}"
      namespace: argocd
      labels:
        managed-by: workload-appset
        team: "{{ index .path.segments 1 }}"
      finalizers:
        - resources-finalizer.argocd.argoproj.io
    spec:
      project: "{{ index .path.segments 1 }}"
      source:
        repoURL: https://git.my-org.io/gitops-fleet.git
        targetRevision: main
        path: "{{ .path.path }}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{ index .path.segments 1 }}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
  syncPolicy:
    # ApplicationSet-level policy: preserve Application on AppSet deletion
    preserveResourcesOnDeletion: false
```

## Cluster Generator: Multi-Cluster Fleet Deployment

The cluster generator creates one Application per registered ArgoCD cluster. Cluster metadata (labels on the cluster secret) is available as template parameters.

```yaml
# applicationsets/cluster-addons-fleet.yaml
---
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: cluster-addons-fleet
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - clusters:
        selector:
          matchLabels:
            # Only target clusters with this label
            fleet.my-org.io/managed: "true"
        # Values from cluster Secret labels become template variables
        values:
          # Fetch environment from cluster label
          environment: "{{ .metadata.labels.env }}"
          region: "{{ .metadata.labels.region }}"
  template:
    metadata:
      name: "cert-manager-{{ .name }}"
      namespace: argocd
      labels:
        app: cert-manager
        cluster: "{{ .name }}"
        environment: "{{ .values.environment }}"
      finalizers:
        - resources-finalizer.argocd.argoproj.io
    spec:
      project: cluster-addons
      source:
        repoURL: https://charts.jetstack.io
        chart: cert-manager
        targetRevision: v1.14.4
        helm:
          releaseName: cert-manager
          # Environment-specific values file
          valueFiles:
            - environments/{{ .values.environment }}/cert-manager.yaml
      destination:
        server: "{{ .server }}"
        namespace: cert-manager
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
```

## Matrix Generator: Apps x Environments Cross-Product

The matrix generator combines two generators, producing the cartesian product. This is ideal for deploying N applications to M environments with environment-specific overrides.

```yaml
# applicationsets/matrix-apps-environments.yaml
---
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: platform-services-all-envs
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - matrix:
        generators:
          # Generator 1: List of applications
          - list:
              elements:
                - app: ingress-nginx
                  chart: ingress-nginx
                  repoURL: https://kubernetes.github.io/ingress-nginx
                  chartVersion: "4.10.0"
                  namespace: ingress-nginx
                - app: external-dns
                  chart: external-dns
                  repoURL: https://charts.bitnami.com/bitnami
                  chartVersion: "6.38.0"
                  namespace: external-dns
                - app: velero
                  chart: velero
                  repoURL: https://vmware-tanzu.github.io/helm-charts
                  chartVersion: "6.0.0"
                  namespace: velero
          # Generator 2: Cluster environments
          - list:
              elements:
                - clusterName: production
                  clusterServer: https://k8s-prod.my-org.io
                  environment: production
                  syncEnabled: "true"
                - clusterName: staging
                  clusterServer: https://k8s-staging.my-org.io
                  environment: staging
                  syncEnabled: "true"
                - clusterName: development
                  clusterServer: https://k8s-dev.my-org.io
                  environment: development
                  syncEnabled: "false"
  template:
    metadata:
      name: "{{ .app }}-{{ .environment }}"
      namespace: argocd
      labels:
        app: "{{ .app }}"
        environment: "{{ .environment }}"
      finalizers:
        - resources-finalizer.argocd.argoproj.io
    spec:
      project: platform
      source:
        repoURL: "{{ .repoURL }}"
        chart: "{{ .chart }}"
        targetRevision: "{{ .chartVersion }}"
        helm:
          releaseName: "{{ .app }}"
          valueFiles:
            - $values/environments/{{ .environment }}/{{ .app }}.yaml
      destination:
        server: "{{ .clusterServer }}"
        namespace: "{{ .namespace }}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: "{{ eq .syncEnabled \"true\" }}"
        syncOptions:
          - CreateNamespace=true
```

## Git File Generator: Declarative Application Inventory

The git files generator reads JSON or YAML configuration files from a repository and exposes their fields as template parameters. This provides the most flexible application inventory management.

```yaml
# applicationsets/git-files-appset.yaml
---
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: service-catalog
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - git:
        repoURL: https://git.my-org.io/service-catalog.git
        revision: main
        files:
          - path: "services/**/*.json"
  template:
    metadata:
      name: "{{ .service.name }}-{{ .environment.name }}"
      namespace: argocd
      labels:
        service: "{{ .service.name }}"
        team: "{{ .service.team }}"
        environment: "{{ .environment.name }}"
    spec:
      project: "{{ .service.team }}"
      source:
        repoURL: "{{ .service.repoURL }}"
        targetRevision: "{{ .environment.gitRevision }}"
        path: "{{ .service.chartPath }}"
        helm:
          releaseName: "{{ .service.name }}"
          parameters:
            - name: image.tag
              value: "{{ .service.imageTag }}"
            - name: replicaCount
              value: "{{ .environment.replicaCount }}"
      destination:
        server: "{{ .environment.clusterServer }}"
        namespace: "{{ .service.team }}-{{ .environment.name }}"
      syncPolicy:
        automated:
          prune: "{{ .environment.autoPrune }}"
          selfHeal: true
```

```json
// services/payments/production.json
{
  "service": {
    "name": "payments-api",
    "team": "payments",
    "repoURL": "https://git.my-org.io/payments-api.git",
    "chartPath": "chart",
    "imageTag": "v3.2.1"
  },
  "environment": {
    "name": "production",
    "clusterServer": "https://k8s-prod.my-org.io",
    "gitRevision": "v3.2.1",
    "replicaCount": "3",
    "autoPrune": "true"
  }
}
```

## Merge Generator: Combining Multiple Data Sources

The merge generator overlays data from multiple generators, allowing base configuration to be overridden by environment-specific values.

```yaml
# applicationsets/merge-generator-example.yaml
---
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: apps-with-env-overrides
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - merge:
        mergeKeys:
          - app
        generators:
          # Base: list all applications with defaults
          - list:
              elements:
                - app: frontend
                  namespace: web
                  replicas: "2"
                  syncEnabled: "false"
                - app: backend
                  namespace: api
                  replicas: "2"
                  syncEnabled: "false"
          # Override: production-specific values
          - list:
              elements:
                - app: frontend
                  replicas: "5"
                  syncEnabled: "true"
                - app: backend
                  replicas: "3"
                  syncEnabled: "true"
  template:
    metadata:
      name: "{{ .app }}-production"
      namespace: argocd
    spec:
      project: production-apps
      source:
        repoURL: https://git.my-org.io/gitops-fleet.git
        targetRevision: main
        path: "apps/{{ .app }}"
        helm:
          parameters:
            - name: replicaCount
              value: "{{ .replicas }}"
      destination:
        server: https://k8s-prod.my-org.io
        namespace: "{{ .namespace }}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: "{{ eq .syncEnabled \"true\" }}"
```

# Multi-Tenant ArgoCD Architecture

## AppProject Design for Tenant Isolation

`AppProject` resources define the boundary of what an ArgoCD project can deploy to, what source repositories it can pull from, and what cluster resources it can manage. Multi-tenant ArgoCD uses one project per team with restricted permissions.

```yaml
# projects/team-payments-project.yaml
---
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: payments-team
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  description: "Payments team project - isolated to payments/* namespaces"

  # Only allow these source repositories
  sourceRepos:
    - https://git.my-org.io/payments-api.git
    - https://git.my-org.io/payments-worker.git
    - https://git.my-org.io/gitops-fleet.git
    - https://charts.bitnami.com/bitnami     # Bitnami Helm charts only

  # Only allow deployments to namespaces matching payments-*
  destinations:
    - server: https://k8s-prod.my-org.io
      namespace: payments-production
    - server: https://k8s-staging.my-org.io
      namespace: payments-staging
    - server: https://k8s-dev.my-org.io
      namespace: payments-*    # Wildcard for dev

  # Cluster-scoped resources this project cannot manage
  clusterResourceBlacklist:
    - group: ""
      kind: Namespace
    - group: rbac.authorization.k8s.io
      kind: ClusterRole
    - group: rbac.authorization.k8s.io
      kind: ClusterRoleBinding

  # Namespace-scoped resources this project CAN manage
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
    - group: networking.k8s.io
      kind: Ingress
    - group: autoscaling
      kind: HorizontalPodAutoscaler
    - group: policy
      kind: PodDisruptionBudget
    - group: batch
      kind: CronJob

  # Sync windows: no production deploys on weekends
  syncWindows:
    - kind: allow
      schedule: "0 8 * * 1-5"   # Weekdays 8am-6pm UTC
      duration: 10h
      namespaces:
        - payments-production
      applications:
        - "*"
    - kind: deny
      schedule: "0 0 * * 0,6"   # Weekends
      duration: 48h
      namespaces:
        - payments-production
      manualSync: false   # Block even manual syncs on weekends

  # RBAC within the project
  roles:
    - name: developer
      description: "Read-only access for developers"
      policies:
        - p, proj:payments-team:developer, applications, get, payments-team/*, allow
        - p, proj:payments-team:developer, applications, sync, payments-team/*, allow
      groups:
        - payments-engineers
    - name: deployer
      description: "Deploy access for CI/CD"
      policies:
        - p, proj:payments-team:deployer, applications, *, payments-team/*, allow
      groups:
        - payments-ci-cd-bot
```

## Tenant-Aware ApplicationSet with Project Scoping

```yaml
# applicationsets/per-tenant-appset.yaml
---
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: tenant-applications
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - git:
        repoURL: https://git.my-org.io/gitops-fleet.git
        revision: main
        files:
          - path: "tenants/**/app-config.yaml"
  # ApplicationSet-level RBAC: only argocd-admins can manage this AppSet
  templatePatch: |
    spec:
      project: "{{ .tenant }}"
  template:
    metadata:
      name: "{{ .tenant }}-{{ .appName }}"
      namespace: argocd
      labels:
        tenant: "{{ .tenant }}"
        app: "{{ .appName }}"
    spec:
      project: "{{ .tenant }}"
      source:
        repoURL: "{{ .sourceRepo }}"
        targetRevision: "{{ .targetRevision }}"
        path: "{{ .chartPath }}"
      destination:
        server: "{{ .clusterServer }}"
        namespace: "{{ .tenant }}-production"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

# Environment Promotion Workflows

## Promotion via Git Branch Strategy

```
┌─────────────────────────────────────────────────────────────────────┐
│              GitOps Promotion Workflow                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Developer merges PR to main                                        │
│       │                                                             │
│       ▼                                                             │
│  CI pipeline builds image, updates values file                      │
│  imageTag: v1.2.3  ──► environments/dev/payments.yaml               │
│       │                                                             │
│       ▼                                                             │
│  ArgoCD detects diff, syncs to development cluster                  │
│  Tests pass ──► PR: bump imageTag in environments/staging/          │
│       │                                                             │
│       ▼                                                             │
│  Staging PR merged ──► ArgoCD syncs to staging cluster              │
│  Approval obtained ──► PR: bump imageTag in environments/production/│
│       │                                                             │
│       ▼                                                             │
│  Production PR merged (requires 2 reviews + status checks)          │
│  ArgoCD syncs to production cluster within sync window              │
└─────────────────────────────────────────────────────────────────────┘
```

```yaml
# .github/workflows/promote-to-staging.yaml
name: Promote to Staging
on:
  workflow_dispatch:
    inputs:
      service:
        description: "Service to promote"
        required: true
      image_tag:
        description: "Image tag to promote"
        required: true

jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITOPS_TOKEN }}

      - name: Update staging values
        run: |
          # Update the image tag in the staging values file
          yq e ".image.tag = \"${{ inputs.image_tag }}\"" -i \
            "environments/staging/${{ inputs.service }}.yaml"

          git config user.email "ci@my-org.io"
          git config user.name "CI Bot"
          git add "environments/staging/${{ inputs.service }}.yaml"
          git commit -m "chore: promote ${{ inputs.service }} ${{ inputs.image_tag }} to staging"
          git push

      - name: Wait for ArgoCD sync
        run: |
          # Use ArgoCD CLI to wait for sync completion
          argocd app wait ${{ inputs.service }}-staging \
            --sync \
            --health \
            --timeout 300 \
            --server argocd.my-org.io \
            --auth-token "${{ secrets.ARGOCD_AUTH_TOKEN }}"
```

## ApplicationSet Webhook Trigger for Faster Reconciliation

By default, ApplicationSet polls Git every 3 minutes. Webhook triggers reduce this to near-instant reconciliation when a push event arrives.

```yaml
# argocd-applicationset-webhook-config.yaml
# This is configured in the ArgoCD ConfigMap for the ApplicationSet controller
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  # Enable webhook for ApplicationSet
  applicationsetcontroller.enable.leader.election: "true"
  applicationsetcontroller.policy: sync
  # Reduce poll interval - webhook handles real-time updates
  applicationsetcontroller.requeue.after.seconds: "180"
```

```bash
# Configure GitHub/GitLab webhook to point to ArgoCD
# ArgoCD ApplicationSet webhook endpoint:
# https://argocd.my-org.io/api/webhook

# Create a shared secret for webhook verification
kubectl -n argocd create secret generic argocd-webhook-secret \
  --from-literal=webhook.github.secret=EXAMPLE_TOKEN_REPLACE_ME

# Patch the ArgoCD secret to add the webhook secret
kubectl -n argocd patch secret argocd-secret \
  --type='json' \
  -p='[{"op":"add","path":"/data/webhook.github.secret","value":"'$(echo -n "EXAMPLE_TOKEN_REPLACE_ME" | base64)'"}]'
```

# ArgoCD RBAC and Security Hardening

## Global RBAC Policy Configuration

```yaml
# argocd-rbac-cm.yaml
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: role:readonly
  policy.csv: |
    # Platform admin - full access
    p, role:platform-admin, applications, *, */*, allow
    p, role:platform-admin, clusters, *, *, allow
    p, role:platform-admin, repositories, *, *, allow
    p, role:platform-admin, projects, *, *, allow
    p, role:platform-admin, accounts, *, *, allow
    p, role:platform-admin, gpgkeys, *, *, allow
    p, role:platform-admin, logs, get, */*, allow
    p, role:platform-admin, exec, create, */*, allow

    # Platform viewer - read only
    p, role:platform-viewer, applications, get, */*, allow
    p, role:platform-viewer, clusters, get, *, allow
    p, role:platform-viewer, repositories, get, *, allow
    p, role:platform-viewer, projects, get, *, allow

    # CI/CD service role - sync only, no delete
    p, role:ci-cd, applications, get, */*, allow
    p, role:ci-cd, applications, sync, */*, allow
    p, role:ci-cd, applications, override, */*, allow

    # Group mappings (from OIDC/LDAP groups)
    g, platform-admins, role:platform-admin
    g, platform-engineers, role:platform-viewer
    g, ci-cd-bots, role:ci-cd
  scopes: "[groups, email]"
```

## Repository Credentials and Access Control

```yaml
# argocd-repositories.yaml
---
# GitHub App credentials (preferred over PAT for production)
apiVersion: v1
kind: Secret
metadata:
  name: gitops-fleet-repo
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
stringData:
  type: git
  url: https://git.my-org.io/gitops-fleet.git
  # GitHub App authentication
  githubAppID: "12345"
  githubAppInstallationID: "67890"
  githubAppPrivateKey: |
    # Paste your GitHub App private key PEM contents here
    EXAMPLE_TOKEN_REPLACE_ME

---
# Helm repository with OCI registry
apiVersion: v1
kind: Secret
metadata:
  name: private-helm-registry
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
stringData:
  type: helm
  url: oci://registry.my-org.io/helm-charts
  username: robot-argocd
  password: EXAMPLE_TOKEN_REPLACE_ME
  enableOCI: "true"
```

## Cluster Registration for Multi-Cluster Fleet

```bash
# Register an external cluster with ArgoCD using the CLI
# The CLI creates the cluster secret automatically
argocd cluster add production-cluster \
  --name production \
  --server argocd.my-org.io \
  --auth-token "EXAMPLE_TOKEN_REPLACE_ME" \
  --label env=production \
  --label region=us-east-1 \
  --label fleet.my-org.io/managed=true

# Alternatively, create the cluster secret directly for GitOps management
# This allows the cluster registration itself to be version-controlled
```

```yaml
# cluster-secrets/production-cluster.yaml (stored in sealed-secrets or ESO)
---
apiVersion: v1
kind: Secret
metadata:
  name: production-cluster
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
    env: production
    region: us-east-1
    fleet.my-org.io/managed: "true"
type: Opaque
stringData:
  name: production
  server: https://k8s-prod.my-org.io
  config: |
    {
      "bearerToken": "EXAMPLE_TOKEN_REPLACE_ME",
      "tlsClientConfig": {
        "insecure": false,
        "caData": "EXAMPLE_TOKEN_REPLACE_ME"
      }
    }
```

# Operational Practices

## Monitoring ArgoCD Fleet Health

```yaml
# argocd-prometheus-rules.yaml
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: argocd-fleet-health
  namespace: monitoring
spec:
  groups:
    - name: argocd-applications
      interval: 30s
      rules:
        - alert: ArgoCDApplicationOutOfSync
          expr: |
            argocd_app_info{sync_status!="Synced"} == 1
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "ArgoCD application out of sync"
            description: "Application {{ $labels.name }} in project {{ $labels.project }} has sync status {{ $labels.sync_status }}"

        - alert: ArgoCDApplicationDegraded
          expr: |
            argocd_app_info{health_status!~"Healthy|Progressing"} == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "ArgoCD application health degraded"
            description: "Application {{ $labels.name }} health is {{ $labels.health_status }}"

        - alert: ArgoCDSyncFailed
          expr: |
            increase(argocd_app_sync_total{phase="Error"}[5m]) > 0
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "ArgoCD sync failed"
            description: "Application {{ $labels.name }} sync failed"

        - alert: ArgoCDRepoServerUnhealthy
          expr: |
            up{job="argocd-repo-server"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "ArgoCD repo server is down"
```

## Useful CLI Operations for Fleet Management

```bash
# List all applications and their health/sync status
argocd app list -o wide --server argocd.my-org.io

# List all out-of-sync applications
argocd app list --selector '!argocd.argoproj.io/hook' \
  -o wide | grep -v Synced

# Sync all applications in a specific project
argocd app list -p payments-team -o name | \
  xargs -I{} argocd app sync {} --async

# Force hard refresh (bypass cache) for all apps
argocd app list -o name | \
  xargs -I{} argocd app get {} --hard-refresh

# Check sync windows for an app
argocd proj windows list payments-team

# Override a sync window for emergency deployment
argocd proj windows enable payments-team <window-id>
# Deploy...
argocd proj windows disable payments-team <window-id>

# Terminate a running sync operation
argocd app terminate-op my-app

# Rollback an application to a previous deployment
argocd app history my-app
argocd app rollback my-app <revision-id>

# Get resource tree for debugging
argocd app resources my-app
argocd app resource-actions list my-app --kind Deployment --resource-name my-deploy
```

## Garbage Collection: Orphaned Application Cleanup

```bash
#!/bin/bash
# cleanup-orphaned-apps.sh
# Finds ArgoCD Applications whose source paths no longer exist in Git

ARGOCD_SERVER="argocd.my-org.io"
GITOPS_REPO_PATH="/tmp/gitops-fleet"

# Clone the GitOps repo
git clone https://git.my-org.io/gitops-fleet.git "${GITOPS_REPO_PATH}"

# Get all ArgoCD applications
argocd app list -o json --server "${ARGOCD_SERVER}" | \
  jq -r '.[] | "\(.metadata.name) \(.spec.source.path // "N/A") \(.spec.source.repoURL // "N/A")"' | \
  while read -r APP_NAME APP_PATH APP_REPO; do
    if [ "${APP_REPO}" = "https://git.my-org.io/gitops-fleet.git" ] && \
       [ "${APP_PATH}" != "N/A" ]; then
      FULL_PATH="${GITOPS_REPO_PATH}/${APP_PATH}"
      if [ ! -d "${FULL_PATH}" ]; then
        echo "ORPHANED: ${APP_NAME} (path ${APP_PATH} not found in Git)"
        # Uncomment to automatically delete:
        # argocd app delete "${APP_NAME}" --cascade --server "${ARGOCD_SERVER}"
      fi
    fi
  done

rm -rf "${GITOPS_REPO_PATH}"
```

The App-of-Apps pattern transforms ArgoCD from an application deployment tool into a fully declarative cluster management platform. When every ArgoCD Application resource is itself tracked in Git, the management plane becomes as reproducible and auditable as the workloads it deploys. ApplicationSets extend this to fleet scale, enabling platform teams to express complex multi-cluster, multi-environment deployment topologies in a handful of YAML files rather than hundreds. The result is a GitOps system that can be fully reconstructed from a single `kubectl apply` and a Git clone.
