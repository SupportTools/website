---
title: "ArgoCD ApplicationSets: Advanced Generators for Multi-Cluster GitOps"
date: 2028-10-06T00:00:00-05:00
draft: false
tags: ["ArgoCD", "GitOps", "Kubernetes", "ApplicationSets", "CI/CD"]
categories:
- ArgoCD
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced ArgoCD ApplicationSet generators including List, Cluster, Git directory/files, Matrix, Merge, progressive sync with RolloutStrategy, pull request preview environments, and multi-tenant patterns."
more_link: "yes"
url: "/argocd-applicationsets-generators-enterprise-guide/"
---

ArgoCD ApplicationSets extend ArgoCD with templated, multi-target application management. Instead of manually creating hundreds of Application resources for clusters, environments, and services, ApplicationSets generate them programmatically from generators—templates that produce parameter sets. This guide covers every production-relevant generator type, progressive delivery across clusters, pull request preview environments, and multi-tenant RBAC patterns.

<!--more-->

# ArgoCD ApplicationSets: Advanced Generators for Multi-Cluster GitOps

## ApplicationSet Architecture

An ApplicationSet controller runs alongside ArgoCD and watches `ApplicationSet` resources. When an ApplicationSet's generator produces a new set of parameters, the controller creates, updates, or deletes `Application` resources accordingly. This enables a single ApplicationSet to manage dozens of Application resources across environments and clusters.

The key relationship: one ApplicationSet resource produces N Application resources, where N is determined by the generator output.

## Installing the ApplicationSet Controller

In ArgoCD 2.3+, the ApplicationSet controller is bundled:

```bash
# Check ArgoCD version
kubectl -n argocd exec -it deployment/argocd-server -- argocd version --server

# Verify ApplicationSet controller is running
kubectl -n argocd get deployment argocd-applicationset-controller

# Check for ApplicationSet CRD
kubectl get crd applicationsets.argoproj.io
```

## List Generator

The List generator is the simplest: it iterates over an inline list of key-value pairs:

```yaml
# list-generator.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: guestbook-envs
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - cluster: dev
            url: https://dev-cluster.k8s.example.com
            env: development
            replicas: "1"
            resources_cpu: "100m"
            resources_memory: "128Mi"
          - cluster: staging
            url: https://staging-cluster.k8s.example.com
            env: staging
            replicas: "2"
            resources_cpu: "250m"
            resources_memory: "256Mi"
          - cluster: prod
            url: https://prod-cluster.k8s.example.com
            env: production
            replicas: "5"
            resources_cpu: "500m"
            resources_memory: "512Mi"

  template:
    metadata:
      name: "guestbook-{{cluster}}"
      labels:
        app.kubernetes.io/name: guestbook
        environment: "{{env}}"
      annotations:
        argocd.argoproj.io/sync-wave: "10"
    spec:
      project: default
      source:
        repoURL: https://github.com/argoproj/argocd-example-apps
        targetRevision: HEAD
        path: guestbook
        helm:
          values: |
            replicaCount: {{replicas}}
            resources:
              requests:
                cpu: {{resources_cpu}}
                memory: {{resources_memory}}
      destination:
        server: "{{url}}"
        namespace: guestbook
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
```

## Cluster Generator

The Cluster generator iterates over registered ArgoCD clusters, selecting them by labels:

```yaml
# cluster-generator.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: monitoring-stack
  namespace: argocd
spec:
  generators:
    - clusters:
        # Deploy to all clusters labeled as production-grade
        selector:
          matchLabels:
            environment: production
            monitoring: enabled
        # values are merged with cluster secret labels/annotations
        values:
          revision: stable
          alertmanager_url: https://alertmanager.ops.example.com
  template:
    metadata:
      name: "monitoring-{{name}}"
      annotations:
        cluster-url: "{{server}}"
    spec:
      project: platform
      source:
        repoURL: https://github.com/yourorg/platform-charts
        targetRevision: "{{values.revision}}"
        path: charts/monitoring
        helm:
          values: |
            global:
              clusterName: "{{name}}"
              environment: "{{metadata.labels.environment}}"
            alertmanager:
              externalUrl: "{{values.alertmanager_url}}/{{name}}"
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

Register clusters with labels so the generator can filter them:

```bash
# Add a cluster with labels
argocd cluster add prod-us-east-1 \
  --label environment=production \
  --label monitoring=enabled \
  --label region=us-east-1 \
  --name prod-us-east-1

# Update an existing cluster's labels via the cluster secret
kubectl -n argocd patch secret prod-us-east-1 \
  --type=merge \
  --patch '{"metadata": {"labels": {"argocd.argoproj.io/environment": "production"}}}'

# List clusters with their labels
argocd cluster list -o json | jq '.[] | {name: .name, labels: .connectionState}'
```

## Git Directory Generator

The Git Directory generator creates one Application per directory matching a pattern in a Git repository:

```yaml
# git-directory-generator.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: cluster-addons
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/yourorg/cluster-addons
        revision: HEAD
        directories:
          - path: "addons/*/base"
          - path: "addons/experimental"
            exclude: true  # Exclude this directory

  template:
    metadata:
      name: "addon-{{path.basename}}"
      labels:
        app.kubernetes.io/name: "{{path.basename}}"
        managed-by: applicationset
    spec:
      project: cluster-addons
      source:
        repoURL: https://github.com/yourorg/cluster-addons
        targetRevision: HEAD
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

The `{{path}}` variable is the full directory path, and `{{path.basename}}` is just the directory name. Other available variables:

- `{{path}}` — full path: `addons/cert-manager/base`
- `{{path.basename}}` — last component: `base`
- `{{path[0]}}` — first component: `addons`
- `{{path[1]}}` — second component: `cert-manager`
- `{{path.basenameNormalized}}` — normalized (no special chars): `base`

## Git Files Generator

The Git Files generator reads JSON or YAML files from the repository to produce parameter sets:

```yaml
# cluster-config structure in Git:
# clusters/
#   prod-us-east-1/config.yaml
#   prod-eu-west-1/config.yaml
#   staging-us-east-1/config.yaml
```

```yaml
# clusters/prod-us-east-1/config.yaml
cluster_name: prod-us-east-1
cluster_url: https://prod-us-east.k8s.example.com
environment: production
region: us-east-1
namespaces:
  - platform
  - monitoring
  - ingress
helm_values:
  replicaCount: 3
  nodeSelector:
    node-role: application
ingress:
  domain: us-east-1.example.com
  tls_enabled: true
```

```yaml
# git-files-generator.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: platform-per-cluster
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/yourorg/cluster-configs
        revision: HEAD
        files:
          - path: "clusters/*/config.yaml"

  template:
    metadata:
      name: "platform-{{cluster_name}}"
      labels:
        environment: "{{environment}}"
        region: "{{region}}"
    spec:
      project: platform
      source:
        repoURL: https://github.com/yourorg/platform-charts
        targetRevision: HEAD
        path: charts/platform
        helm:
          values: |
            global:
              clusterName: "{{cluster_name}}"
              environment: "{{environment}}"
              region: "{{region}}"
              ingressDomain: "{{ingress.domain}}"
            replicaCount: {{helm_values.replicaCount}}
      destination:
        server: "{{cluster_url}}"
        namespace: platform
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

## Matrix Generator

The Matrix generator combines two generators to produce the Cartesian product:

```yaml
# matrix-generator.yaml - Deploy each app to each cluster
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: apps-cross-clusters
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          # First generator: all production clusters
          - clusters:
              selector:
                matchLabels:
                  environment: production
          # Second generator: all apps from Git
          - git:
              repoURL: https://github.com/yourorg/apps
              revision: HEAD
              directories:
                - path: "services/*"

  template:
    metadata:
      name: "{{name}}-{{path.basename}}"
      labels:
        cluster: "{{name}}"
        app: "{{path.basename}}"
    spec:
      project: production
      source:
        repoURL: https://github.com/yourorg/apps
        targetRevision: HEAD
        path: "{{path}}"
      destination:
        server: "{{server}}"
        namespace: "{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

## Merge Generator

The Merge generator combines parameter sets from multiple generators, using later generators to patch the base:

```yaml
# merge-generator.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: apps-with-overrides
  namespace: argocd
spec:
  generators:
    - merge:
        mergeKeys:
          - cluster  # Merge on the 'cluster' key
        generators:
          # Base: all clusters from cluster generator
          - clusters:
              values:
                replicas: "2"
                version: "1.0.0"
          # Override: specific values for high-availability clusters
          - list:
              elements:
                - cluster: prod-us-east-1
                  replicas: "5"
                  version: "1.0.0"
                  priority: high
                - cluster: prod-eu-west-1
                  replicas: "3"
                  version: "1.0.0"

  template:
    metadata:
      name: "myapp-{{cluster}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/yourorg/apps
        targetRevision: HEAD
        path: myapp
        helm:
          values: |
            replicaCount: {{values.replicas}}
            image:
              tag: {{values.version}}
      destination:
        server: "{{server}}"
        namespace: myapp
```

## Progressive Sync with RolloutStrategy

The RolloutStrategy allows progressive rollout across clusters, waiting for health checks before proceeding:

```yaml
# progressive-rollout.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: progressive-delivery
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - cluster: canary-cluster
            stage: canary
            weight: "10"
          - cluster: staging-cluster
            stage: staging
            weight: "30"
          - cluster: prod-cluster-1
            stage: production
            weight: "30"
          - cluster: prod-cluster-2
            stage: production
            weight: "30"

  strategy:
    type: RollingSync
    rollingSync:
      steps:
        - matchExpressions:
            - key: envLabel
              operator: In
              values:
                - canary
          maxUpdate: 1  # Roll out to 1 canary cluster first
        - matchExpressions:
            - key: envLabel
              operator: In
              values:
                - staging
          maxUpdate: 1
        - matchExpressions:
            - key: envLabel
              operator: In
              values:
                - production
          maxUpdate: 25%  # Roll out to 25% of production clusters at a time

  template:
    metadata:
      name: "myapp-{{cluster}}"
      labels:
        envLabel: "{{stage}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/yourorg/apps
        targetRevision: HEAD
        path: myapp
      destination:
        server: "https://{{cluster}}.k8s.example.com"
        namespace: myapp
      syncPolicy:
        automated:
          prune: true
          selfHeal: false  # Manual sync for progressive rollout
```

Trigger a progressive sync:

```bash
# Sync the ApplicationSet (triggers the rolling strategy)
argocd appset sync progressive-delivery

# Watch the rollout progress
watch -n 5 argocd app list -l app.kubernetes.io/part-of=progressive-delivery -o wide
```

## Pull Request Generator for Preview Environments

The Pull Request generator creates preview environments for each open pull request:

```yaml
# pr-preview-environments.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: pr-preview
  namespace: argocd
spec:
  generators:
    - pullRequest:
        github:
          owner: yourorg
          repo: myapp
          # tokenRef references a secret with a GitHub PAT
          tokenRef:
            secretName: github-pat
            key: token
          # Filter: only PRs with the 'preview' label
          labels:
            - preview
        requeueAfterSeconds: 60  # Poll every 60 seconds

  template:
    metadata:
      name: "pr-preview-{{number}}"
      labels:
        app.kubernetes.io/name: myapp
        pr-number: "{{number}}"
        branch: "{{branch}}"
        environment: preview
      annotations:
        # Notify GitHub with the deployment URL
        notifications.argoproj.io/subscribe.on-sync-succeeded.github: ""
        link.argocd.argoproj.io/external-link: "https://pr-{{number}}.preview.example.com"
    spec:
      project: preview-environments
      source:
        repoURL: https://github.com/yourorg/myapp
        targetRevision: "{{head_sha}}"
        path: helm/myapp
        helm:
          values: |
            image:
              tag: "pr-{{number}}"
            ingress:
              enabled: true
              host: "pr-{{number}}.preview.example.com"
              annotations:
                cert-manager.io/cluster-issuer: letsencrypt-staging
            env: preview
            db:
              name: "myapp_pr_{{number}}"
              createDatabase: true
      destination:
        server: https://preview-cluster.k8s.example.com
        namespace: "pr-{{number}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true

  # Clean up namespaces when the PR is closed/merged
  preservedFields:
    annotations:
      - argocd.argoproj.io/managed-by-cluster-argocd
  syncPolicy:
    preserveResourcesOnDeletion: false  # Delete namespace when PR closes
```

Create the GitHub PAT secret:

```bash
kubectl -n argocd create secret generic github-pat \
  --from-literal=token="ghp_your_personal_access_token"
```

## Multi-Tenant ApplicationSet Patterns

In multi-tenant environments, restrict which namespaces teams can deploy to:

```yaml
# tenant-appset-rbac.yaml
# First, create an AppProject per tenant
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-alpha
  namespace: argocd
spec:
  description: "Team Alpha applications"
  sourceRepos:
    - "https://github.com/yourorg/team-alpha-apps"
    - "https://charts.bitnami.com/bitnami"
  destinations:
    - server: "https://kubernetes.default.svc"
      namespace: "team-alpha-*"  # Only team-alpha prefixed namespaces
    - server: "https://prod-cluster.k8s.example.com"
      namespace: "team-alpha-*"
  clusterResourceWhitelist: []  # No cluster-scoped resources
  namespaceResourceBlacklist:
    - group: ""
      kind: ResourceQuota  # Teams cannot manage their own quotas
    - group: ""
      kind: LimitRange
  orphanedResources:
    warn: true
  roles:
    - name: team-alpha-developer
      description: Team Alpha developers
      policies:
        - p, proj:team-alpha:team-alpha-developer, applications, get, team-alpha/*, allow
        - p, proj:team-alpha:team-alpha-developer, applications, sync, team-alpha/*, allow
        - p, proj:team-alpha:team-alpha-developer, applications, override, team-alpha/*, allow
      groups:
        - github-org:team-alpha
```

```yaml
# Scoped ApplicationSet for a tenant
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: team-alpha-services
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/yourorg/team-alpha-apps
        revision: HEAD
        directories:
          - path: "services/*"

  template:
    metadata:
      name: "team-alpha-{{path.basename}}"
      labels:
        team: alpha
    spec:
      project: team-alpha  # Bound to team-alpha project (restricted destinations)
      source:
        repoURL: https://github.com/yourorg/team-alpha-apps
        targetRevision: HEAD
        path: "{{path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "team-alpha-{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

## ApplicationSet Controller RBAC

Restrict which namespaces the ApplicationSet controller can create Applications in:

```bash
# In ArgoCD 2.6+, configure namespace scoping
kubectl -n argocd patch configmap argocd-cmd-params-cm \
  --type=merge \
  --patch '{"data": {"applicationsetcontroller.namespaces": "argocd,team-alpha,team-beta"}}'

kubectl -n argocd rollout restart deployment/argocd-applicationset-controller
```

Configure which namespaces ArgoCD Applications can be created in:

```yaml
# argocd-cmd-params-cm patch
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  # Allow ApplicationSets to create Applications in these namespaces
  applicationsetcontroller.namespaces: "argocd,team-alpha,team-beta"
  # Allow apps-in-any-namespace feature
  application.namespaces: "team-alpha,team-beta"
```

## Go Templates for Advanced Templating

ApplicationSets support Go templates in addition to the default `{{parameter}}` syntax, enabling more complex expressions:

```yaml
# go-template-appset.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: apps-go-template
  namespace: argocd
spec:
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]

  generators:
    - list:
        elements:
          - cluster: prod-us
            region: us-east-1
            tier: gold
            max_replicas: 10
          - cluster: prod-eu
            region: eu-west-1
            tier: silver
            max_replicas: 5

  template:
    metadata:
      # Use Go template functions
      name: "{{ .cluster }}-myapp"
      labels:
        # Upper-case the tier using a Go template function
        tier: "{{ upper .tier }}"
        # Truncate long names
        app: "{{ trunc 20 .cluster }}"
    spec:
      project: default
      source:
        repoURL: https://github.com/yourorg/apps
        targetRevision: HEAD
        path: myapp
        helm:
          values: |
            global:
              cluster: "{{ .cluster }}"
              region: "{{ .region }}"
            autoscaling:
              maxReplicas: {{ .max_replicas }}
              # Compute min replicas as 20% of max using Go math
              minReplicas: {{ max 1 (div .max_replicas 5) }}
      destination:
        server: "https://{{ .cluster }}.k8s.example.com"
        namespace: myapp
```

## Monitoring ApplicationSets

```bash
# List all ApplicationSets with their sync status
argocd appset list

# Get detailed status of an ApplicationSet
argocd appset get progressive-delivery

# Check ApplicationSet controller logs for errors
kubectl -n argocd logs deployment/argocd-applicationset-controller --tail=50

# List all Applications generated by an ApplicationSet
kubectl -n argocd get applications -l app.kubernetes.io/managed-by=argocd-applicationset

# Watch Application sync status in real-time
watch -n 5 'argocd app list | sort -k 7'

# Check ApplicationSet events
kubectl -n argocd describe applicationset progressive-delivery | grep -A 20 Events
```

## Triggering Sync from CI/CD

```bash
#!/bin/bash
# ci-trigger-appset-sync.sh

APP_NAME="myapp"
NEW_TAG="${GITHUB_SHA:-$(git rev-parse --short HEAD)}"
ARGOCD_SERVER="argocd.internal.example.com"

# Login to ArgoCD
argocd login "$ARGOCD_SERVER" \
  --auth-token "$ARGOCD_AUTH_TOKEN" \
  --grpc-web

# Update the image tag in Git (triggers reconciliation)
# Or: force a sync if the ApplicationSet already tracks HEAD
argocd appset sync "apps-go-template" --wait --timeout 300

# Monitor rollout health
argocd app wait --selector "app.kubernetes.io/name=${APP_NAME}" \
  --health \
  --timeout 300
```

## Summary

ApplicationSets are the production-ready mechanism for managing GitOps at scale. The List and Cluster generators handle static and dynamic multi-cluster deployments. Git directory and file generators enable convention-over-configuration patterns where folder structure drives application creation. Matrix and Merge generators combine these building blocks for sophisticated cross-product deployments. The pull request generator automates preview environment lifecycle with zero manual intervention. Progressive rollout strategies prevent a bad deployment from propagating to all clusters simultaneously. Together, these patterns let a small platform team manage hundreds of applications across dozens of clusters with a consistent, auditable GitOps workflow.
