---
title: "ArgoCD ApplicationSets: Dynamic Multi-Cluster Application Deployment"
date: 2029-01-12T00:00:00-05:00
draft: false
tags: ["ArgoCD", "GitOps", "ApplicationSets", "Multi-Cluster", "Kubernetes", "Kustomize"]
categories:
- Kubernetes
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to ArgoCD ApplicationSets for dynamic multi-cluster application deployment, covering generators, templating, progressive sync, and production patterns for managing hundreds of clusters from a single control plane."
more_link: "yes"
url: "/argocd-applicationsets-dynamic-multicluster/"
---

ArgoCD ApplicationSets extend ArgoCD's GitOps model to multi-cluster, multi-tenant environments by automating the creation, modification, and deletion of ArgoCD Applications. Instead of manually creating one Application per cluster or environment, ApplicationSets generate Applications dynamically from parameterized templates driven by generators. This guide covers the full range of ApplicationSet generators, advanced templating patterns, progressive sync strategies, and the operational patterns needed to manage hundreds of clusters reliably.

<!--more-->

## ApplicationSet Architecture

An ApplicationSet controller runs alongside ArgoCD and watches `ApplicationSet` custom resources. When an ApplicationSet is created or its generators produce new entries, the controller renders Application objects and submits them to the ArgoCD API server.

### Generator Types Overview

| Generator | Use Case | Data Source |
|---|---|---|
| List | Fixed list of clusters/environments | Inline YAML |
| Cluster | All registered ArgoCD clusters | ArgoCD cluster secrets |
| Git Directories | One app per directory in Git | Git repository structure |
| Git Files | One app per config file in Git | JSON/YAML files in Git |
| Matrix | Cartesian product of two generators | Combined generators |
| Merge | Merge outputs from multiple generators | Combined generators |
| SCM Provider | All repos in GitHub/GitLab org | SCM API |
| Pull Request | One app per open PR | SCM pull requests |
| Cluster Decision Resource | External cluster lists | Custom CRDs |

## Basic ApplicationSet Examples

### List Generator: Fixed Environment Deployment

```yaml
# applicationsets/guestbook-environments.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: guestbook-environments
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - cluster: dev-us-east-1
            url: https://dev-k8s.corp.example.com:6443
            namespace: guestbook-dev
            values:
              replicaCount: "1"
              imageTag: "latest"
              resourcePreset: small
          - cluster: staging-us-east-1
            url: https://staging-k8s.corp.example.com:6443
            namespace: guestbook-staging
            values:
              replicaCount: "2"
              imageTag: "1.8.3"
              resourcePreset: medium
          - cluster: prod-us-east-1
            url: https://prod-k8s-use1.corp.example.com:6443
            namespace: guestbook-prod
            values:
              replicaCount: "5"
              imageTag: "1.8.3"
              resourcePreset: large
          - cluster: prod-eu-west-1
            url: https://prod-k8s-euw1.corp.example.com:6443
            namespace: guestbook-prod
            values:
              replicaCount: "5"
              imageTag: "1.8.3"
              resourcePreset: large
  template:
    metadata:
      name: "guestbook-{{cluster}}"
      labels:
        app.kubernetes.io/name: guestbook
        environment: "{{cluster}}"
      annotations:
        notifications.argoproj.io/subscribe.on-sync-failed.slack: platform-alerts
        notifications.argoproj.io/subscribe.on-health-degraded.slack: platform-alerts
    spec:
      project: default
      source:
        repoURL: https://github.com/corp/guestbook.git
        targetRevision: HEAD
        path: helm/guestbook
        helm:
          valueFiles:
            - "../../config/{{cluster}}/values.yaml"
          parameters:
            - name: replicaCount
              value: "{{values.replicaCount}}"
            - name: image.tag
              value: "{{values.imageTag}}"
            - name: resources.preset
              value: "{{values.resourcePreset}}"
      destination:
        server: "{{url}}"
        namespace: "{{namespace}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - PrunePropagationPolicy=foreground
          - ServerSideApply=true
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
            - /spec/replicas  # Allow HPA to manage replicas
```

### Cluster Generator: All Registered Clusters

The Cluster generator iterates over all clusters registered in ArgoCD, with optional label-based filtering.

```yaml
# applicationsets/cluster-addons.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: cluster-monitoring-addons
  namespace: argocd
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            argocd.argoproj.io/secret-type: cluster
            monitoring: enabled
          matchExpressions:
            - key: environment
              operator: In
              values: [production, staging]
            - key: cluster-tier
              operator: NotIn
              values: [management]
  template:
    metadata:
      name: "monitoring-{{name}}"
    spec:
      project: platform-addons
      source:
        repoURL: https://github.com/corp/cluster-addons.git
        targetRevision: main
        path: monitoring
        kustomize:
          namePrefix: "{{name}}-"
          commonLabels:
            cluster-name: "{{name}}"
            cluster-region: "{{metadata.labels.region}}"
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

## Git Generators: Directory and File Patterns

### Git Directory Generator

Automatically create one Application per directory matching a glob pattern.

```
# Git repository structure for git-directories generator
apps/
├── team-payments/
│   ├── payment-api/
│   │   ├── kustomization.yaml
│   │   └── deployment.yaml
│   ├── payment-worker/
│   │   ├── kustomization.yaml
│   │   └── deployment.yaml
│   └── fraud-detection/
│       ├── kustomization.yaml
│       └── deployment.yaml
└── team-identity/
    ├── auth-service/
    │   └── kustomization.yaml
    └── user-service/
        └── kustomization.yaml
```

```yaml
# applicationsets/team-apps-directories.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: team-applications
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/corp/platform-apps.git
        revision: main
        directories:
          - path: apps/*/*       # Match app directories two levels deep
          - path: apps/*/deprecated
            exclude: true        # Exclude deprecated subdirectories
  template:
    metadata:
      # path.basename = directory name (e.g., "payment-api")
      # path[0] = first path component after apps/ (e.g., "team-payments")
      name: "{{path.basename}}"
      labels:
        team: "{{path[0]}}"
        app: "{{path.basename}}"
    spec:
      project: "{{path[0]}}"
      source:
        repoURL: https://github.com/corp/platform-apps.git
        targetRevision: main
        path: "{{path}}"
      destination:
        server: https://prod-k8s.corp.example.com:6443
        namespace: "{{path[0]}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: false   # Disable selfHeal for team namespaces
        syncOptions:
          - CreateNamespace=true
```

### Git File Generator: Config-Driven Deployment

The Git Files generator reads JSON or YAML files matching a glob and uses their contents as template parameters.

```yaml
# config/clusters/prod-us-east-1.yaml
clusterName: prod-us-east-1
serverURL: https://prod-k8s-use1.corp.example.com:6443
region: us-east-1
environment: production
tier: workload
addons:
  monitoring: true
  logging: true
  velero: true
  certManager: true
helmDefaults:
  timeout: 600
  atomicInstall: true
```

```yaml
# config/clusters/dev-us-east-1.yaml
clusterName: dev-us-east-1
serverURL: https://dev-k8s.corp.example.com:6443
region: us-east-1
environment: development
tier: workload
addons:
  monitoring: true
  logging: false
  velero: false
  certManager: true
helmDefaults:
  timeout: 300
  atomicInstall: false
```

```yaml
# applicationsets/cert-manager-clusters.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: cert-manager-per-cluster
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/corp/cluster-config.git
        revision: main
        files:
          - path: "config/clusters/*.yaml"
  # Use a conditional check: only deploy if certManager addon is enabled
  template:
    metadata:
      name: "cert-manager-{{clusterName}}"
    spec:
      project: platform-addons
      source:
        repoURL: https://github.com/corp/cluster-addons.git
        targetRevision: main
        path: cert-manager
        helm:
          releaseName: cert-manager
          valueFiles:
            - values-common.yaml
            - "values-{{environment}}.yaml"
      destination:
        server: "{{serverURL}}"
        namespace: cert-manager
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
```

## Matrix Generator: Cross-Product Deployments

The Matrix generator creates the Cartesian product of two generators, enabling a deployment to every (cluster, application) combination.

```yaml
# applicationsets/platform-apps-all-clusters.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: platform-core-services
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          # Generator 1: All production clusters from Git config
          - git:
              repoURL: https://github.com/corp/cluster-config.git
              revision: main
              files:
                - path: "config/clusters/prod-*.yaml"
          # Generator 2: List of core platform services
          - list:
              elements:
                - service: metrics-server
                  namespace: kube-system
                  path: addons/metrics-server
                - service: node-problem-detector
                  namespace: kube-system
                  path: addons/node-problem-detector
                - service: descheduler
                  namespace: kube-system
                  path: addons/descheduler
                - service: kube-state-metrics
                  namespace: monitoring
                  path: addons/kube-state-metrics
  template:
    metadata:
      name: "{{service}}-{{clusterName}}"
    spec:
      project: platform-addons
      source:
        repoURL: https://github.com/corp/cluster-addons.git
        targetRevision: main
        path: "{{path}}"
        helm:
          valueFiles:
            - values.yaml
            - "values-{{environment}}.yaml"
      destination:
        server: "{{serverURL}}"
        namespace: "{{namespace}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
```

## Merge Generator: Combining Multiple Sources

The Merge generator combines generator outputs, with later generators overriding earlier ones for matching keys.

```yaml
# applicationsets/merged-config-deployment.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: app-with-overrides
  namespace: argocd
spec:
  generators:
    - merge:
        mergeKeys:
          - clusterName
        generators:
          # Base: all clusters
          - clusters:
              selector:
                matchLabels:
                  argocd.argoproj.io/secret-type: cluster
              values:
                imageTag: "1.8.3"
                replicas: "2"
                resourceProfile: standard
          # Override: production clusters get specific settings
          - list:
              elements:
                - clusterName: prod-us-east-1
                  values:
                    imageTag: "1.8.3"
                    replicas: "5"
                    resourceProfile: large
                - clusterName: prod-eu-west-1
                  values:
                    imageTag: "1.8.3"
                    replicas: "5"
                    resourceProfile: large
  template:
    metadata:
      name: "myapp-{{clusterName}}"
    spec:
      project: applications
      source:
        repoURL: https://github.com/corp/myapp.git
        targetRevision: main
        path: helm/myapp
        helm:
          parameters:
            - name: image.tag
              value: "{{values.imageTag}}"
            - name: replicaCount
              value: "{{values.replicas}}"
            - name: resources.profile
              value: "{{values.resourceProfile}}"
      destination:
        server: "{{server}}"
        namespace: myapp
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

## Pull Request Generator: Preview Environments

The Pull Request generator creates ephemeral Applications for each open pull request, enabling preview environments.

```yaml
# applicationsets/pr-preview-environments.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: pr-preview-environments
  namespace: argocd
spec:
  generators:
    - pullRequest:
        github:
          owner: corp
          repo: myapp
          appSecretName: github-app-secret  # ArgoCD secret with GitHub App credentials
          tokenRef:
            secretName: github-token
            key: token
          labels:
            - preview  # Only PRs labeled "preview" get environments
        requeueAfterSeconds: 180
  template:
    metadata:
      name: "myapp-pr-{{number}}"
      labels:
        environment: preview
        pr-number: "{{number}}"
      annotations:
        # Auto-delete app when PR is closed
        argocd-image-updater.argoproj.io/image-list: myapp=registry.corp.example.com/myapp
    spec:
      project: preview-environments
      source:
        repoURL: https://github.com/corp/myapp.git
        targetRevision: "{{head_sha}}"
        path: helm/myapp
        helm:
          parameters:
            - name: image.tag
              value: "pr-{{number}}"
            - name: ingress.host
              value: "myapp-pr-{{number}}.preview.corp.example.com"
            - name: replicaCount
              value: "1"
            - name: environment
              value: preview
      destination:
        server: https://dev-k8s.corp.example.com:6443
        namespace: "preview-pr-{{number}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
      info:
        - name: GitHub PR
          value: "https://github.com/corp/myapp/pull/{{number}}"
        - name: Preview URL
          value: "https://myapp-pr-{{number}}.preview.corp.example.com"
```

## Progressive Sync with ApplicationSet

ArgoCD 2.6+ added progressive rollout support to ApplicationSets via the `syncPolicy.applicationsSync` and `rollout` features.

```yaml
# applicationsets/progressive-rollout.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: myapp-progressive-rollout
  namespace: argocd
spec:
  strategy:
    type: RollingSync
    rollingSync:
      steps:
        - matchExpressions:
            - key: environment
              operator: In
              values: [dev]
          maxUpdate: 100%    # Roll out all dev clusters at once
        - matchExpressions:
            - key: environment
              operator: In
              values: [staging]
          maxUpdate: 50%     # Roll out 50% of staging clusters
        - matchExpressions:
            - key: environment
              operator: In
              values: [production]
            - key: region
              operator: In
              values: [us-east-1]
          maxUpdate: 1       # One production cluster at a time, starting with US East
        - matchExpressions:
            - key: environment
              operator: In
              values: [production]
          maxUpdate: 25%     # Remaining production clusters at 25% per step
  generators:
    - clusters:
        selector:
          matchLabels:
            managed-by: applicationset-progressive
  template:
    metadata:
      name: "myapp-{{name}}"
      labels:
        environment: "{{metadata.labels.environment}}"
        region: "{{metadata.labels.region}}"
    spec:
      project: applications
      source:
        repoURL: https://github.com/corp/myapp.git
        targetRevision: "v2.1.0"
        path: helm/myapp
      destination:
        server: "{{server}}"
        namespace: myapp
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

## Ignoring Application Differences

Production applications often have legitimate runtime differences (HPA-managed replica counts, operator-injected annotations). Configure `ignoreDifferences` to prevent unnecessary sync operations.

```yaml
# Comprehensive ignoreDifferences configuration
spec:
  template:
    spec:
      ignoreDifferences:
        # Ignore HPA-managed replicas
        - group: apps
          kind: Deployment
          jsonPointers:
            - /spec/replicas
        # Ignore operator-injected labels and annotations
        - group: ""
          kind: Service
          jqPathExpressions:
            - .metadata.labels["app.kubernetes.io/managed-by"]
            - .metadata.annotations["cloud.google.com/neg"]
        # Ignore mutating webhook injected fields
        - group: apps
          kind: Deployment
          managedFieldsManagers:
            - kube-controller-manager
            - datadog-agent
        # Ignore cert-manager generated certificate data
        - group: ""
          kind: Secret
          name: myapp-tls
          jsonPointers:
            - /data
```

## SCM Provider Generator: Organization-Wide Discovery

```yaml
# applicationsets/github-org-apps.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: github-org-microservices
  namespace: argocd
spec:
  generators:
    - scmProvider:
        github:
          organization: corp
          appSecretName: github-app-secret
          allBranches: false
        filters:
          - repositoryMatch: "^svc-"     # Only repos starting with "svc-"
            branchMatch: main
            pathsExist:
              - deploy/kubernetes         # Only repos with this path
            labelMatch: "deploy=argocd"  # Only repos with this topic
  template:
    metadata:
      name: "{{repository}}-{{branch}}"
    spec:
      project: microservices
      source:
        repoURL: "{{url}}"
        targetRevision: "{{branch}}"
        path: deploy/kubernetes
        kustomize:
          commonLabels:
            repo: "{{repository}}"
            org: "{{organization}}"
      destination:
        server: https://prod-k8s.corp.example.com:6443
        namespace: "{{repository}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

## Governance: ApplicationSet RBAC and Projects

```yaml
# argocd/projects/platform-addons.yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: platform-addons
  namespace: argocd
spec:
  description: Platform infrastructure addons managed by ApplicationSets
  sourceRepos:
    - https://github.com/corp/cluster-addons.git
    - https://charts.corp.example.com/*
  destinations:
    - server: "*"
      namespace: "*"
  clusterResourceWhitelist:
    - group: ""
      kind: Namespace
    - group: rbac.authorization.k8s.io
      kind: ClusterRole
    - group: rbac.authorization.k8s.io
      kind: ClusterRoleBinding
  namespaceResourceWhitelist:
    - group: "*"
      kind: "*"
  roles:
    - name: applicationset-controller
      description: Role for ApplicationSet controller to manage apps
      policies:
        - p, proj:platform-addons:applicationset-controller, applications, create, platform-addons/*, allow
        - p, proj:platform-addons:applicationset-controller, applications, update, platform-addons/*, allow
        - p, proj:platform-addons:applicationset-controller, applications, delete, platform-addons/*, allow
        - p, proj:platform-addons:applicationset-controller, applications, sync, platform-addons/*, allow
      jwtTokens:
        - iat: 1704067200
    - name: platform-team-admin
      description: Platform team full access
      policies:
        - p, proj:platform-addons:platform-team-admin, applications, *, platform-addons/*, allow
      groups:
        - platform-team@corp.example.com
```

## Debugging and Observability

```bash
# Check ApplicationSet status
kubectl get applicationset -n argocd
kubectl describe applicationset guestbook-environments -n argocd

# View generated Applications
kubectl get applications -n argocd -l app.kubernetes.io/name=guestbook

# Check ApplicationSet controller logs
kubectl logs -n argocd \
  deploy/argocd-applicationset-controller \
  --tail=100 | grep -E "error|warn|guestbook"

# Check if generators are producing correct output
# (Use argocd CLI dry-run)
argocd appset get guestbook-environments --output json | \
  jq '.status.conditions'

# List all Applications generated by a specific ApplicationSet
argocd app list -l \
  argocd.argoproj.io/application-set-name=cluster-monitoring-addons

# Sync all applications in an ApplicationSet
argocd app list -l \
  argocd.argoproj.io/application-set-name=cluster-monitoring-addons \
  -o name | xargs -I{} argocd app sync {}

# Check ApplicationSet conditions for errors
kubectl get applicationset -n argocd -o json | \
  jq -r '.items[] | select(.status.conditions != null) |
  "\(.metadata.name): \(.status.conditions[].message)"'
```

## Production Hardening

```yaml
# argocd-applicationset-controller ConfigMap tuning
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  # Concurrent reconciliation workers (default: 10)
  applicationsetcontroller.concurrent.reconciliations.max: "20"

  # Git polling interval for git-based generators
  applicationsetcontroller.poll.interval: "3m"

  # Enable dry-run mode for testing (set to false in production)
  applicationsetcontroller.dryrun: "false"

  # Restrict ApplicationSets to specific namespaces (ArgoCD 2.8+)
  applicationsetcontroller.namespaces: "argocd,team-a-ns,team-b-ns"

  # Enable SCM provider metrics
  applicationsetcontroller.metrics.port: "8085"
```

## Summary

ArgoCD ApplicationSets transform multi-cluster GitOps from a manual, error-prone process into a scalable, automated workflow. Key patterns for production adoption:

- Use Git Files generators as the primary discovery mechanism for cluster-specific configuration; store cluster metadata in YAML files rather than hardcoding in ApplicationSet manifests
- Implement progressive sync strategies for production rollouts to gate deployments behind cluster-level health checks
- Use the Matrix generator sparingly — the Cartesian product grows exponentially and can generate hundreds of Applications from a small input set
- Apply `ignoreDifferences` for all runtime-managed fields (replicas, operator annotations) to prevent continuous reconciliation loops
- Organize Applications into ArgoCD Projects with explicit RBAC to prevent teams from deploying to unauthorized clusters
- Monitor ApplicationSet controller metrics alongside ArgoCD Application health for end-to-end GitOps observability
